# Homebrew Cask для Cloud VPN.
#
# Установка (без ручного обхода Gatekeeper — brew сам снимает карантин):
#   brew tap Loretiks/cloudvpn https://github.com/Loretiks/homebrew-cloudvpn
#   brew install --cask cloudvpn
#
# Этот файл живёт в отдельном tap-репозитории Loretiks/homebrew-cloudvpn в папке Casks/.
# scripts/release.sh обновляет version + sha256 здесь; после релиза скопируй/запушь его
# в tap-репо (или настрой пуш в release.sh).
cask "cloudvpn" do
  version "0.1.0"
  sha256 "c6fa5ad17fb82c30d2039fc6a67a5762178e8a34bc4c146dac6497a71ea6e66d"

  url "https://github.com/Loretiks/cloudvpn-macos/releases/download/v#{version}/CloudVPN-#{version}.dmg",
      verified: "github.com/Loretiks/cloudvpn-macos/"
  name "Cloud VPN"
  desc "Быстрый и приватный VPN (VLESS + Reality, ядро mihomo)"
  homepage "https://cloude.tech/"

  # Приложение обновляется само через Sparkle — brew не перетирает и не мешает.
  auto_updates true
  depends_on macos: ">= :ventura"

  app "CloudVPN.app"

  # Привилегированный root-хелпер ставится приложением через SMAppService.
  uninstall quit:      "tech.cloude.vpn.mac",
            launchctl: "tech.cloude.vpn.mac.helper"

  zap trash: [
    "~/Library/Preferences/tech.cloude.vpn.mac.plist",
    "~/Library/Caches/tech.cloude.vpn.mac",
    "~/Library/Application Support/CloudVPN",
  ]
end
