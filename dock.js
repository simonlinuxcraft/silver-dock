import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {mix, parseColor} from './colors.js';
import {Color, HAS_ACCENT, setVertical} from './compat.js';
import {badgeOf, countText, progressOf} from './launcher.js';
import {dropIndex, hover, rest, STYLES} from './layout.js';
import {TRASH, driveMounts, openPlace, placeActions, placeIcon, placeName} from './places.js';
import {restorePanel, takePanel} from './takeover.js';

// px from the icons to the bar's inner side and to the screen edge (window dots)
const INNER = 6;
const OUTER = 8;
const MAX_DOTS = 4;
const HIDE_DELAY = 400;
const SLIDE_TIME = 200;
const LIFT_TIME = 300;
const WIGGLE_EVERY = 2500;
const MOVE_TIME = 150;
// with the panel buttons' 8 px padding this gives 12 px beside every separator
const EDGE = 4;
const SEP_MARGIN = 4;
const MIN_ICON = 16;
const POP_TIME = 350;
const DOT = 5;
const DOT_LONG = 12;
const BUTTON_LIFT = 3;
const WARP_LIFT = 5;
const SCROLL_PAUSE = 150;
const FADE_TIME = 120;
// longer than WIGGLE_EVERY, so a waiting wiggle still shows
const REVEAL_TIME = 3000;
// px the hidden background moves beyond the edge, its shadow with it
const SHADOW = 16;
// like GNOME's hot corner: px of push within ms
const PRESSURE = 100;
const PRESSURE_TIMEOUT = 1000;
const POOF_TIME = 400;
const PUFFS = 7;

const SIDES = {bottom: St.Side.BOTTOM, top: St.Side.TOP, left: St.Side.LEFT, right: St.Side.RIGHT};
// "r, g, b", the opacity setting adds the alpha
export const COLORS = {bg: '28, 29, 33', fg: '235, 237, 242', border: '1px solid rgba(214, 218, 226, 0.3)'};

// No ease for values already there: every ease keeps the compositor busy.
function settle(actor, props, immediate, params) {
    const busy = key => actor.get_transition(key.replaceAll('_', '-'));
    if (immediate) {
        Object.keys(props).forEach(key => busy(key) && actor.remove_transition(key.replaceAll('_', '-')));
        Object.assign(actor, props);
    } else if (Object.entries(props).some(([key, value]) => busy(key) || actor[key] !== value)) {
        actor.ease({...props, ...params});
    }
}

function setClass(actor, name, on) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

function findActor(actor, test) {
    if (test(actor))
        return actor;
    for (const child of actor.get_children()) {
        const found = findActor(child, test);
        if (found)
            return found;
    }
    return null;
}

function rocketOf(button) {
    return button?.has_style_class_name('arcmenu-panel-menu')
        ? findActor(button, actor => actor instanceof St.Icon && actor.has_style_class_name('arcmenu-menu-button'))
        : null;
}

function resetRocket(rocket) {
    settle(rocket, {translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255}, true);
    rocket.set_pivot_point(0, 0);
}

// One bar on one monitor. "along" runs with the icon row, "across" from the bar's
// inner side to the screen edge, _xy() maps them to x and y.
export class Dock {
    constructor(ext, monitorIndex, primary, intro) {
        this._ext = ext;
        this._settings = ext.settings;
        this._previews = ext.previews;
        this.monitorIndex = monitorIndex;
        this._primary = primary;
        this._items = [];
        this._laters = {};
        this._pointer = 0;
        this._hidden = false;
        this._gaps = [];
        this._restWidth = 0;
        this._centers = [];
        this._dropIndex = null;
        this._dragging = false;
        this._intro = intro;
        this._hovered = null;
        this._keyFocus = null;

        this._bg = new St.Widget({style_class: 'silver-dock-bg'});
        // X11 only sends the pointer to tracked chrome, this covers the magnified icons.
        this._reach = new St.Widget({visible: false});
        // Named like the top bar, the moved panel buttons keep their theme styling.
        this._bar = new St.BoxLayout({name: 'panel', style_class: 'silver-dock', reactive: true, track_hover: true});
        this._row = new St.Widget({reactive: true, track_hover: true});
        this._label = new St.Label({style_class: 'dash-label', visible: false});
        this._seps = [this._separator(), this._separator()];
        [this._seps[0], this._row, this._seps[1]].forEach(actor => this._bar.add_child(actor));
        this._boxes = [];
        this._panelOk = true;
        this._rowSeps = [this._separator(), this._separator()];
        this._rowSeps.forEach(sep => this._row.add_child(sep));
        this._bounds = [0, 0];
        this._row._delegate = {
            handleDragOver: (source, actor, x, y) => this._dragOver(source, this._vertical ? y : x),
            acceptDrop: source => this._acceptDrop(source),
        };
        this._menuManager = new PopupMenu.PopupMenuManager(this._bar);

        this._amount = new St.Adjustment({actor: this._row, lower: 0, upper: 1});
        this._amount.connectObject('notify::value', () => this._animate(), this);

        this._row.connectObject(
            'notify::hover', () => {
                this._easeAmount();
                // A very short visit may not move the amount at all.
                this._animate();
            },
            'motion-event', (actor, event) => {
                const [, x, y] = actor.transform_stage_point(...event.get_coords());
                this._pointer = this._vertical ? y : x;
                this._animate();
                return Clutter.EVENT_PROPAGATE;
            }, this);
        // Moving the bar mid layout pass leaves it unallocated for a frame.
        this._bar.connectObject(
            'notify::width', () => this.queuePlace(),
            'notify::height', () => this.queuePlace(),
            'notify::hover', () => {
                this._reach.visible = this._bar.hover;
                if (!this._bar.hover)
                    this._hoverButton(null);
                this._updateAutohide();
            },
            'captured-event', (actor, event) => this._barEvent(event),
            // Only on a free spot, GNOME 46's top bar buttons pass their clicks on.
            'button-press-event', (actor, event) => {
                const target = global.stage.get_event_actor(event);
                if (event.get_button() !== Clutter.BUTTON_SECONDARY || (target !== this._bar && target !== this._row))
                    return Clutter.EVENT_PROPAGATE;
                this._openDockMenu(event.get_coords());
                return Clutter.EVENT_STOP;
            },
            // Only GNOME's teardown at logout, destroy() disconnects first.
            'destroy', () => ext.lost(), this);

        Main.layoutManager.addChrome(this._bg, {trackFullscreen: true});
        this.trackBar();
        Main.layoutManager.addChrome(this._label);
        Main.layoutManager.addChrome(this._reach);
        if (primary)
            Main.ctrlAltTabManager.addGroup(this._bar, _('Dock'), 'shell-focus-top-bar-symbolic');
    }

