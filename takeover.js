// The only place that touches GNOME Shell internals (the top bar's private
// boxes). Check this first when a new GNOME release breaks something.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Moves the top bar's left box into `bar` in front of `before` and its center and
// right box behind `after`, then hides the empty top bar. Returns the moved boxes.
// If the internals changed, nothing is touched and it returns an empty list.
export function takePanel(bar, before, after) {
    const panel = Main.panel;
    const boxes = [panel?._leftBox, panel?._centerBox, panel?._rightBox];
    if (!boxes.every(box => box?.get_parent() === panel))
        return [];

    boxes.forEach(box => panel.remove_child(box));
    const [left, center, right] = boxes;
    bar.insert_child_below(left, before);
    bar.insert_child_above(right, after);
    bar.insert_child_above(center, after);
    panel.hide();
    return boxes;
}

export function restorePanel(bar, boxes) {
    for (const box of boxes) {
        box.translation_x = box.translation_y = 0;
        if (box.get_parent() === bar)
            bar.remove_child(box);
        if (!box.get_parent())
            Main.panel.add_child(box);
    }
    if (boxes.length)
        Main.panel.show();
}
