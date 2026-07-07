# Cloud VPN — macOS

Нативный macOS-клиент Cloud VPN **с тем же интерфейсом, что и Windows-клиент**: общий
HTML/CSS/JS (`App/Web`, дословно из cloudvpn-desktop) рендерится в WKWebView, а Swift-мост
(`NativeBridge`) реализует тот же протокол сообщений, что C#-хост на Windows
(`vpn:connect / vpn:sub / ping / apps:list / win:* / theme / notify / autostart / update`).
Ядро — **mihomo** (VLESS + Reality + Vision) в TUN- или прокси-режиме через
привилегированный хелпер. **Не требует Apple NetworkExtension** — собирается и
запускается на своём маке даже с **бесплатным** Apple ID.

> Проект собирается «из коробки»: copy-phases (mihomo, хелпер, launchd-plist, geo-базы,
> Web-ресурсы) прописаны в `project.yml`, XPC-клиент проверяется по подписи. Осталось
> только выбрать свою Team в Xcode (или оставить прописанную) и разрешить хелпер при
> первом запуске.

---

## Архитектура

```
┌───────────────────────────────────┐        XPC        ┌───────────────────────────────┐
│  CloudVPN.app                     │ ◀──────────────▶  │ CloudVPNHelper (LaunchDaemon) │  root
│  WKWebView ← App/Web (общий UI    │                   │ • запускает/тушит mihomo      │
│  с Windows: логин, orb, серверы,  │   start(config)   │ • mihomo создаёт utun +       │
│  тарифы, устройства, темы)        │ ────────────────▶ │   маршруты (full-tunnel)      │
│  NativeBridge (Swift ⇄ JS):       │                   └───────────────────────────────┘
│  vless→mihomo cfg, пинг, apps,    │                                 │ spawns
│  трафик из external-controller    │                                 ▼
└───────────────────────────────────┘                Core/mihomo ──▶ VLESS/Reality nodes
        │ HTTPS (из JS, Bearer)
        ▼
  cloude.tech/api  (auth: Telegram deep-link / e-mail; /me, подписка, платежи, устройства)
```

- **UI** (`App/Web`) — дословно интерфейс Windows-клиента; сам ходит в API по Bearer-токену
  и просит нативную часть подключаться (`vpn:connect:{vless, mode, route, rules}`).
- **NativeBridge** конвертирует vless:// в конфиг mihomo (`MihomoConfigBuilder`, Reality/
  Vision/ws/grpc), импортирует подписку (`SubscriptionImporter`), меряет ICMP-пинг,
  отдаёт список запущенных приложений для split-tunneling и стримит трафик/статус
  из `external-controller` (127.0.0.1:9191) обратно в JS.
- **Хелпер** (root, ставится через `SMAppService`) получает конфиг по XPC и запускает
  `mihomo -d <dir> -f config.yaml`. mihomo сам поднимает `utun` и маршруты; в
  прокси-режиме просто слушает 127.0.0.1:7897 (mixed).

Почему так, а не NetworkExtension: NE-VPN для раздачи требует платный Apple Developer +
отдельный энтайтлмент от Apple. Хелпер+utun это обходит и повторяет твою Windows-схему.
Минус — для распространения (нотаризация DMG) платный аккаунт всё равно понадобится.

---

## Быстрый старт (на маке)

```bash
git clone git@github.com:Loretiks/cloudvpn-macos.git
cd cloudvpn-macos
./scripts/bootstrap.sh        # brew install xcodegen + fetch mihomo + xcodegen generate
open CloudVPN.xcodeproj
```

В Xcode:
1. `project.yml` уже содержит `DEVELOPMENT_TEAM` — если Team другой, поменяй в
   *Signing & Capabilities* у обоих таргетов (бесплатный Apple ID подойдёт для своего мака).
2. **Run**. Первый запуск попросит включить хелпер в *System Settings → General → Login Items* —
   разреши, потом жми Connect.

Или из терминала:

```bash
xcodebuild -project CloudVPN.xcodeproj -scheme CloudVPN -configuration Debug \
  -destination 'platform=macOS' -allowProvisioningUpdates build
```

