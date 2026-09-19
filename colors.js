// Colors of the GTK theme in use, read from its CSS: @define-color names, followed
// through references. Colors written as functions (mix, shade, alpha) are skipped.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAMED = {black: '0, 0, 0', white: '255, 255, 255'};

// "r, g, b" of a plain CSS color, or null.
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
    if (m && (m[4] === undefined || Number(m[4]) > 0))
        return `${m[1]}, ${m[2]}, ${m[3]}`;
    return null;
}

// "r, g, b" of the first name the CSS defines as a plain color, or null.
export function definedColor(css, names) {
    // A later definition wins, as in CSS.
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

let cache = {key: null, files: []};

// The theme's CSS files, the libadwaita override first, then GTK 3 and 4 (dark
// variant first when dark is preferred).
function themeCss(name, dark) {
    const key = `${name} ${dark}`;
    if (cache.key === key)
        return cache.files;
    const bases = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
        .map(dir => GLib.build_filenamev([dir, 'themes', name]))
        .concat(GLib.build_filenamev([GLib.get_home_dir(), '.themes', name]));
    const variants = ['libadwaita/gtk.css', ...['gtk-3.0', 'gtk-4.0'].flatMap(version =>
        [dark ? `${version}/gtk-dark.css` : null, `${version}/gtk.css`].filter(Boolean))];
    const files = [];
    for (const base of bases) {
        for (const variant of variants) {
            try {
                const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([base, variant]));
                files.push(new TextDecoder().decode(bytes));
            } catch {
                // not part of this theme
            }
        }
        if (files.length)
            break;
    }
    // ponytail: cached per theme name, an edited theme file needs a theme switch or a restart
    cache = {key, files};
    return files;
}

// {bg, accent} of the GTK theme in use, each "r, g, b" or null.
export function gtkColors(settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})) {
    const files = themeCss(settings.get_string('gtk-theme'), settings.get_string('color-scheme') === 'prefer-dark');
    const first = names => files.map(css => definedColor(css, names)).find(Boolean) ?? null;
    return {
        bg: first(['window_bg_color', 'theme_bg_color']),
        accent: first(['accent_bg_color', 'theme_selected_bg_color']),
    };
}
