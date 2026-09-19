import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SilverDockPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // The instance method needs no lookup of the extension by file path.
        const _ = text => this.gettext(text);
        const settings = this.getSettings();

        // Several pages give the window a switcher at the top.
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
        };
        const toggle = (g, key, title) => {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            g.add(row);
        };
        // A string key with fixed choices, options are [value, label] pairs.
        const choice = (g, key, title, options) => {
            const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(([, label]) => label))});
            const show = () => {
                row.selected = Math.max(0, options.findIndex(([id]) => id === settings.get_string(key)));
            };
            show();
            settings.connect(`changed::${key}`, show);
            row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
            g.add(row);
        };

        const look = page(_('Appearance'), 'applications-graphics-symbolic');
        const where = group(look, _('Position'));
        choice(where, 'position', _('Screen edge'),
            [['bottom', _('Bottom')], ['top', _('Top')], ['left', _('Left')], ['right', _('Right')]]);
        toggle(where, 'keep-top-bar', _('Keep the top bar (bar at the bottom)'));
        toggle(where, 'style-top-bar', _('Top bar in the dock\'s look (when on its own)'));
        const size = group(look, _('Size'));
        spin(size, 'icon-size', _('Icon size'), 24, 96, 2);
        spin(size, 'margin', _('Distance from screen edge'), 0, 48, 1);
        spin(size, 'radius', _('Corner radius'), 0, 48, 1);
        const colors = group(look, _('Colors'));
        toggle(colors, 'theme-colors', _('Colors from the shell and GTK theme'));
        spin(colors, 'opacity', _('Background opacity (%)'), 0, 100, 5);
        toggle(colors, 'dynamic-opacity', _('Opaque while a window touches the bar'));
        toggle(colors, 'separators', _('Separators'));

        const motion = page(_('Animation'), 'media-playback-start-symbolic');
        const hovering = group(motion, _('Hover'));
        choice(hovering, 'animation', _('Hover animation'),
            [['magnify', _('Magnify')], ['ripple', _('Ripple')], ['lift', _('Lift')], ['none', _('None')]]);
        spin(hovering, 'zoom', _('Magnification'), 1, 2.5, 0.1, 1);
        const icons = group(motion, _('Icons'));
        toggle(icons, 'pop', _('Apps pop in and out'));
        toggle(icons, 'squash', _('Squash on click'));
        toggle(icons, 'glide', _('Window dots glide'));
        toggle(icons, 'intro', _('Rise in a wave after login and unlock'));
        const status = group(motion, _('App status'));
        toggle(status, 'bounce', _('Bounce while an app starts'));
        toggle(status, 'attention', _('Wiggle when an app asks for attention'));
        toggle(status, 'badges', _('Badges and progress on app icons'));
        toggle(status, 'badge-pop', _('Badges pop up'));
        const windows = group(motion, _('Bar and windows'));
        toggle(windows, 'springy', _('Bar springs back in after hiding'));
        toggle(windows, 'minimize-to-icon', _('Windows minimize into their icon'));
        const topBar = group(motion, _('Top bar content in the dock'));
        toggle(topBar, 'warp', _('Warp start for the ArcMenu button'));
        toggle(topBar, 'lift-buttons', _('Buttons lift on hover instead of lighting up'));

        const behavior = page(_('Behavior'), 'preferences-system-symbolic');
        const bar = group(behavior, _('Bar'));
        toggle(bar, 'autohide', _('Hide when a window overlaps the bar'));
        toggle(bar, 'tooltips', _('Show app names on hover'));
        toggle(bar, 'previews', _('Show window previews on hover'));
        toggle(bar, 'dnd', _('Drag to rearrange, pin and unpin apps'));
        const places = group(behavior, _('Places'));
        toggle(places, 'trash', _('Trash'));
        toggle(places, 'drives', _('Removable drives (USB sticks, SD cards)'));
        toggle(places, 'internal-drives', _('Internal drives too'));
    }
}
