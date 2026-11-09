import GLib from 'gi://GLib';
import St from 'gi://St';

const EVERY = 2;
const HISTORY = 8;

function read(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

// CPU share of the last HISTORY samples and the memory in use, each 0 to 1.
export class SystemLoad {
    constructor(onChange) {
        this.cpu = new Array(HISTORY).fill(0);
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
                this.cpu.shift();
                this.cpu.push(spent > 0 ? 1 - (idle - this._last.idle) / spent : 0);
            }
            this._last = {idle, total};
            const mem = Object.fromEntries(read('/proc/meminfo').split('\n').map(line => {
                const [key, value] = line.split(/:\s+/);
                return [key, parseInt(value)];
            }));
            this.memory = 1 - mem.MemAvailable / mem.MemTotal;
        } catch (e) {
            console.log(`Silver Dock: no system load (${e.message})`);
        }
    }

    destroy() {
        GLib.source_remove(this._id);
    }
}

// CPU history as bars, the memory as the wider bar on the right. Its own opaque tile like an app icon:
// the floating design has no bar behind it.
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

        const pad = w * 0.16;
        const inner = h - 2 * pad;
        const step = (w - 2 * pad) / (HISTORY + 3);
        const bar = (x, width, share) => {
            const height = Math.max(1, Math.min(1, share) * inner);
            cr.rectangle(x, h - pad - height, width, height);
            cr.fill();
        };
        cr.setSourceRGB(0.4, 0.85, 0.6);
        load.cpu.forEach((share, i) => bar(pad + i * step, step * 0.7, share));
        cr.setSourceRGB(0.55, 0.7, 0.95);
        bar(pad + (HISTORY + 1) * step, step * 2, load.memory);
        cr.$dispose();
    });
    return area;
}
