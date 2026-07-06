# Cloud VPN — macOS

Нативный macOS-клиент Cloud VPN. SwiftUI-приложение + **mihomo** (Clash.Meta) в TUN-режиме
через привилегированный хелпер. Архитектура повторяет Windows-клиент (mihomo владеет TUN,
хелпер даёт рут-права) и **не требует Apple NetworkExtension** — значит собирается и
запускается на своём маке даже с **бесплатным** Apple ID.

> Это скелет для разработки на маке, не готовый релиз. Всё компилируемое написано, но
> mac-специфику (copy phases, подпись, первый прогон хелпера) нужно докрутить в Xcode.

---

## Архитектура

```
┌────────────────────────┐        XPC         ┌───────────────────────────────┐
│  CloudVPN.app (SwiftUI)│ ◀───────────────▶  │ CloudVPNHelper (LaunchDaemon) │  root
│  • логин (Telegram)    │                    │ • запускает/тушит mihomo      │
│  • тянет sub_url        │  start(config)     │ • mihomo создаёт utun +       │
│  • строит mihomo config │ ─────────────────▶ │   маршруты (full-tunnel)      │
└────────────────────────┘                    └───────────────────────────────┘
        │ HTTPS                                          │ spawns
        ▼                                                ▼
  cloude.tech/api                                   Core/mihomo  ──▶  VLESS/Reality nodes
  (auth, /me → sub_url)                             (config.yaml)
```

- **Приложение** логинит юзера (Telegram deep-link, без капчи), получает `sub_url`
  (`https://sub.cloude.tech/<short>`), скачивает clash-конфиг и добавляет `tun:` +
  `external-controller:`.
- **Хелпер** (root, ставится через `SMAppService`) получает конфиг по XPC и запускает
  `mihomo -d <dir> -f config.yaml`. mihomo сам поднимает `utun` и маршруты.

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
1. Таргеты **CloudVPN** и **CloudVPNHelper** → *Signing & Capabilities* → выбери **Team**
   (бесплатный Apple ID подойдёт для запуска на своём маке).
2. Проверь copy phases (см. ниже) — `Core/mihomo` и `Helper/Launchd.plist` должны попасть в бандл.
3. **Run**. Первый запуск попросит включить хелпер в *System Settings → General → Login Items* —
   разреши, потом жми Connect.

Требования: macOS 13+, Xcode 15+, [XcodeGen](https://github.com/yonyz/XcodeGen) (`brew install xcodegen`).

---

## Wiring в Xcode (то, что нельзя выразить в project.yml на 100%)

`project.yml` задаёт оба таргета, entitlements и вшивает `Info.plist`/`Launchd.plist` в
хелпер через `-sectcreate`. Вручную в Xcode добавь **Copy Files** phases в таргет `CloudVPN`:

| Что копировать              | Куда (Destination)                         |
|-----------------------------|--------------------------------------------|
| `Core/mihomo`               | `Resources` (или `Executables`)            |
| собранный `CloudVPNHelper`  | `Contents/MacOS/` (Wrapper → `MacOS`)      |
| `Helper/Launchd.plist`      | `Contents/Library/LaunchDaemons/` как `tech.cloude.vpn.mac.helper.plist` |

Пути, откуда хелпер ищет `mihomo`, лежат в `Helper/main.swift → mihomoBinary()` — поправь
под выбранный Destination. Подробно про `SMAppService` daemon:
Apple → “Updating helper executables from earlier versions of macOS”.

---

## Подключение к API

Клиент: `App/API/CloudVPNAPI.swift`. Аутентификация — **Telegram deep-link** (как в десктопе,
без Turnstile-капчи):

1. `POST /api/auth/telegram/start` → `{token, url}` — открываем `t.me/…?start=login_<token>`.
2. Юзер подтверждает в боте.
3. `GET /api/auth/telegram/poll?token=…` — пока не подтвердил, отдаёт «pending»; после —
   ставит session-cookie (URLSession хранит его сам).
4. `GET /api/auth/me` → аккаунт с `subUrl`.

⚠️ **Проверь имена полей** в ответах `/auth/me` и `/auth/telegram/*` на живом API — модель
`Account` сделана «мягкой» (все поля optional), но `subUrl` должен приходить. Правь
`Models.swift`, если сервер отдаёт иначе.

⚠️ **SNI-блок:** `cloude.tech` на части RU-сетей режется по SNI — а это ровно те юзеры,
кому нужен VPN. Для запросов к API нужен доступный там эндпоинт (незаблокированный
api-домен / origin-IP + Host / fronting-домен). Задаётся в `Shared/Constants.swift`
(`apiBase`) или через env `CLOUDVPN_API_BASE`. Реши это до релиза.

---

## Безопасность

- Хелпер (root) в `Helper/main.swift` **обязан проверять подпись клиента** перед доверием
  (audit token + designated requirement по нашему Team ID) — сейчас там `SECURITY TODO`.
  Сделать до любого публичного релиза, иначе любой локальный процесс сможет рулить рут-хелпером.
- Никаких секретов в репо: токенов/паролей/`.env` тут нет и не должно быть.

---

## Дистрибуция (позже, нужен платный Apple Developer)

- Собрать → подписать **Developer ID** → **нотаризовать** (`notarytool`) → упаковать в DMG.
- Автообновление — как на Windows-клиенте, через GitHub Releases (можно
  [Sparkle](https://sparkle-project.org/)).
- CI (`.github/workflows/build.yml`) сейчас делает только **unsigned** сборку. Подпись/нотаризацию
  добавишь секретами, когда будет платный аккаунт.

---

## Роадмап / TODO

- [ ] Проверить/поправить поля `Account` под живой `/api/auth/me`.
- [ ] Решить SNI-доступ к API из RU.
- [ ] Проверка подписи XPC-клиента в хелпере.
- [ ] Copy phases (mihomo + Launchd.plist) в Xcode.
- [ ] Выбор ноды/региона (mihomo external-controller уже включён на `127.0.0.1:9191`).
- [ ] Меню-бар режим (`LSUIElement`) + автозапуск.
- [ ] Подпись + нотаризация + DMG + автообновление.

## Структура

```
project.yml            XcodeGen-спека (app + helper)
App/                   SwiftUI: вход, экран подключения, API-клиент, mihomo-конфиг, XPC-клиент
Helper/                привилегированный демон (root) + launchd/entitlements
Shared/                Constants + XPC-протокол (в обоих таргетах)
Core/                  mihomo-бинарь (fetch-скриптом, не в гите)
scripts/               fetch-mihomo.sh, bootstrap.sh
.github/workflows/     CI (unsigned build)
```
