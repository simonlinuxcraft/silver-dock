// Unity LauncherEntry: badges, progress and urgency (libunity, Electron, Chromium, Steam).
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

export class NotificationCounts {
    constructor(onChange) {
        this._onChange = onChange;
        this._sources = new Set();
        Main.messageTray.connectObject(
            'source-added', (tray, source) => this._add(source),
            'source-removed', (tray, source) => {
                source.disconnectObject(this);
                this._sources.delete(source);
                onChange();
            }, this);
        Main.messageTray.getSources().forEach(source => this._add(source));
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        this._sources.forEach(source => source.disconnectObject(this));
        this._sources.clear();
    }

    // The policy id is the app's desktop id without .desktop, system sources have none.
    get(appId) {
        let count = 0;
        for (const source of this._sources) {
            if (source.policy?.id && `${source.policy.id}.desktop` === appId)
                count += source.count;
        }
        return count;
    }

    _add(source) {
        this._sources.add(source);
        source.connectObject('notify::count', () => this._onChange(), this);
        this._onChange();
    }
}

export function countText(count) {
    count = Math.trunc(Number(count));
    return count > 0 ? (count > 99 ? '99+' : String(count)) : null;
}

export function badgeOf(entry) {
    return entry?.['count-visible'] ? countText(entry.count) : null;
}

export function progressOf(entry) {
    const progress = Number(entry?.progress);
    return entry?.['progress-visible'] && Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : null;
}
