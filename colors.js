// GTK theme colors from @define-color in its CSS, functions (mix, shade) are skipped.
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAMED = {black: '0, 0, 0', white: '255, 255, 255'};

// "r, g, b" or null
export function parseColor(value) {
    value = value.trim().toLowerCase();
    if (NAMED[value])
        return NAMED[value];
    let m = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (m) {
        const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
        return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    }
    m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m && m.slice(1, 4).every(c => Number(c) <= 255) && (m[4] === undefined || Number(m[4]) > 0))
        return `${m[1]}, ${m[2]}, ${m[3]}`;
    return null;
}

// Perceived brightness of "r, g, b", 0 to 255
export function luma(color) {
    return color.split(',').reduce((sum, c, i) => sum + c * [0.299, 0.587, 0.114][i], 0);
}

export function mix(base, color, share) {
    const to = color.split(',').map(Number);
    return base.split(',').map((c, i) => Math.round(Number(c) + (to[i] - c) * share)).join(', ');
}

export function averageColor(pixels, width, height, rowstride, channels) {
    const sum = [0, 0, 0];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            sum.forEach((s, c) => (sum[c] += pixels[y * rowstride + x * channels + c]));
    }
    return sum.map(s => Math.round(s / (width * height))).join(', ');
}

export function definedColor(css, names) {
    const defs = new Map([...css.matchAll(/@define-color\s+([\w-]+)\s+([^;]+);/g)]
        .map(([, name, value]) => [name, value.trim()]));
    const resolve = (name, depth) => {
        const value = defs.get(name);
        if (value === undefined || depth > 10)
            return null;
        return value.startsWith('@') ? resolve(value.slice(1), depth + 1) : parseColor(value);
    };
    for (const name of names) {
        const color = resolve(name, 0);
        if (color)
            return color;
    }
    return null;
}

let cache = {key: null, files: null};

// Like GTK, each file comes from the first folder that has it.
function loadThemeCss(name, dark, done) {
    const bases = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
        .map(dir => GLib.build_filenamev([dir, 'themes', name]))
        .concat(GLib.build_filenamev([GLib.get_home_dir(), '.themes', name]));
    const variants = ['libadwaita/gtk.css', ...['gtk-3.0', 'gtk-4.0'].flatMap(version =>
        [dark ? `${version}/gtk-dark.css` : null, `${version}/gtk.css`].filter(Boolean))];
    const files = [];
    const next = (variant, base) => {
        if (variant === variants.length) {
            done(files);
            return;
        }
        if (base === bases.length) {
            next(variant + 1, 0);
            return;
        }
        const file = Gio.File.new_for_path(GLib.build_filenamev([bases[base], variants[variant]]));
        file.load_contents_async(null, (f, result) => {
            let text = null;
            try {
                text = new TextDecoder().decode(f.load_contents_finish(result)[1]);
            } catch {
            }
            if (text === null) {
                next(variant, base + 1);
            } else {
                files.push(text);
                next(variant + 1, 0);
            }
        });
    };
    next(0, 0);
}

// Null until the theme's files are read, cached per theme name.
export function gtkColors(settings, onLoaded) {
    const name = settings.get_string('gtk-theme');
    const dark = settings.get_string('color-scheme') === 'prefer-dark';
    const key = `${name} ${dark}`;
    if (cache.key !== key) {
        cache = {key, files: null};
        loadThemeCss(name, dark, files => {
            if (cache.key !== key)
                return;
            cache.files = files;
            onLoaded();
        });
    }
    const files = cache.files ?? [];
    const first = names => files.map(css => definedColor(css, names)).find(Boolean) ?? null;
    return {
        bg: first(['window_bg_color', 'theme_bg_color']),
        accent: first(['accent_bg_color', 'theme_selected_bg_color']),
    };
}

let wallpaper = {key: null, color: null};

// Decoded in a thread, a big photo would stall the shell. Slideshows stay null.
export function wallpaperColor(settings, dark, onLoaded) {
    const uri = (dark && settings.get_string('picture-uri-dark')) || settings.get_string('picture-uri');
    const plain = settings.get_string('picture-options') === 'none' || !uri;
    const key = plain ? settings.get_string('primary-color') : uri;
    if (wallpaper.key === key)
        return wallpaper.color;
    wallpaper = {key, color: plain ? parseColor(key) : null};
    if (!plain) {
        Gio.File.new_for_uri(uri).read_async(GLib.PRIORITY_DEFAULT, null, (file, result) => {
            try {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(file.read_finish(result), 16, 16, false, null,
                    (stream, done) => {
                        try {
                            const p = GdkPixbuf.Pixbuf.new_from_stream_finish(done);
                            if (wallpaper.key !== key)
                                return;
                            wallpaper.color = averageColor(p.get_pixels(), p.width, p.height, p.rowstride, p.n_channels);
                            onLoaded();
                        } catch {
                        }
                    });
            } catch {
            }
        });
    }
    return wallpaper.color;
}
