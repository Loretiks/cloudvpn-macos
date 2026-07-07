import Foundation

/// Drives the tunnel: builds a mihomo config from the vless:// the UI selected,
/// starts/stops the core through the privileged helper, and streams status events
/// back to the web UI as `vpn:{json}` messages (same shape as the Windows host):
///   {state: connecting|connected|disconnected|error, down, up, totalDown, totalUp, ping, error, details}
@MainActor
final class VPNController {
    struct ConnectOptions: Decodable {
        var vless: String
        var mode: String?        // "tun" | "proxy"
        var route: String?       // "all" | "apps"
        var rules: [String]?     // mihomo rule lines targeting GLOBAL
        var apps: [String]?      // legacy shape, PROCESS-NAME list
    }

    private let emitJSON: (String) -> Void
    private var monitorTask: Task<Void, Never>?
    private var serverHost: String?
    private var connectSeq = 0
    private var killSwitchSeq = 0            // сериализация живых тоглов kill switch

    // Для kill switch: разрешённые IP текущего сервера + признак «туннель поднят».
    private var currentAllowedIPs: [String] = []
    private var isConnected = false
    // Явный признак «pf взведён». НЕ выводим из currentAllowedIPs — иначе взвод с
    // пустым списком (DNS не резолвнулся) монитор ошибочно счёл бы «не взведён».
    private var killSwitchArmed = false
    // Kill switch имеет смысл только в full-tunnel: в split-режиме DIRECT-приложения
    // ходят напрямую, и «block drop out» их бы отрезал. Помним режим текущей сессии.
    private var currentRouteAll = true

    // Минимум состояния сессии — чтобы adopt после рестарта восстановил ping/kill switch.
    private let defaults = UserDefaults.standard

    init(emit: @escaping (String) -> Void) {
        self.emitJSON = emit
    }

    private func persistSession() {
        defaults.set(serverHost, forKey: "cloudvpn.session.host")
        defaults.set(currentAllowedIPs, forKey: "cloudvpn.session.ips")
        defaults.set(currentRouteAll, forKey: "cloudvpn.session.routeAll")
        defaults.set(killSwitchArmed, forKey: "cloudvpn.session.ksArmed")
    }

