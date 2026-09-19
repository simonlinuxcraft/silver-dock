// Thumbnails of an app's windows next to its icon, shown on hover. A plain chrome
// actor, not a menu: it takes no grab, so moving along the dock keeps working.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setVertical} from './compat.js';

const SHOW_DELAY = 400;
const HIDE_DELAY = 250;
const THUMB_WIDTH = 220;
const THUMB_HEIGHT = 140;
const GAP = 8; // px between the icon and the previews
const PEEK_DELAY = 250; // ms on a preview before only its window stays visible
const PEEK_TIME = 200;

export class WindowPreviews {
    // onChange runs whenever the previews appear, vanish or gain or lose the pointer.
    constructor(onChange) {
        this._onChange = onChange;
        this._timers = {};
        this.peek = false; // set by the dock from its settings
        this._peeked = new Set(); // faded window actors, see _peekAt
        this.actor = new St.BoxLayout({style_class: 'silver-dock-previews', reactive: true, track_hover: true, visible: false});
        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                this._stop('hide');
            else
                this._start('hide', HIDE_DELAY, () => this.hide());
            this._onChange();
        });
        Main.layoutManager.addChrome(this.actor);
    }

    get shown() {
        return this.actor.visible;
    }

    get hover() {
        return this.actor.hover;
    }

    get app() {
        return this.shown ? this._app : null;
    }

    // anchor: the icon's button. side: the dock's screen edge as an St.Side.
    hoverIcon(app, anchor, side) {
        this._stop('hide');
        if (this.shown)
            this._open(app, anchor, side);
        else
            this._start('show', SHOW_DELAY, () => this._open(app, anchor, side));
    }

    leaveIcon() {
        this._stop('show');
        if (this.shown && !this.actor.hover)
            this._start('hide', HIDE_DELAY, () => this.hide());
    }

    // Follows windows opening and closing while shown.
    refresh(app) {
        if (this.app === app)
            this._open(app, this._anchor, this._side);
    }

    hide() {
        this._stop('show');
        this._stop('hide');
        this._endPeek();
        if (!this.shown)
            return;
        this.actor.hide();
        this.actor.destroy_all_children();
        this._app = this._anchor = null;
        this._onChange();
    }

    // Off the stage before the children go, see SilverDock.disable().
    destroy() {
        this._stop('show');
        this._stop('hide');
        this._endPeek(true);
        this.actor.get_allocation_box(); // pending relayout, see SilverDock.disable()
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }

    // Only this window stays visible, the others fade out until _endPeek. Desktop
    // icons and docks (skip taskbar) stay. A minimized window has nothing to show.
    _peekAt(win) {
        if (win.minimized) {
            this._endPeek();
            return;
        }
        for (const actor of global.get_window_actors()) {
            const other = actor.meta_window;
            const fade = other !== win && actor.visible && !other.is_skip_taskbar();
            if (fade && !this._peeked.has(actor)) {
                this._peeked.add(actor);
                actor.connectObject('destroy', () => this._peeked.delete(actor), this);
            } else if (!fade && this._peeked.has(actor)) {
                this._restore(actor, false);
            }
            if (fade)
                actor.ease({opacity: 0, duration: PEEK_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _endPeek(immediate = false) {
        this._stop('peek');
        this._stop('unpeek');
        this._peeked.forEach(actor => this._restore(actor, immediate));
    }

    _restore(actor, immediate) {
        actor.disconnectObject(this);
        this._peeked.delete(actor);
        if (immediate) {
            actor.remove_transition('opacity');
            actor.opacity = 255;
        } else {
            actor.ease({opacity: 255, duration: PEEK_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _start(name, delay, fn) {
        this._stop(name);
        this._timers[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timers[name] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop(name) {
        if (this._timers[name])
            GLib.source_remove(this._timers[name]);
        this._timers[name] = 0;
    }

    _open(app, anchor, side) {
        const windows = app.get_windows().filter(win => win.get_compositor_private());
        // The icon's monitor, none while all screens are off.
        const monitor = anchor.get_stage() && Main.layoutManager.findMonitorForActor(anchor);
        // A freshly built icon has no place yet, previews would land somewhere else.
        if (!windows.length || !monitor || !anchor.get_stage() || !anchor.has_allocation()) {
            this.hide();
            return;
        }
        const wasShown = this.shown;
        this._app = app;
        this._anchor = anchor;
        this._side = side;

        const width = Math.min(THUMB_WIDTH, Math.floor(monitor.width * 0.9 / windows.length) - 2 * GAP);
        this.actor.destroy_all_children();
        windows.forEach(win => this.actor.add_child(this._preview(win, width)));
        this.actor.show();

        const [, , natWidth, natHeight] = this.actor.get_preferred_size();
        const [x, y] = anchor.get_transformed_position();
        const [w, h] = anchor.get_transformed_size();
        const [left, top] = {
            [St.Side.BOTTOM]: [x + w / 2 - natWidth / 2, y - natHeight - GAP],
            [St.Side.TOP]: [x + w / 2 - natWidth / 2, y + h + GAP],
            [St.Side.LEFT]: [x + w + GAP, y + h / 2 - natHeight / 2],
            [St.Side.RIGHT]: [x - natWidth - GAP, y + h / 2 - natHeight / 2],
        }[side];
        const clamp = (v, start, length, size) => Math.min(Math.max(v, start + GAP), start + length - size - GAP);
        this.actor.set_position(
            Math.round(clamp(left, monitor.x, monitor.width, natWidth)),
            Math.round(clamp(top, monitor.y, monitor.height, natHeight)));
        if (!wasShown)
            this._onChange();
    }

    _preview(win, width) {
        const box = new St.BoxLayout({width});
        setVertical(box, true);

        const header = new St.BoxLayout({style_class: 'silver-dock-preview-header'});
        const title = new St.Label({style_class: 'silver-dock-preview-title', text: win.get_title() ?? '', x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const close = new St.Button({
            style_class: 'silver-dock-preview-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
        });
        close.connect('clicked', () => win.delete(global.get_current_time()));
        header.add_child(title);
        header.add_child(close);
        box.add_child(header);
        box.add_child(this._thumbnail(win, width));

        const button = new St.Button({style_class: 'silver-dock-preview', child: box});
        // Moving on to the next preview keeps the peek going, only its window changes.
        button.connect('notify::hover', () => {
            if (button.hover && this.peek) {
                this._stop('unpeek');
                this._start('peek', PEEK_DELAY, () => this._peekAt(win));
            } else {
                this._stop('peek');
                this._start('unpeek', 100, () => this._endPeek());
            }
        });
        button.connect('clicked', () => {
            Main.activateWindow(win);
            this.hide();
        });
        return button;
    }

    // The window actor includes invisible borders and shadows, the clip shows only
    // the frame, scaled to fit.
    _thumbnail(win, width) {
        const actor = win.get_compositor_private();
        const frame = win.get_frame_rect();
        const buffer = win.get_buffer_rect();
        const scale = Math.min(width / frame.width, THUMB_HEIGHT / frame.height, 1);
        const clip = new St.Widget({
            width: Math.round(frame.width * scale),
            height: Math.round(frame.height * scale),
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        clip.add_child(new Clutter.Clone({
            source: actor,
            x: Math.round((buffer.x - frame.x) * scale),
            y: Math.round((buffer.y - frame.y) * scale),
            width: Math.round(actor.width * scale),
            height: Math.round(actor.height * scale),
        }));
        return clip;
    }
}
