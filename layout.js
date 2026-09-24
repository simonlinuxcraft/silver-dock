// No gi imports, the test runs under plain gjs.

// zoom: share of the zoom setting. lift: in slots. flat/range: pointer distance in
// slots with full and with no effect. eased: the caller animates each change.
export const STYLES = {
    magnify: {zoom: 1, lift: 0, flat: 0, range: 3, spread: true},
    ripple: {zoom: 0.25, lift: 0.3, flat: 0, range: 3, spread: false},
    lift: {zoom: 0, lift: 0.2, flat: 0.5, range: 0.5, spread: false, eased: true},
    none: {zoom: 0, lift: 0, flat: 0, range: 1, spread: false},
};

function level(dist, flat, range) {
    if (dist <= flat)
        return 1;
    if (dist >= range)
        return 0;
    return (Math.cos(Math.PI * (dist - flat) / (range - flat)) + 1) / 2;
}

// gaps[i]: fixed px before slot i, gaps[n] after the last.
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

export function hover(style, n, slot, px, zoom, amount, gaps = []) {
    const s = STYLES[style];
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

    // The point under the pointer stays fixed. Only slots grow, gaps can be negative (popping icons).
    const p = Math.min(Math.max(px, 0), width);
    let mapped = p;
    for (let i = 0; i < n; i++)
        mapped += slot * (scales[i] - 1) * Math.min(Math.max((p - centers[i] + slot / 2) / slot, 0), 1);
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

// px is mapped as if the open gap were closed, or the gap would chase the pointer.
// null right next to the dragged icon's own index `from`.
export function dropIndex(centers, slot, px, open, limit, from) {
    if (open !== null) {
        const start = open < centers.length ? centers[open] - slot / 2 : (centers.at(-1) ?? 0) + slot / 2;
        px = px < start ? px : Math.max(start, px - slot);
    }
    const index = Math.min(centers.filter(c => c < px).length, limit);
    return from >= 0 && (index === from || index === from + 1) ? null : index;
}