    private func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        emitJSON(json)
    }

    // MARK: connect / disconnect

    func connect(json: String, killSwitch: Bool) {
        guard let data = json.data(using: .utf8),
              let opts = try? JSONDecoder().decode(ConnectOptions.self, from: data) else {
            emit(["state": "error", "error": "некорректные параметры подключения"])
            return
        }
        connectSeq += 1
        let seq = connectSeq
        isConnected = false
        let routeAll = (opts.route ?? "all") == "all"
        // Kill switch взводим только в full-tunnel (в split он бы отрезал DIRECT-трафик).
        let armKS = killSwitch && routeAll
        stopMonitor()
        emit(["state": "connecting"])
        Task {
            do {
                // Для kill switch резолвим IP сервера ДО сборки и закрепляем их в
                // конфиге (hosts:), чтобы mihomo коннектился ровно к тем IP, что
                // разрешит pf — иначе GeoDNS-расхождение оборвало бы туннель.
                let allowed: [String]
                if armKS, let host = MihomoConfigBuilder.serverHost(fromVless: opts.vless) {
                    allowed = await Self.resolveIPs(host: host)
                } else {
                    allowed = []
                }
                // Взводить с пустым списком нельзя: заблокировали бы и сам сервер, туннель
                // не встал бы. Если IP не резолвнулись — kill switch в этой сессии выключен.
                let reallyArm = armKS && !allowed.isEmpty
                let built = try MihomoConfigBuilder.build(
                    vless: opts.vless,
                    tun: (opts.mode ?? "tun") == "tun",
                    route: opts.route ?? "all",
                    rules: opts.rules ?? (opts.apps ?? []).map { "PROCESS-NAME,\($0),GLOBAL" },
                    pinnedServerIPs: reallyArm ? allowed : []
                )
                try await HelperClient.shared.start(config: built.yaml, killSwitch: reallyArm, allowedIPs: allowed)
                try await waitForCore()
                // Пока мы поднимались, юзер мог отключиться/переподключиться — тогда
                // этот туннель уже не наш: гасим его, чтобы не осиротить.
                guard seq == self.connectSeq else { await HelperClient.shared.stop(); return }
                self.serverHost = built.serverHost
                self.currentAllowedIPs = allowed
                self.currentRouteAll = routeAll
                self.killSwitchArmed = reallyArm
                self.isConnected = true
                self.persistSession()
                if armKS && !reallyArm {
                    NSLog("kill switch requested but server IP unresolved — not arming this session")
                }
                self.emit(["state": "connected"])
                self.startMonitor()
            } catch {
                guard seq == self.connectSeq else { return }
                await HelperClient.shared.stop()
                let tail = NativeBridge.tail(
                    of: URL(fileURLWithPath: Const.workDir).appendingPathComponent("mihomo.log"), lines: 12)
                self.emit(["state": "error", "error": error.localizedDescription, "details": tail])
            }
        }
    }

    func disconnect() {
        connectSeq += 1
        killSwitchSeq += 1                      // отменяем незавершённые тоглы kill switch
        isConnected = false
        killSwitchArmed = false
        stopMonitor()
        persistSession()
        Task {
            await HelperClient.shared.stop()
            self.emit(["state": "disconnected"])
        }
    }

    /// Тумблер kill switch переключили при активном туннеле — применяем на лету.
    /// Сериализуем через killSwitchSeq: если пока резолвили IP пришёл более новый
    /// тогл (или дисконнект), эта операция себя отменяет — иначе «ON→OFF» быстро мог
    /// оставить pf взведённым.
    func setKillSwitchLive(_ enabled: Bool) {
        killSwitchSeq += 1
        let seq = killSwitchSeq
        Task {
            // В split-tunnel или при выключении — просто снимаем.
            if !enabled || !self.currentRouteAll {
                guard seq == self.killSwitchSeq else { return }
                self.killSwitchArmed = false
                self.currentAllowedIPs = []
                self.persistSession()
                await HelperClient.shared.setKillSwitch(enabled: false, allowedIPs: [])
                return
            }
            var ips = self.currentAllowedIPs
            if ips.isEmpty, let host = self.serverHost {
                ips = await Self.resolveIPs(host: host)
            }
            guard seq == self.killSwitchSeq else { return }   // перебит новым тоглом/дисконнектом
            let arm = self.isConnected && !ips.isEmpty
            self.currentAllowedIPs = ips
            self.killSwitchArmed = arm
            self.persistSession()
            await HelperClient.shared.setKillSwitch(enabled: arm, allowedIPs: ips)
        }
    }

    /// host (домен или IP) → список IP через getaddrinfo. Для IP возвращает его же.
    static func resolveIPs(host: String) async -> [String] {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                                     ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
                var res: UnsafeMutablePointer<addrinfo>?
                guard getaddrinfo(host, nil, &hints, &res) == 0, let first = res else {
                    cont.resume(returning: []); return
                }
                defer { freeaddrinfo(res) }
                var ips = Set<String>()
                var cur: UnsafeMutablePointer<addrinfo>? = first
                while let c = cur {
                    var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(c.pointee.ai_addr, c.pointee.ai_addrlen,
                                   &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                        ips.insert(String(cString: buf))
                    }
                    cur = c.pointee.ai_next
                }
                cont.resume(returning: Array(ips))
            }
        }
    }

    /// On launch: if the helper still runs mihomo from a previous session, adopt it
    /// so the UI reflects reality instead of assuming "disconnected".
    func adoptRunningTunnelIfAny() {
        Task {
            let status = await HelperClient.shared.status()
            guard status == "running", await Self.coreResponds() else {
                // Хелпер жив, но ядро стоит: если приложение когда-то упало с
                // взведённым kill switch, pf мог остаться и держать сеть в офлайне.
                // Снимаем — иначе юзер заблокирован без индикации.
                if status == "stopped", self.defaults.bool(forKey: "cloudvpn.session.ksArmed") {
                    await HelperClient.shared.setKillSwitch(enabled: false, allowedIPs: [])
                    self.killSwitchArmed = false
                    self.defaults.set(false, forKey: "cloudvpn.session.ksArmed")
                }
                return
            }
            // Восстанавливаем состояние прошлой сессии, чтобы работали ping и
            // корректный тоггл kill switch на подхваченном туннеле.
            self.serverHost = self.defaults.string(forKey: "cloudvpn.session.host")
            self.currentAllowedIPs = self.defaults.stringArray(forKey: "cloudvpn.session.ips") ?? []
            self.currentRouteAll = self.defaults.object(forKey: "cloudvpn.session.routeAll") as? Bool ?? true
            self.killSwitchArmed = self.defaults.bool(forKey: "cloudvpn.session.ksArmed")
            self.isConnected = true
            self.emit(["state": "connected"])
            self.startMonitor()
        }
    }

    // MARK: mihomo external controller

    private static var controllerBase: URL { URL(string: "http://\(Const.mihomoController)")! }

    private static func coreResponds() async -> Bool {
        var req = URLRequest(url: controllerBase.appendingPathComponent("version"))
        req.timeoutInterval = 1.5
        return (try? await URLSession.shared.data(for: req)) != nil
    }

    private func waitForCore() async throws {
        for _ in 0..<20 {
            if await Self.coreResponds() { return }
            try await Task.sleep(nanoseconds: 400_000_000)
        }
        throw NSError(domain: "CloudVPN", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "ядро не ответило на \(Const.mihomoController)"])
    }

    // MARK: traffic / ping monitor (1s tick, like the Windows host)

    private struct Totals: Decodable { var downloadTotal: Int64?; var uploadTotal: Int64? }

    private func startMonitor() {
        stopMonitor()
        let mySeq = connectSeq                   // эта сессия; если сменится — мы уже не актуальны
        monitorTask = Task { [weak self] in
            var prevDown: Int64 = 0, prevUp: Int64 = 0, first = true
            var failures = 0, tick = 0
            var lastPing: Int? = nil
            while !Task.isCancelled {
                guard let self, mySeq == self.connectSeq else { return }
                var req = URLRequest(url: Self.controllerBase.appendingPathComponent("connections"))
                req.timeoutInterval = 1.5
                if let (data, _) = try? await URLSession.shared.data(for: req),
                   let t = try? JSONDecoder().decode(Totals.self, from: data) {
                    failures = 0
                    let down = t.downloadTotal ?? 0, up = t.uploadTotal ?? 0
                    var payload: [String: Any] = [
                        "state": "connected",
                        "down": first ? 0 : max(0, down - prevDown),
                        "up": first ? 0 : max(0, up - prevUp),
                        "totalDown": down,
                        "totalUp": up,
                    ]
                    if tick % 5 == 0, let host = self.serverHost {
                        lastPing = await Pinger.ping(host: host)
                    }
                    if let p = lastPing { payload["ping"] = p }
                    self.emit(payload)
                    prevDown = down; prevUp = up; first = false
                } else {
                    failures += 1
                    if failures >= 4 {                      // ядро умерло / остановлено извне
                        guard mySeq == self.connectSeq else { return }  // нас уже перебили
                        self.isConnected = false
                        if !self.killSwitchArmed {
                            // без kill switch — просто отключаемся
                            self.emit(["state": "disconnected"])
                            await HelperClient.shared.stop()
                        } else {
                            // kill switch взведён — НЕ снимаем pf: сеть остаётся
                            // заблокированной (в этом и смысл), пока юзер не
                            // переподключится / не выключит kill switch / не выйдет.
                            self.emit(["state": "error",
                                       "error": "Туннель разорван — Kill Switch блокирует сеть. Переподключитесь."])
                        }
                        return
                    }
                }
                tick += 1
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func stopMonitor() {
        monitorTask?.cancel()
        monitorTask = nil
        serverHost = nil
    }
}
