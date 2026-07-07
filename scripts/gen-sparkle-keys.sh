#!/usr/bin/env bash
# Одноразово: создаёт пару ключей Sparkle EdDSA. Приватный ключ кладётся в Keychain
# (им подписываются релизы через generate_appcast/sign_update), публичный печатается —
# его нужно вписать в App/Info.plist → SUPublicEDKey.
#
# ⚠ Приватный ключ НЕ коммить и не терять: без него нельзя выпустить обновление,
#   которое примут уже установленные клиенты. Экспорт для бэкапа: sign_update -x file
set -euo pipefail
cd "$(dirname "$0")/.."

SPARKLE_BIN="${SPARKLE_BIN:-$(find "$HOME/Library/Developer/Xcode/DerivedData" \
  -path '*artifacts/sparkle/Sparkle/bin' -type d 2>/dev/null | head -1)}"
if [ -z "$SPARKLE_BIN" ] || [ ! -x "$SPARKLE_BIN/generate_keys" ]; then
  echo "✗ инструменты Sparkle не найдены — сначала собери проект (xcodebuild), потом запусти снова." >&2
  exit 1
fi

"$SPARKLE_BIN/generate_keys"
echo
echo "→ Скопируй значение SUPublicEDKey выше в App/Info.plist (ключ уже есть — замени)."
