import AppKit
import WebKit
import ServiceManagement
import UserNotifications

/// Speaks the exact message protocol of the Windows client's C# host, so the
/// shared web UI works unchanged:
///   JS → native : win:* theme:* notify:* autostart:* open:* ping:* apps:list
///                 log:* update:* vpn:connect:* vpn:disconnect vpn:sub:*
///   native → JS : vpn:{json} sub:{json} pong:* apps:list:[…] log:tail:{…} update:*
@MainActor
final class NativeBridge: NSObject {
    private weak var window: NSWindow?
    private weak var webView: WKWebView?
    private lazy var vpn = VPNController { [weak self] json in self?.emitVPN(json) }

    /// Вызывается при смене состояния туннеля (для меню-бар иконки).
    var onVPNState: ((Bool) -> Void)?

    /// Запуск проверки обновлений через Sparkle (владелец — AppDelegate).
    var onCheckForUpdates: (() -> Void)?

    /// Kill Switch: источник правды на нативной стороне (persist), чтобы применять
    /// при каждом коннекте. Значение шлёт UI сообщением `killswitch:on|off`.
    static let killSwitchKey = "cloudvpn.killswitch"
    var killSwitchEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.killSwitchKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.killSwitchKey) }
    }

    init(window: NSWindow, webView: WKWebView) {
        self.window = window
        self.webView = webView
        super.init()
    }

    /// Транслируем vpn-события в UI и параллельно обновляем меню-бар.
    private func emitVPN(_ json: String) {
        send("vpn:" + json)
        if let data = json.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let state = obj["state"] as? String {
            switch state {
            case "connected":    onVPNState?(true)
            case "disconnected", "error": onVPNState?(false)
            default: break
            }
        }
    }

    /// WebView2 API surface expected by the shared UI, backed by webkit handlers.
    static let webview2Shim = """
    (function () {
      const listeners = [];
      window.chrome = window.chrome || {};
      window.chrome.webview = {
        postMessage(m) { try { window.webkit.messageHandlers.host.postMessage(String(m)); } catch (e) {} },
        addEventListener(t, fn) { if (t === 'message' && typeof fn === 'function') listeners.push(fn); },
        removeEventListener(t, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        __emit(data) { listeners.forEach(fn => { try { fn({ data }); } catch (e) {} }); },
      };
    })();
    """

    // MARK: native → JS

    func send(_ message: String) {
        guard let data = try? JSONEncoder().encode(message),
              let literal = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.chrome.webview.__emit(\(literal))")
    }

    // MARK: JS → native

    private func handle(_ msg: String) {
        switch true {
        case msg.hasPrefix("win:"):        handleWindow(String(msg.dropFirst(4)))
        case msg.hasPrefix("theme:"):      handleTheme(String(msg.dropFirst(6)))
        case msg.hasPrefix("notify:"):     notify(String(msg.dropFirst(7)))
        case msg == "autostart:on":        setAutostart(true)
        case msg == "autostart:off":       setAutostart(false)
        case msg.hasPrefix("open:"):       openExternal(String(msg.dropFirst(5)))
        case msg.hasPrefix("ping:"):       handlePing(String(msg.dropFirst(5)))
        case msg == "apps:list":           handleAppsList()
        case msg == "log:open":            openLog()
        case msg == "log:tail":            sendLogTail()
        case msg == "update:check", msg == "update:install": onCheckForUpdates?()   // Sparkle
        case msg.hasPrefix("vpn:connect:"): vpn.connect(json: String(msg.dropFirst(12)), killSwitch: killSwitchEnabled)
        case msg == "vpn:disconnect":      vpn.disconnect()
        case msg.hasPrefix("vpn:sub:"):    importSubscription(String(msg.dropFirst(8)))
        case msg == "killswitch:on":       setKillSwitch(true)
        case msg == "killswitch:off":      setKillSwitch(false)
        case msg.hasPrefix("debug:"):      NSLog("webui %@", String(msg.dropFirst(6)))
        default: NSLog("bridge: unhandled message %@", String(msg.prefix(80)))
        }
    }

    // MARK: window controls (page draws its own title bar)

    private func handleWindow(_ cmd: String) {
        guard let window else { return }
        switch cmd {
        case "min":   window.miniaturize(nil)
        case "max":   window.zoom(nil)
        case "close": window.orderOut(nil)   // сворачиваем в трей, туннель живёт в хелпере
        case "drag":  if let e = NSApp.currentEvent { window.performDrag(with: e) }
        default: break
        }
    }

    private func handleTheme(_ value: String) {
        window?.backgroundColor = value == "dark"
            ? NSColor(srgbRed: 0.031, green: 0.047, blue: 0.118, alpha: 1)   // --bg dark  #080c1e
            : NSColor(srgbRed: 0.933, green: 0.949, blue: 0.984, alpha: 1)   // --bg light #eef2fb
        window?.appearance = NSAppearance(named: value == "dark" ? .darkAqua : .aqua)
    }

    // MARK: notifications / autostart / links

    private func notify(_ body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "Cloud VPN"
            content.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    private func setAutostart(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("autostart: %@", error.localizedDescription)
        }
    }

    /// Kill Switch: сохраняем выбор и применяем на лету, если туннель уже поднят.
    private func setKillSwitch(_ on: Bool) {
        killSwitchEnabled = on
        vpn.setKillSwitchLive(on)
    }

    private func openExternal(_ raw: String) {
        guard let url = URL(string: raw),
              ["http", "https", "tg", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: ping / running apps

    private func handlePing(_ rest: String) {
        // формат: <id>:<host>
        guard let sep = rest.firstIndex(of: ":") else { return }
        let id = String(rest[..<sep]), host = String(rest[rest.index(after: sep)...])
        Task {
            let ms = await Pinger.ping(host: host)
            self.send("pong:\(id):\(ms ?? -1)")
        }
    }

    private func handleAppsList() {
        Task {
            let json = RunningApps.listJSON()
            self.send("apps:list:" + json)
        }
    }

    // MARK: mihomo log

    private var logURL: URL { URL(fileURLWithPath: Const.workDir).appendingPathComponent("mihomo.log") }

    private func openLog() {
        if FileManager.default.fileExists(atPath: logURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([logURL])
        }
    }

    private func sendLogTail() {
        let tail = Self.tail(of: logURL, lines: 80)
        if let data = try? JSONSerialization.data(withJSONObject: ["tail": tail]),
           let json = String(data: data, encoding: .utf8) {
            send("log:tail:" + json)
        }
    }

    static func tail(of url: URL, lines: Int) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return text.split(separator: "\n").suffix(lines).joined(separator: "\n")
    }

    // Обновления полностью на Sparkle: `update:check`/`update:install` из web-UI и
    // пункт меню-бара зовут SPUStandardUpdaterController (см. AppDelegate). Свою UI
    // Sparkle рисует сам; фид/подпись — appcast.xml на домене.

    // MARK: subscription import

    private func importSubscription(_ input: String) {
        Task {
            do {
                let items = try await SubscriptionImporter.fetchItems(from: input)
                let data = try JSONSerialization.data(withJSONObject: ["items": items])
                self.send("sub:" + (String(data: data, encoding: .utf8) ?? #"{"items":[]}"#))
            } catch {
                let data = (try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])) ?? Data()
                self.send("sub:" + (String(data: data, encoding: .utf8) ?? #"{"error":"import failed"}"#))
            }
        }
    }

    // MARK: page-load bootstrap

    private func pushInitialState() {
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
        webView?.evaluateJavaScript("""
        (function(){
          const v = document.getElementById('aboutVersion'); if (v) v.textContent = 'v\(version)';
          const a = document.getElementById('autostartToggle'); if (a) a.checked = \(SMAppService.mainApp.status == .enabled);
          const k = document.getElementById('killSwitchToggle'); if (k) k.checked = \(killSwitchEnabled);
        })();
        """)
        vpn.adoptRunningTunnelIfAny()
        // Обновления проверяет Sparkle (SUEnableAutomaticChecks) — тут не дёргаем.
    }
}

extension NativeBridge: WKScriptMessageHandler {
    nonisolated func userContentController(_ userContentController: WKUserContentController,
                                           didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        Task { @MainActor in self.handle(body) }
    }
}

extension NativeBridge: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushInitialState()
        #if DEBUG
        // Самодиагностика dev-сборки: JS-ошибки в NSLog + снапшот страницы на диск.
        webView.evaluateJavaScript("""
        window.addEventListener('error', e =>
          window.chrome.webview.postMessage('debug:jserror: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
        """)
        if ProcessInfo.processInfo.environment["CLOUDVPN_DEBUG_SETTINGS"] != nil {
            webView.evaluateJavaScript("""
            document.getElementById('authView').style.display='none';
            document.getElementById('appShell').hidden=false;
            document.querySelector('.rail__item[data-view=settings]').click();
            """)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak webView] in
            webView?.takeSnapshot(with: nil) { image, _ in
                guard let tiff = image?.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("cloudvpn-snapshot.png"))
            }
        }
        #endif
    }

    // target=_blank и window.open — во внешний браузер.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { openExternal(url.absoluteString) }
        return nil
    }
}
