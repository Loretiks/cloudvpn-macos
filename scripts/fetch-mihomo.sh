#!/usr/bin/env bash
# Download the mihomo (Clash.Meta) core for macOS (arm64 + amd64) and build a
# universal binary at Core/mihomo. The binary is NOT committed (see .gitignore) —
# run this once after cloning, and again to bump the version.
#
#   MIHOMO_VERSION=v1.18.10 ./scripts/fetch-mihomo.sh
#
# Verify the latest tag + asset names at:  https://github.com/MetaCubeX/mihomo/releases
set -euo pipefail

VER="${MIHOMO_VERSION:-v1.18.10}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/Core"
BASE="https://github.com/MetaCubeX/mihomo/releases/download/$VER"
mkdir -p "$OUT"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

for arch in arm64 amd64; do
  url="$BASE/mihomo-darwin-$arch-$VER.gz"
  echo "↓ $url"
  curl -fSL "$url" -o "$tmp/m-$arch.gz"
  gunzip -c "$tmp/m-$arch.gz" > "$tmp/mihomo-$arch"
done

lipo -create -output "$OUT/mihomo" "$tmp/mihomo-arm64" "$tmp/mihomo-amd64"
chmod +x "$OUT/mihomo"
echo "✓ built universal core → $OUT/mihomo"
file "$OUT/mihomo"
