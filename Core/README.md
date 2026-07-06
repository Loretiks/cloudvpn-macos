# Core

The mihomo (Clash.Meta) binary lives here as `Core/mihomo` (universal arm64+amd64).

It is **not committed** (it's large and versioned) — fetch it with:

```bash
./scripts/fetch-mihomo.sh
```

Xcode must copy `Core/mihomo` into the app bundle (e.g. `Contents/Resources/mihomo`
or next to the helper in `Contents/MacOS/`) via a **Copy Files** build phase so the
privileged helper can launch it. See the repo README → “Wiring in Xcode”.

`geoip`/`geosite` data: mihomo downloads it on first run if the config references it,
or bundle `geoip.metadb` / `geosite.metadb` here and point the config at them.
