// gjs -m test/colors-test.js
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {averageColor, definedColor, mix, parseColor, wallpaperColor} from '../colors.js';

const check = (ok, msg) => {
    if (!ok)
        throw new Error(msg);
};

check(parseColor('#EC0101') === '236, 1, 1', 'hex');
check(parseColor('#fff') === '255, 255, 255', 'short hex');
check(parseColor(' black ') === '0, 0, 0', 'named');
check(parseColor('rgba(8, 8, 8, 0.9)') === '8, 8, 8', 'rgba');
check(parseColor('rgba(8, 8, 8, 0)') === null, 'transparent has no color to take');
check(parseColor('mix(#fff, #000, 0.5)') === null, 'functions are skipped');
check(parseColor('rgb(300, 0, 0)') === null, 'channels above 255 are no color');
check(mix('0, 0, 0', '255, 255, 255', 0.4) === '102, 102, 102', 'mix moves the share');
check(mix('28, 29, 33', '28, 29, 33', 0.4) === '28, 29, 33', 'mix with itself');

const css = `
@define-color accent_bg_color #2777ff;
@define-color window_bg_color #080808;
@define-color theme_bg_color @window_bg_color;
@define-color accent_bg_color #ec0101;
@define-color loop_a @loop_b;
@define-color loop_b @loop_a;
@define-color shaded shade(#fff, 0.5);
`;
check(definedColor(css, ['accent_bg_color']) === '236, 1, 1', 'the later definition wins');
check(definedColor(css, ['theme_bg_color']) === '8, 8, 8', 'references are followed');
check(definedColor(css, ['missing', 'window_bg_color']) === '8, 8, 8', 'first name that resolves');
check(definedColor(css, ['loop_a']) === null, 'reference loops end');
check(definedColor(css, ['shaded']) === null, 'function values are skipped');

// 2x2 RGBA with 4 bytes of row padding: red, blue / red, blue
const pixels = [255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 9, 255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 9];
check(averageColor(pixels, 2, 2, 12, 4) === '128, 0, 128', 'mean skips alpha and row padding');

const settings = values => ({get_string: key => values[key] ?? ''});
check(wallpaperColor(settings({'picture-options': 'none', 'primary-color': '#204a87'}), false, () => {}) === '32, 74, 135',
    'a plain background gives its color');

const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 64, 64);
pixbuf.fill(0x40a0e0ff);
const [fd, path] = GLib.file_open_tmp('silver-dock-XXXXXX.png');
GLib.close(fd);
pixbuf.savev(path, 'png', [], []);
const uri = `file://${path}`;
const loaded = new Promise(resolve => {
    const first = wallpaperColor(settings({'picture-uri': uri, 'picture-options': 'zoom'}), true, resolve);
    check(first === null, 'an image is read in the background first');
});
const timeout = new Promise((resolve, reject) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => reject(new Error('wallpaper never loaded'))));
await Promise.race([loaded, timeout]);
check(wallpaperColor(settings({'picture-uri': uri, 'picture-options': 'zoom'}), true, () => {}) === '64, 160, 224',
    'the image mean, dark falls back to the light picture');
GLib.unlink(path);

print('colors ok');
