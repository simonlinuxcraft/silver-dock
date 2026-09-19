#!/bin/bash
# Loads the extension in a headless GNOME Shell, cycles enable/disable (like
# lock/unlock), changes settings and fails on errors. Own D-Bus and dconf
# database, the running session is not touched. Rerun after every GNOME upgrade.
# --show: same in a window to try the dock by hand (needs mutter-dev-bin). Ubuntu's
#         defaults, nothing of your desktop but ArcMenu (with its own defaults), for
#         the dock's menu button.
# --x11: an X11 session on a virtual X server instead of headless Wayland, for
#         GNOME before 50 (see test/gnome46.sh, needs Xvfb).

# One block, read whole before it runs: bash reads a running script piece by piece
# from disk, and an edit during a --show session would otherwise run fragments.
{
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$root/metadata.json")
schema=org.gnome.shell.extensions.silver-dock
show=
x11=
for arg in "$@"; do
    case $arg in
    --show) show=1 ;;
    --x11) x11=1 ;;
    *) echo "usage: $0 [--x11 | --show]" >&2; exit 2 ;;
    esac
done
work=$(mktemp -d)
ext=$work/data/gnome-shell/extensions
mkdir -p "$ext"
ln -s "$root" "$ext/$uuid"
glib-compile-schemas "$root/schemas"
for po in "$root"/po/*.po; do
    lang=$(basename "$po" .po)
    mkdir -p "$root/locale/$lang/LC_MESSAGES"
    msgfmt --check -o "$root/locale/$lang/LC_MESSAGES/silver-dock.mo" "$po"
done

# Two monitors: the second one gets a dock of its own with all-monitors.
mode=(--headless --virtual-monitor 1280x800 --virtual-monitor 1024x768)
if [[ $show ]]; then
    mode=(--devkit)
    if [[ -f /usr/share/gnome-shell/modes/ubuntu.json ]]; then
        mode+=(--mode=ubuntu)
    fi
    # Desktop Icons gets an empty desktop folder of its own, it restarts in a loop without one.
    mkdir -p "$work/config" "$work/desktop"
    printf 'XDG_DESKTOP_DIR="%s"\n' "$work/desktop" >"$work/config/user-dirs.dirs"
    arcmenu=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/arcmenu@arcmenu.com
    if [[ -e $arcmenu ]]; then
        ln -s "$arcmenu" "$ext/"
    fi
fi

# Own name per run: dconf flags changes through a file of that name in the shared runtime
# dir, and a parallel run removing it leaves the other shell reading stale settings.
# No hyphen, the name ends up in a D-Bus object path.
db=silverdocktest$$
printf 'user-db:%s\n' "$db" >"$work/dconf-profile"
export DCONF_PROFILE="$work/dconf-profile" XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" \
    XDG_STATE_HOME="$work/state" XDG_CACHE_HOME="$work/cache"
# The test window speaks your language, the headless run and parsed output stay plain.
if [[ ! $show ]]; then
    export LC_ALL=C
fi
if [[ ! $show ]]; then
    unset WAYLAND_DISPLAY DISPLAY
fi
if [[ $x11 ]]; then
    Xvfb -displayfd 3 -screen 0 1280x800x24 3>"$work/display" >"$work/xvfb.log" 2>&1 &
    xvfb=$!
    for _ in $(seq 50); do [[ -s $work/display ]] && break; sleep 0.1; done
    export DISPLAY=:$(cat "$work/display")
fi
# Something in the test trash (under the test XDG_DATA_HOME) for the full trash icon.
# Written by hand, gio refuses to trash on /tmp.
mkdir -p "$XDG_DATA_HOME/Trash/files" "$XDG_DATA_HOME/Trash/info"
touch "$XDG_DATA_HOME/Trash/files/demo.txt"
printf '[Trash Info]\nPath=%s\nDeletionDate=2026-01-01T00:00:00\n' "$work/demo.txt" \
    >"$XDG_DATA_HOME/Trash/info/demo.txt.trashinfo"

mapfile -t bus < <(dbus-daemon --session --fork --print-address=1 --print-pid=1)
export DBUS_SESSION_BUS_ADDRESS=${bus[0]}
# Empty stand-in for the system bus, keeps the test shell away from logind and GDM.
mapfile -t sysbus < <(dbus-daemon --session --fork --print-address=1 --print-pid=1)
export DBUS_SYSTEM_BUS_ADDRESS=${sysbus[0]}

# Own PipeWire without any devices, it carries the devkit window's picture. The
# real one stalls for minutes when a USB camera hangs, and the test stays out of it.
export PIPEWIRE_RUNTIME_DIR=$work/pipewire
mkdir -p "$PIPEWIRE_RUNTIME_DIR"
pipewire >"$work/pipewire.log" 2>&1 &
pw=$!
for _ in $(seq 25); do [[ -S $PIPEWIRE_RUNTIME_DIR/pipewire-0 ]] && break; sleep 0.2; done
wireplumber --profile policy >>"$work/pipewire.log" 2>&1 &
wp=$!

if [[ $show ]]; then
    # Set before the start, like a login: switched at runtime right after another
    # extension, GNOME's extension manager enabled ArcMenu twice.
    dconf write /org/gnome/shell/enabled-extensions "['arcmenu@arcmenu.com']"
    dconf write /org/gnome/shell/disabled-extensions "['ubuntu-dock@ubuntu.com']"
fi

# The test shell shares the real runtime dir. Killed within 60 s it leaves GNOME's crash
# marker behind, and a crash of the real shell would then disable its extensions.
marker=${XDG_RUNTIME_DIR:-/run/user/$UID}/gnome-shell-disable-extensions
had_marker=
[[ -e $marker ]] && had_marker=1

# Own socket name, so demo windows land in the test shell and parallel runs do not collide.
wl=silverdocktest-$$
if [[ $x11 ]]; then
    shell_args=(--x11 --replace)
    client=(GDK_BACKEND=x11)
else
    shell_args=("${mode[@]}" --no-x11 --wayland-display "$wl")
    client=(WAYLAND_DISPLAY="$wl")
fi
# Line buffered, or the last messages are lost when the shell is killed.
setsid stdbuf -oL gnome-shell "${shell_args[@]}" >"$work/shell.log" 2>&1 &
shell=$!

cleanup() {
    # setsid made the shell a session leader, so this only hits the test shell and its helpers
    [[ $(ps -o sid= -p "$shell" | tr -d ' ') == "$shell" ]] && pkill -s "$shell" || true
    kill "${bus[1]}" "${sysbus[1]}" ${tray:-} ${viewer:-} ${wp:-} ${pw:-} ${xvfb:-} 2>/dev/null || true
    rm -f "${XDG_RUNTIME_DIR:-/run/user/$UID}"/{dconf/"$db","$wl","$wl.lock"}
    [[ $had_marker ]] || rm -f "$marker"
    echo "log: $work/shell.log"
}
trap cleanup EXIT

# The shell's own D-Bus interface: the gnome-extensions tool gives nothing in the
# GNOME 46 container. States are numbers, the same from GNOME 46 to 50.
shell_call() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method "org.gnome.Shell.Extensions.$1" "${@:2}"
}
switch() { shell_call "$1Extension" "$2" >/dev/null 2>&1 || true; }
state() {
    shell_call GetExtensionInfo "$uuid" 2>/dev/null | sed -n "s/.*'state': <\([0-9]*\)\.0>.*/\1/p" |
        sed 's/^1$/ACTIVE/; s/^2$/INACTIVE/; s/^3$/ERROR/; s/^4$/OUT OF DATE/'
}
expect() {
    for _ in $(seq 50); do [[ $(state) == "$1" ]] && return; sleep 0.2; done
    echo "FAIL: expected state $1, got '$(state)'"
    exit 1
}
tray_items() {
    busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher \
        org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems 2>/dev/null | cut -d' ' -f2
}
set_key() { gsettings --schemadir "$root/schemas" set "$schema" "$@"; }