    destroy() {
        this.stopListening();
        // ArcMenu's actors, left as they were.
        this._hoverButton(null, true);
        this._rocket?.disconnectObject(this);
        if (this._rocket)
            resetRocket(this._rocket);
        this._amount.remove_transition('value');

        // Off the stage before any child changes, or Clutter relayouts the destroyed bar.
        if (this._primary)
            Main.ctrlAltTabManager.removeGroup(this._bar);
        const actors = [this._bar, this._bg, this._label, this._reach];
        // Clutter may queue a chrome actor twice for relayout but drops one entry on
        // leaving the stage, asking for the allocation runs that relayout now.
        actors.forEach(actor => actor.get_stage() && actor.get_allocation_box());
        actors.forEach(actor => actor.get_parent() && Main.layoutManager.removeChrome(actor));
        this._items.forEach(item => this._destroyItem(item));
        this._dockMenu?.destroy();
        // The panel boxes would die with the bar.
        restorePanel(this._bar, this._boxes);
        this._undress();
        actors.forEach(actor => actor.destroy());
    }

    // Also at logout, when GNOME destroys the bar without disabling the extension.
    stopListening() {
        this._row.disconnectObject(this);
        this._bar.disconnectObject(this);
        this._amount.disconnectObject(this);
        Object.values(this._laters).forEach(id => id && global.compositor.get_laters().remove(id));
        this._laters = {};
        if (this._hideTimer)
            GLib.source_remove(this._hideTimer);
        if (this._wiggleTimer)
            GLib.source_remove(this._wiggleTimer);
        if (this._revealTimer)
            GLib.source_remove(this._revealTimer);
        this._hideTimer = this._wiggleTimer = this._revealTimer = 0;
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
        this._removeBarrier();
    }

    _undress() {
        if (!this._dressed)
            return;
        Main.panel.set_style(this._panelStyle);
        Main.panel.remove_style_class_name('silver-dock-ink');
        Main.panel.remove_style_class_name('silver-dock-shadow');
        this._dressed = false;
    }

    paint() {
        const margin = this._settings.get_int('margin');
        const radius = this._settings.get_int('radius');
        const mode = this._settings.get_string('colors');
        const themed = mode === 'theme';
        const own = mode === 'custom' && parseColor(this._settings.get_string('color'));
        let colors = themed ? this._ext.themeColors() : COLORS;
        let ink = false;
        if (own) {
            // Border and separators lighter, or darker on a light color, for contrast.
            const light = own.split(',').reduce((sum, c, i) => sum + c * [0.299, 0.587, 0.114][i], 0) > 150;
            const shade = mix(own, light ? '0, 0, 0' : '255, 255, 255', 0.6);
            colors = {bg: own, fg: shade, border: `1px solid rgba(${shade}, 0.5)`};
            ink = light && this._settings.get_int('opacity') >= 50;
        }
        const tint = this._settings.get_boolean('tint-icons') && parseColor(this._settings.get_string('icon-color'));
        const [red, green, blue] = tint ? tint.split(',').map(Number) : [];
        this._tint = tint ? new Color({red, green, blue, alpha: 255}) : null;
        setClass(this._bar, 'silver-dock-ink', ink);
        const opacity = themed ? colors.alpha : this._settings.get_int('opacity') / 100;
        this._geom.opacity = opacity;
        this._accent = colors.accent ?? null;
        // The stylesheet's system accent needs GNOME 47.
        setClass(this._bar, 'themed', themed && HAS_ACCENT);
        const shadow = this._settings.get_boolean('shadow');
        setClass(this._bg, 'silver-dock-shadow', shadow);

        if (this._primary && this._ownTopBar && this._settings.get_boolean('style-top-bar')) {
            if (!this._dressed) {
                this._panelStyle = Main.panel.get_style();
                this._dressed = true;
            }
            Main.panel.set_style(`margin: ${margin}px ${margin}px 0; ` +
                `background-color: rgba(${colors.bg}, ${opacity}); border: ${colors.border}; ` +
                `border-radius: ${radius}px;`);
            setClass(Main.panel, 'silver-dock-ink', ink);
            setClass(Main.panel, 'silver-dock-shadow', shadow);
        } else {
            this._undress();
        }

        // Opacity on the actor, so dynamic opacity can ease it.
        this._bg.set_style(`border-radius: ${radius}px; background-color: rgb(${colors.bg}); border: ${colors.border};`);
        this._bg.remove_transition('opacity');
        this._bg.opacity = this._bgOpacity = Math.round(255 * opacity);
        for (const sep of [...this._seps, ...this._rowSeps])
            sep.set_style(`background-color: rgba(${colors.fg}, 0.25);`);
        this._items.forEach(item => {
            item.fill.set_style(this._accent && `background-color: rgb(${this._accent});`);
            this._tintIcon(item.icon);
        });
        this.updateDots();
        this.queueCheck();
    }

