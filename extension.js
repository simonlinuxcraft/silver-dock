import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {gtkColors, wallpaperColor} from './colors.js';
import {COLORS, Dock} from './dock.js';
import {LauncherEntries, NotificationCounts} from './launcher.js';
import {TrashWatcher} from './places.js';
import {MediaPlayers} from './media.js';
import {WindowPreviews} from './previews.js';

// ms after a window appears in which demands-attention is GNOME's, not the app's (urgent is always the app's)
const OPENING = 5000;
// Windows flagged only that way, kept while the extension is off, as on every lock.
const quiet = new Set();
// Read where they are used. A rebuild would only close open menus and bring a hidden bar out.
const LIVE = new Set(['tooltips', 'previews', 'peek', 'click-action', 'middle-click', 'scroll', 'scroll-workspaces',
    'bounce', 'squash', 'poof', 'intro', 'springy', 'minimize-to-icon', 'badge-pop', 'pop']);

export default class SilverDock extends Extension {
    enable() {
        try {
            this._setup();
        } catch (e) {
            // GNOME skips disable() after a failed enable, the top bar content would stay stranded.
            this.disable();
            throw e;
        }
    }

    _setup() {
        this.settings = this.getSettings();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this.volumes = Gio.VolumeMonitor.get();
        this.launcher = new LauncherEntries(() => this._each(dock => dock.updateBadges()));
        this.notifications = new NotificationCounts(() => this._each(dock => dock.updateBadges()));
        this.media = new MediaPlayers();
        this.previews = new WindowPreviews(() => this._each(dock => dock.previewsChanged()));
        this.trash = null;
        this._docks = [];
        this._watched = new Set();

        const sync = () => this._each(dock => dock.sync());
        const check = () => this._each(dock => dock.queueCheck());
        const recolor = () => this._recolor();
        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', (appSystem, app) => this._each(dock => dock.onAppState(app)),
            'installed-changed', sync, this);
        AppFavorites.getAppFavorites().connectObject('changed', sync, this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', () => this._each(dock => dock.updateDots()), this);
        this.settings.connectObject(
            'changed::autohide', () => this._each(dock => dock.trackBar()),
            'changed', (settings, key) => {
                if (key === 'all-monitors')
                    this._build(false);
                else if (LIVE.has(key))
                    this._services();
                else
                    this._refresh();
            }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._build(false), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'changed', recolor,
            'notify::scale-factor', () => this._refresh(), this);
        this._iface.connectObject('changed::gtk-theme', recolor, 'changed::color-scheme', recolor, this);
        this._background.connectObject('changed', recolor, this);
        // A wallpaper on a disk mounted later.
        this.volumes.connectObject('mount-added', () => {
            sync();
            recolor();
        }, 'mount-removed', sync, 'mount-changed', sync, this);

        global.display.connectObject(
            'window-created', (display, win) => this._watchWindow(win),
            'restacked', check,
            'workareas-changed', () => this._each(dock => dock.queuePlace()),
            'in-fullscreen-changed', check, this);
        global.workspace_manager.connectObject('active-workspace-changed', check, this);
        // Open menus and the keyboard in the dock take the key focus.
        global.stage.connectObject('notify::key-focus', check, this);
        Main.overview.connectObject(
            'showing', check,
            'hidden', check,
            'item-drag-begin', () => this._each(dock => dock.startDrag()),
            'item-drag-end', () => this._each(dock => dock.endDrag()),
            'item-drag-cancelled', () => this._each(dock => dock.endDrag()), this);
        const windows = global.get_window_actors().map(actor => actor.meta_window);
        quiet.forEach(win => windows.includes(win) || quiet.delete(win));
        windows.forEach(win => this._watchWindow(win, 0));

        this._services();
        this._build(true);
    }

    // Also after a failed enable, every step tolerates missing parts.
    disable() {
        this._stopListening();
        this._watched?.forEach(win => win.set_icon_geometry(null));
        this._docks?.forEach(dock => dock.destroy());
        this.previews?.destroy();
        this.settings = this._iface = this._background = this.volumes = this.previews = this._docks = this._watched = null;
    }

    // GNOME tears the stage down at logout without disabling extensions.
    lost() {
        this._stopListening();
        this._each(dock => dock.stopListening());
    }

