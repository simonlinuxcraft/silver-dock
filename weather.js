import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {setVertical} from './compat.js';

const EVERY = 30 * 60;
const HOURS = [1, 3, 5, 7, 9, 11];
// Open-Meteo's WMO weather codes, each entry covers the codes up to its number.
const ICONS = [[1, 'clear'], [2, 'few-clouds'], [3, 'overcast'], [48, 'fog'], [67, 'showers'], [77, 'snow'],
    [82, 'showers'], [86, 'snow'], [99, 'storm']];

function weatherIcon(code, day = true) {
    // Open-Meteo sends null for an hour its model has no value for.
    const name = (code != null && ICONS.find(([last]) => code <= last)?.[1]) || 'overcast';
    const night = !day && (name === 'clear' || name === 'few-clouds');
    return `weather-${name}${night ? '-night' : ''}-symbolic`;
}

const degrees = t => t == null ? '-' : `${Math.round(t)}°`;

// The weather of the place in the settings from Open-Meteo, no key or account needed.
export class Weather {
    constructor(settings, onChange) {
        this.data = null;
        this.place = '';
        this._settings = settings;
        this._onChange = onChange;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._fetched = -Infinity;
        this._retry = 0;
        settings.connectObject('changed::weather-location', () => this._fetch(),
            'changed::weather-unit', () => this._fetch(), this);
        // Offline at login or after suspend: try again once the network is back. A VPN fires this often.
        // Wall time, the monotonic clock stands still during suspend.
        Gio.NetworkMonitor.get_default().connectObject('network-changed', (monitor, up) => {
            if (up && GLib.get_real_time() - this._fetched > 5 * 60 * 1e6)
                this._fetch();
        }, this);
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EVERY, () => {
            this._fetch();
            return GLib.SOURCE_CONTINUE;
        });
        this._fetch();
    }

    _fetch() {
        // An answer still on its way would overwrite the newer one, or a place cleared since.
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const [place, lat, lon] = this._settings.get_value('weather-location').deepUnpack();
        if (!place) {
            this._show(null, '');
            return;
        }
        const unit = this._settings.get_string('weather-unit');
        const query = [`latitude=${lat}`, `longitude=${lon}`, 'timezone=auto', 'forecast_days=5', 'forecast_hours=12',
            'current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
            'hourly=temperature_2m,weather_code,is_day',
            'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
            `temperature_unit=${unit}`, `wind_speed_unit=${unit === 'fahrenheit' ? 'mph' : 'kmh'}`];
        const message = Soup.Message.new('GET', `https://api.open-meteo.com/v1/forecast?${query.join('&')}`);
        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${message.get_status()}`);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const {current} = data;
                this.place = place;
                this._fetched = GLib.get_real_time();
                this._show(data, weatherIcon(current.weather_code, current.is_day), degrees(current.temperature_2m));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                // The last weather stays. Soon again, unless the request itself is wrong (429: too many).
                console.log(`Silver Dock: no weather (${e.message})`);
                const status = message.get_status();
                if (status < 400 || status >= 500 || status === 429)
                    this._retry ||= GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 120, () => {
                        this._retry = 0;
                        this._fetch();
                        return GLib.SOURCE_REMOVE;
                    });
            }
        });
    }

    _show(data, icon, text) {
        this.data = data;
        this.icon = icon;
        this.text = text;
        this._onChange();
    }

    destroy() {
        this._cancellable.cancel();
        GLib.source_remove(this._id);
        if (this._retry)
            GLib.source_remove(this._retry);
        this._settings.disconnectObject(this);
        Gio.NetworkMonitor.get_default().disconnectObject(this);
        this._session.abort();
    }
}

function forecastRow(columns) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
    const row = new St.BoxLayout({style_class: 'silver-dock-forecast', x_expand: true});
    for (const [top, icon, ...below] of columns) {
        const column = new St.BoxLayout({style_class: 'silver-dock-forecast-column', x_expand: true});
        setVertical(column, true);
        // St has no opacity in CSS, and a fixed color would vanish on a light menu theme.
        const label = (text, dim) => new St.Label({text, x_align: Clutter.ActorAlign.CENTER,
            style_class: dim ? 'silver-dock-forecast-dim' : null, opacity: dim ? 170 : 255});
        column.add_child(label(top, true));
        column.add_child(new St.Icon({icon_name: icon, icon_size: 24, x_align: Clutter.ActorAlign.CENTER}));
        below.forEach((text, i) => column.add_child(label(text, i > 0)));
        row.add_child(column);
    }
    item.add_child(row);
    return item;
}

// Icon and temperature after the clock, a click shows the forecast. Hidden while there is no weather yet.
export class WeatherButton {
    constructor(weather, clock, side) {
        this._weather = weather;
        this._icon = new St.Icon({style_class: 'silver-dock-weather-icon', y_align: Clutter.ActorAlign.CENTER});
        this._temp = new St.Label({style_class: 'silver-dock-weather', y_align: Clutter.ActorAlign.CENTER});
        const box = new St.BoxLayout({style_class: 'silver-dock-weather-box'});
        box.add_child(this._icon);
        box.add_child(this._temp);
        this.actor = new St.Button({style_class: 'panel-button', child: box, can_focus: true, accessible_name: _('Weather')});
        this.menu = new PopupMenu.PopupMenu(this.actor, 0.5, side);
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        // The top bar's manager: the dock stays while it is open, and the pointer moves on to the other menus.
        Main.panel.menuManager.addMenu(this.menu);
        this.menu.connect('open-state-changed', (menu, open) => {
            this.actor.checked = open;
            if (!open && this._stale)
                this.update();
        });
        this.actor.connect('clicked', () => this.menu.toggle());
        clock.get_parent().insert_child_above(this.actor, clock);
        this.update();
    }

    update() {
        this.actor.visible = Boolean(this._weather.icon);
        if (this._weather.icon) {
            this._icon.icon_name = this._weather.icon;
            this._temp.text = this._weather.text;
        }
        // Filled ahead, an empty menu does not open. A reply missing fields must not stop the dock's rebuild.
        try {
            // An open menu keeps its rows and gets them on closing.
            this._stale = this.menu.isOpen;
            if (!this._stale)
                this._fill();
        } catch (e) {
            this.menu.removeAll();
            console.log(`Silver Dock: no weather menu (${e.message})`);
        }
    }

    _fill() {
        this.menu.removeAll();
        const {data, place} = this._weather;
        if (!data)
            return;
        const {current, current_units: units, hourly, daily} = data;
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(place, {reactive: false}));
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem([
            _('Feels like %s').format(degrees(current.apparent_temperature)),
            _('Wind %s').format(`${Math.round(current.wind_speed_10m)} ${units.wind_speed_10m}`),
            _('Humidity %s').format(`${current.relative_humidity_2m} %`),
        ].join('    '), {reactive: false}));
        if (hourly?.time) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(forecastRow(HOURS.filter(i => i < hourly.time.length).map(i => [
                // The place's own time, shown in ours.
                new Date(Date.parse(`${hourly.time[i]}Z`) - data.utc_offset_seconds * 1000)
                    .toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}),
                weatherIcon(hourly.weather_code[i], hourly.is_day[i]), degrees(hourly.temperature_2m[i])])));
        }
        if (daily?.time) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(forecastRow(daily.time.map((day, i) => [
                // Noon, a bare date counts as UTC and can land on the day before.
                i ? new Date(`${day}T12:00`).toLocaleDateString(undefined, {weekday: 'short'}) : _('Today'),
                weatherIcon(daily.weather_code[i]),
                `${degrees(daily.temperature_2m_max[i])} ${degrees(daily.temperature_2m_min[i])}`,
                `${daily.precipitation_probability_max[i] ?? 0} %`])));
        }
    }

    destroy() {
        Main.panel.menuManager.removeMenu(this.menu);
        this.menu.destroy();
        this.actor.destroy();
    }
}
