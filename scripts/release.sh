#!/usr/bin/env bash
# Выпускает релиз Cloud VPN на GitHub Releases с рабочим авто-обновлением Sparkle
# (appcast + EdDSA-подпись + дельты). Нотаризация Apple НЕ требуется — целостность
# обновления гарантирует EdDSA-подпись. Единственная плата за отсутствие нотаризации:
# у пользователя разовый обход Gatekeeper при первом запуске (или установка через brew).
#
# Требуется:
#   • gh (GitHub CLI), авторизован: gh auth status
#   • приватный EdDSA-ключ Sparkle в Keychain (scripts/gen-sparkle-keys.sh)
#   • публичный репо REPO (иначе ассеты релиза требуют авторизации → Sparkle не скачает)
#
# Использование:
#   ./scripts/release.sh                 # собрать текущую версию и выпустить
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

REPO="${REPO:-Loretiks/cloudvpn-macos}"
DIST="$ROOT/dist"
UPDATES="$DIST/updates"          # накапливает ВСЕ DMG/дельты + appcast.xml между релизами

command -v gh >/dev/null || { echo "✗ нужен gh (GitHub CLI): brew install gh && gh auth login" >&2; exit 1; }

# 1. Инструменты Sparkle (из SPM-артефактов; резолвятся при сборке проекта).
SPARKLE_BIN="${SPARKLE_BIN:-$(find "$HOME/Library/Developer/Xcode/DerivedData" \
  -path '*artifacts/sparkle/Sparkle/bin' -type d 2>/dev/null | head -1)}"
[ -x "$SPARKLE_BIN/generate_appcast" ] || { echo "✗ инструменты Sparkle не найдены — собери проект и повтори (или задай SPARKLE_BIN=)" >&2; exit 1; }

# 2. Собрать Release.
echo "→ сборка Release…"
DERIVED="$DIST/DerivedData"
xcodebuild -project CloudVPN.xcodeproj -scheme CloudVPN -configuration Release \
  -destination 'platform=macOS' -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates build >/dev/null
APP="$DERIVED/Build/Products/Release/CloudVPN.app"
[ -d "$APP" ] || { echo "✗ .app не собрался" >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
TAG="v$VERSION"
echo "→ версия: $VERSION  (тег $TAG)"

# 3. (для чужих маков) Developer ID + нотаризация — раскомментируй с платным аккаунтом:
# codesign --force --deep --options runtime --timestamp \
#   --sign "Developer ID Application: <NAME> (STWWNS7WRF)" "$APP"
# … и после упаковки DMG: xcrun notarytool submit … && xcrun stapler staple …
# Без этого приложение рабочее, но при ПЕРВОМ запуске просит ручной обход Gatekeeper.

# 4. Упаковать в DMG.
mkdir -p "$UPDATES"
DMG="$UPDATES/CloudVPN-$VERSION.dmg"
rm -f "$DMG"
echo "→ упаковка DMG…"
STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Cloud VPN" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# 5. Сгенерировать appcast (EdDSA-подпись + дельты). URL-префикс — путь ассетов ЭТОГО
#    релиза; latest-item и его дельта укажут на ассеты этого тега (что и нужно апдейту).
PREFIX="https://github.com/$REPO/releases/download/$TAG/"
echo "→ генерация appcast.xml (префикс $PREFIX)…"
"$SPARKLE_BIN/generate_appcast" --download-url-prefix "$PREFIX" "$UPDATES"

# 6. Обновить Homebrew cask (версия + sha256 DMG).
SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
CASK="$ROOT/Casks/cloudvpn.rb"
if [ -f "$CASK" ]; then
  /usr/bin/sed -i '' -E "s/  version \".*\"/  version \"$VERSION\"/" "$CASK"
  /usr/bin/sed -i '' -E "s/  sha256 \".*\"/  sha256 \"$SHA\"/" "$CASK"
  echo "→ cask обновлён: version $VERSION, sha256 $SHA"
fi

# 7. Выложить на GitHub Releases: DMG текущей версии, все дельты и appcast.xml.
#    appcast.xml обязателен как ассет — на него смотрит SUFeedURL (latest/download).
echo "→ публикация релиза ${TAG} в ${REPO} …"
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$UPDATES/appcast.xml" "$DMG" $UPDATES/*.delta --clobber -R "$REPO" 2>/dev/null || \
  gh release upload "$TAG" "$UPDATES/appcast.xml" "$DMG" --clobber -R "$REPO"
else
  gh release create "$TAG" -R "$REPO" --latest --title "Cloud VPN $VERSION" \
    --notes "Автообновление через Sparkle. Первый запуск — правый клик → «Открыть» (или brew --cask)." \
    "$UPDATES/appcast.xml" "$DMG" $UPDATES/*.delta 2>/dev/null || \
  gh release create "$TAG" -R "$REPO" --latest --title "Cloud VPN $VERSION" \
    --notes "Автообновление через Sparkle." "$UPDATES/appcast.xml" "$DMG"
fi

echo
echo "✓ Релиз $TAG опубликован."
echo "  Фид: https://github.com/$REPO/releases/latest/download/appcast.xml"
echo "  DMG: $PREFIX$(basename "$DMG")"
echo "  ⚠ репо должен быть ПУБЛИЧНЫМ, иначе Sparkle не скачает ассеты."
echo "  ⚠ без нотаризации первый запуск требует обхода Gatekeeper (или установки через brew --cask)."
