import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {trayBox, trayIcons, trayIndicator} from './takeover.js';

const GAP = 6;

// Tray icons that are not pinned wait behind an arrow, a click on it shows them in a flyout.
export class TrayOverflow {
    constructor(settings, onToggle) {
        this._settings = settings;
        this._onToggle = onToggle;
        this.open = false;
        this._box = trayBox();
        this._arrow = new St.Button({
            style_class: 'panel-button',
            child: new St.Icon({icon_name: 'pan-up-symbolic', style_class: 'system-status-icon'}),
            accessible_name: _('Show hidden icons'),
            can_focus: true,
            visible: false,
        });
        this._arrow.connect('clicked', () => (this.open ? this._close() : this._open()));
        // Named like the top bar so the theme's panel button styles still reach the icons.
        this._flyout = new St.BoxLayout({name: 'panel', style_class: 'silver-dock-tray-flyout', reactive: true, visible: false});
        // Not on top: under the menus of its icons, and at logout gone before them like the top bar is.
        Main.layoutManager.addChrome(this._flyout);
        // A click on a window never reaches the stage. Over the windows while the flyout is open, this takes it.
        this._sheet = new St.Widget({reactive: true, visible: false});
        Main.layoutManager.addChrome(this._sheet);
        Main.uiGroup.set_child_above_sibling(this._sheet, global.window_group);
        this._box.insert_child_at_index(this._arrow, 0);
        // AppIndicator adds an icon before it knows its id, and hides the button of a passive one.
        this._watched = new Map();
        const watch = child => {
            const button = child.get_first_child();
            if (!button || this._watched.has(button))
                return;
            const indicator = trayIndicator(button);
            this._watched.set(button, indicator);
            button.connectObject('notify::visible', () => this._sort(), 'destroy', () => this._unwatch(button), this);
            indicator?.connectObject('ready', () => this._sort(), this);
        };
        this._box.get_children().forEach(watch);
        this._box.connectObject('child-added', (box, child) => {
            watch(child);
            this._sort();
        }, this);
        // An app that quits takes its icon out of the flyout.
        this._flyout.connectObject('child-removed', () => this._showArrow(), this);
        settings.connectObject('changed::tray-pinned', () => this._sort(),
            'changed::position', () => this._close(), 'changed::keep-top-bar', () => this._close(), this);
        this._sort();
    }

    _sort() {
        // Moving icons fires child-added again.
        if (this._sorting)
            return;
        this._sorting = true;
        const icons = trayIcons();
        this._remember(icons);
        const pinned = new Set(this._settings.get_strv('tray-pinned'));
        for (const {id, container, menu} of icons) {
            const hide = !pinned.has(id);
            const parent = container.get_parent();
            if (hide && parent !== this._flyout) {
                parent?.remove_child(container);
                this._flyout.add_child(container);
                // Done with its menu, done with the flyout.
                menu?.connectObject('open-state-changed', (m, open) => open || this._close(), this);
            } else if (!hide && parent === this._flyout) {
                this._unhide(container, menu);
            }
        }
        this._showArrow();
        this._sorting = false;
    }

    _unwatch(button) {
        button.disconnectObject(this);
        this._watched.get(button)?.disconnectObject(this);
        this._watched.delete(button);
    }

    _showArrow() {
        this._arrow.visible = this._flyout.get_children().some(child => child.visible);
        this._point(this.open);
        if (!this._arrow.visible)
            this._close();
    }

    _unhide(container, menu) {
        menu?.disconnectObject(this);
        this._flyout.remove_child(container);
        // Where AppIndicator puts its icons: behind GNOME's first indicator, the arrow counted.
        this._box.insert_child_at_index(container, 2);
    }

    // For the preferences, which cannot see the shell's icons. Written only when a new one shows up.
    _remember(icons) {
        const known = this._settings.get_strv('tray-known');
        const ids = new Set(known.map(entry => entry.split('\t')[0]));
        // Icons of one Wine prefix share their window class, so their id.
        const fresh = icons.filter(icon => !ids.has(icon.id) && ids.add(icon.id)).map(icon => `${icon.id}\t${icon.title}`);
        if (fresh.length)
            this._settings.set_strv('tray-known', [...known, ...fresh]);
    }

    _open() {
        this.open = true;
        this._sheet.set_size(global.stage.width, global.stage.height);
        this._sheet.show();
        this._flyout.show();
        this._place();
        this._arrow.add_style_pseudo_class('checked');
        global.stage.connectObject('captured-event', (stage, event) => this._outside(event), this);
        this._onToggle();
    }

    _monitor() {
        return Main.layoutManager.findMonitorForActor(this._arrow) ?? Main.layoutManager.primaryMonitor;
    }

    // Upwards only from a bottom dock holding the top bar. The arrow points where it opens, back while open.
    _up() {
        return this._settings.get_string('position') === 'bottom' && !this._settings.get_boolean('keep-top-bar');
    }

    _point(open) {
        this._arrow.child.icon_name = this._up() !== open ? 'pan-up-symbolic' : 'pan-down-symbolic';
    }

    _place() {
        const [ax, ay] = this._arrow.get_transformed_position();
        const [aw, ah] = this._arrow.get_transformed_size();
        const monitor = this._monitor();
        const [, , fw, fh] = this._flyout.get_preferred_size();
        const up = this._up();
        this._point(true);
        const x = Math.min(Math.max(ax + aw / 2 - fw / 2, monitor.x + GAP), monitor.x + monitor.width - fw - GAP);
        this._flyout.set_position(Math.round(x), Math.round(up ? ay - fh - GAP : ay + ah + GAP));
    }

    // A press elsewhere closes it, unless one of its icons has a menu open: that menu takes the click.
    _outside(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        const inside = this._flyout.contains(target) || this._arrow.contains(target);
        if (!inside && !trayIcons().some(icon => icon.menu?.isOpen && icon.container.get_parent() === this._flyout))
            this._close();
        return Clutter.EVENT_PROPAGATE;
    }

    _close() {
        this._point(false);
        if (!this.open)
            return;
        this.open = false;
        global.stage.disconnectObject(this);
        this._arrow.remove_style_pseudo_class('checked');
        // After the click that closed a menu has been handled. Opened again by then, it stays.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this.open) {
                this._flyout?.hide();
                this._sheet?.hide();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._onToggle();
    }

    destroy() {
        this.open = false;
        global.stage.disconnectObject(this);
        this._box.disconnectObject(this);
        this._flyout.disconnectObject(this);
        [...this._watched.keys()].forEach(button => this._unwatch(button));
        this._settings.disconnectObject(this);
        this._sorting = true;
        for (const {container, menu} of trayIcons()) {
            if (container.get_parent() === this._flyout)
                this._unhide(container, menu);
        }
        this._arrow.destroy();
        for (const actor of [this._flyout, this._sheet]) {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._flyout = null;
        this._sheet = null;
    }
}
