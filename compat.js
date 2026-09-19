// Differences between GNOME 46 and 50, next to takeover.js the place to check first.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
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
