// GNOME Shell internals, check here first when a release breaks. dock.js also reads _delegate of menus.
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME stretches these pills to the bar's height, in the taller dock they turn into circles.
function pills() {
    const area = Main.panel.statusArea;
    return [area.screenRecording, area.screenSharing].filter(Boolean);
}

// The top bar's boxes while GNOME holds them, none if the internals changed.
export function panelBoxes() {
    const panel = Main.panel;
    const boxes = [panel?._leftBox, panel?._centerBox, panel?._rightBox];
    return boxes.every(box => box?.get_parent() === panel) ? boxes : [];
}

// Returns the moved boxes, none if the internals changed.
export function takePanel(bar, before, after) {
    const panel = Main.panel;
    const boxes = panelBoxes();
    if (!boxes.length)
        return [];

    boxes.forEach(box => panel.remove_child(box));
    const [left, center, right] = boxes;
    bar.insert_child_below(left, before);
    bar.insert_child_above(right, after);
    bar.insert_child_above(center, after);
    panel.hide();
    pills().forEach(pill => (pill.y_align = Clutter.ActorAlign.CENTER));
    // Panel menus now open upwards, the stylesheet drops the theme's bottom margin on them.
    Main.uiGroup.add_style_class_name('silver-dock-panel');
    return boxes;
}

// The top bar clock's one line of date and time.
export function clockLabel() {
    return Main.panel.statusArea.dateMenu?._clockDisplay ?? null;
}

// The date menu's own client, GNOME's has no destroy() and a second one would leak.
export function weatherClient() {
    return Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
}

// The top bar's right box, wherever it is, and the AppIndicator icons in it or in the flyout.
export function trayBox() {
    return Main.panel._rightBox;
}

// The StatusNotifierItem id stays the same across restarts, the status area key does not.
export function trayIcons() {
    return Object.values(Main.panel.statusArea)
        .filter(item => item?._indicator?.id && item.container)
        .map(item => ({id: item._indicator.id, title: item._indicator.title || item._indicator.id,
            container: item.container, menu: item.menu}));
}

export function restorePanel(bar, boxes) {
    for (const box of boxes) {
        box.translation_x = box.translation_y = 0;
        box.set_style(null);
        if (box.get_parent() === bar)
            bar.remove_child(box);
        if (!box.get_parent())
            Main.panel.add_child(box);
    }
    if (boxes.length) {
        Main.panel.show();
        pills().forEach(pill => (pill.y_align = Clutter.ActorAlign.FILL));
        Main.uiGroup.remove_style_class_name('silver-dock-panel');
    }
}
