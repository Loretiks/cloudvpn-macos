#!/usr/bin/env bash
# Собирает оформленный установщик: фон (Retina), окно 640×430 (контент 640×400 — под фон), приложение слева,
# «Программы» справа, значок тома = значок приложения.
#
#   ./scripts/make-dmg.sh <CloudVPN.app> <out.dmg>
#
# Фон рисуется из scripts/dmg/background.swift; раскладку делает create-dmg через
# Finder (AppleScript) — только так фон гарантированно работает на свежих macOS
# (dmgbuild пишет .DS_Store сам, и Finder 26 фон из него игнорирует).
# Нужен мак с GUI-сессией и разрешением «Терминал → Finder» (Автоматизация).
# Без create-dmg — откат на простой hdiutil, чтобы релиз не встал.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$1"; DMG="$2"; VOL="Cloud VPN"
[ -d "$APP" ] || { echo "✗ нет $APP" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"; cp -R "$APP" "$WORK/src/"
APPNAME="$(basename "$APP")"
rm -f "$DMG"

command -v create-dmg >/dev/null || brew install create-dmg >/dev/null 2>&1 || true
if command -v create-dmg >/dev/null; then
  # create-dmg адресует диск по имени тома — одноимённый смонтированный том (старый
  # установщик) перехватит раскладку. Отмонтировать заранее.
  [ -d "/Volumes/$VOL" ] && hdiutil detach "/Volumes/$VOL" -quiet || true
  swift scripts/dmg/background.swift "$WORK" >/dev/null
  tiffutil -cathidpicheck "$WORK/background.png" "$WORK/background@2x.png" -out "$WORK/background.tiff" >/dev/null
  create-dmg --volname "$VOL" \
    --volicon "$APP/Contents/Resources/AppIcon.icns" \
    --background "$WORK/background.tiff" \
    --window-pos 200 140 --window-size 640 430 \
    --icon-size 112 --text-size 13 \
    --icon "$APPNAME" 170 205 --hide-extension "$APPNAME" \
    --app-drop-link 470 205 \
    --no-internet-enable \
    "$DMG" "$WORK/src" >/dev/null
else
  echo "⚠ create-dmg недоступен — простой DMG без оформления" >&2
  ln -s /Applications "$WORK/src/Applications"
  hdiutil create -volname "$VOL" -srcfolder "$WORK/src" -ov -format UDZO "$DMG" >/dev/null
fi
echo "✓ $DMG"
