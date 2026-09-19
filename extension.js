import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {gtkColors} from './colors.js';
import {COLORS, Dock} from './dock.js';
import {LauncherEntries} from './launcher.js';
import {TrashWatcher} from './places.js';
import {WindowPreviews} from './previews.js';

// A dock on the primary monitor, on request one on every monitor (see dock.js).
// The parts all docks share live here: settings, launcher entries, trash, volumes,
// window previews, theme colors and the watch on every window.
export default class SilverDock extends Extension {
    enable() {
        try {
            this._setup();
        } catch (e) {
            // GNOME does not call disable() after a failed enable, and the top bar
            // content must never stay stranded in a half built dock.
            this.disable();
            throw e;
        }
    }

    _setup() {
        this.settings = this.getSettings();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.volumes = Gio.VolumeMonitor.get();
        this.launcher = new LauncherEntries(() => this._each(dock => dock.updateBadges()));
        this.previews = new WindowPreviews(() => this._each(dock => dock.previewsChanged()));
        this.trash = null;
        this._docks = [];
        this._watched = new Set(); // windows with our signals, see _watchWindow

        const sync = () => this._each(dock => dock.sync());
        const check = () => this._each(dock => dock.queueCheck());
        // Theme colors follow a switch of the shell or GTK theme.
        const retheme = () => {
            if (this.settings.get_string('colors') === 'theme')
                this._each(dock => dock.paint());
        };
        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', (appSystem, app) => this._each(dock => dock.onAppState(app)),
            'installed-changed', sync, this);
        AppFavorites.getAppFavorites().connectObject('changed', sync, this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', () => this._each(dock => dock.updateDots()), this);
        this.settings.connectObject(
            'changed::autohide', () => this._each(dock => dock.trackBar()),
            'changed', (settings, key) => (key === 'all-monitors' ? this._build(false) : this._refresh()), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._build(false), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', retheme, this);
        this._iface.connectObject('changed::gtk-theme', retheme, 'changed::color-scheme', retheme, this);
        this.volumes.connectObject('mount-added', sync, 'mount-removed', sync, 'mount-changed', sync, this);

        // Autohide follows every window that could cover a bar, and shows the bars
        // for open menus (they take the key focus) and the overview.
        global.display.connectObject(
            'window-created', (display, win) => this._watchWindow(win),
            'restacked', check,
            // A side bar keeps clear of the top bar, which changes the work area.
            'workareas-changed', () => this._each(dock => dock.queuePlace()), this);
        global.workspace_manager.connectObject('active-workspace-changed', check, this);
        global.stage.connectObject('notify::key-focus', check, this);
        Main.overview.connectObject(
            'showing', check,
            'hidden', check,
            'item-drag-begin', () => this._each(dock => dock.startDrag()),
            'item-drag-end', () => this._each(dock => dock.endDrag()),
            'item-drag-cancelled', () => this._each(dock => dock.endDrag()), this);
        global.get_window_actors().forEach(actor => this._watchWindow(actor.meta_window));

        this._services();
        this._build(true);
    }

    // Also runs after a failed enable, so every step tolerates missing parts.
    disable() {
        this._stopListening();
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        global.stage.disconnectObject(this);
        this._watched?.forEach(win => win.set_icon_geometry(null));
        this._docks?.forEach(dock => dock.destroy());
        // After the docks, their icons ask whether the previews show their app.
        this.previews?.destroy();
        this.settings = this._iface = this.volumes = this.previews = this._docks = this._watched = null;
    }

    // GNOME tears the stage down at logout without disabling extensions, see Dock.
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
        this._watched?.forEach(win => win.disconnectObject(this));
        this.volumes?.disconnectObject(this);
        this.launcher?.destroy();
        this.trash?.destroy();
        this.launcher = this.trash = null;
        this.settings?.disconnectObject(this);
        this._iface?.disconnectObject(this);
    }

    _each(fn) {
        this._docks?.forEach(fn);
    }

    // The shared parts that follow the settings.
    _services() {
        this.previews.peek = this.settings.get_boolean('peek');
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

    // One dock on the primary monitor, with all-monitors one on each. The primary one
    // comes first and takes the top bar content. intro: after login or unlock.
    _build(intro) {
        this._docks.forEach(dock => dock.destroy());
        this._docks = [];
        const {monitors, primaryIndex} = Main.layoutManager;
        const others = this.settings.get_boolean('all-monitors')
            ? monitors.map((monitor, i) => i).filter(i => i !== primaryIndex) : [];
        for (const index of [primaryIndex, ...others].filter(i => monitors[i])) {
            // In the list before it fills itself, so a failure still takes it down.
            const dock = new Dock(this, index, index === primaryIndex, intro);
            this._docks.push(dock);
            dock.refresh(true);
        }
    }

    _watchWindow(win) {
        this._watched.add(win);
        const check = () => this._each(dock => dock.queueCheck());
        const attention = () => this._each(dock => dock.queueAttention());
        win.connectObject(
            'position-changed', check,
            'size-changed', check,
            'notify::minimized', () => {
                this._setIconGeometry(win);
                check();
            },
            'notify::demands-attention', attention,
            'notify::urgent', attention,
            // Meta.Window is no actor, its signal tracker entry would outlive the window.
            'unmanaged', () => {
                win.disconnectObject(this);
                this._watched.delete(win);
                check();
                attention();
            }, this);
        check();
    }

    // GNOME's minimize animation flies into a window's icon geometry, its unminimize
    // grows out of it. Set right as the state changes, the animation follows later.
    // The icon in the dock on the window's monitor, else the one on the primary.
    _setIconGeometry(win) {
        let rect = null;
        if (this.settings.get_boolean('minimize-to-icon')) {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            const dock = this._docks.find(d => d.monitorIndex === win.get_monitor()) ?? this._docks[0];
            rect = dock?.iconRect(app) ?? null;
        }
        win.set_icon_geometry(rect);
    }

    // The dock takes the place of the top bar, so it wears the shell theme's top bar
    // colors, read from a hidden stand-in. A see-through top bar leaves the background
    // to the GTK theme. The accent comes from the GTK theme, else the system accent
    // color applies (stylesheet.css).
    themeColors() {
        const panel = new St.Widget({name: 'panel', visible: false});
        Main.layoutManager.uiGroup.add_child(panel);
        const node = panel.get_theme_node();
        const rgb = c => `${c.red}, ${c.green}, ${c.blue}`;
        const bg = node.get_background_color();
        const fg = rgb(node.get_foreground_color());
        panel.destroy();
        const gtk = gtkColors(this._iface, () => {
            if (this.settings?.get_string('colors') === 'theme')
                this._each(dock => dock.paint());
        });
        if (bg.alpha)
            return {bg: rgb(bg), alpha: bg.alpha / 255, fg, border: 'none', accent: gtk.accent};
        return {bg: gtk.bg ?? COLORS.bg, alpha: 1, fg, border: 'none', accent: gtk.accent};
    }
}