    _separator() {
        return new St.Widget({
            style_class: 'silver-dock-separator',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _xy(along, across) {
        return this._vertical ? [across, along] : [along, across];
    }

    // Both axes: after a position change the old offset sits on the other one.
    _resetSlide() {
        this._hidden = false;
        for (const actor of [this._bar, this._bg]) {
            actor.remove_transition('translation-x');
            actor.remove_transition('translation-y');
            actor.translation_x = actor.translation_y = 0;
        }
    }

    trackBar() {
        // Struts follow the transformed position, a slid out bar would reserve 1 px.
        this._resetSlide();
        const params = {affectsStruts: !this._settings.get_boolean('autohide'), trackFullscreen: true};
        // Taking the bar off stage would reset hover and menus.
        if (this._bar.get_parent()) {
            Main.layoutManager.untrackChrome(this._bar);
            Main.layoutManager.trackChrome(this._bar, params);
        } else {
            Main.layoutManager.addChrome(this._bar, params);
        }
    }

    // refit: a bar shrunk to fit tries the set size again.
    refresh(refit = false) {
        if (refit)
            this._fitIcon = null;
        // Before the axes change, a lifted button drops on the axis it rose on.
        this._hoverButton(null, true);
        const icon = Math.min(this._settings.get_int('icon-size'), this._fitIcon ?? Infinity);
        const zoom = this._settings.get_double('zoom');
        const margin = this._settings.get_int('margin');
        const radius = this._settings.get_int('radius');

        this._style = this._settings.get_string('animation');
        this._position = this._settings.get_string('position');
        this._side = SIDES[this._position];
        this._vertical = this._position === 'left' || this._position === 'right';
        this._edgeFirst = this._position === 'top' || this._position === 'left';
        this._dir = this._edgeFirst ? 1 : -1;
        this._along = this._vertical ? 'translation_y' : 'translation_x';
        this._across = this._vertical ? 'translation_x' : 'translation_y';
        this._geom = {
            icon,
            zoom,
            margin,
            opacity: 1,
            slot: icon + Math.round(icon / 5),
            big: Math.round(icon * zoom), // rendered at full zoom and scaled down, stays sharp
            thick: INNER + icon + OUTER,
        };

        // The strut needs the bar on the screen edge, the gap is padding.
        const end = Math.round(radius / 2) + 4;
        this._bar.set_style({
            bottom: `padding: 0 ${end}px ${margin}px;`,
            top: `padding: ${margin}px ${end}px 0;`,
            left: `padding: ${end}px 0 ${end}px ${margin}px;`,
            right: `padding: ${end}px ${margin}px ${end}px 0;`,
        }[this._position]);
        setVertical(this._bar, this._vertical);
        setClass(this._bar, 'vertical', this._vertical);
        this._bar.set_size(-1, -1);
        if (this._vertical)
            this._bar.width = this._geom.thick + margin;
        else
            this._bar.height = this._geom.thick + margin;
        this._ownTopBar = this._vertical ||
            (this._position === 'bottom' && this._settings.get_boolean('keep-top-bar'));
        const wantPanel = this._primary && !this._ownTopBar && this._panelOk;
        if (wantPanel && !this._boxes.length) {
            this._boxes = takePanel(this._bar, this._seps[0], this._seps[1]);
            this._panelOk = this._boxes.length > 0;
        } else if (!wantPanel && this._boxes.length) {
            restorePanel(this._bar, this._boxes);
            this._boxes = [];
        }
        for (const key of ['lift-buttons', 'warp', 'glide'])
            setClass(this._bar, key, this._settings.get_boolean(key));
        // Opens to the old side otherwise.
        this._dockMenu?.destroy();
        this._dockMenu = null;
        this.paint();
        const sepSize = this._xy(1, Math.round(icon * 0.6));
        for (const sep of [...this._seps, ...this._rowSeps])
            sep.set_size(...sepSize);
        for (const sep of this._seps) {
            sep.visible = this._settings.get_boolean('separators') && this._boxes.length > 0;
            [sep.margin_left, sep.margin_right, sep.margin_top, sep.margin_bottom] = this._vertical
                ? [0, 0, SEP_MARGIN, SEP_MARGIN] : [SEP_MARGIN, SEP_MARGIN, 0, 0];
        }
        this._resetSlide();
        for (const actor of [...this._boxes, ...this._seps, ...this._rowSeps])
            actor.translation_x = actor.translation_y = 0;

        this._items.forEach(item => this._destroyItem(item));
        this._items = [];
        this.sync();
        this.queueCheck();
        // The barrier follows settings that leave the bar's size alone.
        this.queuePlace();
    }

    // Keeps existing icons, a rebuild would close their open menus.
    sync() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favIds = new Set(favorites.map(app => app.get_id()));
        const pos = new Map(this._items.map((item, i) => [item.key, i]));
        const last = this._items.length;
        const running = Shell.AppSystem.get_default().get_running()
            .filter(app => !favIds.has(app.get_id()))
            .sort((a, b) => (pos.get(a) ?? last) - (pos.get(b) ?? last));
        const places = [
            ...this._settings.get_boolean('trash') ? [TRASH] : [],
            ...driveMounts(this._ext.volumes, this._settings.get_boolean('drives'),
                this._settings.get_boolean('internal-drives')),
        ];

        // Not on a rebuild, every icon would pop.
        const pop = this._settings.get_boolean('pop') && this._items.length > 0;
        const prev = this._items;
        // A shrinking icon comes back when its app does, a live one wins.
        const old = new Map([...prev.filter(item => item.leaving), ...prev.filter(item => !item.leaving)]
            .map(item => [item.key, item]));
        const sections = [favorites, running, places];
        const items = sections.flatMap((keys, section) => keys.map(key => {
            let item = old.get(key);
            if (item?.leaving) {
                item.leaving = false;
                item.button.reactive = true;
                // Replaces the shrink, whose onComplete then never comes.
                this._popIn(item, false);
            } else if (!item) {
                item = this._createItem(key);
                if (pop)
                    this._popIn(item);
            }
            old.delete(key);
            item.section = section;
            return item;
        }));
        const gone = [...old.values()].filter(item => !item.leaving);
        for (const item of gone) {
            if (pop)
                item.leaving = true;
            else
                this._destroyItem(item);
        }
        // Shrinking icons stay behind their old neighbour.
        prev.forEach((item, i) => {
            if (!item.leaving)
                return;
            const before = prev.slice(0, i).reverse().find(other => items.includes(other));
            items.splice(before ? items.indexOf(before) + 1 : 0, 0, item);
        });
        this._items = items;

        const separators = this._settings.get_boolean('separators');
        const start = section => {
            const i = items.findIndex(item => item.section >= section);
            return i < 0 ? items.length : i;
        };
        this._bounds = [start(1), start(2)];
        this._rowSeps.forEach((sep, i) => {
            const at = this._bounds[i];
            sep.visible = separators && at > 0 && at < items.length && (i === 1 || this._bounds[1] > this._bounds[0]);
        });

        this._layout();
        if (this._intro && this._settings.get_boolean('intro'))
            this._wave();
        this._intro = false;
        this.updateDots();
        this.updateBadges();
        this._animate();
        // Last: without animations the ease ends at once and syncs again.
        if (pop)
            gone.forEach(item => this._popOut(item));
    }

    _popIn({icon}, fromNothing = true) {
        if (fromNothing)
            icon.set_scale(0, 0);
        icon.ease({scale_x: 1, scale_y: 1, duration: POP_TIME, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    _popOut(item) {
        item.button.reactive = false;
        this._hideLabel(item);
        if (item.app && this._previews.app === item.app)
            this._previews.hide();
        item.icon.ease({
            scale_x: 0,
            scale_y: 0,
            duration: POP_TIME * 0.7,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._items = this._items.filter(other => other !== item);
                this._destroyItem(item);
                this.sync();
            },
        });
    }

    _wave() {
        const {big} = this._geom;
        this._items.forEach(({icon}, i) => {
            icon[this._across] = -this._dir * big;
            icon.opacity = 0;
            const delay = i * 40;
            icon.ease({[this._across]: 0, delay, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            icon.ease({opacity: 255, delay, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    _squash({icon}) {
        const [x, y] = this._xy(1.15, 0.8);
        const [along, across] = this._xy('scale_x', 'scale_y');
        icon.ease({
            scale_x: x,
            scale_y: y,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // No overshoot below 1 along the bar, it would take the neighbours' room.
                icon.ease({[along]: 1, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                icon.ease({[across]: 1, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            },
        });
    }

    _tintIcon(icon) {
        icon.remove_effect_by_name('silver-dock-tint');
        if (this._tint)
            icon.add_effect_with_name('silver-dock-tint', new Clutter.ColorizeEffect({tint: this._tint}));
        return icon;
    }

    _createItem(key) {
        const {icon: size, big, slot} = this._geom;
        const app = key instanceof Shell.App ? key : null;
        const name = app ? app.get_name() : placeName(key);
        const icon = app ? app.create_icon_texture(big) : placeIcon(key, big, this._ext.trash?.full);
        icon.set_pivot_point(0.5, 0.5);
        this._tintIcon(icon);

        const font = Math.max(10, Math.round(size / 3));
        const badge = new St.Label({
            style_class: 'silver-dock-badge',
            style: `font-size: ${font}px; min-width: ${Math.round(font * 1.1)}px; border-radius: ${font}px;`,
            visible: false,
        });
        const progress = new St.Widget({
            style_class: 'silver-dock-progress',
            height: Math.max(3, Math.round(size * 0.1)),
            visible: false,
        });
        const fill = new St.Widget({style_class: 'silver-dock-progress-fill'});
        if (this._accent)
            fill.set_style(`background-color: rgb(${this._accent});`);
        progress.add_child(fill);

        const button = new St.Button({
            style_class: 'silver-dock-app',
            style: `border-radius: ${Math.round(big / 4)}px;`,
            child: icon,
            accessible_name: name,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            width: big,
            height: big,
        });
        button.set_pivot_point(...this._xy(0.5, this._edgeFirst ? 0 : 1));

        const dots = new St.BoxLayout({
            style_class: 'silver-dock-dots',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setVertical(dots, this._vertical);
        // Named to tell its warnings from GNOME's own containers, see smoke.sh.
        const indicator = new St.Bin({name: 'silver-dock-indicator', child: dots});
        indicator.set_size(...this._xy(slot, -1));

        const item = {key, app, name, icon, badge, progress, fill, fraction: 0, button, indicator, dots, menu: null, room: 1};
        badge.set_pivot_point(0.5, 0.5);
        // room: share of its slot the icon takes, a popping icon pushes its neighbours aside.
        const along = this._vertical ? 'scale_y' : 'scale_x';
        icon.connect(`notify::${along.replace('_', '-')}`, () => {
            const room = Math.min(1, icon[along]);
            if (room === item.room)
                return;
            item.room = room;
            this._queue('room', () => {
                this._layout();
                this._place();
            });
        });
        button.connect('clicked', (b, mouseButton) => {
            if (this._settings.get_boolean('squash'))
                this._squash(item);
            this._hideLabel(item);
            this._previews.hide();
            if (mouseButton === 3)
                this._openMenu(item);
            else if (app)
                this._activate(app, mouseButton);
            else
                openPlace(key);
        });
        button.connect('scroll-event', (actor, event) => this._scroll(item, event));
        // Menu key or Shift+F10
        button.connect('popup-menu', () => this._openMenu(item));
        button.connect('key-focus-in', () => this._focusItem(item));
        button.connect('key-focus-out', () => this._focusItem(null));
        button.connect('notify::hover', () => {
            if (button.hover) {
                if (app && this._settings.get_boolean('previews') && !this._dragging && !this._menuOpen())
                    this._previews.hoverIcon(app, button, this._side);
                this._showLabel(item);
            } else {
                this._hideLabel(item);
                this._previews.leaveIcon();
            }
        });
        app?.connectObject('windows-changed', () => {
            this.updateDots();
            this._previews.refresh(app);
        }, button);
        if (app && this._settings.get_boolean('dnd'))
            this._makeDraggable(item);

        [button, indicator, progress, badge].forEach(actor => this._row.add_child(actor));
        return item;
    }

    _destroyItem(item) {
        this._hideLabel(item);
        if (item.app && this._previews.app === item.app)
            this._previews.hide();
        item.menu?.destroy();
        [item.button, item.indicator, item.progress, item.badge].forEach(actor => actor.destroy());
    }

    _layout(animate = false) {
        const {icon, big, slot, thick} = this._geom;
        const n = this._items.length;
        const sepGap = Math.round(slot * 0.4);
        const gaps = new Array(n + 1).fill(0);
        gaps[0] += EDGE;
        gaps[n] += EDGE;
        this._rowSeps.forEach((sep, i) => {
            if (sep.visible)
                gaps[this._bounds[i]] += sepGap;
        });
        this._items.forEach(({room}, i) => {
            gaps[i] -= (1 - room) * slot / 2;
            gaps[i + 1] -= (1 - room) * slot / 2;
        });
        this._restNoDrop = rest(n, slot, gaps);
        if (this._dropIndex !== null)
            gaps[this._dropIndex] += slot;
        this._gaps = gaps;
        const {centers, width} = rest(n, slot, gaps);
        this._centers = centers;
        this._restWidth = width;

        const move = (actor, along, across) => {
            const [x, y] = this._xy(Math.round(along), Math.round(across));
            if (animate) {
                actor.ease({x, y, duration: MOVE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                actor.remove_transition('x');
                actor.remove_transition('y');
                actor.set_position(x, y);
            }
        };
        this._items.forEach((item, i) => {
            move(item.button, centers[i] - big / 2, this._edgeFirst ? OUTER : INNER + icon - big);
            move(item.indicator, centers[i] - slot / 2, this._edgeFirst ? OUTER - 7 : INNER + icon + 2);
        });
        this._rowSeps.forEach((sep, i) => {
            const at = this._bounds[i];
            if (at > 0 && at < n)
                move(sep, centers[at] - slot / 2 - gaps[at] + sepGap / 2, (this._edgeFirst ? OUTER : INNER) + icon * 0.2);
        });
        this._row.set_size(...this._xy(width, thick));
        this._animate();
    }

    updateDots() {
        const focused = Shell.WindowTracker.get_default().focus_app;
        const glide = this._settings.get_boolean('glide');
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        for (const {app, dots} of this._items) {
            const n = app?.state === Shell.AppState.RUNNING
                ? Math.min(Math.max(app.get_n_windows(), 1), MAX_DOTS) : 0;
            const size = this._xy(app === focused ? DOT_LONG : DOT, DOT);
            const changed = dots.has_style_class_name('focused') !== (app === focused);
            while (dots.get_n_children() > n)
                dots.get_last_child().destroy();
            while (dots.get_n_children() < n) {
                const dot = new St.Widget({style_class: 'silver-dock-dot'});
                dot.set_size(...size);
                if (glide) {
                    dot.opacity = 0;
                    dot.ease({opacity: 255, duration: 250, mode});
                }
                dots.add_child(dot);
            }
            dots.style_class = app === focused ? 'silver-dock-dots focused' : 'silver-dock-dots';
            const color = this._accent && `background-color: rgba(${this._accent}, ${app === focused ? 1 : 0.55});`;
            dots.get_children().forEach(dot => dot.set_style(color || null));
            if (!changed)
                continue;
            for (const dot of dots.get_children()) {
                if (glide)
                    dot.ease({width: size[0], height: size[1], duration: 250, mode});
                else
                    dot.set_size(...size);
            }
        }
    }

    onAppState(app) {
        this.sync();
        if (app.state === Shell.AppState.STARTING && this._settings.get_boolean('bounce'))
            this._bounce(this._items.find(item => item.app === app && !item.leaving));
    }

    updateBadges() {
        const shown = this._settings.get_boolean('badges');
        for (const item of this._items) {
            const entry = shown && item.app ? this._ext.launcher?.get(item.app.get_id()) : null;
            // An app's own count knows better than its notifications.
            const notes = shown && item.app && this._settings.get_boolean('notification-badges')
                ? this._ext.notifications?.get(item.app.get_id()) : 0;
            const text = badgeOf(entry) ?? countText(notes);
            // Not on the first update, a rebuild would pop every badge.
            if (item.badgeText !== undefined && text !== null && text !== item.badgeText &&
                this._settings.get_boolean('badge-pop')) {
                item.badge.set_scale(0.3, 0.3);
                item.badge.ease({scale_x: 1, scale_y: 1, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
            item.badgeText = text;
            item.badge.visible = text !== null;
            item.badge.text = text ?? '';
            const fraction = progressOf(entry);
            item.progress.visible = fraction !== null;
            item.fraction = fraction ?? 0;
        }
        this.updateAttention();
        this._animate();
    }

    // Next to the scaled button, not in it: text scaled down from the big rendering blurs.
    _placeExtras(item, center, scale) {
        const {icon} = this._geom;
        const size = icon * scale;
        const across = this._edgeFirst ? OUTER : INNER + icon - size;
        const [x, y] = this._xy(center - size / 2, across);
        const {badge, progress, fill} = item;
        if (badge.visible)
            badge.set_position(Math.round(x + size - badge.width * 0.8), Math.round(y - badge.height * 0.2));
        if (progress.visible) {
            const inset = Math.round(size * 0.12);
            const width = Math.round(size - 2 * inset);
            progress.set_position(Math.round(x + inset), Math.round(y + size - progress.height - inset / 2));
            progress.width = width;
            fill.set_size(Math.round(item.fraction * width), progress.height);
        }
    }

    updateTrash() {
        const item = this._items.find(i => i.key === TRASH);
        if (item)
            item.icon.icon_name = this._ext.trash?.full ? 'user-trash-full' : 'user-trash';
    }

    // The icon inside the button moves, the button carries the hover transform.
    _bounce(item) {
        const icon = item?.icon;
        if (!icon || icon.get_transition(this._across.replace('_', '-')))
            return;
        icon.ease({
            [this._across]: this._dir * Math.round(this._geom.big * 0.4),
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            repeatCount: 5,
            autoReverse: true,
        });
    }

    // Bursts and pauses: an ease disables direct scanout (fullscreen games).
    updateAttention() {
        const enabled = this._settings.get_boolean('attention');
        let fresh = false;
        for (const item of this._items) {
            const was = item.attention;
            item.attention = enabled && Boolean(item.app) &&
                (Boolean(this._ext.launcher?.get(item.app.get_id())?.urgent) ||
                 item.app.get_windows().some(win => win.demands_attention || win.urgent));
            fresh ||= item.attention && !was;
        }
        // Before the wiggle, which a hidden bar skips.
        if (fresh && this._settings.get_boolean('autohide'))
            this._reveal();
        const wanted = this._items.some(item => item.attention);
        if (wanted && !this._wiggleTimer) {
            this._wiggle();
            this._wiggleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WIGGLE_EVERY, () => {
                this._wiggle();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._wiggleTimer) {
            GLib.source_remove(this._wiggleTimer);
            this._wiggleTimer = 0;
        }
    }

    _wiggle() {
        if (!this._bar.visible || this._hidden)
            return;
        const mode = Clutter.AnimationMode.EASE_IN_OUT_SINE;
        for (const {attention, icon} of this._items) {
            if (!attention || icon.get_transition('rotation-angle-z'))
                continue;
            icon.ease({
                rotation_angle_z: -8, duration: 60, mode, onComplete: () => icon.ease({
                    rotation_angle_z: 8, duration: 120, mode, repeatCount: 4, autoReverse: true,
                    onComplete: () => icon.ease({rotation_angle_z: 0, duration: 60, mode}),
                }),
            });
        }
    }

    // An autohidden bar shows for a moment.
    _reveal() {
        if (this._revealTimer)
            GLib.source_remove(this._revealTimer);
        this._revealTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_TIME, () => {
            this._revealTimer = 0;
            this._updateAutohide();
            return GLib.SOURCE_REMOVE;
        });
        this._updateAutohide();
    }

    // Fades in only from hidden, moving between icons it just follows.
    _showLabel(item) {
        if (!this._settings.get_boolean('tooltips') || this._hidden || this._dragging || this._menuOpen() ||
            this._previews.shown)
            return;
        this._labelItem = item;
        this._label.text = item.name;
        if (!this._label.visible) {
            this._label.opacity = 0;
            this._label.show();
        }
        settle(this._label, {opacity: 255}, false, {duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._placeLabel();
    }

    _hideLabel(item) {
        if ((item && item !== this._labelItem) || !this._label.visible)
            return;
        this._labelItem = null;
        this._label.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._label.hide(),
        });
    }

    _placeLabel() {
        const button = this._labelItem?.button;
        if (!button)
            return;
        const [x, y] = button.get_transformed_position();
        const [w, h] = button.get_transformed_size();
        // Where an eased lift ends up.
        const lift = this._labelItem.lift;
        const pending = lift === undefined ? 0 : this._dir * lift - button[this._across];
        const [dx, dy] = this._xy(0, pending);
        const {width: lw, height: lh} = this._label;
        const [lx, ly] = {
            [St.Side.BOTTOM]: [x + (w - lw) / 2, y + dy - lh - 6],
            [St.Side.TOP]: [x + (w - lw) / 2, y + dy + h + 6],
            [St.Side.LEFT]: [x + dx + w + 6, y + (h - lh) / 2],
            [St.Side.RIGHT]: [x + dx - lw - 6, y + (h - lh) / 2],
        }[this._side];
        this._label.set_position(Math.round(lx), Math.round(ly));
    }

    _openMenu(item) {
        this._previews.hide();
        if (!item.menu) {
            if (item.app) {
                item.menu = new AppMenu(item.button, this._side, {favoritesSection: true, showSingleWindows: true});
                item.menu.setApp(item.app);
            } else {
                item.menu = new PopupMenu.PopupMenu(item.button, 0.5, this._side);
                placeActions(item.key).forEach(([label, action]) => item.menu.addAction(label, action));
            }
            Main.uiGroup.add_child(item.menu.actor);
            this._menuManager.addMenu(item.menu);
        }
        item.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    // Points at the click.
    _openDockMenu([x, y]) {
        if (!this._dockMenu) {
            this._dockMenu = new PopupMenu.PopupMenu(this._bar, 0.5, this._side);
            this._dockMenu.addAction(_('Dock Settings'), () => this._ext.openPreferences());
            Main.uiGroup.add_child(this._dockMenu.actor);
            this._dockMenu.actor.hide();
            this._menuManager.addMenu(this._dockMenu);
        }
        // Relative to the content box, like the BoxPointer.
        const box = this._bar.get_theme_node().get_content_box(this._bar.get_allocation_box());
        const [bx, by] = this._bar.get_transformed_position();
        this._dockMenu.setSourceAlignment(this._vertical
            ? (y - by - box.y1) / box.get_height()
            : (x - bx - box.x1) / box.get_width());
        this._hideLabel();
        this._previews.hide();
        this._dockMenu.open(BoxPointer.PopupAnimation.FULL);
    }

    // Keyboard focus (Ctrl+Alt+Tab) magnifies like the pointer.
    _focusItem(item) {
        const was = this._keyFocus;
        this._keyFocus = item;
        if (item) {
            this._pointer = this._centers[this._items.indexOf(item)] ?? this._pointer;
            this._updateAutohide();
            this._showLabel(item);
        } else {
            this._hideLabel(was);
        }
        // Later: focus also leaves while items are destroyed, and without animations
        // the ease runs _animate() at once.
        this._queue('focus', () => {
            this._easeAmount();
            this._animate();
        });
    }

    _easeAmount() {
        this._amount.ease(this._row.hover || this._keyFocus ? 1 : 0, {
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Stable order, so each step goes on from the window the last one raised.
    _scroll({app}, event) {
        const step = {
            [Clutter.ScrollDirection.UP]: -1,
            [Clutter.ScrollDirection.LEFT]: -1,
            [Clutter.ScrollDirection.DOWN]: 1,
            [Clutter.ScrollDirection.RIGHT]: 1,
        }[event.get_scroll_direction()];
        if (!app || !step || !this._settings.get_boolean('scroll'))
            return Clutter.EVENT_PROPAGATE;
        const now = GLib.get_monotonic_time();
        if (now - (this._scrolled ?? 0) < SCROLL_PAUSE * 1000)
            return Clutter.EVENT_STOP;
        this._scrolled = now;
        const windows = app.get_windows().sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        if (!windows.length)
            return Clutter.EVENT_STOP;
        const at = windows.indexOf(global.display.focus_window);
        const next = at < 0 ? (step > 0 ? 0 : windows.length - 1) : (at + step + windows.length) % windows.length;
        this._previews.hide();
        Main.activateWindow(windows[next]);
        return Clutter.EVENT_STOP;
    }

    // Focused app: one window minimizes, several cycle.
    _activate(app, mouseButton) {
        if (mouseButton === 2) {
            app.open_new_window(-1);
            return;
        }
        const windows = app.get_windows();
        if (!windows.length || Shell.WindowTracker.get_default().focus_app !== app)
            app.activate();
        else if (windows.length === 1)
            windows[0].minimize();
        else
            Main.activateWindow(windows[windows.length - 1]);
    }

    _queue(key, fn) {
        this._laters[key] ||= global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laters[key] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    queuePlace() {
        this._queue('place', () => this._place());
    }

    queueCheck() {
        this._queue('check', () => {
            this._updateOpacity();
            this._updateAutohide();
        });
    }

    queueAttention() {
        this._queue('attention', () => this.updateAttention());
    }

    iconRect(app) {
        const button = this._items.find(item => item.app === app && !item.leaving)?.button;
        if (!button?.get_stage())
            return null;
        const [x, y] = button.get_transformed_position();
        const [width, height] = button.get_transformed_size();
        return new Mtk.Rectangle({
            x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
        });
    }

    previewsChanged() {
        if (this._previews.shown)
            this._hideLabel();
        this._updateAutohide();
    }

    _place() {
        const m = Main.layoutManager.monitors[this.monitorIndex];
        if (!m)
            return;

        const area = this._vertical ? Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex) : m;
        const [w, h] = this._bar.get_size();
        if (this._fit(this._vertical ? h : w, this._vertical ? area.height : m.width))
            return;
        const centerX = m.x + Math.round((m.width - w) / 2);
        const centerY = area.y + Math.round((area.height - h) / 2);
        this._bar.set_position(...{
            bottom: [centerX, m.y + m.height - h],
            top: [centerX, m.y],
            left: [m.x, centerY],
            right: [m.x + m.width - w, centerY],
        }[this._position]);
        this._updateBarrier();
        this._animate();
        this._updateOpacity();
        this._updateAutohide();
    }

    // Pushing against the edge shows the hidden bar, passing by does not. Not on an edge
    // shared with another monitor, the barrier would block the way over.
    _updateBarrier() {
        const m = Main.layoutManager.monitors[this.monitorIndex];
        const [along, length] = this._barAxes();
        const edge = {bottom: m.y + m.height, top: m.y, left: m.x, right: m.x + m.width}[this._position];
        const shared = Main.layoutManager.monitors.some(n => n !== m && {
            bottom: n.y === edge,
            top: n.y + n.height === edge,
            left: n.x + n.width === edge,
            right: n.x === edge,
        }[this._position] && (this._vertical
            ? n.y < along + length && n.y + n.height > along
            : n.x < along + length && n.x + n.width > along));
        const wanted = this._settings.get_boolean('autohide') && this._settings.get_boolean('edge-pressure') &&
            !shared && Boolean(global.backend.capabilities & Meta.BackendCapabilities.BARRIERS);
        const [x1, y1] = this._xy(along, edge);
        const [x2, y2] = this._xy(along + length, edge);
        const key = wanted ? `${x1} ${y1} ${x2} ${y2} ${this._position}` : null;
        if (key === this._barrierKey)
            return;
        this._removeBarrier();
        if (!wanted)
            return;
        this._barrierKey = key;
        this._barrier = new Meta.Barrier({
            backend: global.backend, x1, y1, x2, y2,
            directions: {
                bottom: Meta.BarrierDirection.NEGATIVE_Y,
                top: Meta.BarrierDirection.POSITIVE_Y,
                left: Meta.BarrierDirection.POSITIVE_X,
                right: Meta.BarrierDirection.NEGATIVE_X,
            }[this._position],
        });
        this._pressure = new Layout.PressureBarrier(PRESSURE, PRESSURE_TIMEOUT, Shell.ActionMode.NORMAL);
        this._pressure.addBarrier(this._barrier);
        this._pressure.connect('trigger', () => {
            if (!this._hidden)
                return;
            this._slide(false);
            // The pointer on the edge now holds the bar like any hover.
            this._updateAutohide();
        });
    }

    _removeBarrier() {
        this._pressure?.destroy();
        this._barrier?.destroy();
        this._pressure = this._barrier = this._barrierKey = null;
    }

    // Returns true when a rebuild is on its way.
    _fit(length, room) {
        // Rebuilding mid drag would destroy the dragged icon.
        if (this._dragging)
            return false;
        const {icon} = this._geom;
        const wanted = this._settings.get_int('icon-size');
        // px of bar per px of icon size: a slot is 1.2 icons, a separator gap 0.4 slots
        const seps = this._rowSeps.filter(sep => sep.visible).length;
        const perIcon = (this._items.length + 0.4 * seps) * 1.2;
        if (!perIcon)
            return false;
        let fit = this._fitIcon;
        if (length > room && icon > MIN_ICON)
            fit = Math.max(MIN_ICON, Math.floor(icon - (length - room) / perIcon) - 1);
        // A slot to spare, or rounding makes it swing.
        else if (fit != null && length + (wanted - icon) * perIcon + wanted * 1.2 <= room)
            fit = null;
        if (fit === this._fitIcon)
            return false;
        this._fitIcon = fit;
        this._queue('refit', () => this.refresh());
        return true;
    }

    // [along start, along size, across start, thickness] at rest
    _barAxes() {
        const {x, y, width, height} = this._bar;
        return this._vertical ? [y, height, x, width] : [x, width, y, height];
    }

    _animate() {
        const {zoom, slot, margin} = this._geom;
        const n = this._items.length;
        const eased = STYLES[this._style].eased;
        const hovered = eased ? Number(this._row.hover || this._keyFocus !== null) : this._amount.value;
        const {scales, shifts, lifts, left, right} = hover(
            this._style, n, slot, this._pointer, zoom, this._dragging ? 0 : hovered, this._gaps);

        this._items.forEach((item, i) => {
            const {button, indicator} = item;
            button.set_scale(scales[i] / zoom, scales[i] / zoom);
            button[this._along] = shifts[i];
            indicator[this._along] = shifts[i];
            this._placeExtras(item, this._centers[i] + shifts[i], scales[i]);
            const lifted = [button, item.badge, item.progress];
            if (!eased) {
                lifted.forEach(actor => (actor[this._across] = this._dir * lifts[i]));
            } else if (item.lift !== lifts[i]) {
                item.lift = lifts[i];
                lifted.forEach(actor => actor.ease({
                    [this._across]: this._dir * lifts[i],
                    duration: LIFT_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                }));
            }
        });
        this._rowSeps.forEach((sep, i) => {
            const at = this._bounds[i];
            sep[this._along] = at > 0 && at < n ? (shifts[at - 1] + shifts[at]) / 2 : 0;
        });

        // Only visually wider, the bar and its strut keep their size and windows never resize.
        const startShift = Math.min(0, Math.round(left));
        const endShift = Math.max(0, Math.round(right - this._restWidth));
        const [firstBox, ...otherBoxes] = this._boxes;
        const [firstSep, secondSep] = this._seps;
        [firstBox, firstSep].forEach(actor => actor && (actor[this._along] = startShift));
        [secondSep, ...otherBoxes].forEach(actor => actor && (actor[this._along] = endShift));

        const [along, length, across, thick] = this._barAxes();
        this._bg.set_position(...this._xy(along + startShift, across + (this._edgeFirst ? margin : 0)));
        this._bg.set_size(...this._xy(length - startShift + endShift, thick - margin));
        // Growth plus the highest lift (ripple, 0.3 slot) stays below one slot.
        const over = this._geom.big - this._geom.icon + slot;
        this._reach.set_position(...this._xy(along + startShift, this._edgeFirst ? across + thick : across - over));
        this._reach.set_size(...this._xy(length - startShift + endShift, over));
        this._placeLabel();
    }

    // Top bar buttons belong to GNOME and other extensions, only watched, never connected to.
    _barEvent(event) {
        const type = event.type();
        const press = type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN;
        if (type !== Clutter.EventType.MOTION && !press)
            return Clutter.EVENT_PROPAGATE;
        let button = global.stage.get_event_actor(event);
        while (button && button !== this._bar && !button.has_style_class_name?.('panel-button'))
            button = button.get_parent();
        if (button === this._bar)
            button = null;
        if (!press)
            this._hoverButton(button);
        else if (this._settings.get_boolean('warp'))
            this._launch(rocketOf(button));
        return Clutter.EVENT_PROPAGATE;
    }

    _hoverButton(button, immediate = false) {
        if (button === this._hovered)
            return;
        if (this._hovered) {
            this._hovered.disconnectObject(this);
            this._liftButton(this._hovered, false, immediate);
        }
        this._hovered = button;
        button?.connectObject('destroy', () => (this._hovered = null), this);
        if (button)
            this._liftButton(button, true);
    }

    // Off hover back to rest, whatever the settings say by now.
    _liftButton(button, up, immediate = false) {
        const rocket = rocketOf(button);
        const warp = up && Boolean(rocket) && this._settings.get_boolean('warp');
        const lift = up && !warp && this._settings.get_boolean('lift-buttons');
        const params = up
            ? {duration: 300, mode: Clutter.AnimationMode.EASE_OUT_BACK}
            : {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        const content = button.get_first_child();
        if (content)
            settle(content, {[this._across]: lift ? this._dir * BUTTON_LIFT : 0}, immediate, params);
        if (warp)
            this._useRocket(rocket);
        if (rocket && (immediate || !this._flying)) {
            const scale = warp ? 1.12 : 1;
            settle(rocket, {translation_y: warp ? this._dir * WARP_LIFT : 0, scale_x: scale, scale_y: scale},
                immediate, params);
        }
    }

    _useRocket(rocket) {
        if (rocket === this._rocket)
            return;
        this._rocket?.disconnectObject(this);
        if (this._rocket)
            resetRocket(this._rocket);
        this._rocket = rocket;
        rocket.set_pivot_point(0.5, 0.5);
        rocket.connectObject('destroy', () => (this._rocket = null), this);
    }

    _launch(rocket) {
        if (!rocket || this._flying)
            return;
        this._useRocket(rocket);
        this._flying = true;
        const away = this._dir * this._bar.height;
        const step = (props, duration, mode, next) => rocket.ease({
            ...props, duration, mode,
            onStopped: finished => {
                if (finished)
                    return next();
                this._flying = false;
                settle(rocket, {opacity: 255}, true);
            },
        });
        step({scale_x: 0.8, scale_y: 1.3}, 110, Clutter.AnimationMode.EASE_OUT_QUAD, () =>
            step({translation_y: away, scale_x: 0.6, scale_y: 1.6, opacity: 0}, 170,
                Clutter.AnimationMode.EASE_IN_QUAD, () => this._land(rocket, -away / 2)));
    }

    _land(rocket, from) {
        this._flying = false;
        const up = rocketOf(this._hovered) === rocket;
        const scale = up ? 1.12 : 1;
        Object.assign(rocket, {translation_y: from, scale_x: 1, scale_y: 1});
        rocket.ease({
            translation_y: up ? this._dir * WARP_LIFT : 0, scale_x: scale, scale_y: scale,
            duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        rocket.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _makeDraggable(item) {
        const {app, button, icon} = item;
        let dragActor = null;
        let unpin = false;
        let escaped = false;
        const delegate = {
            app,
            getDragActor: () => (dragActor = this._tintIcon(app.create_icon_texture(this._geom.icon))),
            getDragActorSource: () => icon,
        };
        button._delegate = delegate;
        // GNOME's drag outlives its destroyed source (app quit, dock rebuilt).
        let alive = true;
        button.connect('destroy', () => (alive = false));
        const draggable = DND.makeDraggable(button);
        draggable.connect('drag-begin', () => {
            unpin = escaped = false;
            button.opacity = 80;
            Main.overview.beginItemDrag(delegate);
        });
        // Before GNOME flies the icon back. Let go far off the bar unpins, Escape never does:
        // GNOME cancels once more on the button release after it.
        draggable.connect('drag-cancelled', () => {
            Main.overview.cancelledItemDrag(delegate);
            const type = Clutter.get_current_event()?.type();
            escaped ||= type === Clutter.EventType.KEY_PRESS;
            const released = type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END;
            unpin = !escaped && released && this._farFromBar() &&
                AppFavorites.getAppFavorites().isFavorite(app.get_id());
            if (unpin && dragActor && this._settings.get_boolean('poof')) {
                this._poof(app, dragActor);
                // Hidden, the fly back ends at once and GNOME destroys it. A relayout still
                // queued for it would then hit an actor off the stage, run it now.
                dragActor.hide();
                dragActor.get_allocation_box();
            }
        });
        draggable.connect('drag-end', (d, time, success) => {
            if (alive)
                button.opacity = 255;
            Main.overview.endItemDrag(delegate);
            if (!success && unpin)
                AppFavorites.getAppFavorites().removeFavorite(app.get_id());
        });
    }

    // A little cloud where the icon was let go.
    _poof(app, from) {
        const [x, y] = from.get_transformed_position();
        const [size] = from.get_transformed_size();
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        const ghost = this._tintIcon(app.create_icon_texture(Math.round(size)));
        ghost.set_position(Math.round(x), Math.round(y));
        ghost.set_pivot_point(0.5, 0.5);
        Main.uiGroup.add_child(ghost);
        ghost.ease({scale_x: 1.5, scale_y: 1.5, opacity: 0, duration: POOF_TIME * 0.6, mode, onComplete: () => ghost.destroy()});
        const d = Math.round(size * 0.45);
        for (let i = 0; i < PUFFS; i++) {
            const puff = new St.Widget({style_class: 'silver-dock-poof', style: `border-radius: ${d}px;`, width: d, height: d});
            puff.set_position(Math.round(x + (size - d) / 2), Math.round(y + (size - d) / 2));
            puff.set_pivot_point(0.5, 0.5);
            puff.set_scale(0.4, 0.4);
            Main.uiGroup.add_child(puff);
            const angle = 2 * Math.PI * (i + 0.25) / PUFFS;
            puff.ease({
                translation_x: Math.cos(angle) * size * 0.7,
                translation_y: Math.sin(angle) * size * 0.7,
                scale_x: 1.8,
                scale_y: 1.8,
                opacity: 0,
                duration: POOF_TIME,
                mode,
                onComplete: () => puff.destroy(),
            });
        }
    }

    _farFromBar() {
        const [x, y] = global.get_pointer();
        const [, , across, thick] = this._barAxes();
        const p = this._vertical ? x : y;
        return p < across - thick || p > across + 2 * thick;
    }

    // Also for drags from the overview or menus.
    startDrag() {
        if (this._dragging)
            return;
        this._dragging = true;
        this._hideLabel();
        this._previews.hide();
        this._dragMonitor = {
            dragMotion: event => {
                if (!this._row.contains(event.targetActor))
                    this._setDropIndex(null);
                return DND.DragMotionResult.CONTINUE;
            },
            // After acceptDrop, which needs the drop index.
            dragDrop: () => {
                this._queue('drop', () => this.endDrag());
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        this._updateAutohide();
        this._animate();
    }

    endDrag() {
        if (!this._dragging)
            return;
        this._dragging = false;
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
        this._setDropIndex(null);
        this.queueCheck();
    }

    _setDropIndex(index) {
        if (index === this._dropIndex)
            return;
        this._dropIndex = index;
        this._layout(true);
    }

    _dragOver(source, along) {
        const app = source?.app;
        if (!this._settings.get_boolean('dnd') || !(app instanceof Shell.App))
            return DND.DragMotionResult.NO_DROP;
        this.startDrag();
        this._setDropIndex(this._dropIndexAt(app, along));
        return this._dropIndex === null ? DND.DragMotionResult.NO_DROP : DND.DragMotionResult.MOVE_DROP;
    }

    _dropIndexAt(app, along) {
        const from = AppFavorites.getAppFavorites().getFavorites().indexOf(app);
        return dropIndex(this._restNoDrop.centers, this._geom.slot, along, this._dropIndex, this._bounds[0], from);
    }

    _acceptDrop(source) {
        const app = source?.app;
        const pos = this._dropIndex;
        if (!(app instanceof Shell.App) || pos === null)
            return false;
        this.endDrag();
        const favorites = AppFavorites.getAppFavorites();
        const from = favorites.getFavorites().indexOf(app);
        // moveFavoriteToPos counts with the app already taken out.
        if (from >= 0)
            favorites.moveFavoriteToPos(app.get_id(), pos > from ? pos - 1 : pos);
        else
            favorites.addFavoriteAtPos(app.get_id(), pos);
        return true;
    }

    _menuOpen() {
        return Boolean(this._menuManager.activeMenu ||
            (this._boxes.length && Main.panel.menuManager.activeMenu));
    }

    // grow: px on the screen side, to catch windows that only touch the bar.
    _windowsOverlap(grow = 0) {
        const [along, length, across, thick] = this._barAxes();
        const [x, y] = this._xy(along, this._edgeFirst ? across : across - grow);
        const [width, height] = this._xy(length, thick + grow);
        const rect = new Mtk.Rectangle({x, y, width, height});
        // Skip-taskbar windows are desktop icons and docks.
        return global.workspace_manager.get_active_workspace().list_windows().some(win =>
            win.showing_on_its_workspace() && !win.is_skip_taskbar() && win.get_frame_rect().overlap(rect));
    }

    _updateOpacity() {
        const {opacity} = this._geom;
        const touched = this._settings.get_boolean('dynamic-opacity') && this._windowsOverlap(4);
        const target = Math.round(255 * (touched ? Math.max(opacity, 0.95) : opacity));
        if (target === this._bgOpacity)
            return;
        this._bgOpacity = target;
        this._bg.ease({opacity: target, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _shouldHide() {
        const focus = global.stage.key_focus;
        // With a barrier up, the pointer on the 1 px strip needs to push first.
        const hover = this._bar.hover && !(this._hidden && this._barrier);
        return this._settings.get_boolean('autohide') && !hover && !this._dragging && !this._menuOpen() &&
            !this._previews.shown && !this._revealTimer && !(focus && this._bar.contains(focus)) &&
            !Main.overview.visible && this._windowsOverlap();
    }

    _updateAutohide() {
        if (!this._shouldHide()) {
            if (this._hideTimer)
                GLib.source_remove(this._hideTimer);
            this._hideTimer = 0;
            this._slide(false);
            return;
        }
        if (this._hidden || this._hideTimer)
            return;
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideTimer = 0;
            if (this._shouldHide())
                this._slide(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _slide(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        if (hidden) {
            this._hideLabel();
            this._previews.hide();
        }
        const spring = !hidden && this._settings.get_boolean('springy');
        const params = spring
            ? {duration: SLIDE_TIME * 1.75, mode: Clutter.AnimationMode.EASE_OUT_BACK}
            : {duration: SLIDE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        const out = -this._dir;
        const [, , , thick] = this._barAxes();
        // A 1 px strip stays on screen and catches the pointer.
        this._bar.ease({...params, [this._across]: hidden ? out * (thick - 1) : 0});
        this._bg.ease({...params, [this._across]: hidden ? out * (thick + SHADOW) : 0});
    }
}
