// Unity LauncherEntry: badges, progress and urgency (libunity, Electron, Chromium, Steam).
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

const KEYS = ['count', 'count-visible', 'progress', 'progress-visible', 'urgent'];

export class LauncherEntries {
    constructor(onChange) {
        this._entries = new Map();
        this._onChange = onChange;
        const bus = Gio.DBus.session;
        this._subscriptions = [
            bus.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
                Gio.DBusSignalFlags.NONE, (c, sender, path, iface, signal, params) => {
                    // Anyone on the bus can send this, in any shape.
                    if (params.get_type_string() === '(sa{sv})')
                        this._update(sender, ...params.recursiveUnpack());
                }),
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
                (c, sender, path, iface, signal, params) => this._ownerChanged(...params.recursiveUnpack())),
        ];
        // libunity only publishes while someone owns this name.
        this._name = bus.own_name('com.canonical.Unity',
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE, null, null);
    }

    destroy() {
        this._subscriptions.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        Gio.DBus.session.unown_name(this._name);
        this._entries.clear();
    }

    get(appId) {
        return this._entries.get(appId);
    }

    // Only known keys of installed apps are kept.
    _update(sender, uri, props) {
        const id = String(uri).replace(/^\w+:\/\//, '');
        if (!Shell.AppSystem.get_default().lookup_app(id))
            return;
        const entry = this._entries.get(id) ?? {};
        for (const key of KEYS) {
            if (Object.hasOwn(props, key))
                entry[key] = props[key];
        }
        entry.sender = sender;
        this._entries.set(id, entry);
        this._onChange();
    }

    _ownerChanged(name, oldOwner, newOwner) {
        if (newOwner)
            return;
        let changed = false;
        for (const [id, entry] of this._entries) {
            if (entry.sender === name) {
                this._entries.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._onChange();
    }
}

export function badgeOf(entry) {
    const count = Math.trunc(Number(entry?.count));
    return entry?.['count-visible'] && count > 0 ? (count > 99 ? '99+' : String(count)) : null;
}

export function progressOf(entry) {
    const progress = Number(entry?.progress);
    return entry?.['progress-visible'] && Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : null;
}
