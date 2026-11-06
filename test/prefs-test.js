// Run by smoke.sh. Checks every row is bound to its key both ways.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

GLib.setenv('GSETTINGS_BACKEND', 'memory', true);
Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();

const root = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const metadata = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${root}/metadata.json`)[1]));
const {default: Prefs} = await import(`file://${root}/prefs.js`);

Adw.init();
const prefs = new Prefs({...metadata, dir: Gio.File.new_for_path(root), path: root});
const settings = prefs.getSettings();
const window = new Adw.PreferencesWindow();
await prefs.fillPreferencesWindow(window);

const rows = {};
const groups = {};
const walk = widget => {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Adw.PreferencesRow)
            rows[child.title] ??= child; // an expander holds a header row of the same title
        if (child instanceof Adw.PreferencesGroup)
            groups[child.title] = child;
        walk(child);
    }
};
walk(window);
const check = (ok, msg) => {
    if (!ok)
        throw new Error(msg);
};

rows['Icon size'].value = 40;
check(settings.get_int('icon-size') === 40, 'icon size row not written to the int key');
settings.set_int('margin', 20);
check(rows['Distance from screen edge'].value === 20, 'margin key not shown in its row');
rows['Strength'].value = 55;
check(settings.get_int('blur-radius') === 55, 'blur strength row not written');
rows['Magnification'].value = 2;
check(settings.get_double('zoom') === 2, 'zoom row not written');
rows['Hover animation'].selected = 2;
check(settings.get_string('animation') === 'lift', 'animation combo not written');
settings.set_string('animation', 'ripple');
check(rows['Hover animation'].selected === 1, 'animation key not shown in the combo');
rows['Click on an app'].selected = 2;
check(settings.get_string('click-action') === 'minimize', 'click combo not written');
settings.set_string('middle-click', 'close');
check(rows['Middle click'].selected === 2, 'middle click key not shown in its combo');
rows['Colors from'].selected = 3;
check(settings.get_string('colors') === 'wallpaper', 'wallpaper colors not written');
check(!rows['Color'].visible && rows['Background opacity (%)'].visible, 'wrong color rows for wallpaper colors');
rows['Colors from'].selected = 2;
check(settings.get_string('colors') === 'custom', 'colors combo not written');
check(rows['Color'].visible && rows['Background opacity (%)'].visible, 'color rows hidden with an own color');
settings.set_string('color', '#ec0101');
check(rows['Color'].activatable_widget.rgba.to_string() === 'rgb(236,1,1)', 'color key not shown on its button');
const green = new Gdk.RGBA();
green.parse('#00ff00');
rows['Color'].activatable_widget.rgba = green;
check(settings.get_string('color') === 'rgb(0,255,0)', 'color button not written');
settings.set_string('icon-color', '#ec0101');
check(rows['Icon color'].activatable_widget.rgba.to_string() === 'rgb(236,1,1)', 'icon color key not shown on its button');
rows['Icon color'].activatable_widget.rgba = green;
check(settings.get_string('icon-color') === 'rgb(0,255,0)', 'icon color button not written');
settings.set_string('colors', 'theme');
check(rows['Colors from'].selected === 1, 'colors key not shown in the combo');
check(!rows['Color'].visible && !rows['Background opacity (%)'].visible, 'color rows shown with theme colors');
settings.set_string('colors', 'dock');
check(!rows['Color'].visible && rows['Background opacity (%)'].visible, 'wrong color rows for the dock colors');
settings.set_string('animation', 'lift');
check(!rows['Magnification'].visible, 'magnification shown for lift');
settings.set_string('animation', 'rise');
check(rows['Magnification'].visible, 'magnification hidden for lift and grow');
settings.set_string('animation', 'magnify');
check(rows['Magnification'].visible, 'magnification hidden for magnify');
settings.set_string('position', 'bottom');
settings.set_boolean('keep-top-bar', false);
check(rows['Keep the top bar'].visible && !rows['Top bar in the dock\'s look'].visible, 'top bar rows wrong at the bottom');
settings.set_boolean('keep-top-bar', true);
check(rows['Top bar in the dock\'s look'].visible, 'top bar look hidden with a kept top bar');
settings.set_string('position', 'left');
check(!rows['Keep the top bar'].visible && rows['Top bar in the dock\'s look'].visible, 'top bar rows wrong on the left');
const inDock = ['Buttons lift on hover instead of lighting up', 'Light up the button of an open menu',
    'Warp start for the ArcMenu button'];
