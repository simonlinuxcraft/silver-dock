import Cairo from 'cairo';
import GLib from 'gi://GLib';
import St from 'gi://St';

const EVERY = 2;

function read(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

// CPU share, smoothed over the last samples, and the memory in use, each 0 to 1.
export class SystemLoad {
    constructor(onChange) {
        this.cpu = 0;
        this.memory = 0;
        this._last = null;
        this._sample();
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EVERY, () => {
            this._sample();
            onChange();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _sample() {
        try {
            // user nice system idle iowait irq softirq steal, the guest columns are already in user.
            const ticks = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
            const idle = ticks[3] + ticks[4];
            const total = ticks.reduce((sum, t) => sum + t, 0);
            if (this._last) {
                const spent = total - this._last.total;
                // iowait can run backwards.
                const now = spent > 0 ? Math.min(1, Math.max(0, 1 - (idle - this._last.idle) / spent)) : 0;
                this.cpu = (this.cpu + now) / 2;
            }
            this._last = {idle, total};
            const mem = Object.fromEntries(read('/proc/meminfo').split('\n').map(line => {
                const [key, value] = line.split(/:\s+/);
                return [key, parseInt(value)];
            }));
            this.memory = 1 - mem.MemAvailable / mem.MemTotal || 0;
        } catch (e) {
            console.log(`Silver Dock: no system load (${e.message})`);
        }
    }

    destroy() {
        GLib.source_remove(this._id);
    }
}

export function loadText(load) {
    return `CPU ${Math.round(load.cpu * 100)} %    RAM ${Math.round(load.memory * 100)} %`;
}

// CPU as the outer ring with its percentage inside, memory as the inner ring. Its own opaque tile like
// an app icon: the floating design has no bar behind it.
export function loadGraph(load, size) {
    const area = new St.DrawingArea({width: size, height: size});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        const r = w * 0.22;
        cr.newSubPath();
        cr.arc(w - r, r, r, -Math.PI / 2, 0);
        cr.arc(w - r, h - r, r, 0, Math.PI / 2);
        cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
        cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.setSourceRGB(0.17, 0.18, 0.21);
        cr.fill();

        const cx = w / 2, cy = h / 2;
        const ring = (radius, width, share, [red, green, blue]) => {
            cr.setLineWidth(width);
            cr.setSourceRGBA(1, 1, 1, 0.1);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();
            cr.setSourceRGB(red, green, blue);
            cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, share));
            cr.stroke();
        };
        const cpuColor = load.cpu > 0.85 ? [0.95, 0.35, 0.3] : load.cpu > 0.6 ? [0.98, 0.72, 0.25] : [0.4, 0.85, 0.6];
        ring(w * 0.34, w * 0.07, load.cpu, cpuColor);
        ring(w * 0.25, w * 0.04, load.memory, [0.55, 0.7, 0.95]);

        const text = `${Math.round(load.cpu * 100)}`;
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(w * (text.length > 2 ? 0.17 : 0.21));
        const ext = cr.textExtents(text);
        cr.setSourceRGB(0.93, 0.94, 0.96);
        cr.moveTo(cx - ext.width / 2 - ext.xBearing, cy - ext.height / 2 - ext.yBearing);
        cr.showText(text);
        cr.$dispose();
    });
    return area;
}
