# Real apps talk to the real session bus and never show up in the test shell.
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

# Asking for the focus back without an activation token makes the shell flag attention.
OTHER = ("import gi; gi.require_version('Gtk', '3.0'); from gi.repository import GLib, Gtk; "
         "w = Gtk.Window(title='Silver Dock other app'); w.show_all(); "
         "GLib.timeout_add(2500, lambda: w.iconify() or False); "
         "GLib.timeout_add(3500, lambda: Gtk.main_quit() or False); Gtk.main()")


def ask_attention():
    subprocess.Popen([sys.executable, '-c', OTHER])
    GLib.timeout_add(1500, lambda: win.present() or False)
    return False


GLib.timeout_add(1000, ask_attention)

# Repeated, a dock only hears updates sent while it is enabled.
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

MPRIS = '''<node>
<interface name="org.mpris.MediaPlayer2">
  <property name="DesktopEntry" type="s" access="read"/>
</interface>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Next"/><method name="Previous"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
</interface>
</node>'''
player = {'status': 'Playing', 'track': 1}


def player_props():
    return {'PlaybackStatus': GLib.Variant('s', player['status']),
            'Metadata': GLib.Variant('a{sv}', {'xesam:title': GLib.Variant('s', f"Test Song {player['track']}"),
                                               'xesam:artist': GLib.Variant('as', ['Silver Band'])}),
            'CanGoNext': GLib.Variant('b', True), 'CanGoPrevious': GLib.Variant('b', False),
            'CanPlay': GLib.Variant('b', True), 'CanPause': GLib.Variant('b', True)}


def player_call(conn, sender, path, iface, method, params, invocation):
    if method == 'PlayPause':
        player['status'] = 'Paused' if player['status'] == 'Playing' else 'Playing'
    elif method == 'Next':
        player['track'] += 1
    invocation.return_value(None)
    conn.emit_signal(None, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                     GLib.Variant('(sa{sv}as)', ('org.mpris.MediaPlayer2.Player', player_props(), [])))


def player_get(conn, sender, path, iface, prop):
    if iface == 'org.mpris.MediaPlayer2':
        return GLib.Variant('s', 'org.gnome.Nautilus')
    return player_props()[prop]


for info in Gio.DBusNodeInfo.new_for_xml(MPRIS).interfaces:
    bus.register_object('/org/mpris/MediaPlayer2', info, player_call, player_get, None)
Gio.bus_own_name_on_connection(bus, 'org.mpris.MediaPlayer2.silverdockdemo', Gio.BusNameOwnerFlags.NONE, None, None)
# Malformed on purpose.
bus.emit_signal(None, '/com/canonical/unity/launcherentry/demo', 'com.canonical.Unity.LauncherEntry', 'Update',
                GLib.Variant('(s)', ('application://org.gnome.Nautilus.desktop',)))
Gtk.main()
