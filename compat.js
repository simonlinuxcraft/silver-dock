// Differences between GNOME 46 and 50, next to takeover.js the place to check first.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import St from 'gi://St';

// orientation from GNOME 48, vertical before
const HAS_ORIENTATION = 'orientation' in St.BoxLayout.prototype;

export function setVertical(box, vertical) {
    if (HAS_ORIENTATION)
        box.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    else
        box.vertical = vertical;
}

// Cogl.Color from GNOME 47
export const Color = Clutter.Color ?? Cogl.Color;

// accent color and -st-accent-color from GNOME 47
export const HAS_ACCENT = 'accent_color' in St.Settings.prototype;

// X11 only (gone in GNOME 50): a pointer that left for a window keeps its last spot on the stage, an actor
// sliding there gets a fake enter. Connect before other hover handlers, they then see it undone.
const X11 = !(Meta.is_wayland_compositor?.() ?? true);

export function trustHover(actor) {
    if (!X11)
        return;
    actor.connect('notify::hover', () => {
        const [x, y] = global.get_pointer();
        if (actor.hover && !actor.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)))
            actor.hover = false;
    });
}
