import AppKit
import WebKit
import Sparkle

/// Cloud VPN for macOS. The UI is the exact same HTML/CSS/JS the Windows client
/// ships (App/Web) rendered in a WKWebView; the window is chromeless because the
/// page draws its own title bar. NativeBridge implements the same message
/// protocol the Windows C# host speaks (vpn:/sub:/ping:/apps:/win:/…).
@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var bridge: NativeBridge!

    private var statusItem: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var toggleItem: NSMenuItem!
    private var reallyQuit = false
    private var vpnOn = false

    // Sparkle: авто-обновления с appcast на своём домене (SUFeedURL в Info.plist).
    // startingUpdater: true → сам стартует и делает плановые проверки.
    private let updaterController = SPUStandardUpdaterController(
        startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rect = NSRect(x: 0, y: 0, width: 1150, height: 740)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Cloud VPN"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.delegate = self
        // The page renders Windows-style window controls — hide the traffic lights.
        [.closeButton, .miniaturizeButton, .zoomButton].forEach {
            window.standardWindowButton($0)?.isHidden = true
        }
        window.minSize = NSSize(width: 990, height: 640)
        window.backgroundColor = NSColor(srgbRed: 0.933, green: 0.949, blue: 0.984, alpha: 1) // --bg light
        window.center()
        window.isReleasedWhenClosed = false

        let config = WKWebViewConfiguration()
        // The UI is loaded from file:// and calls https://cloude.tech directly —
        // relax the file-origin CORS rules exactly like WebView2 does for the
        // Windows client. Private keys, guarded so a WebKit rename can't crash us.
        config.preferences.trySetValue(true, forKey: "allowFileAccessFromFileURLs")
        config.trySetValue(true, forKey: "allowUniversalAccessFromFileURLs")
        #if DEBUG
        config.preferences.trySetValue(true, forKey: "developerExtrasEnabled")
        #endif

        webView = WKWebView(frame: rect, configuration: config)
        webView.autoresizingMask = [.width, .height]

        bridge = NativeBridge(window: window, webView: webView)
        bridge.onVPNState = { [weak self] on in self?.updateTrayState(on: on) }
        bridge.onCheckForUpdates = { [weak self] in self?.updaterController.checkForUpdates(nil) }
        config.userContentController.add(bridge, name: "host")
        config.userContentController.addUserScript(WKUserScript(
            source: NativeBridge.webview2Shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView.navigationDelegate = bridge
        webView.uiDelegate = bridge

        window.contentView = webView

        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("Web"),
              FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path)
        else {
            NSAlert.showFatal("Web-ресурсы не найдены в бандле. Пересоберите приложение (App/Web должен попасть в Resources).")
            return
        }
        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)

        setupStatusItem()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        #if DEBUG
        // Ручной прогон авто-апдейта: CLOUDVPN_DEBUG_CHECK_UPDATE=1 → проверка сразу.
        if ProcessInfo.processInfo.environment["CLOUDVPN_DEBUG_CHECK_UPDATE"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.updaterController.checkForUpdates(nil)
            }
        }
        #endif
    }

    // MARK: menu-bar (tray) icon — reflects tunnel state, toggles/shows the app

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        applyTrayIcon()

        let menu = NSMenu()
        statusLine = NSMenuItem(title: "Отключено", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())

        toggleItem = NSMenuItem(title: "Подключить", action: #selector(trayToggle), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        let show = NSMenuItem(title: "Открыть Cloud VPN", action: #selector(trayShow), keyEquivalent: "")
        show.target = self
        menu.addItem(show)

        let update = NSMenuItem(title: "Проверить обновления…", action: #selector(trayCheckUpdates), keyEquivalent: "")
        update.target = self
        menu.addItem(update)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Выйти", action: #selector(trayQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func applyTrayIcon() {
        let name = vpnOn ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle"
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "Cloud VPN")
        img?.isTemplate = true
        statusItem.button?.image = img
    }

    private func updateTrayState(on: Bool) {
        vpnOn = on
        applyTrayIcon()
        statusLine?.title = on ? "Защищено" : "Отключено"
        toggleItem?.title = on ? "Отключить" : "Подключить"
    }

    @objc private func trayToggle() {
        // Клик по orb в UI: уважает проверку подписки и выбранный сервер.
        showWindow()
        webView.evaluateJavaScript("document.getElementById('connectOrb')?.click();")
    }

    @objc private func trayShow() { showWindow() }

    @objc private func trayCheckUpdates() { updaterController.checkForUpdates(nil) }

    @objc private func trayQuit() { reallyQuit = true; NSApp.terminate(nil) }

    private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: close → hide to tray (tunnel keeps running in the helper)

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        // «Выйти» = полный выход: гасим туннель и снимаем kill switch, чтобы
        // никогда не оставить сеть заблокированной после закрытия приложения.
        HelperClient.shutdownBlocking()
    }
}

extension NSObject {
    /// KVC set that survives an unknown (private) key instead of raising.
    func trySetValue(_ value: Any?, forKey key: String) {
        guard responds(to: NSSelectorFromString("set\(key.prefix(1).uppercased() + key.dropFirst()):")) else { return }
        setValue(value, forKey: key)
    }
}

extension NSAlert {
    static func showFatal(_ text: String) {
        let a = NSAlert()
        a.messageText = "Cloud VPN"
        a.informativeText = text
        a.runModal()
        NSApp.terminate(nil)
    }
}
