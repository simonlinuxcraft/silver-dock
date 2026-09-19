#!/bin/bash
# Runs test/smoke.sh against the GNOME Shell of older Ubuntu releases in podman
# containers: headless under Wayland, then as an X11 session on a virtual X server
# where the release still has one. Images are built on the first run.
# Usage: test/gnome.sh [46 47 48 49]   (all four by default, GNOME 50 is the host)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
declare -A release=([46]=24.04 [47]=24.10 [48]=25.04 [49]=25.10)
versions=("$@")
(( $# )) || versions=(46 47 48 49)
for v in "${versions[@]}"; do
    image=silver-dock-gnome$v
    podman image exists "$image" ||
        podman build -t "$image" --build-arg RELEASE="${release[$v]}" -f "$root/test/Containerfile" "$root/test"
    for mode in '' --x11; do
        echo "== GNOME $v ${mode:-wayland}"
        # As your own user, so the files smoke.sh compiles into the repo stay yours.
        podman run --rm --userns=keep-id -e HOME=/tmp/home -v "$root:/src" "$image" bash -c '
            export XDG_RUNTIME_DIR=/tmp/runtime; mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$HOME"
            if [[ $0 && ! $(gnome-shell --help-all 2>&1 | grep -e "--x11\b") ]]; then echo "no X11 session, skipped"; exit; fi
            /src/test/smoke.sh $0' "$mode"
    done
done
