import Foundation

/// Drives the tunnel: builds a mihomo config from what the UI selected (обычный
/// vless/hysteria2, игровой AmneziaWG-узел по id, либо режим «только блокировка»),
/// starts/stops the core через привилегированный хелпер, и стримит статус в web-UI
/// как `vpn:{json}` (та же форма, что и Windows-хост):
///   {state: connecting|connected|disconnected|error, down, up, totalDown, totalUp, ping, error, details}
@MainActor
final class VPNController {
    struct ConnectOptions: Decodable {
        var vless: String?       // обычная нода (vless:// или hysteria2://)
        var mode: String?        // "tun" | "proxy" | "block"  (proxy на macOS = tun)
        var route: String?       // "all" | "apps" | "apps-exclude"
        var rules: [String]?     // готовые mihomo-строки, цель GLOBAL/DIRECT уже проставлена
        var apps: [String]?      // legacy: список PROCESS-NAME
        var dns: String?         // "auto" | "cloudflare" | "google" | "adguard" | произвольный
        var gamingId: String?    // id игрового узла из /api/vpn/gaming
    }

    private let emitJSON: (String) -> Void
    /// Сырые сообщения (не vpn:) наверх — conn:data и т.п. Ставит NativeBridge.
    var emitRaw: ((String) -> Void)?

    private var monitorTask: Task<Void, Never>?
    private var serverHost: String?
    private var connectSeq = 0
    private var killSwitchSeq = 0            // сериализация живых тоглов kill switch

    // Для kill switch: разрешённые IP текущего сервера + признак «туннель поднят».
    private var currentAllowedIPs: [String] = []
    private var isConnected = false
    private var killSwitchArmed = false
    private var currentRouteAll = true
    private var currentBlockOnly = false

    // keep-alive: «не рвать прямые соединения». Тумблер переключает GLOBAL↔DIRECT
    // через API контроллера без пересоздания TUN, поэтому живые DIRECT-соединения
    // (Discord-войс/игры) переживают вкл/выкл. idleDirect — ядро крутится, но GLOBAL
    // стоит на DIRECT (пользователь «выключил», TUN жив). runningConfigKey — сигнатура
    // текущего намерения, чтобы понять, что при повторном коннекте достаточно свопа.
    static let keepAliveKey = "cloudvpn.keepalive"
    private var keepAlive: Bool {
        get { UserDefaults.standard.bool(forKey: Self.keepAliveKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.keepAliveKey) }
    }
    private var idleDirect = false
    private var runningConfigKey: String?

    private let defaults = UserDefaults.standard

    // Игровые узлы (AmneziaWG): сырой конфиг живёт тут, в JS приходит только id.
    private var gamingNodes: [String: MihomoConfigBuilder.GamingNode] = [:]

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

    // MARK: gaming nodes

    /// `gaming:load:<json>` — массив узлов (или {servers:[…]}). Держим только валидные
    /// AmneziaWG-узлы; сырые ключи наверх (в JS) не отдаём.
    func loadGaming(json: String) {
        guard let data = json.data(using: .utf8) else { return }
        struct Wrap: Decodable { let servers: [MihomoConfigBuilder.GamingNode]? }
        var list: [MihomoConfigBuilder.GamingNode] = []
        if let arr = try? JSONDecoder().decode([MihomoConfigBuilder.GamingNode].self, from: data) {
            list = arr
        } else if let w = try? JSONDecoder().decode(Wrap.self, from: data), let s = w.servers {
            list = s
        }
        var map: [String: MihomoConfigBuilder.GamingNode] = [:]
        for n in list where n.kind == "amneziawg" {
            if let a = n.awg, !a.server.isEmpty, !a.privateKey.isEmpty, !a.publicKey.isEmpty {
                map[n.id] = n
            }
        }
        gamingNodes = map
        NSLog("gaming loaded: %d node(s)", map.count)
    }

    // MARK: connect / disconnect

