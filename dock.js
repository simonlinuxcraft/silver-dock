import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {luma, mix, parseColor} from './colors.js';
import {Color, HAS_ACCENT, setVertical, trustHover} from './compat.js';
import {badgeOf, countText, progressOf} from './launcher.js';
import {dropIndex, hover, rest, STYLES} from './layout.js';
import {RoundedMask} from './mask.js';
import {mediaSection} from './media.js';
import {TRASH, driveMounts, openPlace, placeActions, placeIcon, placeName} from './places.js';
import {panelBoxes, restorePanel, takePanel} from './takeover.js';

// Logical px, times the shell's scale factor on actors. CSS and icon sizes stay logical.
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
// logical px between neighbouring tiles
const TILE_GAP = 3;
const DOT_LONG = 12;
const BUTTON_LIFT = 3;
const WARP_LIFT = 5;
const SCROLL_PAUSE = 150;
const LABEL_GAP = 6;
const FADE_TIME = 120;
// longer than WIGGLE_EVERY, so a waiting wiggle still shows
const REVEAL_TIME = 3000;
// the hidden background slides this much further, its shadow with it
const SHADOW = 16;
// like GNOME's hot corner: px of push within ms
const PRESSURE = 100;
const PRESSURE_TIMEOUT = 1000;
const POOF_TIME = 400;
// Launchers, Wine above all, close and reopen their window while starting.
const STARTUP = 10000;
const SETTLE = 3000;
const BOUNCE_MAX = 15000;
const PUFFS = 7;

const SIDES = {bottom: St.Side.BOTTOM, top: St.Side.TOP, left: St.Side.LEFT, right: St.Side.RIGHT};
// bg and fg as "r, g, b", the opacity setting adds the alpha
export const COLORS = {bg: '28, 29, 33', fg: '235, 237, 242', border: '1px solid rgba(214, 218, 226, 0.3)'};
// The designs' other half: Silver Dock light, Haiku's panel gray and a dark one
const SILVER_LIGHT = '242, 243, 246';
const HAIKU_BG = '216, 216, 216';
const HAIKU_DARK = '58, 58, 61';

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

// AppIndicator hands every click on a tray icon or its menu a launch token. An app living in the tray then
// counts as starting, even on Quit.
function fromTray() {
    const event = Clutter.get_current_event();
    let actor = event && global.stage.get_event_actor(event);
    while (actor) {
        if (actor.has_style_class_name?.('panel-button'))
            return Boolean(findActor(actor, child => child.has_style_class_name?.('appindicator-icon')));
        actor = actor._delegate?.sourceActor ?? actor.get_parent();
    }
    return false;
}

