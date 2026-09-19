// Pure hover animation math. No gi imports, so the test runs under plain gjs.

// zoom: share of the zoom setting. lift: rise in slots. flat/range: distance
// from the pointer in slots with full and with no effect. spread: neighbours
// move apart instead of overlapping. eased: only the hovered icon counts, the
// caller animates each change over time instead of following the pointer.
export const STYLES = {
    magnify: {zoom: 1, lift: 0, flat: 0, range: 3, spread: true},
    ripple: {zoom: 0.25, lift: 0.3, flat: 0, range: 3, spread: false},
    lift: {zoom: 0, lift: 0.2, flat: 0.5, range: 0.5, spread: false, eased: true},
    none: {zoom: 0, lift: 0, flat: 0, range: 1, spread: false},
};

export function level(dist, flat, range) {
    if (dist <= flat)
        return 1;
    if (dist >= range)
        return 0;
    return (Math.cos(Math.PI * (dist - flat) / (range - flat)) + 1) / 2;
}

// Resting layout of n slots with gaps[i] px of fixed space before slot i
// (gaps[n] after the last). Returns slot centers and the total width.
export function rest(n, slot, gaps = []) {
    const centers = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
        x += gaps[i] ?? 0;
        centers.push(x + slot / 2);
        x += slot;
    }
    return {centers, width: x + (gaps[n] ?? 0)};
}

// Pointer at px in resting coordinates, amount 0..1 from the hover animation.
// Gaps never scale, only the slots do.
export function hover(style, n, slot, px, zoom, amount, gaps = []) {
    const s = STYLES[style] ?? STYLES.magnify;
    const {centers, width} = rest(n, slot, gaps);
    const scales = [];
    const lifts = [];
    for (let i = 0; i < n; i++) {
        const l = level(Math.abs(px - centers[i]) / slot, s.flat, s.range) * amount;
        scales.push(1 + (zoom - 1) * s.zoom * l);
        lifts.push(s.lift * slot * l);
    }
    if (!s.spread)
        return {scales, lifts, shifts: scales.map(() => 0), left: 0, right: width};

    // Keep the point under the pointer fixed, neighbours spread out around it.
    const p = Math.min(Math.max(px, 0), width);
    let mapped = 0;
    for (let i = 0; i < n; i++) {
        const start = centers[i] - slot / 2;
        const gap = gaps[i] ?? 0;
        mapped += Math.min(Math.max(p - (start - gap), 0), gap);
        mapped += slot * scales[i] * Math.min(Math.max((p - start) / slot, 0), 1);
    }
    mapped += Math.min(Math.max(p - (width - (gaps[n] ?? 0)), 0), gaps[n] ?? 0);
    const left = p - mapped;

    const shifts = [];
    let x = left;
    for (let i = 0; i < n; i++) {
        x += gaps[i] ?? 0;
        const w = slot * scales[i];
        shifts.push(x + w / 2 - centers[i]);
        x += w;
    }
    return {scales, lifts, shifts, left, right: x + (gaps[n] ?? 0)};
}

// Insertion index for a drop at px among the first `limit` slots. `centers` is the
// resting layout without the drop gap, `open` the index of the gap already open
// (or null): px is mapped as if that gap were closed, or the gap would chase the
// pointer. `from` is the dragged icon's own index (or -1), dropping right next to
// it changes nothing and gives null.
export function dropIndex(centers, slot, px, open, limit, from) {
    if (open !== null) {
        const start = open < centers.length ? centers[open] - slot / 2 : (centers.at(-1) ?? 0) + slot / 2;
        px = px < start ? px : Math.max(start, px - slot);
    }
    const index = Math.min(centers.filter(c => c < px).length, limit);
    return from >= 0 && (index === from || index === from + 1) ? null : index;
}
