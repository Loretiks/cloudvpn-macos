#!/usr/bin/env bash
# Download the mihomo (Clash.Meta) core for macOS (arm64 + amd64) and build a
# universal binary at Core/mihomo, plus the geo databases mihomo needs for
# GEOIP/GEOSITE rules. None of it is committed (see .gitignore) — run this once
# after cloning, and again to bump the version.
#
#   MIHOMO_VERSION=v1.18.10 ./scripts/fetch-mihomo.sh
#
# Verify the latest tag + asset names at:  https://github.com/MetaCubeX/mihomo/releases
set -euo pipefail

VER="${MIHOMO_VERSION:-v1.18.10}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/Core"
BASE="https://github.com/MetaCubeX/mihomo/releases/download/$VER"
GEO_BASE="https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest"
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
# lipo drops the per-slice ad-hoc signatures Go emits — put one back so the binary
# runs on Apple Silicon. The Xcode embed phase re-signs it with the real identity.
codesign --force --sign - "$OUT/mihomo"
echo "✓ built universal core → $OUT/mihomo"
file "$OUT/mihomo"

# Geo databases: bundled into the app and seeded to the helper's workdir, so the
# first connect doesn't depend on GitHub being reachable (it often isn't, exactly
# where a VPN is needed). Best-effort — mihomo can still self-download.
for f in geoip.metadb geosite.dat; do
  if [ ! -f "$OUT/$f" ]; then
    echo "↓ $GEO_BASE/$f"
    curl -fSL "$GEO_BASE/$f" -o "$OUT/$f" || echo "⚠ could not fetch $f (skipping)"
  fi
done
echo "✓ done"