    _stopListening() {
        Shell.AppSystem.get_default().disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.stage.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._watched?.forEach(win => win.disconnectObject(this));
        this.volumes?.disconnectObject(this);
        this.launcher?.destroy();
        this.notifications?.destroy();
        this.media?.destroy();
        this.trash?.destroy();
        this.launcher = this.notifications = this.media = this.trash = null;
        this.settings?.disconnectObject(this);
        this._iface?.disconnectObject(this);
        this._background?.disconnectObject(this);
    }

    _each(fn) {
        this._docks?.forEach(fn);
    }

    _services() {
        this.previews.peek = this.settings.get_boolean('peek');
        this.previews.haiku = this.settings.get_string('design') === 'haiku';
        if (this.settings.get_boolean('trash')) {
            this.trash ??= new TrashWatcher(() => this._each(dock => dock.updateTrash()));
        } else {
            this.trash?.destroy();
            this.trash = null;
        }
    }

    _refresh() {
        this._services();
        this._each(dock => dock.refresh(true));
    }

    // The primary monitor's dock first, it takes the top bar content.
    _build(intro) {
        this._docks.forEach(dock => dock.destroy());
        this._docks = [];
        const {monitors, primaryIndex} = Main.layoutManager;
        const others = this.settings.get_boolean('all-monitors')
            ? monitors.map((monitor, i) => i).filter(i => i !== primaryIndex) : [];
        for (const index of [primaryIndex, ...others].filter(i => monitors[i])) {
            // Listed before it fills itself, so disable() still takes a failed one down.
            const dock = new Dock(this, index, index === primaryIndex, intro);
            this._docks.push(dock);
            dock.refresh(true);
        }
    }

    // born: 0 for windows from before the extension.
    _watchWindow(win, born = GLib.get_monotonic_time()) {
        this._watched.add(win);
        const check = () => this._each(dock => dock.queueCheck());
        const attention = () => {
            // GNOME flags a window it opens without the focus ("is ready"), that is no request of the app.
            if (!win.demands_attention)
                quiet.delete(win);
            else if (GLib.get_monotonic_time() - born < OPENING * 1000)
                quiet.add(win);
            this._each(dock => dock.queueAttention());
        };
        win.connectObject(
            'position-changed', check,
            'size-changed', check,
            'notify::minimized', () => {
                this._setIconGeometry(win);
                check();
            },
            'notify::demands-attention', attention,
            'notify::urgent', attention,
            // Meta.Window is no actor, its signal tracker entry would outlive it.
            'unmanaged', () => {
                win.disconnectObject(this);
                this._watched.delete(win);
                quiet.delete(win);
                check();
                this._each(dock => dock.queueAttention());
            }, this);
        check();
    }

    // Like GNOME's own handler: not for helpers off the taskbar or the window in front.
    wantsAttention(win) {
        return (win.urgent || (win.demands_attention && !quiet.has(win))) && !win.is_skip_taskbar() && !win.has_focus();
    }

    // GNOME's (un)minimize animation uses it, set before the animation starts.
    _setIconGeometry(win) {
        let rect = null;
        if (this.settings.get_boolean('minimize-to-icon')) {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            const dock = this._docks.find(d => d.monitorIndex === win.get_monitor()) ?? this._docks[0];
            rect = dock?.iconRect(app) ?? null;
        }
        win.set_icon_geometry(rect);
    }

    _recolor() {
        const colors = this.settings?.get_string('colors');
        if (['theme', 'wallpaper'].includes(colors) || colors === 'dock' && this.settings.get_string('scheme') === 'system')
            this._each(dock => dock.paint());
    }

    prefersDark() {
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    wallpaperColor() {
        return wallpaperColor(this._background, this.prefersDark(), () => this._recolor());
    }

    // The shell theme's top bar colors from a hidden stand-in, the GTK theme fills in.
    themeColors() {
        const panel = new St.Widget({name: 'panel', visible: false});
        Main.layoutManager.uiGroup.add_child(panel);
        const node = panel.get_theme_node();
        const rgb = c => `${c.red}, ${c.green}, ${c.blue}`;
        const bg = node.get_background_color();
        const fg = rgb(node.get_foreground_color());
        panel.destroy();
        const gtk = gtkColors(this._iface, () => this._recolor());
        return {bg: bg.alpha ? rgb(bg) : gtk.bg ?? COLORS.bg, alpha: bg.alpha / 255 || 1, fg, border: 'none', accent: gtk.accent};
    }
}
