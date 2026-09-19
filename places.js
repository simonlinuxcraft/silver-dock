// Trash and removable drives, shown after the apps.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const TRASH = 'trash';

function isRemovable(mount) {
    return mount.can_eject() || Boolean(mount.get_drive()?.is_removable());
}

// Removable media and, on request, the internal disks. Network shares stay out.
export function driveMounts(monitor, removable, internal) {
    return monitor.get_mounts().filter(mount => !mount.is_shadowed() &&
        (isRemovable(mount) ? removable : internal && mount.get_root().is_native()));
}

export function placeName(place) {
    return place === TRASH ? _('Trash') : place.get_name();
}

export function placeIcon(place, size, trashFull) {
    return place === TRASH
        ? new St.Icon({icon_name: trashFull ? 'user-trash-full' : 'user-trash', icon_size: size})
        : new St.Icon({gicon: place.get_icon(), icon_size: size});
}

export function openPlace(place) {
    const uri = place === TRASH ? 'trash:///' : place.get_root().get_uri();
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError(_('Cannot open %s').format(placeName(place)), e.message);
    }
}

// [label, action] pairs for the right click menu.
export function placeActions(place) {
    const actions = [[_('Open'), () => openPlace(place)]];
    if (place === TRASH)
        actions.push([_('Empty Trash'), emptyTrash]);
    // Internal disks only open, unmounting one from the dock is too easy a slip.
    else if (isRemovable(place) && (place.can_eject() || place.can_unmount()))
        actions.push([place.can_eject() ? _('Eject') : _('Unmount'), () => eject(place)]);
    return actions;
}

// Nautilus asks before deleting. The trash spans every mounted disk, not only the home folder.
function emptyTrash() {
    Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
        'org.gnome.Nautilus.FileOperations2', 'EmptyTrash', new GLib.Variant('(ba{sv})', [true, {}]),
        null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (e) {
                Main.notifyError(_('Cannot empty the trash'), e.message);
            }
        });
}

function eject(mount) {
    const [start, finish] = mount.can_eject()
        ? ['eject_with_operation', 'eject_with_operation_finish']
        : ['unmount_with_operation', 'unmount_with_operation_finish'];
    mount[start](Gio.MountUnmountFlags.NONE, null, null, (m, result) => {
        try {
            m[finish](result);
        } catch (e) {
            Main.notifyError(_('Cannot eject %s').format(m.get_name()), e.message);
        }
    });
}

// Tells whether the trash holds anything and reports changes.
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

    // Emptying a big trash fires a burst of events, one query at a time is enough.
    _query() {
        if (this._busy) {
            this._again = true;
            return;
        }
        this._busy = true;
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, result) => {
                let full;
                try {
                    full = file.query_info_finish(result).get_attribute_uint32('trash::item-count') > 0;
                } catch {
                    this._busy = false;
                    return; // cancelled on disable, or no gvfs
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
