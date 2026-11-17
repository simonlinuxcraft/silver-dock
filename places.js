import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const TRASH = 'trash';
export const DOWNLOADS = 'downloads';
export const SYSMON = 'system-monitor';

const MONITORS = ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop', 'net.nokyan.Resources.desktop'];

export function downloadsDir() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
}

function monitorApp() {
    const apps = Shell.AppSystem.get_default();
    const known = MONITORS.map(id => apps.lookup_app(id)).find(Boolean);
    if (known)
        return known;
    const info = Gio.AppInfo.get_all().find(i => i.should_show() && i.get_categories?.()?.split(';').includes('Monitor'));
    return info ? apps.lookup_app(info.get_id()) : null;
}

function isRemovable(mount) {
    return mount.can_eject() || mount.get_drive()?.is_removable();
}

export function driveMounts(monitor, removable, internal) {
    return removable ? monitor.get_mounts().filter(mount => !mount.is_shadowed() &&
        (isRemovable(mount) || internal && mount.get_root().is_native())) : [];
}

export function placeName(place) {
    if (place === TRASH)
        return _('Trash');
    if (place === DOWNLOADS)
        return _('Downloads');
    if (place === SYSMON)
        return _('System Load');
    return place.get_name();
}

export function placeIcon(place, size, trashFull) {
    if (place === TRASH)
        return new St.Icon({icon_name: trashFull ? 'user-trash-full' : 'user-trash', icon_size: size});
    if (place === DOWNLOADS)
        return new St.Icon({icon_name: 'folder-download', icon_size: size});
    return new St.Icon({gicon: place.get_icon(), icon_size: size});
}

export function openPlace(place) {
    if (place === SYSMON) {
        const app = monitorApp();
        if (app)
            app.activate();
        else
            Main.notifyError(_('No system monitor installed'), _('Install GNOME System Monitor or Resources.'));
        return;
    }
    const uri = {[TRASH]: 'trash:///', [DOWNLOADS]: Gio.File.new_for_path(downloadsDir()).get_uri()}[place] ??
        place.get_root().get_uri();
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError(_('Cannot open %s').format(placeName(place)), e.message);
    }
}

export function placeActions(place) {
    const actions = [[place === DOWNLOADS ? _('Open Folder') : _('Open'), () => openPlace(place)]];
    if (place === TRASH)
        actions.push([_('Empty Trash'), emptyTrash]);
    // Unmounting an internal disk from the dock is too easy a slip.
    else if (typeof place === 'object' && isRemovable(place) && (place.can_eject() || place.can_unmount()))
        actions.push([place.can_eject() ? _('Eject') : _('Unmount'), () => eject(place)]);
    return actions;
}

// Through Nautilus: it asks first, and the trash spans every mounted disk.
function emptyTrash() {
    Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
        'org.gnome.Nautilus.FileOperations2', 'EmptyTrash', new GLib.Variant('(ba{sv})', [true, {}]),
        null, Gio.DBusCallFlags.NONE, -1, null).catch(e => Main.notifyError(_('Cannot empty the trash'), e.message));
}

function eject(mount) {
    const [start, finish, failed] = mount.can_eject()
        ? ['eject_with_operation', 'eject_with_operation_finish', _('Cannot eject %s')]
        : ['unmount_with_operation', 'unmount_with_operation_finish', _('Cannot unmount %s')];
    mount[start](Gio.MountUnmountFlags.NONE, null, null, (m, result) => {
        try {
            m[finish](result);
        } catch (e) {
            Main.notifyError(failed.format(m.get_name()), e.message);
        }
    });
}

export class TrashWatcher {
    constructor(onChange) {
        this.full = false;
        this._onChange = onChange;
        this._file = Gio.File.new_for_uri('trash:///');
        this._cancellable = new Gio.Cancellable();
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._monitor.connect('changed', () => this._query());
        } catch (e) {
            console.log(`Silver Dock: trash not watchable (${e.message})`);
        }
        this._query();
    }

    destroy() {
        this._cancellable.cancel();
        this._monitor?.cancel();
    }

    // Emptying a big trash fires a burst of events.
    _query() {
        if (this._busy) {
            this._again = true;
            return;
        }
        this._busy = true;
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, result) => {
                let full = this.full;
                try {
                    full = file.query_info_finish(result).get_attribute_uint32('trash::item-count') > 0;
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // No gvfs yet early after login, a change meanwhile still counts.
                }
                this._busy = false;
                if (this._again) {
                    this._again = false;
                    this._query();
                }
                if (full !== this.full) {
                    this.full = full;
                    this._onChange();
                }
            });
    }
}
