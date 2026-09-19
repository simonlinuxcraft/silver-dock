// gjs -m test/colors-test.js
import {definedColor, parseColor} from '../colors.js';

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

print('colors ok');
