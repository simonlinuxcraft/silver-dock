import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {downloadsDir} from './places.js';

const SHOWN = 10;
const ATTRS = 'standard::name,standard::display-name,standard::symbolic-icon,standard::is-hidden,standard::is-backup,time::modified';
// Browsers write these while a download runs.
const PARTIAL = /\.(part|crdownload|download)$/;

function open(file, appInfo) {
    try {
        const context = global.create_app_launch_context(0, -1);
        if (appInfo)
            appInfo.launch([file], context);
        else
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), context);
    } catch (e) {
        Main.notifyError(_('Cannot open %s').format(file.get_basename()), e.message);
    }
}

// File names are untrusted, PopupImageMenuItem sets them as plain text.
function addFile(section, file, name, icon, appInfo) {
    const item = new PopupMenu.PopupImageMenuItem(name, icon);
    item.label.style = 'max-width: 22em;';
    item.label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    item.connect('activate', () => open(file, appInfo));
    section.addMenuItem(item);
}

// Async: a big or network mounted folder must not stall the shell.
function newest(dir, cancellable, done) {
    const infos = [];
    dir.enumerate_children_async(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (d, result) => {
        let children;
        try {
            children = d.enumerate_children_finish(result);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                done([]);
            return;
        }
        const next = () => children.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable, (c, res) => {
            let batch;
            try {
                batch = c.next_files_finish(res);
            } catch (e) {
                children.close_async(GLib.PRIORITY_DEFAULT, null, null);
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    done([]);
                return;
            }
            if (batch.length) {
                infos.push(...batch);
                next();
                return;
            }
            children.close_async(GLib.PRIORITY_DEFAULT, null, null);
            done(infos.filter(i => !i.get_is_hidden() && !i.get_is_backup() && !PARTIAL.test(i.get_name()))
                .sort((a, b) => b.get_attribute_uint64('time::modified') - a.get_attribute_uint64('time::modified'))
                .slice(0, SHOWN));
        });
        next();
    });
}

export function downloadsSection(menu) {
    const section = new PopupMenu.PopupMenuSection();
    menu.addMenuItem(section, 0);
    let cancellable = null;
    section.connect('destroy', () => cancellable?.cancel());
    return () => {
        cancellable?.cancel();
        cancellable = new Gio.Cancellable();
        const dir = Gio.File.new_for_path(downloadsDir());
        newest(dir, cancellable, infos => {
            section.removeAll();
            if (!infos.length)
                section.addMenuItem(new PopupMenu.PopupMenuItem(_('No files'), {reactive: false}));
            for (const info of infos)
                addFile(section, dir.get_child(info.get_name()), info.get_display_name(), info.get_symbolic_icon(), null);
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        });
    };
}

function opens(types, mime) {
    return types.some(type => Gio.content_type_is_a(mime, type));
}

// Parsed per right click, a few ms at the usual few hundred entries.
function recentFiles(types) {
    // The file keeps entries that GTK hides by these settings.
    const privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
    if (!privacy.get_boolean('remember-recent-files'))
        return [];
    const days = privacy.get_int('recent-files-max-age');
    const oldest = days < 0 ? 0 : Date.now() / 1000 - days * 86400;
    const bookmarks = new GLib.BookmarkFile();
    try {
        bookmarks.load_from_file(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
    } catch {
        return [];
    }
    const entries = [];
    for (const uri of bookmarks.get_uris()) {
        if (!uri.startsWith('file://'))
            continue;
        try {
            const mime = bookmarks.get_mime_type(uri);
            const time = bookmarks.get_modified_date_time(uri).to_unix();
            if (time >= oldest && opens(types, mime))
                entries.push({uri, mime, time});
        } catch {
            // An entry without a type or date.
        }
    }
    return entries.sort((a, b) => b.time - a.time);
}

// Not query_exists: a file on a hung network disk would freeze the shell.
function existing(entries, cancellable, done, files = [], i = 0) {
    if (i === entries.length || files.length === SHOWN / 2)
        return done(files);
    const file = Gio.File.new_for_uri(entries[i].uri);
    file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
        try {
            f.query_info_finish(result);
            files.push({file, mime: entries[i].mime});
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
        }
        existing(entries, cancellable, done, files, i + 1);
    });
}

export function recentSection(menu, app) {
    const section = new PopupMenu.PopupMenuSection();
    menu.addMenuItem(section, 0);
    let cancellable = null;
    section.connect('destroy', () => cancellable?.cancel());
    return () => {
        cancellable?.cancel();
        cancellable = new Gio.Cancellable();
        section.removeAll();
        const appInfo = app.get_app_info();
        const types = appInfo?.get_supported_types() ?? [];
        // Without types it would list nothing, a file manager would list every folder.
        const entries = types.length && !types.includes('inode/directory') ? recentFiles(types) : [];
        existing(entries, cancellable, files => {
            if (!files.length)
                return;
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent Files')));
            for (const {file, mime} of files)
                addFile(section, file, file.get_basename(), Gio.content_type_get_symbolic_icon(mime), appInfo);
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        });
    };
}
