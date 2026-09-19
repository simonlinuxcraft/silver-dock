import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SilverDockPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // The module gettext finds the extension by its file path, which fails in the tests.
        const _ = text => this.gettext(text);
        const settings = this.getSettings();

        const page = (title, iconName) => {
            const p = new Adw.PreferencesPage({title, icon_name: iconName});
            window.add(p);
            return p;
        };
        const group = (p, title) => {
            const g = new Adw.PreferencesGroup({title});
            p.add(g);
            return g;
        };
        const spin = (g, key, title, lower, upper, step, digits = 0) => {
            const row = Adw.SpinRow.new_with_range(lower, upper, step);
            row.set_title(title);
            row.set_digits(digits);
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            g.add(row);
            return row;
        };
        const put = (g, row) => (g instanceof Adw.ExpanderRow ? g.add_row(row) : g.add(row));
        const toggle = (g, key, title) => {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            put(g, row);
            return row;
        };
        const fold = (g, key, title) => {
            const row = new Adw.ExpanderRow({title, show_enable_switch: true});
            settings.bind(key, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
            row.expanded = false;
            g.add(row);
            return row;
        };
        const choice = (g, key, title, options) => {
            const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(([, label]) => label))});
            const show = () => {
                row.selected = Math.max(0, options.findIndex(([id]) => id === settings.get_string(key)));
            };
            show();
            settings.connect(`changed::${key}`, show);
            row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
            g.add(row);
            return row;
        };
        const showIf = (row, test, ...keys) => {
            const update = () => {
                row.visible = test();
            };
            update();
            keys.forEach(key => settings.connect(`changed::${key}`, update));
        };
        const color = (g, key, title) => {
            const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER});
            const row = new Adw.ActionRow({title, activatable_widget: button});
            row.add_suffix(button);
            put(g, row);
            const show = () => {
                const rgba = new Gdk.RGBA();
                if (rgba.parse(settings.get_string(key)) && !rgba.equal(button.rgba))
                    button.rgba = rgba;
            };
            show();
            settings.connect(`changed::${key}`, show);
            button.connect('notify::rgba', () => settings.set_string(key, button.rgba.to_string()));
            return row;
        };
        const is = (key, ...values) => values.includes(settings.get_string(key));

        const look = page(_('Appearance'), 'applications-graphics-symbolic');
        const where = group(look, _('Position'));
        choice(where, 'position', _('Screen edge'),
            [['bottom', _('Bottom')], ['top', _('Top')], ['left', _('Left')], ['right', _('Right')]]);
        toggle(where, 'all-monitors', _('A dock on every monitor'));
        showIf(toggle(where, 'keep-top-bar', _('Keep the top bar')), () => is('position', 'bottom'), 'position');
        showIf(toggle(where, 'style-top-bar', _('Top bar in the dock\'s look')),
            () => is('position', 'left', 'right') || is('position', 'bottom') && settings.get_boolean('keep-top-bar'),
            'position', 'keep-top-bar');
        const size = group(look, _('Size and layout'));
        spin(size, 'icon-size', _('Icon size'), 24, 96, 2);
        spin(size, 'margin', _('Distance from screen edge'), 0, 48, 1);
        spin(size, 'radius', _('Corner radius'), 0, 48, 1);
        toggle(size, 'separators', _('Separators'));
        const colors = group(look, _('Colors'));
        choice(colors, 'colors', _('Colors from'),
            [['dock', _('Silver Dock')], ['theme', _('Shell and GTK theme')], ['custom', _('Own color')]]);
        showIf(color(colors, 'color', _('Color')), () => is('colors', 'custom'), 'colors');
        showIf(spin(colors, 'opacity', _('Background opacity (%)'), 0, 100, 5), () => !is('colors', 'theme'), 'colors');
        toggle(colors, 'dynamic-opacity', _('Opaque while a window touches the bar'));
        color(fold(colors, 'tint-icons', _('Tint app icons')), 'icon-color', _('Icon color'));

        const behavior = page(_('Behavior'), 'preferences-system-symbolic');
        const bar = group(behavior, _('Bar'));
        toggle(bar, 'autohide', _('Hide when a window overlaps the bar'));
        toggle(bar, 'tooltips', _('Show app names on hover'));
        toggle(fold(bar, 'previews', _('Show window previews on hover')), 'peek', _('Show only that window while on its preview'));
        const icons = group(behavior, _('App icons'));
        toggle(icons, 'dnd', _('Drag to rearrange, pin and unpin apps'));
        toggle(icons, 'scroll', _('Scroll over an icon to switch its windows'));
        toggle(fold(icons, 'badges', _('Badges and progress on app icons')), 'badge-pop', _('Badges pop up'));
        const places = group(behavior, _('Places'));
        toggle(places, 'trash', _('Trash'));
        toggle(fold(places, 'drives', _('Removable drives (USB sticks, SD cards)')), 'internal-drives', _('Internal drives too'));

        const motion = page(_('Animation'), 'media-playback-start-symbolic');
        const hovering = group(motion, _('Hover'));
        choice(hovering, 'animation', _('Hover animation'),
            [['magnify', _('Magnify')], ['ripple', _('Ripple')], ['lift', _('Lift')], ['none', _('None')]]);
        showIf(spin(hovering, 'zoom', _('Magnification'), 1, 2.5, 0.1, 1), () => is('animation', 'magnify', 'ripple'), 'animation');
        const moving = group(motion, _('Icons'));
        toggle(moving, 'pop', _('Apps pop in and out'));
        toggle(moving, 'squash', _('Squash on click'));
        toggle(moving, 'glide', _('Window dots glide'));
        toggle(moving, 'intro', _('Rise in a wave after login and unlock'));
        toggle(moving, 'bounce', _('Bounce while an app starts'));
        toggle(moving, 'attention', _('Wiggle when an app asks for attention'));
        const windows = group(motion, _('Bar and windows'));
        toggle(windows, 'springy', _('Bar springs back in after hiding'));
        toggle(windows, 'minimize-to-icon', _('Windows minimize into their icon'));
        const topBar = group(motion, _('Top bar content in the dock'));
        toggle(topBar, 'warp', _('Warp start for the ArcMenu button'));
        toggle(topBar, 'lift-buttons', _('Buttons lift on hover instead of lighting up'));
    }
}
