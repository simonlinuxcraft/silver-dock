// MPRIS players on the session bus, matched to their apps, for the app menus.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MPRIS = 'org.mpris.MediaPlayer2';
const PATH = '/org/mpris/MediaPlayer2';
// method, capability, icon (play/pause follows the status)
const CONTROLS = [
    ['Previous', 'CanGoPrevious', 'media-skip-backward-symbolic'],
    ['PlayPause', 'CanPlay', null],
    ['Next', 'CanGoNext', 'media-skip-forward-symbolic'],
];

export class MediaPlayers {
    constructor() {
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();
        this._subscription = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', MPRIS, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (c, sender, path, iface, signal, params) => {
                const [name, , owner] = params.deepUnpack();
                this._players.delete(name);
                if (owner)
                    this._add(name);
            });
        this._call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null)
            .then(([names]) => names.filter(name => name.startsWith(`${MPRIS}.`)).forEach(name => this._add(name)))
            .catch(e => this._log(e));
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._subscription);
        this._players.clear();
    }

    forApp(app) {
        return [...this._players.values()].filter(player => player?.app === app);
    }

    // The player's own DesktopEntry, else the app owning its process.
    async _add(name) {
        const token = {};
        this._players.set(name, token);
        try {
            const [pid] = await this._call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [name]));
            const [entry] = await this._call(name, PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [MPRIS, 'DesktopEntry'])).catch(() => []);
            const proxy = await new Promise((resolve, reject) => Gio.DBusProxy.new(Gio.DBus.session,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, PATH, `${MPRIS}.Player`, this._cancellable,
                (o, result) => {
                    try {
                        resolve(Gio.DBusProxy.new_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }));
            const app = (typeof entry === 'string' && Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`)) ||
                Shell.WindowTracker.get_default().get_app_from_pid(pid);
            // Gone or replaced meanwhile.
            if (this._players.get(name) === token)
                this._players.set(name, app ? {app, proxy} : null);
        } catch (e) {
            this._log(e);
        }
    }

    _call(name, path, iface, method, args) {
        return new Promise((resolve, reject) => Gio.DBus.session.call(name, path, iface, method, args, null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (bus, result) => {
                try {
                    resolve(bus.call_finish(result).recursiveUnpack());
                } catch (e) {
                    reject(e);
                }
            }));
    }

    _log(e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.log(`Silver Dock: media player (${e.message})`);
    }
}

// At the top of an app menu, returns the function that fills it before each opening.
export function mediaSection(menu, media, app) {
    const section = new PopupMenu.PopupMenuSection();
    menu.addMenuItem(section, 0);
    return () => {
        section.removeAll();
        const players = media.forApp(app);
        players.forEach(player => section.addMenuItem(playerItem(player, app)));
        if (players.length)
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    };
}

// Titles and artists come from the player, plain text only.
function playerItem({proxy}, app) {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
    const box = new St.BoxLayout({style_class: 'silver-dock-media', x_expand: true});
    const title = new St.Label({style_class: 'silver-dock-media-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(title);
    const buttons = CONTROLS.map(([method, can, iconName]) => {
        const button = new St.Button({
            style_class: 'silver-dock-media-button',
            can_focus: true,
            child: new St.Icon({icon_name: iconName ?? 'media-playback-start-symbolic', icon_size: 16}),
        });
        button.connect('clicked', () => proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null));
        box.add_child(button);
        return {button, can};
    });
    item.add_child(box);

    const update = () => {
        const get = key => proxy.get_cached_property(key)?.recursiveUnpack();
        const meta = get('Metadata') ?? {};
        const artist = [meta['xesam:artist'] ?? []].flat().join(', ');
        title.text = [meta['xesam:title'], artist].filter(Boolean).join(' · ') || app.get_name();
        const playing = get('PlaybackStatus') === 'Playing';
        buttons[1].button.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        buttons[1].can = playing ? 'CanPause' : 'CanPlay';
        for (const {button, can} of buttons) {
            button.reactive = get(can) !== false;
            button.opacity = button.reactive ? 255 : 90;
        }
    };
    proxy.connectObject('g-properties-changed', update, item);
    update();
    return item;
}