    func connect(json: String, killSwitch: Bool) {
        guard let data = json.data(using: .utf8),
              let opts = try? JSONDecoder().decode(ConnectOptions.self, from: data) else {
            emit(["state": "error", "error": "некорректные параметры подключения"])
            return
        }
        let route = opts.route ?? "all"
        let dns = opts.dns ?? "auto"
        let blockOnly = (opts.mode ?? "") == "block"
        let vless = opts.vless ?? ""
        let gamingId = opts.gamingId
        // Правила: новые готовые строки, либо legacy apps → PROCESS-NAME,…,GLOBAL.
        let rules = opts.rules ?? (opts.apps ?? []).map { "PROCESS-NAME,\($0),GLOBAL" }

        if !blockOnly && vless.isEmpty && (gamingId?.isEmpty ?? true) {
            emit(["state": "error", "error": "нет сервера для подключения"])
            return
        }
        let cfgKey = configKey(blockOnly: blockOnly, vless: vless, gamingId: gamingId,
                               route: route, rules: rules, dns: dns)

        connectSeq += 1
        let seq = connectSeq
        isConnected = false
        let routeAll = route == "all"
        let armKS = killSwitch && routeAll && !blockOnly
        stopMonitor(keepHost: true)   // serverHost нужен keep-alive fast-path (ping/KS)
        emit(["state": "connecting"])

        Task {
            // keep-alive fast-path: то же ядро уже крутится на том же намерении (та же
            // нода/правила/DNS), возможно в idle-direct после «выключения». Возвращаем
            // GLOBAL на PROXY через API — без пересоздания TUN, живые соединения целы.
            if keepAlive, !blockOnly, runningConfigKey == cfgKey,
               await Self.coreResponds(), await self.switchGlobal(to: "PROXY") {
                guard seq == self.connectSeq else { return }
                self.idleDirect = false
                self.isConnected = true
                self.currentRouteAll = routeAll
                self.currentBlockOnly = false
                if armKS, let host = self.serverHost {
                    // на idle-direct мы снимали pf — при необходимости взводим заново
                    let ips = self.currentAllowedIPs.isEmpty ? await Self.resolveIPs(host: host) : self.currentAllowedIPs
                    if !ips.isEmpty {
                        self.currentAllowedIPs = ips
                        self.killSwitchArmed = true
                        await HelperClient.shared.setKillSwitch(enabled: true, allowedIPs: ips)
                    }
                }
                self.persistSession()
                self.emit(["state": "connected"])
                self.startMonitor()
                return
            }

            do {
                // Для kill switch резолвим IP сервера ДО сборки и закрепляем их (hosts:),
                // чтобы mihomo коннектился ровно к тем IP, что разрешит pf.
                var host = ""
                if blockOnly {
                    host = ""
                } else if let gid = gamingId, let node = self.gamingNodes[gid], let a = node.awg {
                    host = a.server
                } else if !vless.isEmpty {
                    host = MihomoConfigBuilder.serverHost(fromVless: vless) ?? ""
                }
                let allowed = (armKS && !host.isEmpty) ? await Self.resolveIPs(host: host) : []
                let reallyArm = armKS && !allowed.isEmpty

                let built: MihomoConfigBuilder.Built
                if blockOnly {
                    built = MihomoConfigBuilder.buildBlock(rules: rules, dns: dns)
                } else if let gid = gamingId, let node = self.gamingNodes[gid] {
                    built = try MihomoConfigBuilder.buildGaming(node, route: route, rules: rules, dns: dns,
                                                                pinnedServerIPs: reallyArm ? allowed : [])
                } else {
                    built = try MihomoConfigBuilder.build(uri: vless, route: route, rules: rules, dns: dns,
                                                          pinnedServerIPs: reallyArm ? allowed : [])
                }

                try await HelperClient.shared.start(config: built.yaml, killSwitch: reallyArm, allowedIPs: allowed)
                try await waitForCore()
                // Пока поднимались, юзер мог переподключиться — тогда этот туннель не наш.
                guard seq == self.connectSeq else { await HelperClient.shared.stop(); return }
                self.serverHost = built.serverHost.isEmpty ? nil : built.serverHost
                self.currentAllowedIPs = allowed
                self.currentRouteAll = routeAll
                self.currentBlockOnly = blockOnly
                self.killSwitchArmed = reallyArm
                self.idleDirect = false
                self.runningConfigKey = blockOnly ? nil : cfgKey
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
        killSwitchSeq += 1
        let wasKeepAlive = keepAlive && isConnected && !currentBlockOnly && runningConfigKey != nil
        isConnected = false
        stopMonitor(keepHost: wasKeepAlive)   // idle-direct сохраняет host для след. свопа

        if wasKeepAlive {
            // keep-alive: НЕ гасим TUN. Переводим GLOBAL на DIRECT — трафик идёт мимо
            // VPN, но виртуальный адаптер жив, поэтому открытые соединения не рвутся.
            // pf снимаем (мы намеренно идём напрямую), иначе интернет остался бы заперт.
            let hadKS = killSwitchArmed
            killSwitchArmed = false
            persistSession()
            Task {
                if hadKS { await HelperClient.shared.setKillSwitch(enabled: false, allowedIPs: []) }
                if await self.switchGlobal(to: "DIRECT") {
                    self.idleDirect = true
                    self.emit(["state": "disconnected"])
                } else {
                    // своп не удался — обычное отключение
                    self.idleDirect = false
                    self.runningConfigKey = nil
                    await HelperClient.shared.stop()
                    self.emit(["state": "disconnected"])
                }
            }
            return
        }

        killSwitchArmed = false
        idleDirect = false
        runningConfigKey = nil
        persistSession()
        Task {
            await HelperClient.shared.stop()
            self.emit(["state": "disconnected"])
        }
    }

    /// Тумблер keep-alive из UI. При выключении — гасим осиротевшее idle-direct ядро.
    func setKeepAlive(_ on: Bool) {
        keepAlive = on
        if !on && idleDirect {
            idleDirect = false
            runningConfigKey = nil
            Task { await HelperClient.shared.stop() }
        }
    }

    /// Сигнатура намерения — чтобы keep-alive понял, что достаточно свопа GLOBAL.
    private func configKey(blockOnly: Bool, vless: String, gamingId: String?,
                           route: String, rules: [String], dns: String) -> String {
        let target = gamingId.map { "g:\($0)" } ?? "v:\(vless)"
        return "\(target)|r:\(route)|d:\(dns)|rules:\(rules.joined(separator: "¦"))"
    }

    /// GLOBAL → PROXY|DIRECT через контроллер (PUT /proxies/GLOBAL). 204 = ок.
    private func switchGlobal(to name: String) async -> Bool {
        var req = URLRequest(url: Self.controllerBase.appendingPathComponent("proxies/GLOBAL"))
        req.httpMethod = "PUT"
        req.timeoutInterval = 2.0
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])
        guard let (_, resp) = try? await URLSession.shared.data(for: req),
              let code = (resp as? HTTPURLResponse)?.statusCode else { return false }
        return code == 204 || code == 200
    }

