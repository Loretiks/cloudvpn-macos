#!/usr/bin/env bash
# One-shot setup on a fresh Mac: install XcodeGen, fetch the core, generate the project.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "→ installing XcodeGen (brew)…"
  brew install xcodegen
fi

if [ ! -x Core/mihomo ]; then
  echo "→ fetching mihomo core…"
  ./scripts/fetch-mihomo.sh
fi

echo "→ generating CloudVPN.xcodeproj…"
xcodegen generate

cat <<'EOF'

✓ Готово.
  1. open CloudVPN.xcodeproj
  2. Team уже прописана в project.yml — если она не твоя, поменяй в Signing & Capabilities
     у обоих таргетов (бесплатный Apple ID подойдёт для запуска на своём маке).
  3. Run. Первый запуск попросит разрешить хелпер в System Settings → General → Login Items.
     Всё остальное (mihomo, launchd-plist, geo-базы) попадает в бандл автоматически.
EOF
