#!/usr/bin/env bash
# Installs the extension for the current user. Works on Bazzite's immutable
# image: everything goes to ~/.local, nothing is layered.
set -euo pipefail

uuid="rdp-workspace@platypuschan.github.io"
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$uuid"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$src/." "$dest/"
glib-compile-schemas "$dest/schemas"

echo "Installed to $dest"
echo "Log out and back in (Wayland cannot reload the shell), then run:"
echo "  gnome-extensions enable $uuid"
