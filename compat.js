// Differences between the GNOME versions the dock runs on (46 to 50). Check here
// first when a version breaks something, next to takeover.js.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// St.BoxLayout has an orientation from GNOME 48, before that a vertical flag.
const HAS_ORIENTATION = 'orientation' in St.BoxLayout.prototype;

export function setVertical(box, vertical) {
    if (HAS_ORIENTATION)
        box.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    else
        box.vertical = vertical;
}

// The system accent color, and -st-accent-color in stylesheets, from GNOME 47.
export const HAS_ACCENT = 'accent_color' in St.Settings.prototype;