// "along" runs with the icon row, "across" from its inner side to the screen edge.
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
        this._fullscreen = false;
        this._gaps = [];
        this._restWidth = 0;
        this._centers = [];
        this._dropIndex = null;
        this._dragging = false;
        this._intro = intro;
        this._hovered = null;
        this._keyFocus = null;
        this._scale = 1;

        this._bg = new St.Widget({style_class: 'silver-dock-bg'});
        this._blur = null;
        // X11 only sends the pointer to tracked chrome, this covers the magnified icons.
        this._reach = new St.Widget({visible: false});
        // Named like the top bar, the moved panel buttons keep their theme styling.
        this._bar = new St.BoxLayout({name: 'panel', style_class: 'silver-dock', reactive: true, track_hover: true});
        this._row = new St.Widget({reactive: true, track_hover: true});
        [this._bar, this._row].forEach(trustHover);
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
            },
            'notify::width', () => this._contentChanged(),
            'notify::height', () => this._contentChanged(), this);
        // Moving the bar mid layout pass leaves it unallocated for a frame.
        this._bar.connectObject(
            'notify::width', () => this.queuePlace(),
            'notify::height', () => this.queuePlace(),
            'notify::hover', () => {
                // A springy slide overshoots and leaves the pointer behind for a moment, _slide syncs at the end.
                if (!this._bar.hover && this._bar.get_transition(this._across.replace('_', '-')))
                    return;
                this._syncHover();
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
            // Icons and the volume button scroll themselves.
            'scroll-event', (actor, event) => {
                const target = global.stage.get_event_actor(event);
                if (!this._settings.get_boolean('scroll-workspaces') || (target !== this._bar && target !== this._row))
                    return Clutter.EVENT_PROPAGATE;
                return Main.wm.handleWorkspaceScroll(event);
            },
            // Only GNOME's teardown at logout, destroy() disconnects first.
            'destroy', () => ext.lost(), this);

        Main.layoutManager.addChrome(this._bg);
        this.trackBar();
        Main.layoutManager.addChrome(this._label);
        Main.layoutManager.addChrome(this._reach);
        if (primary)
            Main.ctrlAltTabManager.addGroup(this._bar, _('Dock'), 'shell-focus-top-bar-symbolic');
    }

    destroy() {
        this.stopListening();
        this._setBlur(false);
        // ArcMenu's actors go back as they were.
        this._hoverButton(null, true);
        this._useRocket(null);
        this._amount.remove_transition('value');

        if (this._primary)
            Main.ctrlAltTabManager.removeGroup(this._bar);
        // Off the stage before any child changes, or Clutter relayouts the destroyed bar.
        const actors = [this._bar, this._bg, this._label, this._reach];
        // Clutter can hold a chrome actor twice for relayout, flush it while still on stage.
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
        this._stopped = true;
        this._boxes.forEach(box => box.disconnectObject(this));
        this._row.disconnectObject(this);
        this._bar.disconnectObject(this);
        this._amount.disconnectObject(this);
        Object.values(this._laters).forEach(id => id && global.compositor.get_laters().remove(id));
        this._laters = {};
        for (const timer of ['_hideTimer', '_wiggleTimer', '_revealTimer', '_settleTimer']) {
            if (this[timer])
                GLib.source_remove(this[timer]);
            this[timer] = 0;
        }
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
        this._removeBarrier();
    }

    _undress() {
        if (!this._dressed)
            return;
        Main.panel.set_style(this._panelStyle);
        for (const name of ['ink', 'bright', 'shadow', 'haiku', 'dim'])
            Main.panel.remove_style_class_name(`silver-dock-${name}`);
        this._dressBoxes(panelBoxes(), false);
        this._dressed = false;
    }

    paint() {
        const margin = this._settings.get_int('margin');
        const radius = this._radius();
        const mode = this._settings.get_string('colors');
        const themed = mode === 'theme';
        const haiku = this._settings.get_string('design') === 'haiku';
        const scheme = this._settings.get_string('scheme');
        const night = scheme === 'design' ? !haiku : scheme === 'system' ? this._ext.prefersDark() : scheme === 'dark';
        const own = (mode === 'custom' && parseColor(this._settings.get_string('color'))) ||
            (mode === 'wallpaper' && this._ext.wallpaperColor()) ||
            (mode === 'dock' && (haiku ? (night ? HAIKU_DARK : HAIKU_BG) : !night && SILVER_LIGHT));
        let colors = themed ? this._ext.themeColors() : COLORS;
        let ink = false;
        this._light = false;
        this._themed = themed;
        if (own) {
            // Border and separators lighter, or darker on a light color, for contrast.
            const light = this._light = luma(own) > 150;
            const shade = mix(own, light ? '0, 0, 0' : '255, 255, 255', 0.6);
            colors = {bg: own, fg: shade, border: `1px solid rgba(${shade}, 0.5)`};
            ink = light && this._settings.get_int('opacity') >= 50;
        }
        const tint = this._settings.get_boolean('tint-icons') && parseColor(this._settings.get_string('icon-color'));
        const [red, green, blue] = tint ? tint.split(',').map(Number) : [];
        this._tint = tint ? new Color({red, green, blue, alpha: 255}) : null;
        // Haiku: a dark bevel edge on the bar and the tiles. A dark bar gets dark tiles.
        const dim = haiku && luma(colors.bg) < 80;
        this._edge = haiku ? mix(colors.bg, '0, 0, 0', dim ? 0.5 : 0.45) : null;
        if (haiku)
            colors = {...colors, border: `1px solid rgb(${this._edge})`};
        setClass(this._bar, 'haiku', haiku);
        setClass(this._bar, 'dim', dim);
        this._previews.dim = dim;
        this._surface = {haiku, dim, fg: colors.fg};
        setClass(this._label, 'silver-dock-tab', haiku);
        const bright = !themed && !ink;
        const opacity = themed ? colors.alpha : this._settings.get_int('opacity') / 100;
        this._inkBar(opacity);
        this._geom.opacity = opacity;
        this._accent = colors.accent ?? null;
        // The stylesheet's system accent needs GNOME 47.
        setClass(this._bar, 'themed', themed && HAS_ACCENT);
        const shadow = this._settings.get_boolean('shadow');
        setClass(this._bg, 'silver-dock-shadow', shadow);
        setClass(this._bg, 'silver-dock-haiku', haiku);
        this._setBlur(this._settings.get_boolean('blur'));

        if (this._primary && this._ownTopBar && this._settings.get_boolean('style-top-bar')) {
            if (!this._dressed) {
                this._panelStyle = Main.panel.get_style();
                this._dressed = true;
            }
            Main.panel.set_style(`margin: ${margin}px ${margin}px 0; ` +
                `background-color: rgba(${colors.bg}, ${opacity}); ${this._borderCss(colors.border, 'top', true)} ` +
                `border-radius: ${radius}px;`);
            setClass(Main.panel, 'silver-dock-ink', ink);
            setClass(Main.panel, 'silver-dock-bright', bright);
            setClass(Main.panel, 'silver-dock-shadow', shadow);
            setClass(Main.panel, 'silver-dock-haiku', haiku);
            setClass(Main.panel, 'silver-dock-dim', dim);
            this._dressBoxes(panelBoxes(), haiku, 2, opacity);
        } else {
            this._undress();
        }

        // Opacity on the actor, so dynamic opacity can ease it.
        this._bg.set_style(`border-radius: ${radius}px; background-color: rgb(${colors.bg}); ${this._borderCss(colors.border)}`);
        this._bg.remove_transition('opacity');
        this._bg.opacity = this._bgOpacity = Math.round(255 * opacity);
        this._paintSurface(opacity);
        this._items.forEach(item => {
            item.fill.set_style(this._accent && `background-color: rgb(${this._accent});`);
            item.button.set_style(this._buttonStyle());
            this._tintIcon(item.icon);
        });
        this.updateDots();
        this.queueCheck();
    }

    // Haiku's bar is square.
    _radius() {
        return this._settings.get_string('design') === 'haiku' ? 0 : this._settings.get_int('radius');
    }

    // Haiku's bar spans the screen edge to edge, or only as far as its content.
    get _full() {
        return this._settings.get_string('design') === 'haiku' && this._settings.get_string('bar-width') === 'full';
    }

    // What belongs to the bar's surface fades with its background: Haiku's highlight, grooves, leaf and field.
    _paintSurface(alpha) {
        const {haiku, dim, fg} = this._surface;
        const glow = {bottom: '0 1px', top: '0 -1px', left: '-1px 0', right: '1px 0'}[this._position];
        // Along the far side, just inside the bar's clear border there.
        this._bar.set_style((this._barStyle ?? '') +
            (haiku ? ` box-shadow: inset ${glow} 0 rgba(255, 255, 255, ${(dim ? 0.12 : 0.8) * alpha});` : ''));
        // Haiku's separators are grooves, a dark line with a light one beside it.
        const groove = `${this._vertical ? '0 1px' : '1px 0'} 0 rgba(255, 255, 255, ${(dim ? 0.12 : 0.7) * alpha})`;
        for (const sep of [...this._seps, ...this._rowSeps])
            sep.set_style(haiku ? `background-color: rgba(${this._edge}, ${alpha}); box-shadow: ${groove};`
                : `background-color: rgba(${fg}, 0.25);`);
        this._dressBoxes(this._boxes, haiku, 1, alpha);
    }

    // Haiku: the menu on the yellow leaf, from the field box on an inset field (clock and tray, in the top bar the tray).
    // Painted here, the surface fades with the bar.
    _dressBoxes(boxes, haiku, field = 1, alpha = 1) {
        const dim = this._surface?.dim;
        boxes.forEach((box, i) => {
            setClass(box, 'silver-dock-leaf', haiku && i === 0);
            setClass(box, 'silver-dock-field', haiku && i >= field);
            if (!haiku || (i > 0 && i < field))
                box.set_style(null);
            else if (i === 0)
                box.set_style('padding: 0 4px; background-gradient-direction: vertical; ' +
                    `background-gradient-start: rgba(255, 243, 176, ${alpha}); ` +
                    `background-gradient-end: rgba(255, 203, 0, ${alpha}); box-shadow: inset -1px 0 0 rgba(138, 112, 0, ${alpha});`);
            else
                box.set_style(`background-color: rgba(0, 0, 0, ${(dim ? 0.18 : 0.06) * alpha});` +
                    (i === field ? ` box-shadow: inset 1px 0 0 rgba(0, 0, 0, ${(dim ? 0.5 : 0.3) * alpha});` : ''));
        });
    }

    // A Haiku bar on the screen edge has no border along it, spanning the edge none at its ends either.
    _borderCss(border, side = this._position, spans = this._full) {
        if (!this._edge || this._settings.get_int('margin') > 0)
            return `border: ${border};`;
        const far = {bottom: 'top', top: 'bottom', left: 'right', right: 'left'}[side];
        return spans ? `border: 0; border-${far}: ${border};` : `border: ${border}; border-${side}-width: 0;`;
    }

    // The same Haiku border in logical px per side, the bar keeps its content inside it.
    _lines() {
        const flush = this._settings.get_int('margin') === 0;
        return {far: 1, ends: flush && this._full ? 0 : 1, edge: flush ? 0 : 1};
    }

    // The bar's length along its edge when it spans the screen, less the distance to the edge on both ends.
    _fullLength() {
        const m = Main.layoutManager.monitors[this.monitorIndex];
        if (!m)
            return -1;
        const room = this._vertical ? Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex).height : m.width;
        return room - 2 * this._geom.margin;
    }

    // What the bar needs along its edge: its children and padding, whatever the set length, and the room magnify
    // spreads into (its icons grow by up to three slots' worth).
    _content() {
        const pick = this._vertical ? 'get_preferred_height' : 'get_preferred_width';
        const {slot, peak} = this._geom;
        const spread = STYLES[this._style].spread ? Math.ceil(3 * slot * (peak - 1)) : 0;
        return this._bar.get_children().reduce((sum, child) => sum + (child.visible ? child[pick](-1)[1] : 0),
            2 * this._end * this._scale + spread);
    }

    // The button is the tile. Tiles are small boxes with a bevel edge, the border takes 1 px of the padding.
    _buttonStyle() {
        const {big, pad} = this._geom;
        const s = this._scale;
        return this._edge
            ? `border-radius: 3px; padding: ${pad / s - 1}px; border: 1px solid rgb(${this._edge});`
            : `border-radius: ${Math.round((big / 4 + pad) / s)}px; padding: ${pad / s}px;`;
    }

    _separator() {
        return new St.Widget({
            style_class: 'silver-dock-separator',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    // Only the wallpaper: GNOME's live blur can't take rounded corners.
    _setBlur(on) {
        const m = Main.layoutManager.monitors[this.monitorIndex];
        if (on && !this._blur && m) {
            this._wallpaper = new Clutter.Actor({visible: false, x: m.x, y: m.y, width: m.width, height: m.height});
            Main.uiGroup.add_child(this._wallpaper);
            this._backgrounds = new Background.BackgroundManager({
                container: this._wallpaper, monitorIndex: this.monitorIndex, controlPosition: false,
            });
            this._blurEffect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
            this._wallpaper.add_effect(this._blurEffect);
            this._clone = new Clutter.Clone({source: this._wallpaper});
            this._blur = new St.Widget({clip_to_allocation: true});
            this._blur.add_child(this._clone);
            this._mask = new RoundedMask();
            this._blur.add_effect(this._mask);
            this._blur.visible = !this._fullscreen;
            Main.layoutManager.addChrome(this._blur);
            Main.layoutManager.uiGroup.set_child_below_sibling(this._blur, this._bg);
        } else if (!on && this._blur) {
            this._blur.get_allocation_box();
            Main.layoutManager.removeChrome(this._blur);
            this._blur.destroy();
            this._backgrounds.destroy();
            this._wallpaper.destroy();
            this._blur = this._clone = this._mask = this._blurEffect = this._backgrounds = this._wallpaper = null;
        }
        if (!this._blur)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._blurEffect.radius = this._settings.get_int('blur-radius') * scale;
    }

    _placeBlur(x, y, width, height) {
        if (!this._blur)
            return;
        this._blur.set_position(x, y);
        this._blur.set_size(width, height);
        this._clone.set_position(this._wallpaper.x - x, this._wallpaper.y - y);
        // St draws no radius beyond half the height.
        const radius = this._radius() * this._scale;
        this._mask.setShape(width, height, Math.min(radius, width / 2, height / 2));
    }

    _xy(along, across) {
        return this._vertical ? [across, along] : [along, across];
    }

    // Both axes: after a position change the old offset sits on the other one.
    _resetSlide() {
        this._hidden = false;
        for (const actor of [this._bar, this._bg, this._blur].filter(Boolean)) {
            actor.remove_transition('translation-x');
            actor.remove_transition('translation-y');
            actor.translation_x = actor.translation_y = 0;
        }
    }

    trackBar() {
        // Struts follow the transformed position, a slid out bar would reserve 1 px.
        this._resetSlide();
        const params = {affectsStruts: !this._settings.get_boolean('autohide')};
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
        // Without scale-monitor-framebuffer (GNOME 46 to 49) actors count physical px.
        const s = this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const icon = Math.min(this._settings.get_int('icon-size') * s, this._fitIcon ?? Infinity);
        const zoom = this._settings.get_double('zoom');
        const margin = this._settings.get_int('margin');
        const radius = this._radius();
        const haiku = this._settings.get_string('design') === 'haiku';

        this._style = this._settings.get_string('animation');
        this._position = this._settings.get_string('position');
        this._side = SIDES[this._position];
        this._vertical = this._position === 'left' || this._position === 'right';
        this._edgeFirst = this._position === 'top' || this._position === 'left';
        this._dir = this._edgeFirst ? 1 : -1;
        this._along = this._vertical ? 'translation_y' : 'translation_x';
        this._across = this._vertical ? 'translation_x' : 'translation_y';
        // Only magnify and ripple grow the icons, rendered any bigger they would only lose detail scaled down.
        const peak = 1 + (zoom - 1) * STYLES[this._style].zoom;
        // big and pad whole logical px, St draws icons and padding in those.
        this._geom = {
            icon,
            zoom,
            peak,
            margin: margin * s,
            // Haiku centres the tiles, the dots sit below them anyway.
            inner: (haiku ? (INNER + OUTER) / 2 : INNER) * s,
            outer: (haiku ? (INNER + OUTER) / 2 : OUTER) * s,
            slot: icon + Math.round(icon / 5),
            big: Math.round(icon * peak / s) * s, // rendered at the largest size and scaled down, stays sharp
            thick: (INNER + OUTER) * s + icon,
        };
        // Room for the tile around the icon, at rest as wide as a slot, or a gap narrower in the Haiku design.
        const gap = haiku ? TILE_GAP * s : 0;
        this._geom.pad = Math.floor((this._geom.slot - icon - gap) / 2 * peak / s) * s;

        // The strut needs the bar on the screen edge, the gap is padding.
        const full = this._full;
        // Haiku's leaf and field reach the ends, inside the border.
        const {far, ends, edge} = haiku ? this._lines() : {far: 0, ends: 0, edge: 0};
        const end = this._end = Math.round(radius / 2) + (haiku ? ends : 4);
        const near = margin + edge;
        // On the far side a clear border, the highlight is drawn inside it, below the background's edge.
        const farSide = {bottom: 'top', top: 'bottom', left: 'right', right: 'left'}[this._position];
        this._barStyle = {
            bottom: `padding: 0 ${end}px ${near}px;`,
            top: `padding: ${near}px ${end}px 0;`,
            left: `padding: ${end}px 0 ${end}px ${near}px;`,
            right: `padding: ${end}px ${near}px ${end}px 0;`,
        }[this._position] + (far ? ` border-${farSide}: ${far}px solid transparent;` : '');
        this._bar.set_style(this._barStyle);
        setVertical(this._bar, this._vertical);
        setClass(this._bar, 'vertical', this._vertical);
        this._bar.set_size(-1, -1);
        const lines = (far + edge) * s;
        if (this._vertical)
            this._bar.width = this._geom.thick + this._geom.margin + lines;
        else
            this._bar.height = this._geom.thick + this._geom.margin + lines;
        // Spanning the screen, the icons sit at the start and the clock and tray at the far end.
        const [main, cross] = this._vertical ? ['y', 'x'] : ['x', 'y'];
        this._row.set({
            [`${main}_expand`]: full,
            [`${main}_align`]: full ? Clutter.ActorAlign.START : Clutter.ActorAlign.FILL,
            [`${cross}_expand`]: false,
            [`${cross}_align`]: Clutter.ActorAlign.FILL,
        });
        if (full)
            this._bar[this._vertical ? 'height' : 'width'] = this._fullLength();
        this._ownTopBar = this._vertical ||
            (this._position === 'bottom' && this._settings.get_boolean('keep-top-bar'));
        const wantPanel = this._primary && !this._ownTopBar && this._panelOk;
        if (wantPanel && !this._boxes.length) {
            this._boxes = takePanel(this._bar, this._seps[0], this._seps[1]);
            this._panelOk = this._boxes.length > 0;
            this._boxes.forEach(box => box.connectObject(
                'notify::width', () => this._contentChanged(),
                'notify::height', () => this._contentChanged(), this));
        } else if (!wantPanel && this._boxes.length) {
            this._boxes.forEach(box => box.disconnectObject(this));
            restorePanel(this._bar, this._boxes);
            this._boxes = [];
        }
        for (const key of ['lift-buttons', 'warp', 'glide'])
            setClass(this._bar, key, this._settings.get_boolean(key));
        setClass(this._bar, 'quiet-menus', !this._settings.get_boolean('open-highlight'));
        // Opens to the old side otherwise.
        this._dockMenu?.destroy();
        this._dockMenu = null;
        this.paint();
        const sepSize = this._xy(s, Math.round(icon * 0.6));
        for (const sep of [...this._seps, ...this._rowSeps])
            sep.set_size(...sepSize);
        for (const sep of this._seps) {
            // Haiku's leaf and field bring their own edges.
            sep.visible = this._settings.get_boolean('separators') && this._boxes.length > 0 && !haiku;
            [sep.margin_left, sep.margin_right, sep.margin_top, sep.margin_bottom] = this._vertical
                ? [0, 0, SEP_MARGIN * s, SEP_MARGIN * s] : [SEP_MARGIN * s, SEP_MARGIN * s, 0, 0];
        }
        this._resetSlide();
        for (const actor of [...this._boxes, ...this._seps, ...this._rowSeps])
            actor.translation_x = actor.translation_y = 0;

        this._items.forEach(item => this._destroyItem(item));
        this._items = [];
        this._fresh = true;
        this.sync();
        this._fresh = false;
        // The barrier follows settings that leave the bar's size alone.
        this.queuePlace();
    }

    // Keeps existing icons, a rebuild would close their open menus.
    sync() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favIds = new Set(favorites.map(app => app.get_id()));
        const pos = new Map(this._items.map((item, i) => [item.key, i]));
        const last = this._items.length;
        const live = new Set(Shell.AppSystem.get_default().get_running());
        const settling = this._settling(live);
        const running = [...live, ...settling.map(item => item.app)]
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
        const created = [];
        const items = sections.flatMap((keys, section) => keys.map(key => {
            let item = old.get(key);
            if (item?.leaving) {
                item.leaving = false;
                item.button.reactive = true;
                // Replaces the shrink, whose onComplete then never comes.
                this._popIn(item, false);
            } else if (!item) {
                item = this._createItem(key);
                created.push(item);
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
        // A window that remaps or matches late swaps its app, popping out and in would widen the bar.
        for (const item of pop ? created.filter(({section}) => section === 1) : []) {
            const leaving = items.filter(other => other.leaving && other.section === 1);
            const i = items.indexOf(item);
            const twin = leaving.find(other => other.name === item.name) ??
                [items[i - 1], items[i + 1]].find(other => leaving.includes(other));
            if (!twin)
                continue;
            item.icon.set_scale(twin.icon.scale_x, twin.icon.scale_y);
            this._popIn(item, false);
            items.splice(i, 1);
            items.splice(items.indexOf(twin), 1, item);
            if (gone.includes(twin))
                gone.splice(gone.indexOf(twin), 1);
            this._destroyItem(twin);
        }
        this._items = items;
        // Tab goes by child order, new and moved icons were added at the end.
        const order = items.flatMap(item => [item.button, item.indicator, item.progress, item.badge]);
        if (this._row.get_children().filter(actor => order.includes(actor)).some((actor, i) => actor !== order[i]))
            order.forEach(actor => this._row.set_child_above_sibling(actor, null));

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
        // Last: without animations the ease ends at once and syncs again.
        if (pop)
            gone.forEach(item => this._popOut(item));
    }

    // A young app that just lost its window keeps its icon a moment, it may come right back.
    _settling(live) {
        const now = GLib.get_monotonic_time() / 1000;
        const settling = this._items.filter(item => {
            if (!item.app || live.has(item.app)) {
                item.goneAt = null;
                return false;
            }
            item.goneAt ??= now;
            // A window-backed app never comes back, its window gets a new one.
            return item.section === 1 && !item.leaving && !item.app.is_window_backed() &&
                now - item.born < STARTUP && now - item.goneAt < SETTLE;
        });
        if (this._settleTimer)
            GLib.source_remove(this._settleTimer);
        this._settleTimer = 0;
        if (settling.length) {
            const wait = Math.min(...settling.map(item => item.goneAt + SETTLE - now));
            this._settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait) + 1, () => {
                this._settleTimer = 0;
                this.sync();
                return GLib.SOURCE_REMOVE;
            });
        }
        return settling;
    }

    _popIn({icon}, fromNothing = true) {
        if (fromNothing)
            icon.set_scale(0, 0);
        icon.ease({scale_x: 1, scale_y: 1, duration: POP_TIME, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    _popOut(item) {
        item.button.reactive = false;
        this._hideLabel(item);
        this._previews.forget(item.button);
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
        const {icon: size, big, slot, pad} = this._geom;
        const s = this._scale;
        const app = key instanceof Shell.App ? key : null;
        const name = app ? app.get_name() : placeName(key);
        const icon = app ? app.create_icon_texture(big / s) : placeIcon(key, big / s, this._ext.trash?.full);
        icon.set_pivot_point(0.5, 0.5);
        // Drawn smaller than rendered while at rest, mipmaps keep the edges from aliasing.
        const smooth = child => child.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        icon.get_children().forEach(smooth);
        icon.connectObject('child-added', (actor, child) => smooth(child), this);
        this._tintIcon(icon);

        const font = Math.max(10, Math.round(size / s / 3));
        const badge = new St.Label({
            style_class: 'silver-dock-badge',
            style: `font-size: ${font}px; min-width: ${Math.round(font * 1.1)}px;` +
                (this._settings.get_string('design') === 'haiku' ? '' : ` border-radius: ${font}px;`),
            visible: false,
        });
        const progress = new St.Widget({
            style_class: 'silver-dock-progress',
            height: Math.max(3 * s, Math.round(size * 0.1)),
            visible: false,
        });
        const fill = new St.Widget({style_class: 'silver-dock-progress-fill'});
        if (this._accent)
            fill.set_style(`background-color: rgb(${this._accent});`);
        progress.add_child(fill);

        const button = new St.Button({
            style_class: 'silver-dock-app',
            style: this._buttonStyle(),
            child: icon,
            accessible_name: name,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            width: big + 2 * pad,
            height: big + 2 * pad,
        });
        // On the icon's outer edge, not the tile's.
        button.set_pivot_point(...this._xy(0.5, (this._edgeFirst ? pad : pad + big) / (big + 2 * pad)));

        const dots = new St.BoxLayout({
            style_class: 'silver-dock-dots',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setVertical(dots, this._vertical);
        // Named to tell its warnings from GNOME's own containers, see smoke.sh.
        const indicator = new St.Bin({name: 'silver-dock-indicator', child: dots});
        indicator.set_size(...this._xy(slot, -1));

        const item = {key, app, name, icon, badge, progress, fill, fraction: 0, button, indicator, dots, menu: null, room: 1,
            // After a rebuild (settings, unlock) start times are unknown, the apps count as settled.
            born: this._fresh ? 0 : GLib.get_monotonic_time() / 1000};
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
                // In the same frame, the bar's own notify comes a frame late.
                this._place();
            });
        });
        button.connect('clicked', (b, mouseButton) => {
            if (this._settings.get_boolean('squash'))
                this._squash(item);
            this._hideLabel(item);
            if (mouseButton === 3) {
                this._openMenu(item);
            } else if (app) {
                this._activate(item, mouseButton);
            } else {
                this._previews.hide();
                openPlace(key);
            }
        });
        button.connect('scroll-event', (actor, event) => this._scroll(item, event));
        // GNOME's app menu calls it for New Window and the app's actions.
        button.animateLaunch = () => this._launched(item);
        // Menu key or Shift+F10
        button.connect('popup-menu', () => this._openMenu(item));
        button.connect('key-focus-in', () => this._focusItem(item));
        button.connect('key-focus-out', () => this._focusItem(null));
        trustHover(button);
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
        this._previews.forget(item.button);
        item.menu?.destroy();
        [item.button, item.indicator, item.progress, item.badge].forEach(actor => actor.destroy());
    }

    _layout(animate = false) {
        const {icon, big, slot, thick, pad, inner, outer} = this._geom;
        const s = this._scale;
        const n = this._items.length;
        const sepGap = Math.round(slot * 0.4);
        const gaps = new Array(n + 1).fill(0);
        gaps[0] += EDGE * s;
        gaps[n] += EDGE * s;
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
            move(item.button, centers[i] - big / 2 - pad, (this._edgeFirst ? outer : inner + icon - big) - pad);
            move(item.indicator, centers[i] - slot / 2, this._edgeFirst ? outer - 7 * s : inner + icon + 2 * s);
        });
        this._rowSeps.forEach((sep, i) => {
            const at = this._bounds[i];
            if (at > 0 && at < n)
                move(sep, centers[at] - slot / 2 - gaps[at] + sepGap / 2, (this._edgeFirst ? outer : inner) + icon * 0.2);
        });
        this._row.set_size(...this._xy(width, thick));
        this._animate();
    }

    updateDots() {
        const focused = Shell.WindowTracker.get_default().focus_app;
        const glide = this._settings.get_boolean('glide');
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        const highlight = this._settings.get_boolean('highlight-active');
        for (const {app, dots, button} of this._items) {
            button.checked = highlight && Boolean(app) && app === focused;
            const n = app?.state === Shell.AppState.RUNNING
                ? Math.min(Math.max(app.get_n_windows(), 1), MAX_DOTS) : 0;
            const size = this._xy((app === focused ? DOT_LONG : DOT) * this._scale, DOT * this._scale);
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
        const item = this._items.find(other => other.app === app && !other.leaving);
        if (!item || app.state !== Shell.AppState.STARTING || fromTray())
            return;
        // A bounce from a click on the icon now also ends with the start.
        item.starting = true;
        if (this._settings.get_boolean('bounce'))
            this._bounce(item);
    }

    updateBadges() {
        const shown = this._settings.get_boolean('badges');
        for (const item of this._items) {
            const entry = shown && item.app ? this._ext.launcher?.get(item.app.get_id()) : null;
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
        const {icon, inner, outer} = this._geom;
        const size = icon * scale;
        const across = this._edgeFirst ? outer : inner + icon - size;
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

    // The icon moves, its button carries the hover transform. While GNOME reports the start the bounce ends
    // with it, also when it fails. Else (no StartupNotify) until the first window.
    _bounce(item) {
        const {icon} = item;
        // Unmapped (fullscreen) or without animations an ease ends at once: the hops would recurse.
        // Hidden nobody sees it, an ease keeps the compositor busy.
        const live = () => icon.mapped && !this._hidden && St.Settings.get().enable_animations;
        if (!live() || icon.get_transition(this._across.replace('_', '-')))
            return;
        const until = GLib.get_monotonic_time() + BOUNCE_MAX * 1000;
        const hop = () => icon.ease({
            [this._across]: this._dir * Math.round(this._geom.big * 0.4),
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            repeatCount: 1,
            autoReverse: true,
            onComplete: () => {
                const waiting = item.starting ? item.app.state === Shell.AppState.STARTING : !item.app.get_n_windows();
                if (live() && !item.leaving && waiting && GLib.get_monotonic_time() < until)
                    hop();
            },
        });
        hop();
    }

    // Bursts and pauses: an ease disables direct scanout (fullscreen games).
    updateAttention() {
        const enabled = this._settings.get_boolean('attention');
        const now = GLib.get_monotonic_time();
        let fresh = false;
        for (const item of this._items) {
            const was = item.attention;
            item.attention = enabled && Boolean(item.app) &&
                (Boolean(this._ext.launcher?.get(item.app.get_id())?.urgent) ||
                 item.app.get_windows().some(win => this._ext.wantsAttention(win)));
            if (was && !item.attention)
                item.calm = now;
            // Steam flashes its urgent flag on and off, that is one request.
            fresh ||= item.attention && !was && now - (item.calm ?? 0) > WIGGLE_EVERY * 1000;
        }
        // Before the wiggle, which a hidden bar skips.
        if (fresh && this._settings.get_boolean('autohide'))
            this._reveal();
        // Ends on its own, a flag going off and on must not restart the burst at once.
        if (this._items.some(item => item.attention) && !this._wiggleTimer) {
            this._wiggle();
            this._wiggleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WIGGLE_EVERY, () => {
                if (this._items.some(item => item.attention)) {
                    this._wiggle();
                    return GLib.SOURCE_CONTINUE;
                }
                this._wiggleTimer = 0;
                return GLib.SOURCE_REMOVE;
            });
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

    // Fades in only from hidden, between icons it just moves.
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
            [St.Side.BOTTOM]: [x + (w - lw) / 2, y + dy - lh - LABEL_GAP * this._scale],
            [St.Side.TOP]: [x + (w - lw) / 2, y + dy + h + LABEL_GAP * this._scale],
            [St.Side.LEFT]: [x + dx + w + LABEL_GAP * this._scale, y + (h - lh) / 2],
            [St.Side.RIGHT]: [x + dx - lw - LABEL_GAP * this._scale, y + (h - lh) / 2],
        }[this._side];
        this._label.set_position(Math.round(lx), Math.round(ly));
    }

    _openMenu(item) {
        this._previews.hide();
        if (!item.menu) {
            if (item.app) {
                item.menu = new AppMenu(item.button, this._side, {favoritesSection: true, showSingleWindows: true});
                item.menu.setApp(item.app);
                if (this._settings.get_boolean('media'))
                    item.fillMedia = mediaSection(item.menu, this._ext.media, item.app);
            } else {
                item.menu = new PopupMenu.PopupMenu(item.button, 0.5, this._side);
                placeActions(item.key).forEach(([label, action]) => item.menu.addAction(label, action));
            }
            Main.uiGroup.add_child(item.menu.actor);
            // One manager each: a shared one opens the menu of whatever icon or bar spot the pointer enters.
            new PopupMenu.PopupMenuManager(item.button).addMenu(item.menu);
        }
        item.fillMedia?.();
        item.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _openDockMenu([x, y]) {
        if (!this._dockMenu) {
            this._dockMenu = new PopupMenu.PopupMenu(this._bar, 0.5, this._side);
            this._dockMenu.addAction(_('Dock Settings'), () => this._ext.openPreferences());
            Main.uiGroup.add_child(this._dockMenu.actor);
            this._dockMenu.actor.hide();
            new PopupMenu.PopupMenuManager(this._bar).addMenu(this._dockMenu);
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
        // Later: focus also leaves while items die, and without animations an ease runs at once.
        this._queue('focus', () => {
            this._easeAmount();
            this._animate();
        });
    }

    _easeAmount() {
        if (STYLES[this._style].eased)
            return;
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

    _activate(item, mouseButton) {
        const {app, button} = item;
        const windows = app.get_windows();
        const middle = mouseButton === 2;
        const action = this._settings.get_string(middle ? 'middle-click' : 'click-action');
        // The previews take no keyboard focus.
        if (!middle && action === 'previews' && windows.length > 1 &&
            Clutter.get_current_event()?.type() !== Clutter.EventType.KEY_RELEASE) {
            this._previews.show(app, button, this._side);
            return;
        }
        this._previews.hide();
        if (middle && action !== 'new-window') {
            if (action === 'minimize')
                windows.forEach(win => win.minimize());
            else if (action === 'close')
                app.request_quit();
            return;
        }
        // GNOME only reports a start for apps with StartupNotify.
        if (!windows.length)
            this._launched(item);
        if (middle)
            app.open_new_window(-1);
        else if (!windows.length || action === 'raise' || Shell.WindowTracker.get_default().focus_app !== app)
            app.activate();
        else if (action === 'minimize' || windows.length === 1)
            windows.forEach(win => win.minimize());
        else
            Main.activateWindow(windows[windows.length - 1]);
    }

    _launched(item) {
        item.starting = false;
        if (this._settings.get_boolean('bounce'))
            this._bounce(item);
    }

    _queue(key, fn) {
        // Focus leaves the icons while destroy() takes them down.
        if (this._stopped)
            return;
        this._laters[key] ||= global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laters[key] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    queuePlace() {
        this._queue('place', () => this._place());
    }

    // A bar spanning the screen keeps its size, the icons may have to shrink or may grow back.
    _contentChanged() {
        if (this._full)
            this.queuePlace();
    }

    queueCheck() {
        // Also on key focus changes, as when a grab ends.
        this._queue('check', () => {
            if (this._dragGrab && global.stage.get_grab_actor() !== this._dragGrab)
                this.endDrag();
            if (this._refit) {
                this._refit = false;
                this._place();
            }
            this._updateFullscreen();
            this._updateOpacity();
            this._updateAutohide();
        });
    }

    // Not trackFullscreen: it also counts a maximized window once the top bar sits in an autohiding dock.
    _updateFullscreen() {
        const windows = global.workspace_manager.get_active_workspace().list_windows()
            .filter(win => win.get_monitor() === this.monitorIndex && win.showing_on_its_workspace());
        // GNOME places a menu only on a mapped source, ArcMenu's hotkey would open it where it last was.
        const source = global.stage.get_grab_actor()?._sourceActor;
        const fullscreen = !Main.overview.visible && !(source && this._bar.contains(source)) &&
            Boolean(global.display.sort_windows_by_stacking(windows).at(-1)?.is_fullscreen());
        if (fullscreen === this._fullscreen)
            return;
        this._fullscreen = fullscreen;
        for (const actor of [this._bar, this._bg, this._blur].filter(Boolean))
            actor.visible = !fullscreen;
        this._updateBarrier();
    }

    queueAttention() {
        this._queue('attention', () => this.updateAttention());
    }

    iconRect(app) {
        // Places have no app either.
        const button = app && this._items.find(item => item.app === app && !item.leaving)?.button;
        if (!button?.get_stage())
            return null;
        const [x, y] = button.get_transformed_position();
        const [width, height] = button.get_transformed_size();
        return new Mtk.Rectangle({
            x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
        });
    }

    previewsChanged() {
        // destroy() hides the previews of its icons.
        if (this._stopped)
            return;
        if (this._previews.shown)
            this._hideLabel();
        this._updateAutohide();
        this.queueCheck();
    }

    _place() {
        const m = Main.layoutManager.monitors[this.monitorIndex];
        if (!m)
            return;

        const area = this._vertical ? Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex) : m;
        const full = this._full;
        const size = this._vertical ? 'height' : 'width';
        if (full && this._bar[size] !== this._fullLength())
            this._bar[size] = this._fullLength();
        const [w, h] = this._bar.get_size();
        const room = this._vertical ? area.height : m.width;
        if (full ? this._fit(this._content(), this._fullLength()) : this._fit(this._vertical ? h : w, room))
            return;
        const centerX = m.x + Math.round((m.width - w) / 2);
        const centerY = area.y + Math.round((area.height - h) / 2);
        const [x, y] = {
            bottom: [centerX, m.y + m.height - h],
            top: [centerX, m.y],
            left: [m.x, centerY],
            right: [m.x + m.width - w, centerY],
        }[this._position];
        // The bar always takes its place at once, a popping icon grows the row every frame. Anything else
        // resizing it at once (a tray icon) glides: an offset along the bar eases out, also when the row
        // grows meanwhile and also from the middle of an earlier glide.
        const [prop, along, across] = this._vertical ? ['y', y, x] : ['x', x, y];
        const glide = this._along.replace('_', '-');
        // Rounded, the row's fractional width while popping leaves float noise.
        const others = Math.round((this._vertical ? h : w) - this._row[size]);
        if (this._placedAcross !== across || !this._bar.mapped) {
            this._bar.remove_transition(glide);
            this._bar[this._along] = 0;
        } else if (others !== this._others && this._bar[prop] !== along) {
            const offset = this._bar[prop] + this._bar[this._along] - along;
            this._bar.remove_transition(glide);
            this._bar[this._along] = offset;
            this._bar.ease({[this._along]: 0, duration: MOVE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._bar.get_transition(glide)?.connect_after('new-frame', () => this._animate());
        }
        this._bar.set_position(x, y);
        this._placedAcross = across;
        this._others = others;
        this._updateBarrier();
        this._animate();
        this._updateOpacity();
        this._updateAutohide();
    }

    // Not on an edge shared with another monitor, the barrier would block the way over.
    // now: else a moved or resized bar gets its new barrier once it rests, not every frame of a pop or glide.
    _updateBarrier(now = false) {
        const m = Main.layoutManager.monitors[this.monitorIndex];
        if (!m)
            return;
        const [along, length] = this._barAxes();
        const edge = {bottom: m.y + m.height, top: m.y, left: m.x, right: m.x + m.width}[this._position];
        const touches = {
            bottom: n => n.y === edge,
            top: n => n.y + n.height === edge,
            left: n => n.x + n.width === edge,
            right: n => n.x === edge,
        }[this._position];
        const beside = n => {
            const [start, size] = this._vertical ? [n.y, n.height] : [n.x, n.width];
            return start < along + length && start + size > along;
        };
        const shared = Main.layoutManager.monitors.some(n => n !== m && touches(n) && beside(n));
        // A fullscreen app keeps the edge, a push would slide the dock in and break direct scanout.
        const wanted = this._settings.get_boolean('autohide') && this._settings.get_boolean('edge-pressure') &&
            !shared && !this._fullscreen &&
            Boolean(global.backend.capabilities & Meta.BackendCapabilities.BARRIERS);
        const [x1, y1] = this._xy(along, edge);
        const [x2, y2] = this._xy(along + length, edge);
        const key = wanted ? `${x1} ${y1} ${x2} ${y2} ${this._position}` : null;
        if (key === this._barrierKey)
            return;
        if (!now && key && this._barrierKey) {
            if (this._barrierTimer)
                GLib.source_remove(this._barrierTimer);
            this._barrierTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOVE_TIME, () => {
                this._barrierTimer = 0;
                this._updateBarrier(true);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
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
            this._updateAutohide();
        });
    }

    _removeBarrier() {
        if (this._barrierTimer)
            GLib.source_remove(this._barrierTimer);
        this._barrierTimer = 0;
        this._pressure?.destroy();
        this._barrier?.destroy();
        this._pressure = this._barrier = this._barrierKey = null;
    }

    // Returns true when a rebuild is on its way.
    _fit(length, room) {
        // The rebuild would destroy a dragged icon, open menus and previews. The check redoes it.
        if (this._dragging || this._menuOpen() || this._ownsPreviews()) {
            this._refit = true;
            return false;
        }
        const {icon} = this._geom;
        const wanted = this._settings.get_int('icon-size') * this._scale;
        // px of bar per px of icon size: a slot is 1.2 icons, a separator gap 0.4 slots
        const seps = this._rowSeps.filter(sep => sep.visible).length;
        const perIcon = (this._items.length + 0.4 * seps) * 1.2;
        if (!perIcon)
            return false;
        let fit = this._fitIcon;
        const min = MIN_ICON * this._scale;
        if (length > room && icon > min)
            fit = Math.max(min, Math.floor(icon - (length - room) / perIcon) - 1);
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
        const {zoom, peak, slot, margin} = this._geom;
        const n = this._items.length;
        const eased = STYLES[this._style].eased;
        // The row moves under a resting pointer when an icon pops in or the bar glides.
        if (this._row.hover && !this._keyFocus) {
            const [px, py] = global.get_pointer();
            const [ok, x, y] = this._row.transform_stage_point(px, py);
            if (ok)
                this._pointer = this._vertical ? y : x;
        }
        const hovered = eased ? Number(this._row.hover || this._keyFocus !== null) : this._amount.value;
        const {scales, lifts, left, right, ...spread} = hover(
            this._style, n, slot, this._pointer, zoom, this._dragging ? 0 : hovered, this._gaps);
        // Spanning the screen the row keeps its start and grows into the free space after it.
        const full = this._full;
        const pin = full ? -Math.min(0, left) : 0;
        const shifts = spread.shifts.map(shift => shift + pin);

        this._items.forEach((item, i) => {
            const {button, indicator} = item;
            button.set_scale(scales[i] / peak, scales[i] / peak);
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
        const startShift = full ? 0 : Math.min(0, Math.round(left));
        const endShift = full ? 0 : Math.max(0, Math.round(right - this._restWidth));
        const [firstBox, ...otherBoxes] = this._boxes;
        const [firstSep, secondSep] = this._seps;
        [firstBox, firstSep].forEach(actor => actor && (actor[this._along] = startShift));
        [secondSep, ...otherBoxes].forEach(actor => actor && (actor[this._along] = endShift));

        const [rest, length, across, thick] = this._barAxes();
        // Where a glide has it now.
        const along = rest + this._bar[this._along];
        const bgAt = this._xy(along + startShift, across + (this._edgeFirst ? margin : 0));
        const bgSize = this._xy(length - startShift + endShift, thick - margin);
        this._bg.set_position(...bgAt);
        this._bg.set_size(...bgSize);
        this._placeBlur(...bgAt, ...bgSize);
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
        // A right click opens ArcMenu's context menu, not the menu.
        else if (this._settings.get_boolean('warp') &&
            (type === Clutter.EventType.TOUCH_BEGIN || event.get_button() !== Clutter.BUTTON_SECONDARY))
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
            settle(content, {[this._across]: lift ? this._dir * BUTTON_LIFT * this._scale : 0}, immediate, params);
        if (warp)
            this._useRocket(rocket);
        if (rocket && (immediate || !this._flying)) {
            const scale = warp ? 1.12 : 1;
            const y = warp ? this._dir * WARP_LIFT * this._scale : 0;
            settle(rocket, {translation_y: y, scale_x: scale, scale_y: scale}, immediate, params);
        }
    }

    _useRocket(rocket) {
        if (rocket === this._rocket)
            return;
        if (this._rocket) {
            this._rocket.disconnectObject(this);
            settle(this._rocket, {translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255}, true);
            this._rocket.set_pivot_point(0, 0);
        }
        this._rocket = rocket;
        rocket?.set_pivot_point(0.5, 0.5);
        rocket?.connectObject('destroy', () => (this._rocket = null), this);
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
            translation_y: up ? this._dir * WARP_LIFT * this._scale : 0, scale_x: scale, scale_y: scale,
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
            getDragActor: () => (dragActor = this._tintIcon(app.create_icon_texture(Math.round(this._geom.icon / this._scale)))),
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
        // Escape never unpins, though GNOME cancels once more on the release after it.
        draggable.connect('drag-cancelled', () => {
            Main.overview.cancelledItemDrag(delegate);
            const type = Clutter.get_current_event()?.type();
            escaped ||= type === Clutter.EventType.KEY_PRESS;
            const released = type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END;
            unpin = !escaped && released && this._farFromBar() &&
                AppFavorites.getAppFavorites().isFavorite(app.get_id());
            if (unpin && dragActor && this._settings.get_boolean('poof')) {
                this._poof(app, dragActor);
                // Hidden, the fly back ends at once, flush its relayout before GNOME destroys it.
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

    _poof(app, from) {
        const [x, y] = from.get_transformed_position();
        const [size] = from.get_transformed_size();
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        const ghost = this._tintIcon(app.create_icon_texture(Math.round(size / this._scale)));
        ghost.set_position(Math.round(x), Math.round(y));
        ghost.set_pivot_point(0.5, 0.5);
        Main.uiGroup.add_child(ghost);
        ghost.ease({scale_x: 1.5, scale_y: 1.5, opacity: 0, duration: POOF_TIME * 0.6, mode, onComplete: () => ghost.destroy()});
        const d = Math.round(size * 0.45);
        for (let i = 0; i < PUFFS; i++) {
            const puff = new St.Widget({style_class: 'silver-dock-poof', style: `border-radius: ${d / this._scale}px;`, width: d, height: d});
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
    startDrag(grab = null) {
        if (this._dragging)
            return;
        this._dragging = true;
        // Escape on a drag from a menu tells no monitor, only the drag's grab ends.
        this._dragGrab = grab;
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
        this._dragGrab = null;
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
        this.startDrag(global.stage.get_grab_actor());
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

    _ownsPreviews() {
        const anchor = this._previews.anchor;
        return Boolean(anchor) && this._bar.contains(anchor);
    }

    _menuOpen() {
        return Boolean(this._dockMenu?.isOpen || this._items.some(item => item.menu?.isOpen) ||
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
        const touched = this._settings.get_boolean('dynamic-opacity') && this._windowsOverlap(4 * this._scale);
        const target = Math.round(255 * (touched ? Math.max(opacity, 0.95) : opacity));
        if (target === this._bgOpacity)
            return;
        this._bgOpacity = target;
        this._bg.ease({opacity: target, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (this._surface?.haiku)
            this._paintSurface(target / 255);
        this._inkBar(target / 255);
    }

    // Text dark on a light color that shows, light on any other of ours. Themes may write either.
    _inkBar(alpha) {
        const ink = this._light && alpha >= 0.5;
        setClass(this._bar, 'silver-dock-ink', ink);
        setClass(this._bar, 'silver-dock-bright', !this._themed && !ink);
    }

    _shouldHide() {
        const focus = global.stage.key_focus;
        // With a barrier up, the pointer on the 1 px strip needs to push first.
        const hover = this._bar.hover && !(this._hidden && this._barrier);
        return this._settings.get_boolean('autohide') && !hover && !this._dragging && !this._menuOpen() &&
            !this._ownsPreviews() && !this._revealTimer && !(focus && this._bar.contains(focus)) &&
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

    _syncHover() {
        this._reach.visible = this._bar.hover;
        if (!this._bar.hover)
            this._hoverButton(null);
        this._updateAutohide();
    }

    _slide(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        if (hidden) {
            this._hideLabel();
            if (this._ownsPreviews())
                this._previews.hide();
        }
        const spring = !hidden && this._settings.get_boolean('springy');
        const params = spring
            ? {duration: SLIDE_TIME * 1.75, mode: Clutter.AnimationMode.EASE_OUT_BACK}
            : {duration: SLIDE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        const out = -this._dir;
        const [, , , thick] = this._barAxes();
        const shadow = this._settings.get_boolean('shadow') ? SHADOW * this._scale : 0;
        // A 1 px strip stays on screen and catches the pointer.
        this._bar.ease({...params, [this._across]: hidden ? out * (thick - 1) : 0, onComplete: () => this._syncHover()});
        for (const actor of [this._bg, this._blur].filter(Boolean))
            actor.ease({...params, [this._across]: hidden ? out * (thick + shadow) : 0});
    }
}
