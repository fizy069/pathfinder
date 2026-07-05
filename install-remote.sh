#!/usr/bin/env bash
set -euo pipefail

# Create a temporary directory
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Downloading Pathfinder repository..."
curl -fsSL https://github.com/fizy069/pathfinder/archive/refs/heads/main.tar.gz | tar -xz -C "$TEMP_DIR" --strip-components=1

echo "Running installation..."
"$TEMP_DIR/install.sh" "$@"
