import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import {setVertical} from './compat.js';

// GNOME's one-line clock as the time over the date. Its label stays and comes back on destroy.
export class TwoLineClock {
    constructor(label, vertical) {
        this._label = label;
        this._vertical = vertical;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wall = new GnomeDesktop.WallClock({time_only: true});
        this._time = new St.Label({style_class: 'silver-dock-time', x_align: Clutter.ActorAlign.CENTER});
        // A step behind the time, St has no opacity in CSS.
        this._date = new St.Label({style_class: 'silver-dock-date', x_align: Clutter.ActorAlign.CENTER, opacity: 190});
        this.actor = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        setVertical(this.actor, true);
        this.actor.add_child(this._time);
        this.actor.add_child(this._date);
        label.get_parent().insert_child_above(this.actor, label);
        label.hide();
        const update = () => this._update();
        this._wall.connectObject('notify::clock', update, this);
        this._iface.connectObject('changed::clock-show-date', update, 'changed::clock-show-weekday', update, this);
        update();
    }

    _update() {
        this._time.text = this._wall.clock.trim();
        this._date.visible = this._iface.get_boolean('clock-show-date');
        // A side bar is too narrow for the weekday.
        const weekday = this._iface.get_boolean('clock-show-weekday') && !this._vertical;
        this._date.text = new Date().toLocaleDateString(undefined,
            {weekday: weekday ? 'short' : undefined, day: 'numeric', month: 'short'});
    }

    destroy() {
        this._wall.disconnectObject(this);
        this._iface.disconnectObject(this);
        this._wall = this._iface = null;
        this.actor.destroy();
        this._label.show();
    }
}