for _ in $(seq 150); do [[ -n $(state) ]] && break; sleep 0.2; done
if [[ -z $(state) ]]; then
    echo "FAIL: extension not found in the test shell"
    shell_call GetExtensionInfo "$uuid" || true
    exit 1
fi
# GNOME starts with the overview open, a session starts on the desktop.
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method \
    org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>' >/dev/null || true

if [[ $show ]]; then
    # The devkit window runs in its own session and would stay frozen after the shell is gone.
    viewer=$(pgrep -P "$shell" -x mutter-devkit || true)
    # D-Bus started helpers (the prefs, Nautilus for the desktop icons) open in the test window.
    dbus-update-activation-environment WAYLAND_DISPLAY="$wl"
fi

switch Enable ubuntu-appindicators@ubuntu.com
switch Enable "$uuid"; expect ACTIVE
# Tray icons and a window arriving while the dock is up, like apps starting after login.
env "${client[@]}" python3 "$root/test/demo-apps.py" >"$work/demo.log" 2>&1 &
tray=$!
for _ in $(seq 50); do [[ $(tray_items) == 3 ]] && break; sleep 0.2; done
if [[ $(tray_items) != 3 ]]; then
    echo "FAIL: demo tray icons not registered, see $work/demo.log"
    exit 1
fi
# The prefs need the Extensions app's private libraries.
if ! env GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib/gnome-shell \
    "${client[@]}" LC_ALL=C gjs -m "$root/test/prefs-test.js" >"$work/prefs.log" 2>&1; then
    echo "FAIL: preferences, see $work/prefs.log"
    exit 1