Требования: macOS 13+, Xcode 15+, [XcodeGen](https://github.com/yonyz/XcodeGen) (`brew install xcodegen`).

---

## Как собирается бандл

`project.yml` задаёт оба таргета, entitlements, вшивает `Info.plist`/launchd-plist в хелпер
через `-sectcreate`, а post-build скрипт **Embed helper + core** раскладывает всё по бандлу
(до финальной подписи, так что всё попадает под seal):

| Что                                        | Куда в `CloudVPN.app`                        |
|--------------------------------------------|----------------------------------------------|
| собранный `CloudVPNHelper`                 | `Contents/MacOS/tech.cloude.vpn.mac.helper`  |
| `Helper/tech.cloude.vpn.mac.helper.plist`  | `Contents/Library/LaunchDaemons/`            |
| `Core/mihomo` (переподписывается identity сборки) | `Contents/MacOS/mihomo`               |
| `Core/{geoip.metadb,geosite.dat}`          | `Contents/Resources/` (хелпер сеет их в workdir) |
| `App/Web/` (folder reference в project.yml) | `Contents/Resources/Web/`                   |

Хелпер ищет `mihomo` рядом с собой (`Helper/main.swift → mihomoBinary()`). Лог mihomo
пишется в `/Library/Application Support/CloudVPN/mihomo.log` — смотри туда, если Connect
падает. Подробно про `SMAppService` daemon:
Apple → “Updating helper executables from earlier versions of macOS”.

---

## Подключение к API

Весь API-слой живёт в **JS** (`App/Web/api.js`, общий с Windows) и ходит на
`https://cloude.tech` по **Bearer-токену** (JWT в localStorage): Telegram deep-link
(`/api/auth/telegram/start` → бот → `poll`), e-mail+пароль, e-mail-код, `/api/auth/me`,
подписка, устройства (HWID), платежи Платеги, новости, подарки. Страница загружается
с `file://`, поэтому в WKWebView включён `allowUniversalAccessFromFileURLs` — CORS к
API не мешает (проверено на живом `/api/sale`).

⚠️ **SNI-блок:** `cloude.tech` на части RU-сетей режется по SNI — а это ровно те юзеры,
кому нужен VPN. Для запросов к API нужен доступный там эндпоинт (незаблокированный
api-домен / origin-IP + Host / fronting-домен). База задаётся в `App/Web/config.js`
(`apiBase`). Реши это до релиза.

---

## Безопасность

- Хелпер (root) проверяет подпись XPC-клиента: `setCodeSigningRequirement` (macOS 13+)
  требует Apple-anchored подпись с нашим bundle id и тем же Team ID, что у самого хелпера
  (Team ID читается из собственной подписи — ничего не захардкожено). Ад-хок сборка без
  Team пропускает проверку с warning в лог — **не релизить такую**.
- Никаких секретов в репо: токенов/паролей/`.env` тут нет и не должно быть.

---

## Автообновление (Sparkle) и дистрибуция через GitHub — без платного Apple Developer

Обновления — на **Sparkle**, с appcast на **GitHub Releases** и дельтами, как на Windows-
клиенте. Нотаризация Apple обновлениям **не нужна**: целостность гарантирует EdDSA-подпись
Sparkle. Проверено end-to-end (клиент нашёл новую версию, скачал **дельту ~11 КБ**, проверил
подпись, поставил и перезапустился).

- **Клиент:** `Sparkle.framework` (SPM), фид `SUFeedURL =`
  `https://github.com/Loretiks/cloudvpn-macos/releases/latest/download/appcast.xml`
  (стабильный URL — всегда appcast последнего релиза) и `SUPublicEDKey` в `App/Info.plist`;
  `SPUStandardUpdaterController` в `AppDelegate`. Плановые проверки раз в сутки + пункт
  меню-бара «Проверить обновления…»; web-кнопка «Обновить» тоже дёргает Sparkle.
- **Ключи:** пара EdDSA. Приватный — в Keychain (создать — `scripts/gen-sparkle-keys.sh`),
  публичный — в Info.plist. **Приватный ключ не терять и не коммитить** — без него нельзя
  выпустить обновление, которое примут установленные клиенты.
- **Выпуск релиза:** `scripts/release.sh` — собирает Release, пакует DMG, `generate_appcast`
  подписывает + добавляет дельты, и публикует всё (DMG + дельты + appcast.xml) на GitHub
  Releases через `gh`, помечая релиз как latest. Требует публичный репо и `gh auth login`.

### Установка (пользователю)

- **Homebrew (рекомендуется, без ручного обхода Gatekeeper):**
  ```bash
  brew tap Loretiks/cloudvpn https://github.com/Loretiks/homebrew-cloudvpn
  brew install --cask cloudvpn
  ```
  brew сам снимает карантин — приложение запускается сразу. Cask: `Casks/cloudvpn.rb`
  (лежит в отдельном tap-репо `homebrew-cloudvpn`; `release.sh` обновляет в нём version+sha256).
- **DMG напрямую:** скачать с Releases, перетащить в Программы. Первый запуск —
  правый клик по приложению → **«Открыть»** → подтвердить (или Настройки → Privacy &
  Security → «Открыть всё равно»). Это разово: `com.apple.quarantine` снимается, дальше
  Sparkle-обновления идут без промптов.

### Про нотаризацию

Без платного Apple Developer приложение **не нотаризовано**, поэтому у пользователя один
разовый обход Gatekeeper при первом запуске (или установка через brew, где его нет).
**Апдейты от этого не страдают.** Когда появится платный аккаунт — раскомментируй в
`release.sh` шаги Developer ID подписи + нотаризации (`notarytool`/`stapler`), и первый
запуск станет бесшовным. ⚠ Приложение ставит **root-демон** (SMAppService) — его одобрение
в Настройках на чужих свежих macOS стоит проверить на втором маке.

- CI (`.github/workflows/build.yml`) делает только **unsigned** сборку.

---

## Паритет с Windows-клиентом

Нативные функции, воспроизведённые под macOS:

- **Меню-бар иконка** (`NSStatusItem`): статус туннеля, Подключить/Отключить, «Открыть»,
  «Выйти». Крестик окна сворачивает в трей (туннель живёт в хелпере); «Выйти» —
  полный выход с остановкой туннеля и снятием kill switch.
- **Kill Switch** (`Helper/KillSwitch.swift`): pf-фаервол в рут-хелпере. Пока туннель
  поднят и тумблер включён, весь исходящий трафик кроме утуна, VPN-сервера и lo0
  блокируется (`block drop out quick all`). Правила грузятся в pf-якорь `cloudvpn`,
  включается pf со счётчиком ссылок (`pfctl -E/-X`). Снимается на дисконнекте, выходе
  и старте демона; правила не переживают ребут (грузятся динамически) — в офлайне не
  залипнуть. При обрыве туннеля с включённым kill switch сеть **остаётся заблокированной**
  (это и есть его смысл) до переподключения / выключения тумблера / выхода.
- **Автообновление на Sparkle** (appcast на своём домене + дельты + EdDSA-подпись) —
  см. раздел «Автообновление (Sparkle)» ниже. Проверено end-to-end (дельта ~11 КБ).
- **HWID устройств** (`App/Bridge/DeviceID.swift`): аппаратный UUID + модель + версия ОС
  шлются в заголовках `x-hwid/x-device-os/...` при скачивании подписки — Mac занимает
  слот и появляется в списке «Устройства», как на Windows.

Осознанное отличие: split-tunneling по процессам матчит имена macOS («Google Chrome»),
а не `chrome.exe`.

## Роадмап / TODO

- [x] Дизайн и функционал Windows-клиента: общий Web-UI + Swift-мост с тем же протоколом.
- [x] Проверка подписи XPC-клиента в хелпере.
- [x] Copy phases (mihomo + launchd-plist + geo-базы + Web) — автоматизированы в `project.yml`.
- [x] Выбор ноды/региона, пинг, split-tunneling, импорт подписки.
- [x] Меню-бар иконка + сворачивание в трей, Kill Switch (pf), HWID, иконка приложения.
- [x] Автообновление на Sparkle (appcast + EdDSA + дельты) — проверено end-to-end.
- [ ] Прогнать полный цикл на живом аккаунте (логин → подписка → Connect в TUN + kill switch).
- [ ] Решить SNI-доступ к API из RU.
- [ ] Нотаризация DMG для раздачи на чужие маки (нужен платный Apple Developer).

## Структура

```
project.yml            XcodeGen-спека (app + helper + embed-скрипт)
App/CloudVPNApp.swift  AppKit-запуск: chromeless-окно + WKWebView + меню-бар/трей
App/Web/               UI Windows-клиента как есть (html/css/js + флаги/иконки)
App/Bridge/            NativeBridge (протокол JS⇄Swift), пинг, список приложений, HWID
App/VPN/               vless→mihomo конфиг, импорт подписки, VPNController, XPC-клиент хелпера
App/Assets.xcassets/   иконка приложения (из Windows-клиента)
Helper/                привилегированный демон (root): mihomo + KillSwitch (pf) + launchd
Shared/                Constants + XPC-протокол (в обоих таргетах)
Core/                  mihomo-бинарь + geo-базы (fetch-скриптом, не в гите)
scripts/               fetch-mihomo.sh, bootstrap.sh, release.sh, gen-sparkle-keys.sh
.github/workflows/     CI (unsigned build)
```
