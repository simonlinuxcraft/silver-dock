import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';

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
        const group = (p, title = null) => {
            const g = new Adw.PreferencesGroup({title});
            p.add(g);
            return g;
        };
        const spin = (g, key, title, lower, upper, step, digits = 0) => {
            const row = Adw.SpinRow.new_with_range(lower, upper, step);
            row.set_title(title);
            row.set_digits(digits);
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            put(g, row);
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
            let showing = false;
            const show = () => {
                showing = true;
                row.selected = Math.max(0, options.findIndex(([id]) => id === settings.get_string(key)));
                showing = false;
            };
            show();
            settings.connect(`changed::${key}`, show);
            row.connect('notify::selected', () => {
                if (!showing)
                    settings.set_string(key, options[row.selected][0]);
            });
            put(g, row);
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
        const session = new Soup.Session({timeout: 20});
        const setPlace = (name, lat = 0, lon = 0) =>
            settings.set_value('weather-location', new GLib.Variant('(sdd)', [name, lat, lon]));
        // The typed name to coordinates, the first hit is the biggest place of that name.
        let search = null;
        const findPlace = row => {
            // A slower answer to an earlier name must not win.
            search?.cancel();
            const name = row.text.trim();
            row.remove_css_class('error');
            if (!name)
                return setPlace('');
            if (name === settings.get_value('weather-location').deepUnpack()[0])
                return;
            const lang = GLib.get_language_names()[0].match(/^[a-z]{2}/)?.[0] ?? 'en';
            const message = Soup.Message.new('GET', 'https://geocoding-api.open-meteo.com/v1/search' +
                `?count=1&language=${lang}&name=${encodeURIComponent(name)}`);
            search = new Gio.Cancellable();
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, search, (s, result) => {
                let found;
                try {
                    found = JSON.parse(new TextDecoder().decode(s.send_and_read_finish(result).get_data())).results?.[0];
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    console.warn(`Silver Dock: ${e.message}`);
                }
                // Typed on meanwhile, that text waits for its own apply.
                if (row.text.trim() !== name)
                    return;
                if (!found) {
                    row.add_css_class('error');
                    return;
                }
                const label = [found.name, found.country].filter(Boolean).join(', ');
                setPlace(label, found.latitude, found.longitude);
                row.text = label;
            });
        };

        const topBarInDock = () => is('position', 'top') || is('position', 'bottom') && !settings.get_boolean('keep-top-bar');

        const general = page(_('General'), 'preferences-system-symbolic');
        const where = group(general, _('Position'));
        choice(where, 'position', _('Screen edge'),
            [['bottom', _('Bottom')], ['top', _('Top')], ['left', _('Left')], ['right', _('Right')]]);
        toggle(where, 'all-monitors', _('A dock on every monitor'));
        // At the top the top bar content always moves into the dock.
        const topBar = group(general, _('Top bar'));
        showIf(toggle(topBar, 'keep-top-bar', _('Keep the top bar')), () => is('position', 'bottom'), 'position');
        showIf(toggle(topBar, 'style-top-bar', _('Top bar in the dock\'s look')), () => !topBarInDock(),
            'position', 'keep-top-bar');
        showIf(toggle(topBar, 'lift-buttons', _('Buttons lift on hover instead of lighting up')), topBarInDock,
            'position', 'keep-top-bar');
        showIf(toggle(topBar, 'open-highlight', _('Light up the button of an open menu')), topBarInDock,
            'position', 'keep-top-bar');
        const weather = fold(topBar, 'weather', _('Weather next to the clock'));
        weather.subtitle = _('The place you type in and your IP address go to Open-Meteo');
        const place = new Adw.EntryRow({title: _('Place, the weather comes from Open-Meteo'), show_apply_button: true,
            text: settings.get_value('weather-location').deepUnpack()[0]});
        place.connect('apply', () => findPlace(place));
        weather.add_row(place);
        choice(weather, 'weather-unit', _('Unit'), [['celsius', _('Celsius, km/h')], ['fahrenheit', _('Fahrenheit, mph')]]);
        const hiding = group(general, _('Hiding'));
        toggle(fold(hiding, 'autohide', _('Hide when a window overlaps the bar')), 'edge-pressure',
            _('Only come back when the pointer pushes against the edge'));

        const appearance = page(_('Appearance'), 'applications-graphics-symbolic');
        const bar = group(appearance, _('Bar'));
        choice(bar, 'design', _('Design'), [['silver', _('Silver Dock')], ['float', _('Floating')]]);
        // Floating always has them, and they split the top bar's content: none without it in the dock.
        showIf(toggle(bar, 'islands', _('Separate islands for menu, apps and clock')),
            () => is('design', 'silver') && topBarInDock(), 'design', 'position', 'keep-top-bar');
        showIf(toggle(bar, 'tray-pill', _('Pill behind the tray icons')), topBarInDock, 'position', 'keep-top-bar');
        spin(bar, 'margin', _('Distance from screen edge'), 0, 48, 1);
        spin(bar, 'radius', _('Corner radius'), 0, 48, 1);
        toggle(bar, 'shadow', _('Shadow'));
        toggle(bar, 'separators', _('Separators'));
        spin(fold(bar, 'blur', _('Blur the wallpaper behind the bar')), 'blur-radius', _('Strength'), 5, 100, 5);
        const colors = group(appearance, _('Colors'));
        choice(colors, 'colors', _('Colors from'),
            [['dock', _('Design default')], ['theme', _('Shell and GTK theme')], ['custom', _('Own color')],
                ['wallpaper', _('Wallpaper')]]);
        // Only the design's own colors come in light and dark.
        showIf(choice(colors, 'scheme', _('Light or dark'), [['design', _('As the design')], ['light', _('Light')],
            ['dark', _('Dark')], ['system', _('As the system')]]), () => is('colors', 'dock'), 'colors');
        showIf(color(colors, 'color', _('Color')), () => is('colors', 'custom'), 'colors');
        showIf(spin(colors, 'opacity', _('Background opacity (%)'), 0, 100, 5), () => !is('colors', 'theme'), 'colors');
        toggle(colors, 'dynamic-opacity', _('Opaque while a window touches the bar'));
        const icons = group(appearance, _('Icons'));
        spin(icons, 'icon-size', _('Icon size'), 24, 96, 2);
        toggle(icons, 'highlight-active', _('Highlight the active app'));
        color(fold(icons, 'tint-icons', _('Tint app icons')), 'icon-color', _('Icon color'));

        const behavior = page(_('Behavior'), 'input-mouse-symbolic');
        const clicks = group(behavior, _('Clicks and scrolling'));
        const minimizeAll = _('Minimize all its windows');
        choice(clicks, 'click-action', _('Click on an app'), [['previews', _('Previews if it has several windows')],
            ['cycle', _('Minimize or switch windows')], ['minimize', minimizeAll], ['raise', _('Only bring to the front')]]);
        choice(clicks, 'middle-click', _('Middle click'), [['new-window', _('New window')], ['minimize', minimizeAll],
            ['close', _('Close the app')], ['none', _('Nothing')]]);
        toggle(clicks, 'scroll', _('Scroll over an icon to switch its windows'));
        toggle(clicks, 'scroll-workspaces', _('Scroll on a free spot to switch workspaces'));
        toggle(clicks, 'dnd', _('Drag to rearrange, pin and unpin apps'));
        const pointing = group(behavior, _('Names and previews'));
        toggle(pointing, 'tooltips', _('Show app names on hover'));
        toggle(fold(pointing, 'previews', _('Show window previews on hover')), 'peek', _('Show only that window while on its preview'));
        const extras = group(behavior, _('Badges and media'));
        const badges = fold(extras, 'badges', _('Badges and progress on app icons'));
        toggle(badges, 'notification-badges', _('Count notifications of apps without their own badge'));
        toggle(badges, 'badge-pop', _('Badges pop up'));
        toggle(extras, 'media', _('Media controls in the right click menu'));
        toggle(extras, 'recent-files', _('Recent files in the right click menu'));
        const places = group(behavior, _('Places'));
        toggle(places, 'trash', _('Trash'));
        toggle(fold(places, 'drives', _('Removable drives (USB sticks, SD cards)')), 'internal-drives', _('Internal drives too'));
        toggle(places, 'downloads', _('Downloads'));
        toggle(places, 'system-monitor', _('System load'));
        const tray = fold(group(behavior, _('Tray')), 'tray-overflow', _('Collect tray icons behind an arrow'));
        let pins = [];
        const fillTray = () => {
            pins.forEach(row => tray.remove(row));
            const known = settings.get_strv('tray-known').map(entry => entry.split('\t'));
            const titles = known.map(([id, title]) => title || id);
            pins = known.length ? known.map(([id], i) => {
                // Ubuntu's update notifiers share one title.
                const twin = titles.filter(title => title === titles[i]).length > 1;
                // Titles come from the apps, an & would break the markup.
                const row = new Adw.SwitchRow({title: twin ? `${titles[i]} (${id})` : titles[i],
                    subtitle: _('Shown in the bar'), use_markup: false,
                    active: settings.get_strv('tray-pinned').includes(id)});
                row.connect('notify::active', () => {
                    const pinned = settings.get_strv('tray-pinned').filter(p => p !== id);
                    settings.set_strv('tray-pinned', row.active ? [...pinned, id] : pinned);
                });
                return row;
            }) : [new Adw.ActionRow({title: _('Tray icons show up here once their apps ran with this on')})];
            pins.forEach(row => tray.add_row(row));
        };
        fillTray();
        settings.connect('changed::tray-known', fillTray);

        const motion = page(_('Animation'), 'media-playback-start-symbolic');
        const hover = group(motion, _('Hover'));
        choice(hover, 'animation', _('Hover animation'),
            [['magnify', _('Magnify')], ['ripple', _('Ripple')], ['lift', _('Lift')], ['rise', _('Lift and grow')],
                ['none', _('None')]]);
        showIf(spin(hover, 'zoom', _('Magnification'), 1, 2.5, 0.1, 1), () => is('animation', 'magnify', 'ripple', 'rise'),
            'animation');
        const moving = group(motion, _('Icon effects'));
        toggle(moving, 'pop', _('Apps pop in and out'));
        toggle(moving, 'bounce', _('Bounce while an app starts'));
        toggle(moving, 'attention', _('Wiggle when an app asks for attention'));
        toggle(moving, 'squash', _('Squash on click'));
        toggle(moving, 'poof', _('A little cloud when an app is dragged off'));
        toggle(moving, 'glide', _('Window dots glide'));
        toggle(moving, 'intro', _('Rise in a wave after login and unlock'));
        const windows = group(motion, _('Bar and windows'));
        toggle(windows, 'springy', _('Bar springs back in after hiding'));
        toggle(windows, 'minimize-to-icon', _('Windows minimize into their icon'));
        showIf(toggle(windows, 'warp', _('Warp start for the ArcMenu button')), topBarInDock, 'position', 'keep-top-bar');

        const about = page(_('About'), 'emote-love-symbolic');
        const head = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        head.append(new Gtk.Label({label: this.metadata.name, css_classes: ['title-1']}));
        head.append(new Gtk.Label({label: `${_('Version')} ${this.metadata['version-name']}`, css_classes: ['dim-label']}));
        head.append(new Gtk.Label({label: _('A dock for GNOME, made in my spare time.'), wrap: true,
            justify: Gtk.Justification.CENTER, margin_top: 6}));
        group(about).add(head);
        const links = group(about);
        const link = (title, subtitle, icon, uri) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_prefix(new Gtk.Image({icon_name: icon}));
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            // Links open in the browser, a Ko-fi payment never touches the extension.
            row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, (launcher, result) => {
                try {
                    launcher.launch_finish(result);
                } catch (e) {
                    console.warn(`Silver Dock: ${e.message}`);
                }
            }));
            links.add(row);
        };
        link(_('Buy me a coffee'), _('If you like Silver Dock. Totally optional, nothing gets unlocked.'),
            'emote-love-symbolic', 'https://ko-fi.com/simonlinuxcraft');
        link(_('Source code'), _('All of it is on GitHub'), 'applications-engineering-symbolic', this.metadata.url);
        link(_('Found a bug?'), _('Tell me on GitHub, with the line below'), 'dialog-warning-symbolic',
            `${this.metadata.url}/issues`);
        const info = `${this.metadata.name} ${this.metadata['version-name']}, GNOME Shell ${Config.PACKAGE_VERSION}, ` +
            `${GLib.getenv('XDG_SESSION_TYPE') ?? 'unknown session'}`;
        const copy = new Adw.ActionRow({title: info, subtitle: _('Click to copy'), activatable: true});
        copy.add_prefix(new Gtk.Image({icon_name: 'edit-copy-symbolic'}));
        copy.connect('activated', () => {
            copy.get_clipboard().set(info);
            window.add_toast(new Adw.Toast({title: _('Copied')}));
        });
        links.add(copy);
    }
}
