import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {trayBox, trayIcons} from './takeover.js';

const GAP = 6;

// Tray icons that are not pinned wait behind an arrow, a click on it shows them in a flyout.
export class TrayOverflow {
    constructor(settings) {
        this._settings = settings;
        this._box = trayBox();
        this._arrow = new St.Button({
            style_class: 'panel-button silver-dock-tray-arrow',
            child: new St.Icon({icon_name: 'pan-up-symbolic', style_class: 'system-status-icon'}),
            accessible_name: _('Show hidden icons'),
            can_focus: true,
            visible: false,
        });
        this._arrow.connect('clicked', () => (this._flyout.visible ? this._close() : this._open()));
        // Named like the top bar so the theme's panel button styles still reach the icons.
        this._flyout = new St.BoxLayout({name: 'panel', style_class: 'silver-dock-tray-flyout', reactive: true, visible: false});
        Main.layoutManager.addTopChrome(this._flyout);
        this._box.insert_child_at_index(this._arrow, 0);
        this._box.connectObject('child-added', () => this._sort(), this);
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
        this._arrow.visible = this._flyout.get_n_children() > 0;
        this._point(false);
        if (!this._arrow.visible)
            this._close();
        this._sorting = false;
    }

    _unhide(container, menu) {
        menu?.disconnectObject(this);
        this._flyout.remove_child(container);
        this._box.insert_child_above(container, this._arrow);
    }

    // For the preferences, which cannot see the shell's icons. Written only when a new one shows up.
    _remember(icons) {
        const known = this._settings.get_strv('tray-known');
        const ids = new Set(known.map(entry => entry.split('\t')[0]));
        const fresh = icons.filter(icon => !ids.has(icon.id)).map(icon => `${icon.id}\t${icon.title}`);
        if (fresh.length)
            this._settings.set_strv('tray-known', [...known, ...fresh]);
    }

    _open() {
        this._flyout.show();
        this._place();
        this._arrow.add_style_pseudo_class('checked');
        global.stage.connectObject('captured-event', (stage, event) => this._outside(event), this);
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
        if (!this._flyout.visible)
            return;
        global.stage.disconnectObject(this);
        this._arrow.remove_style_pseudo_class('checked');
        // After the click that closed a menu has been handled.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._flyout?.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        global.stage.disconnectObject(this);
        this._box.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._sorting = true;
        for (const {container, menu} of trayIcons()) {
            if (container.get_parent() === this._flyout)
                this._unhide(container, menu);
        }
        this._arrow.destroy();
        Main.layoutManager.removeChrome(this._flyout);
        this._flyout.destroy();
        this._flyout = null;
    }
}
