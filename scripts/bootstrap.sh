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
  2. В обоих таргетах (CloudVPN + CloudVPNHelper) → Signing & Capabilities → выбери свою Team
     (бесплатный Apple ID подойдёт для запуска на своём маке).
  3. Убедись, что Core/mihomo и Helper/Launchd.plist попадают в бандл (Copy phases) — см. README.
  4. Run. Первый запуск попросит разрешить хелпер в System Settings → General → Login Items.
EOF
