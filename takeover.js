// The only use of GNOME Shell internals, check here first when a release breaks.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Returns the moved boxes, none if the internals changed.
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
    // Panel menus now open upwards, the stylesheet drops the theme's bottom margin on them.
    Main.uiGroup.add_style_class_name('silver-dock-panel');
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
    if (boxes.length) {
        Main.panel.show();
        Main.uiGroup.remove_style_class_name('silver-dock-panel');
    }
}
