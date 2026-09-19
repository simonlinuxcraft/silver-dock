# Tray icons, windows and a launcher badge for the test shell. Real apps talk to
# the real session bus and never show up there.
import subprocess
import sys

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import Gio, GLib, Gtk, AyatanaAppIndicator3 as A

keep = []
for n, icon in enumerate(['network-vpn', 'input-mouse', 'software-update-available']):
    ind = A.Indicator.new(f'silver-dock-demo-{n}', icon, A.IndicatorCategory.APPLICATION_STATUS)
    ind.set_status(A.IndicatorStatus.ACTIVE)
    menu = Gtk.Menu()
    menu.append(Gtk.MenuItem(label=f'Tray test {n + 1}'))
    menu.show_all()
    ind.set_menu(menu)
    keep.append(ind)

win = Gtk.Window(title='Silver Dock test window')
win.maximize()
win.show_all()

# Another app takes the focus, then this window asks for it back without a valid
# activation token, which the shell turns into a request for attention.
# It minimizes itself and quits later: the dock's icon geometry and pop out.
OTHER = ("import gi; gi.require_version('Gtk', '3.0'); from gi.repository import GLib, Gtk; "
         "w = Gtk.Window(title='Silver Dock other app'); w.show_all(); "
         "GLib.timeout_add(2500, lambda: w.iconify() or False); "
         "GLib.timeout_add(3500, lambda: Gtk.main_quit() or False); Gtk.main()")


def ask_attention():
    subprocess.Popen([sys.executable, '-c', OTHER])
    GLib.timeout_add(1500, lambda: win.present() or False)
    return False


GLib.timeout_add(1000, ask_attention)

# A badge that counts 7 to 16 (a step every 3 s) and a running progress bar on the Files icon, sent
# like libunity does. Repeated, because a dock only hears updates sent while it is enabled.
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
step = 0


def launcher_entry():
    global step
    step += 1
    bus.emit_signal(None, '/com/canonical/unity/launcherentry/demo', 'com.canonical.Unity.LauncherEntry', 'Update',
                    GLib.Variant('(sa{sv})', ('application://org.gnome.Nautilus.desktop', {
                        'count': GLib.Variant('x', 7 + step // 3 % 10), 'count-visible': GLib.Variant('b', True),
                        'progress': GLib.Variant('d', step % 10 / 10), 'progress-visible': GLib.Variant('b', True)})))
    return True


GLib.timeout_add(1000, launcher_entry)
# Malformed on purpose: the dock has to ignore it without an error.
bus.emit_signal(None, '/com/canonical/unity/launcherentry/demo', 'com.canonical.Unity.LauncherEntry', 'Update',
                GLib.Variant('(s)', ('application://org.gnome.Nautilus.desktop',)))
Gtk.main()
