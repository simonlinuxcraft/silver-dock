// gjs -m test/layout-test.js
import {dropIndex, hover, rest, STYLES} from '../layout.js';

const SLOT = 56, N = 7, ZOOM = 1.6;
const near = (a, b) => Math.abs(a - b) < 1e-9;
const check = (ok, msg) => {
    if (!ok)
        throw new Error(msg);
};

// At rest nothing moves, whatever the style.
for (const style of Object.keys(STYLES)) {
    const r = hover(style, N, SLOT, 3.5 * SLOT, ZOOM, 0);
    check(r.scales.every(s => s === 1) && r.lifts.every(l => l === 0) &&
        r.shifts.every(s => near(s, 0)) && near(r.right, N * SLOT), `${style}: rest state not neutral`);
}

// Magnify, pointer on icon 3: full zoom in place, neighbours spread symmetrically.
let r = hover('magnify', N, SLOT, 3.5 * SLOT, ZOOM, 1);
check(near(r.scales[3], ZOOM) && near(r.shifts[3], 0), 'hovered icon not zoomed in place');
check(near(r.shifts[2], -r.shifts[4]) && r.shifts[2] < 0, 'neighbours not spread symmetrically');

// Magnify never overlaps, including the edges.
for (const px of [-20, 0, 0.3 * SLOT, 2.9 * SLOT, N * SLOT, N * SLOT + 20]) {
    r = hover('magnify', N, SLOT, px, ZOOM, 1);
    for (let i = 1; i < N; i++) {
        const gap = (i + 0.5) * SLOT + r.shifts[i] - ((i - 0.5) * SLOT + r.shifts[i - 1]);
        check(gap >= (r.scales[i] + r.scales[i - 1]) / 2 * SLOT - 1e-9, `overlap at px=${px}, i=${i}`);
    }
}

// Pointer left of the row: the row grows to the right only.
r = hover('magnify', N, SLOT, -20, ZOOM, 1);
check(near(r.left, 0), 'row moved left although pointer is left of it');

// Lift: only the hovered icon rises, anywhere inside its slot, nothing scales.
for (const px of [3.5 * SLOT, 3.05 * SLOT, 3.95 * SLOT]) {
    r = hover('lift', N, SLOT, px, ZOOM, 1);
    check(near(r.lifts[3], 0.2 * SLOT) && r.lifts.every((l, i) => i === 3 || l === 0), `lift wrong at px=${px}`);
    check(r.scales.every(s => s === 1) && r.shifts.every(s => s === 0), 'lift scaled or moved icons');
}

// Ripple: a symmetric wave that fades out, icons stay in their slots.
r = hover('ripple', N, SLOT, 3.5 * SLOT, ZOOM, 1);
check(r.lifts[3] > r.lifts[2] && r.lifts[2] > r.lifts[1] && r.lifts[1] > r.lifts[0], 'ripple not a wave');
check(near(r.lifts[2], r.lifts[4]) && near(r.lifts[0], 0), 'ripple not symmetric or not fading out');
check(r.shifts.every(s => s === 0), 'ripple moved icons');

// None does nothing even while hovered.
r = hover('none', N, SLOT, 3.5 * SLOT, ZOOM, 1);
check(r.scales.every(s => s === 1) && r.lifts.every(l => l === 0), 'none animated');

// Gaps: fixed space that does not scale, e.g. around separators.
const GAPS = [4, 0, 0, 20, 0, 0, 20, 4];
const base = rest(N, SLOT, GAPS);
check(near(base.width, N * SLOT + 48) && near(base.centers[3], 4 + 3.5 * SLOT + 20), 'rest layout with gaps wrong');
r = hover('magnify', N, SLOT, 0, ZOOM, 0, GAPS);
check(r.shifts.every(s => near(s, 0)) && near(r.right, base.width), 'gaps: rest state not neutral');
r = hover('magnify', N, SLOT, base.centers[2], ZOOM, 1, GAPS);
check(near(r.shifts[2], 0) && near(r.scales[2], ZOOM), 'gaps: hovered icon not zoomed in place');
for (const px of [-20, 0, base.centers[2] + 0.4 * SLOT, base.centers[3] - SLOT / 2 - 10, base.width, base.width + 30]) {
    r = hover('magnify', N, SLOT, px, ZOOM, 1, GAPS);
    for (let i = 1; i < N; i++) {
        const dist = base.centers[i] + r.shifts[i] - (base.centers[i - 1] + r.shifts[i - 1]);
        check(dist >= (r.scales[i] + r.scales[i - 1]) / 2 * SLOT + GAPS[i] - 1e-9, `gap squeezed at px=${px}, i=${i}`);
    }
    check(near(r.right - r.left, base.width + r.scales.reduce((a, b) => a + b - 1, 0) * SLOT), `gaps: width wrong at px=${px}`);
}
// Pointer inside a gap keeps its spot: the neighbours move away on both sides.
const inGap = base.centers[3] - SLOT / 2 - 10;
r = hover('magnify', N, SLOT, inGap, ZOOM, 1, GAPS);
check(r.shifts[2] < 0 && r.shifts[3] > 0, 'gaps: neighbours of a hovered gap do not move apart');

// Drop index: left or right half of a slot, clamped to the favorites.
const drop = rest(5, SLOT, [4, 0, 0, 0, 0, 4]).centers;
check(dropIndex(drop, SLOT, drop[2] - 5, null, 5, -1) === 2, 'drop left of centre not before the icon');
check(dropIndex(drop, SLOT, drop[2] + 5, null, 5, -1) === 3, 'drop right of centre not after the icon');
check(dropIndex(drop, SLOT, 9999, null, 3, -1) === 3, 'drop not clamped to the favorites');
// An open gap at 3 holds still while the pointer is inside it, and maps back behind it.
const gapStart = drop[3] - SLOT / 2;
for (const px of [gapStart + 1, gapStart + SLOT / 2, gapStart + SLOT - 1])
    check(dropIndex(drop, SLOT, px, 3, 5, -1) === 3, `open gap chases the pointer at px=${px}`);
check(dropIndex(drop, SLOT, drop[3] + SLOT + 5, 3, 5, -1) === 4, 'pointer behind an open gap not mapped back');
// Next to its own place an icon has nowhere to go.
check(dropIndex(drop, SLOT, drop[2] - 5, null, 5, 2) === null && dropIndex(drop, SLOT, drop[2] + 5, null, 5, 2) === null,
    'dropping an icon next to itself moves it');
check(dropIndex(drop, SLOT, drop[4] + 5, null, 5, 2) === 5, 'moving an icon to the end refused');

print('layout ok');
