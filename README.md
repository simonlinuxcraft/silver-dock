# Silver Dock

A dock for GNOME Shell 46 to 50, on Wayland and X11. At the bottom or top it also
holds the top bar's menu, clock, tray and system menu. Only `takeover.js` touches
GNOME internals, version differences live in `compat.js`.

- Any screen edge, on one monitor or all. On the left or right the top bar keeps its content, optionally in the dock's look
- Dock look, an own color or the shell and GTK theme's colors, optionally tinted app icons
- Hover styles magnify, ripple, lift or none
- Icons pop in and out, squash on click, rise in a wave after login, bounce while an app starts and wiggle when it asks for attention. Window dots glide, badges pop, windows minimize into their icon, top bar buttons lift, the ArcMenu button takes off
- Window dots, app names on hover, the app menu on right click. A click on the focused app minimizes it or cycles its windows, scrolling switches them
- Right click on a free spot for the settings. Ctrl+Alt+Tab reaches the icons, the arrow keys move along, the Menu key opens the app menu
- Window previews on hover, resting on one shows only that window
- Drag to rearrange, pin and unpin
- Badges and progress bars (Unity LauncherEntry)
- Trash and drives with open, empty and eject
- Separators, a soft shadow, autohide, opaque while a window touches the bar. A hidden bar comes out when an app asks for attention

Every extra can be switched off in the preferences.

## Install

Pack in this folder, install on the target machine:

```
gnome-extensions pack --force --podir=po $(ls *.js | grep -vE '^(extension|prefs)\.js$' | sed 's/^/--extra-source=/') .
gnome-extensions install --force silver-dock@simonlinuxcraft.github.io.shell-extension.zip
```

Log out and back in, then `gnome-extensions enable silver-dock@simonlinuxcraft.github.io`.
Switch other docks off (ubuntu-dock, dash-to-dock, dash-to-panel).

For development, link this folder instead:

```
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/silver-dock@simonlinuxcraft.github.io
```

## Test

```
gjs -m test/layout-test.js   # hover math
gjs -m test/colors-test.js   # GTK theme colors
test/smoke.sh                # headless GNOME Shell: enable/disable, settings, prefs, demo apps
test/smoke.sh --show         # the same in a window (needs mutter-dev-bin)
test/gnome.sh [46..49]       # smoke.sh on GNOME 46 to 49 in podman, X11 too up to 48
```

The test shell has its own D-Bus and settings, the running session is not touched.
For a new GNOME release add it to `shell-version` in `metadata.json` and run the tests.

## Translations

`po/` holds the catalogs, `test/smoke.sh` compiles them into `locale/`. After changing texts:

```
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --package-name=silver-dock -o po/silver-dock.pot extension.js dock.js places.js prefs.js
msgmerge --update po/de.po po/silver-dock.pot
```

A new language starts with `msginit -l <lang> -i po/silver-dock.pot -o po/<lang>.po`.