    /// Тумблер kill switch при активном туннеле — применяем на лету (см. серию через
    /// killSwitchSeq, чтобы быстрый ON→OFF не оставил pf взведённым).
    func setKillSwitchLive(_ enabled: Bool) {
        killSwitchSeq += 1
        let seq = killSwitchSeq
        Task {
            if !enabled || !self.currentRouteAll || self.currentBlockOnly {
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
            guard seq == self.killSwitchSeq else { return }
            let arm = self.isConnected && !ips.isEmpty
            self.currentAllowedIPs = ips
            self.killSwitchArmed = arm
            self.persistSession()
            await HelperClient.shared.setKillSwitch(enabled: arm, allowedIPs: ips)
        }
    }

    // MARK: connections tab (conn:get → conn:data:)

    private struct MihomoConns: Decodable {
        var downloadTotal: Int64?; var uploadTotal: Int64?
        var connections: [Conn]?
        struct Conn: Decodable {
            var upload: Int64?; var download: Int64?; var chains: [String]?
            var metadata: Meta?
            struct Meta: Decodable {
                var host: String?; var destinationIP: String?; var destinationPort: String?
                var network: String?; var type: String?; var process: String?
            }
        }
    }

    /// Активные соединения из mihomo → компактный JSON для вкладки «Соединения».
    /// direct определяем по chains (есть DIRECT → идёт мимо VPN).
    func getConnections() {
        guard isConnected || idleDirect else {
            emitRaw?("conn:data:" + #"{"conns":[],"down":0,"up":0}"#); return
        }
        Task {
            var req = URLRequest(url: Self.controllerBase.appendingPathComponent("connections"))
            req.timeoutInterval = 1.5
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let m = try? JSONDecoder().decode(MihomoConns.self, from: data) else {
                self.emitRaw?("conn:data:" + #"{"conns":[],"down":0,"up":0}"#); return
            }
            var conns: [[String: Any]] = []
            for c in m.connections ?? [] {
                let direct = (c.chains ?? []).contains { $0.caseInsensitiveCompare("DIRECT") == .orderedSame }
                let meta = c.metadata
                conns.append([
                    "host": meta?.host ?? "",
                    "ip": meta?.destinationIP ?? "",
                    "port": meta?.destinationPort ?? "",
                    "net": meta?.network ?? "",
                    "type": meta?.type ?? "",
                    "proc": meta?.process ?? "",
                    "up": c.upload ?? 0,
                    "down": c.download ?? 0,
                    "direct": direct,
                ])
            }
            let payload: [String: Any] = ["down": m.downloadTotal ?? 0, "up": m.uploadTotal ?? 0, "conns": conns]
            if let d = try? JSONSerialization.data(withJSONObject: payload),
               let json = String(data: d, encoding: .utf8) {
                self.emitRaw?("conn:data:" + json)
            }
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

    /// On launch: adopt a tunnel the helper still runs from a previous session.
    func adoptRunningTunnelIfAny() {
        Task {
            let status = await HelperClient.shared.status()
            guard status == "running", await Self.coreResponds() else {
                if status == "stopped", self.defaults.bool(forKey: "cloudvpn.session.ksArmed") {
                    await HelperClient.shared.setKillSwitch(enabled: false, allowedIPs: [])
                    self.killSwitchArmed = false
                    self.defaults.set(false, forKey: "cloudvpn.session.ksArmed")
                }
                return
            }
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

    // MARK: traffic / ping monitor (1s tick)

    private struct Totals: Decodable { var downloadTotal: Int64?; var uploadTotal: Int64? }

    private func startMonitor() {
        stopMonitor(keepHost: true)
        let mySeq = connectSeq
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
                    if failures >= 4 {
                        guard mySeq == self.connectSeq else { return }
                        self.isConnected = false
                        self.runningConfigKey = nil
                        if !self.killSwitchArmed {
                            // «dropped» (не «disconnected») — сигнал web-слою на
                            // авто-переподключение/фейловер (как у Windows-хоста).
                            self.emit(["state": "dropped"])
                            await HelperClient.shared.stop()
                        } else {
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

    private func stopMonitor(keepHost: Bool = false) {
        monitorTask?.cancel()
        monitorTask = nil
        if !keepHost { serverHost = nil }
    }
}
