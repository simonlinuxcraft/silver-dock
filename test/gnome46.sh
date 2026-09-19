#!/bin/bash
# Runs test/smoke.sh against GNOME Shell 46 (Ubuntu 24.04 LTS) in a podman container:
# headless under Wayland, then as an X11 session on a virtual X server. The image is
# built on the first run.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
image=silver-dock-gnome46
podman image exists "$image" || podman build -t "$image" -f "$root/test/Containerfile.gnome46" "$root/test"
for mode in '' --x11; do
    echo "== GNOME 46 ${mode:-wayland}"
    # As your own user, so the files smoke.sh compiles into the repo stay yours.
    podman run --rm --userns=keep-id -e HOME=/tmp/home -v "$root:/src" "$image" bash -c \
        'export XDG_RUNTIME_DIR=/tmp/runtime; mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$HOME"; /src/test/smoke.sh '"$mode"
done
