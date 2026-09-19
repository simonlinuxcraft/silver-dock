# Silver Dock

One bar on a screen edge for GNOME Shell. At the bottom or top it holds the top
bar's content (menu, clock, tray, system menu) and the app icons together.
Apart from moving the top bar's boxes (`takeover.js`) it uses its own actors and
public Shell/St APIs only, which keeps breakage on new GNOME releases small.

- On any screen edge. On the left or right the bar holds the apps and GNOME's top bar keeps the menu, clock, tray and system menu, optionally in the dock's look. At the bottom the top bar can stay on its own too
- Own dark look by default, or the colors of the shell theme and the system accent color
- Hover animations: magnify, ripple, lift or none
- Icons bounce while an app starts and wiggle when it asks for attention
- One dot per window, the focused app's dots stand out
- App name above the hovered icon, right click for the app menu
- Window previews on hover: click one to raise it, close it from its title bar
- Drag icons to rearrange favorites, drop apps from the overview to pin them, drag them off to unpin
- Clicking the focused app minimizes it, or cycles through its windows
- Badge counts and progress bars that apps publish (Unity LauncherEntry API)
- Trash and removable drives after the apps, with open, empty and eject
- Separators between favorites, running apps, places and the top bar content
- Autohide while a window overlaps the bar, opaque background while one touches it

Everything beyond the basic bar can be switched off in the preferences.
Primary monitor only.

## Test

```
gjs -m test/layout-test.js   # hover animation math
test/smoke.sh                # headless GNOME Shell: enable/disable, settings, prefs, demo tray icons and window
test/smoke.sh --show         # same in a window with your shell setup mirrored in (needs mutter-dev-bin)
```

The test shell gets its own D-Bus and in-memory settings, the running session
is not touched.

## Translations

The bar and the preferences follow the system language through gettext. The
catalogs live in `po/`, `test/smoke.sh` compiles them into `locale/`. After
changing texts, update the template and merge it into each language:

```
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --package-name=silver-dock -o po/silver-dock.pot extension.js places.js prefs.js
msgmerge --update po/de.po po/silver-dock.pot
```

A new language starts with `msginit -l <lang> -i po/silver-dock.pot -o po/<lang>.po`.

## Development install

```
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/silver-dock@simonlinuxcraft.github.io
```

Log out and back in, then `gnome-extensions enable silver-dock@simonlinuxcraft.github.io`.

## New GNOME release

Add the version to `shell-version` in `metadata.json` and run `test/smoke.sh`.
