#!/bin/bash
# Loads the extension in a headless GNOME Shell, cycles enable/disable (like
# lock/unlock), changes settings and fails on errors. Own D-Bus and dconf
# database, the running session is not touched. Rerun after every GNOME upgrade.
# --show: same in a window, with your own shell settings and extensions mirrored
#         in, to try the dock by hand (needs mutter-dev-bin).

# One block, read whole before it runs: bash reads a running script piece by piece
# from disk, and an edit during a --show session would otherwise run fragments.
{
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$root/metadata.json")
schema=org.gnome.shell.extensions.silver-dock
show=
[[ ${1:-} == --show ]] && show=1
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

mode=(--headless --virtual-monitor 1280x800)
if [[ $show ]]; then
    mode=(--devkit)
    if [[ -f /usr/share/gnome-shell/modes/ubuntu.json ]]; then
        mode+=(--mode=ubuntu)
    fi
    # Read the real settings now, before the environment below points dconf elsewhere.
    mirror_shell=$(dconf dump /org/gnome/shell/)
    mirror_iface=$(dconf dump /org/gnome/desktop/interface/)
    mirror_bg=$(dconf dump /org/gnome/desktop/background/)
    real_data=${XDG_DATA_HOME:-$HOME/.local/share}
    for dir in applications icons themes fonts backgrounds; do
        if [[ -e $real_data/$dir ]]; then
            ln -s "$real_data/$dir" "$work/data/$dir"
        fi
    done
    # Desktop Icons needs the localized desktop folder, it restarts in a loop without.
    real_dirs=${XDG_CONFIG_HOME:-$HOME/.config}/user-dirs.dirs
    if [[ -e $real_dirs ]]; then
        mkdir -p "$work/config"
        ln -s "$real_dirs" "$work/config/"
    fi
    for e in "$real_data"/gnome-shell/extensions/*; do
        if [[ ! -e $ext/$(basename "$e") ]]; then
            ln -s "$e" "$ext/"
        fi
    done
fi

printf 'user-db:silverdocktest\n' >"$work/dconf-profile"
export DCONF_PROFILE="$work/dconf-profile" XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" \
    XDG_STATE_HOME="$work/state" XDG_CACHE_HOME="$work/cache"
# The test window speaks your language, the headless run and parsed output stay plain.
if [[ ! $show ]]; then
    export LC_ALL=C
fi
if [[ ! $show ]]; then
    unset WAYLAND_DISPLAY DISPLAY
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
    dconf load /org/gnome/shell/ <<<"$mirror_shell"
    dconf load /org/gnome/desktop/interface/ <<<"$mirror_iface"
    dconf load /org/gnome/desktop/background/ <<<"$mirror_bg"
fi

# The test shell shares the real runtime dir. Killed within 60 s it leaves GNOME's crash
# marker behind, and a crash of the real shell would then disable its extensions.
marker=${XDG_RUNTIME_DIR:-/run/user/$UID}/gnome-shell-disable-extensions
had_marker=
[[ -e $marker ]] && had_marker=1

# Own socket name, so demo windows land in the test shell and parallel runs do not collide.
wl=silverdocktest-$$
# Line buffered, or the last messages are lost when the shell is killed.
setsid stdbuf -oL gnome-shell "${mode[@]}" --no-x11 --wayland-display "$wl" >"$work/shell.log" 2>&1 &
shell=$!

cleanup() {
    # setsid made the shell a session leader, so this only hits the test shell and its helpers
    [[ $(ps -o sid= -p "$shell" | tr -d ' ') == "$shell" ]] && pkill -s "$shell" || true
    kill "${bus[1]}" "${sysbus[1]}" ${tray:-} ${viewer:-} ${wp:-} ${pw:-} 2>/dev/null || true
    rm -f "${XDG_RUNTIME_DIR:-/run/user/$UID}"/{dconf/silverdocktest,"$wl","$wl.lock"}
    [[ $had_marker ]] || rm -f "$marker"
    echo "log: $work/shell.log"
}
trap cleanup EXIT

state() { LC_ALL=C gnome-extensions info "$uuid" 2>/dev/null | sed -n 's/^ *State: //p'; }
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
    gnome-extensions list || true
    gnome-extensions info "$uuid" || true
    exit 1
fi

if [[ $show ]]; then
    # The devkit window runs in its own session and would stay frozen after the shell is gone.
    viewer=$(pgrep -P "$shell" -x mutter-devkit || true)
    # D-Bus started helpers (the prefs, Nautilus for the desktop icons) open in the test window.
    dbus-update-activation-environment WAYLAND_DISPLAY="$wl"
    # Silver Dock replaces these, the preview shows the result.
    for other in dash-to-panel@jderose9.github.com dash-to-dock@micxgx.gmail.com ubuntu-dock@ubuntu.com; do
        gnome-extensions disable "$other" 2>/dev/null || true
    done
fi

gnome-extensions enable ubuntu-appindicators@ubuntu.com 2>/dev/null || true
gnome-extensions enable "$uuid"; expect ACTIVE
# Tray icons and a window arriving while the dock is up, like apps starting after login.
WAYLAND_DISPLAY=$wl python3 "$root/test/demo-apps.py" >"$work/demo.log" 2>&1 &
tray=$!
for _ in $(seq 50); do [[ $(tray_items) == 3 ]] && break; sleep 0.2; done
if [[ $(tray_items) != 3 ]]; then
    echo "FAIL: demo tray icons not registered, see $work/demo.log"
    exit 1
fi
# The prefs need the Extensions app's private libraries.
if ! GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib/gnome-shell \
    WAYLAND_DISPLAY=$wl LC_ALL=C gjs -m "$root/test/prefs-test.js" >"$work/prefs.log" 2>&1; then
    echo "FAIL: preferences, see $work/prefs.log"
    exit 1
fi
gnome-extensions disable "$uuid"; expect INACTIVE
gnome-extensions enable "$uuid"; expect ACTIVE
set_key icon-size 48
set_key zoom 1.0
set_key margin 0
for style in ripple lift none magnify; do set_key animation "$style"; done
set_key bounce false
for key in pop squash glide intro badge-pop springy minimize-to-icon lift-buttons warp; do set_key "$key" false; done
set_key separators false
# The top bar back on its own at the top, in the dock's look and theme colors.
set_key keep-top-bar true
set_key theme-colors true
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

if grep -n -B2 -A8 "$uuid" "$work/shell.log" | grep -iE 'error|warning|critical' ||
    grep -nE 'Clutter-|St-CRITICAL' "$work/shell.log"; then
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