fi
switch Disable "$uuid"; expect INACTIVE
switch Enable "$uuid"; expect ACTIVE
set_key icon-size 48
set_key zoom 1.0
set_key margin 0
for style in ripple lift none magnify; do set_key animation "$style"; done
set_key bounce false
# From here on a dock on each of the two monitors, given a moment to be placed at the bottom.
set_key all-monitors true
sleep 1
for key in pop squash glide intro badge-pop springy minimize-to-icon lift-buttons warp; do set_key "$key" false; done
set_key separators false
# The top bar back on its own at the top, in the dock's look and theme colors.
set_key keep-top-bar true
set_key colors custom
set_key color "'rgb(236,1,1)'"
set_key color "'not a color'"
set_key colors theme
set_key dynamic-opacity true
set_key attention false
set_key tooltips false
set_key position top
set_key position left
set_key badges false
set_key trash false
set_key drives false
set_key internal-drives true
set_key dnd false
set_key peek false
set_key scroll false
set_key previews false
set_key position right
set_key style-top-bar false
# Too long for the screen on the side: the icons have to shrink to fit.
set_key icon-size 96
# No strut now, the maximized demo window grows under the bar and hides it.
set_key autohide true
sleep 2
gsettings --schemadir "$root/schemas" reset-recursively "$schema"
sleep 1
expect ACTIVE

# GNOME before 50 warns about the top bar's own button containers (unnamed StBin)
# when they move, at its own startup too. The dock's containers carry names. On X11
# mutter warns about its own window actors when a maximized window shrinks for the
# space a dock reserves, any dock with a strut does that.
noise='^$'
if (( $(gnome-shell --version | sed 's/[^0-9]*\([0-9]*\).*/\1/') < 50 )); then
    noise="Can't update stage views actor unnamed \[StBin\]"
fi
if [[ $x11 ]]; then
    noise+="|Can't update stage views actor unnamed \[Meta(Window|Surface)ActorX11\]"
fi
if grep -n -B2 -A8 "$uuid" "$work/shell.log" | grep -iE 'error|warning|critical' | grep -vE "$noise" ||
    grep -nE 'Clutter-|St-CRITICAL' "$work/shell.log" | grep -vE "$noise"; then
    echo "FAIL: errors from the extension"
    exit 1
fi
echo "smoke ok ($(gnome-shell --version))"

if [[ $show ]]; then
    gnome-extensions prefs "$uuid" || true
    echo "Test shell is open. Close its window or press Ctrl+C to end."
    wait "$shell" || true
fi
exit
}
