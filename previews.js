// No menu: a menu grabs the pointer, and moving along the dock would stop working.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setVertical, trustHover} from './compat.js';

const SHOW_DELAY = 400;
const HIDE_DELAY = 250;
const THUMB_WIDTH = 220;
const THUMB_HEIGHT = 140;
const MIN_THUMB = 48;
const GAP = 8;
const PEEK_DELAY = 250;
const PEEK_TIME = 200;
const FADE_TIME = 150;
const MOVE_TIME = 150;
const RISE = 8;

export class WindowPreviews {
    constructor(onChange) {
        this._onChange = onChange;
        this._timers = {};
        this.peek = false;
        this._peeked = new Set();
        // False while fading out.
        this.shown = false;
        this.app = null;
        // The icon it opened from, each dock only answers for its own.
        this.anchor = null;
        this.actor = new St.BoxLayout({style_class: 'silver-dock-previews', reactive: true, track_hover: true, visible: false});
        trustHover(this.actor);
        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                this._stop('hide');
            else
                this._start('hide', HIDE_DELAY, () => this.hide());
            this._onChange();
        });
        Main.layoutManager.addChrome(this.actor);
    }

    hoverIcon(app, anchor, side) {
        this._stop('hide');
        if (this.shown)
            this._open(app, anchor, side);
        else
            this._start('show', SHOW_DELAY, () => this._open(app, anchor, side));
    }

    show(app, anchor, side) {
        this._stop('show');
        this._stop('hide');
        this._open(app, anchor, side);
    }

    leaveIcon() {
        this._stop('show');
        if (this.shown && !this.actor.hover)
            this._start('hide', HIDE_DELAY, () => this.hide());
    }

    refresh(app) {
        if (this.app === app)
            this._open(app, this.anchor, this._side);
    }

    hide() {
        this._stop('show');
        this._stop('hide');
        this._endPeek();
        if (!this.shown)
            return;
        this.shown = false;
        this.actor.reactive = false;
        this.app = this.anchor = null;
        this.actor.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.actor.hide();
                this.actor.destroy_all_children();
            },
        });
        this._onChange();
    }

    // Off the stage before the children go, see Dock.destroy().
    destroy() {
        this._stop('show');
        this._stop('hide');
        this._endPeek(true);
        this.actor.get_allocation_box();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }

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
        // None while all screens are off.
        const monitor = anchor.get_stage() && Main.layoutManager.findMonitorForActor(anchor);
        // A freshly built icon has no place yet.
        if (!windows.length || !monitor || !anchor.has_allocation()) {
            this.hide();
            return;
        }
        const wasShown = this.shown;
        // Still there or fading out: glide over.
        const onScreen = this.actor.visible;
        this.shown = true;
        this.actor.reactive = true;
        this.app = app;
        this.anchor = anchor;
        this._side = side;

        const width = Math.max(MIN_THUMB, Math.min(THUMB_WIDTH, Math.floor(monitor.width * 0.9 / windows.length) - 2 * GAP));
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
        const to = {
            x: Math.round(clamp(left, monitor.x, monitor.width, natWidth)),
            y: Math.round(clamp(top, monitor.y, monitor.height, natHeight)),
        };
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        if (onScreen) {
            if (to.x !== this.actor.x || to.y !== this.actor.y)
                this.actor.ease({...to, duration: MOVE_TIME, mode});
        } else {
            const [dx, dy] = {
                [St.Side.BOTTOM]: [0, RISE],
                [St.Side.TOP]: [0, -RISE],
                [St.Side.LEFT]: [-RISE, 0],
                [St.Side.RIGHT]: [RISE, 0],
            }[side];
            Object.assign(this.actor, {...to, translation_x: dx, translation_y: dy, opacity: 0});
            this.actor.ease({translation_x: 0, translation_y: 0, duration: FADE_TIME, mode});
        }
        if (this.actor.opacity !== 255 || this.actor.get_transition('opacity'))
            this.actor.ease({opacity: 255, duration: FADE_TIME, mode});
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
        trustHover(button);
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

    // Clipped to the frame, the window actor includes shadows and invisible borders.
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
