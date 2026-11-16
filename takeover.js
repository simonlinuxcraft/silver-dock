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

// Returns the moved boxes.
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

// The date menu's button, the weather goes next to it.
export function clockButton() {
    return Main.panel.statusArea.dateMenu?.container ?? null;
}

export function clockLabel() {
    return Main.panel.statusArea.dateMenu?._clockDisplay ?? null;
}

// The top bar's right box, wherever it is, and the AppIndicator icons in it or in the flyout.
export function trayBox() {
    return Main.panel._rightBox;
}

// AppIndicator's own object behind a tray button, it emits 'ready' once it knows the icon's id.
// Other extensions keep an icon under the same name.
export function trayIndicator(button) {
    const indicator = button._indicator;
    return indicator && 'isReady' in indicator ? indicator : null;
}

// The StatusNotifierItem id stays the same across restarts, the status area key does not.
// Legacy XEmbed icons (Wine) have no indicator, only the Shell.TrayIcon with its window class.
export function trayIcons() {
    return Object.values(Main.panel.statusArea).filter(item => item?.container).map(item => {
        const sni = item._indicator?.id;
        const wmClass = !sni && item._icon?.wm_class;
        if (!sni && !wmClass)
            return null;
        const id = sni ?? `legacy:${wmClass}`;
        const title = sni ? item._indicator.title || sni : item._icon.title || wmClass;
        return {id, title, container: item.container, menu: item.menu};
    }).filter(Boolean);
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