settings.set_string('position', 'top');
check(!rows['Keep the top bar'].visible && inDock.every(title => rows[title].visible), 'top bar rows wrong at the top');
settings.set_string('position', 'bottom');
check(rows['Keep the top bar'].visible && !inDock.some(title => rows[title].visible), 'top bar rows wrong with a kept top bar');
settings.set_boolean('keep-top-bar', false);
check(inDock.every(title => rows[title].visible), 'top bar effects hidden with the top bar in the dock');
settings.set_string('position', 'left');
check(!inDock.some(title => rows[title].visible), 'top bar effects shown on the left');
settings.set_string('colors', 'custom');
check(!rows['Light or dark'].visible, 'light or dark shown with an own color');
settings.set_string('colors', 'dock');
rows['Light or dark'].selected = 3;
check(settings.get_string('scheme') === 'system' && rows['Light or dark'].visible, 'light or dark combo not written');
rows['Hide when a window overlaps the bar'].enable_expansion = true;
check(settings.get_boolean('autohide'), 'autohide switch not written');
rows['Bounce while an app starts'].active = false;
check(!settings.get_boolean('bounce'), 'bounce switch not written');
check(rows['Support Silver Dock']?.activatable, 'ko-fi row missing');
rows['Design'].selected = 1;
check(settings.get_string('design') === 'float', 'design combo not written');
check(!rows['Separate islands for menu, apps and clock'].visible, 'islands row shown with the floating design');
rows['Design'].selected = 0;
check(rows['Separate islands for menu, apps and clock'].visible, 'islands row hidden with the silver design');
rows['Design'].selected = 1;
rows['Screen edge'].selected = 3;
check(settings.get_string('position') === 'right', 'position combo not written');
for (const [title, key] of [['Separators', 'separators'], ['Shadow', 'shadow'],
    ['Only come back when the pointer pushes against the edge', 'edge-pressure'],
    ['Count notifications of apps without their own badge', 'notification-badges'],
    ['A little cloud when an app is dragged off', 'poof'], ['Highlight the active app', 'highlight-active'],
    ['Blur the wallpaper behind the bar', 'blur'], ['Scroll on a free spot to switch workspaces', 'scroll-workspaces'],
    ['Media controls in the right click menu', 'media'], ['Opaque while a window touches the bar', 'dynamic-opacity'],
    ['Wiggle when an app asks for attention', 'attention'], ['Show app names on hover', 'tooltips'],
    ['Badges and progress on app icons', 'badges'], ['Trash', 'trash'], ['Removable drives (USB sticks, SD cards)', 'drives'],
    ['Drag to rearrange, pin and unpin apps', 'dnd'], ['Show window previews on hover', 'previews'],
    ['Top bar in the dock\'s look', 'style-top-bar'], ['Tint app icons', 'tint-icons'], ['Keep the top bar', 'keep-top-bar'],
    ['Apps pop in and out', 'pop'], ['Squash on click', 'squash'], ['Window dots glide', 'glide'],
    ['Rise in a wave after login and unlock', 'intro'], ['Badges pop up', 'badge-pop'],
    ['Bar springs back in after hiding', 'springy'], ['Windows minimize into their icon', 'minimize-to-icon'],
    ['Warp start for the ArcMenu button', 'warp'],
    ['Buttons lift on hover instead of lighting up', 'lift-buttons'], ['Light up the button of an open menu', 'open-highlight'], ['Internal drives too', 'internal-drives'],
    ['Show only that window while on its preview', 'peek'], ['A dock on every monitor', 'all-monitors'], ['Scroll over an icon to switch its windows', 'scroll']]) {
    const prop = rows[title] instanceof Adw.ExpanderRow ? 'enable_expansion' : 'active';
    rows[title][prop] = !settings.get_boolean(key);
    check(rows[title][prop] === settings.get_boolean(key), `${key} switch not written`);
}

print('prefs ok');
