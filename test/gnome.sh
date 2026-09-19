#!/bin/bash
# test/smoke.sh on GNOME 46 to 49 (Ubuntu releases in podman), Wayland and X11 where it exists.
# Usage: test/gnome.sh [46 47 48 49]
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
        # Own user, smoke.sh compiles files into the repo.
        podman run --rm --userns=keep-id -e HOME=/tmp/home -v "$root:/src" "$image" bash -c '
            export XDG_RUNTIME_DIR=/tmp/runtime; mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$HOME"
            if [[ $0 && ! $(gnome-shell --help-all 2>&1 | grep -e "--x11\b") ]]; then echo "no X11 session, skipped"; exit; fi
            /src/test/smoke.sh $0' "$mode"
    done
done
