import Foundation

/// vless:// / hysteria2:// → полный mihomo-конфиг, зеркало C#-хоста Windows-клиента
/// (VpnManager.BuildConfig / BuildBlockConfig / AppendCoreHeader). Плюс AmneziaWG
/// «игровые» узлы (структурный JSON из /api/vpn/gaming) и режим «только блокировка».
///
/// Поддержка vless: reality (pbk) | plain TLS; transport tcp | ws | grpc; flow (vision).
/// Как на Windows: у vless всегда `tls: true`, а reality-opts добавляем при наличии pbk —
/// весь парк CloudVPN на Reality+Vision, так что это совпадает с сабкой.
enum MihomoConfigBuilder {
    struct Built {
        let yaml: String
        let serverHost: String   // для kill switch (пустой у block-only)
    }

    enum BuildError: LocalizedError {
        case badURI(String)
        var errorDescription: String? {
            switch self { case .badURI(let m): return "не удалось разобрать ссылку: \(m)" }
        }
    }

    /// Игровой узел (AmneziaWG). Приходит из `gaming:load:` как JSON — те же ключи,
    /// что читает Windows-клиент (VpnManager.LoadGaming): camelCase внутри `awg`.
    struct GamingNode: Decodable {
        let id: String
        let name: String?
        let country: String?
        let city: String?
        let code: String?
        let kind: String?
        let awg: AWG?
        struct AWG: Decodable {
            let server: String
            let port: Int?
            let ip: String?
            let privateKey: String
            let publicKey: String
            let presharedKey: String?
            let mtu: Int?
            let jc: Int?; let jmin: Int?; let jmax: Int?
            let s1: Int?; let s2: Int?
            let h1: Int?; let h2: Int?; let h3: Int?; let h4: Int?
        }
    }

    // MARK: host extraction (для kill switch — резолвим IP сервера ДО сборки)

    /// host из vless://|hysteria2:// без полной сборки. Fragment (эмодзи/кириллица)
    /// отрезаем — URL(string:) на старых macOS его не парсит, а нам нужен только host.
    static func serverHost(fromVless raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let noFragment = trimmed.split(separator: "#", maxSplits: 1).first,
              let uri = URL(string: String(noFragment)),
              let host = uri.host, !host.isEmpty else { return nil }
        return host
    }

    // MARK: public builders

    /// vless:// или hysteria2:// (обычная нода из подписки).
    static func build(uri raw: String, route: String, rules: [String], dns: String,
                      pinnedServerIPs: [String] = []) throws -> Built {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let noFragment = trimmed.split(separator: "#", maxSplits: 1).first else {
            throw BuildError.badURI("пустая ссылка")
        }
        guard let uri = URL(string: String(noFragment)),
              let host = uri.host, !host.isEmpty else { throw BuildError.badURI("нет адреса сервера") }
        let scheme = (uri.scheme ?? "").lowercased()
        let port = uri.port ?? 443
        var q: [String: String] = [:]
        for item in URLComponents(url: uri, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            q[item.name.lowercased()] = item.value ?? ""
        }

        let proxyBlock: String
        if scheme == "hysteria2" || scheme == "hy2" {
            guard let pw = uri.user, !pw.isEmpty else { throw BuildError.badURI("в hysteria2-ссылке нет пароля") }
            let sni = q["sni"] ?? q["peer"] ?? ""
            let ins = q["insecure"] ?? q["allowinsecure"] ?? q["skip-cert-verify"] ?? ""
            let skip = ins == "1" || ins.lowercased() == "true"
            var p = """
              - name: \(quote(ProxyName))
                type: hysteria2
                server: \(quote(host))
                port: \(port)
                password: \(quote(pw))
            """
            if !sni.isEmpty { p += "\n    sni: \(quote(sni))" }
            p += "\n    skip-cert-verify: \(skip ? "true" : "false")"
            proxyBlock = p
        } else if scheme == "vless" {
            guard let uuid = uri.user, !uuid.isEmpty else { throw BuildError.badURI("в ссылке нет uuid") }
            let network = (q["type"] ?? "tcp").lowercased()
            let sni = q["sni"] ?? q["servername"] ?? ""
            let flow = q["flow"] ?? ""
            let fp = q["fp"] ?? "chrome"
            let pbk = q["pbk"] ?? ""
            let sid = q["sid"] ?? ""
            // XUDP — как ожидают Xray/Vision-серверы UDP-over-VLESS. Без него QUIC,
            // Discord-войс и игры нестабильны в TUN. Сабка задаёт то же самое.
            var p = """
              - name: \(quote(ProxyName))
                type: vless
                server: \(quote(host))
                port: \(port)
                uuid: \(quote(uuid))
                network: \(quote(network.isEmpty ? "tcp" : network))
                udp: true
                packet-encoding: xudp
                tls: true
            """
            if !flow.isEmpty { p += "\n    flow: \(quote(flow))" }
            if !sni.isEmpty { p += "\n    servername: \(quote(sni))" }
            p += "\n    client-fingerprint: \(quote(fp.isEmpty ? "chrome" : fp))"
            if !pbk.isEmpty {
                p += "\n    reality-opts:\n      public-key: \(quote(pbk))"
                if !sid.isEmpty { p += "\n      short-id: \(quote(sid))" }
            }
            if network == "ws" {
                let path = q["path"] ?? "/"
                let wsHost = q["host"] ?? ""
                p += "\n    ws-opts:\n      path: \(quote(path.isEmpty ? "/" : path))"
                if !wsHost.isEmpty { p += "\n      headers:\n        Host: \(quote(wsHost))" }
            } else if network == "grpc" {
                if let svc = q["servicename"], !svc.isEmpty {
                    p += "\n    grpc-opts:\n      grpc-service-name: \(quote(svc))"
                }
            }
            proxyBlock = p
        } else {
            throw BuildError.badURI("это не vless:// / hysteria2:// ссылка")
        }

        let yaml = assemble(dns: dns, proxyBlock: proxyBlock, serverHost: host,
                            route: route, rules: rules, pinnedServerIPs: pinnedServerIPs)
        return Built(yaml: yaml, serverHost: host)
    }

    /// AmneziaWG «игровой» узел. Проверенная схема mihomo: type: wireguard +
    /// amnezia-wg-option. ВАЖНО: remote-dns-resolve обязателен — без него хендшейк
    /// проходит, но данные не идут (fake-ip 198.18.x → network unreachable).
    static func buildGaming(_ node: GamingNode, route: String, rules: [String], dns: String,
                            pinnedServerIPs: [String] = []) throws -> Built {
        guard let a = node.awg, !a.server.isEmpty, !a.privateKey.isEmpty, !a.publicKey.isEmpty else {
            throw BuildError.badURI("в игровом узле нет ключей или адреса")
        }
        let ip = (a.ip?.isEmpty == false) ? a.ip! : "10.13.13.2/32"
        let mtu = (a.mtu ?? 0) > 0 ? a.mtu! : 1280
        func n(_ v: Int?) -> Int { v ?? 0 }
        var p = """
          - name: \(quote(ProxyName))
            type: wireguard
            server: \(quote(a.server))
            port: \(a.port ?? 443)
            ip: \(quote(ip))
            private-key: \(quote(a.privateKey))
            public-key: \(quote(a.publicKey))
        """
        if let psk = a.presharedKey, !psk.isEmpty { p += "\n    pre-shared-key: \(quote(psk))" }
        p += "\n    udp: true"
        p += "\n    mtu: \(mtu)"
        p += "\n    remote-dns-resolve: true"
        p += "\n    dns:\n      - 1.1.1.1\n      - 8.8.8.8"
        p += "\n    amnezia-wg-option:"
        p += "\n      jc: \(n(a.jc))\n      jmin: \(n(a.jmin))\n      jmax: \(n(a.jmax))"
        p += "\n      s1: \(n(a.s1))\n      s2: \(n(a.s2))"
        p += "\n      h1: \(n(a.h1))\n      h2: \(n(a.h2))\n      h3: \(n(a.h3))\n      h4: \(n(a.h4))"

        let yaml = assemble(dns: dns, proxyBlock: p, serverHost: a.server,
                            route: route, rules: rules, pinnedServerIPs: pinnedServerIPs)
        return Built(yaml: yaml, serverHost: a.server)
    }

    /// Режим «только блокировка»: прокси нет вовсе, весь трафик напрямую
    /// (MATCH,DIRECT), а перечисленные домены отбиваются REJECT. Работает при
    /// ВЫКЛЮЧЕННОМ VPN — иначе ядро не запущено и блокировать нечем.
    static func buildBlock(rules: [String], dns: String) -> Built {
        var y = coreHeader(dns: dns)
        y += "rules:\n"
        y += "  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve\n"
        y += "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve\n"
        y += "  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve\n"
        y += "  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve\n"
        for r in normalizedRules(rules) { y += "  - \(quote(r))\n" }
        y += "  - MATCH,DIRECT\n"
        return Built(yaml: y, serverHost: "")
    }

    // MARK: shared assembly

    private static let ProxyName = "PROXY"

    /// Общий хвост: proxy-group GLOBAL[PROXY, DIRECT] + правила. GLOBAL с DIRECT
    /// внутри нужен keep-alive: тумблер переключает GLOBAL→DIRECT через API без
    /// пересоздания TUN, поэтому живые соединения (Discord/игры) не рвутся.
    private static func assemble(dns: String, proxyBlock: String, serverHost: String,
                                 route: String, rules: [String], pinnedServerIPs: [String]) -> String {
        // Закрепляем IP сервера (kill switch): mihomo резолвит host ровно в эти
        // адреса — те же, что разрешит pf. Иначе GeoDNS-расхождение оборвёт туннель.
        let validPins = pinnedServerIPs.filter { isIPLiteral($0) }
        var hostsBlock = ""
        if !validPins.isEmpty, !serverHost.isEmpty {
            let list = validPins.map { quote($0) }.joined(separator: ", ")
            hostsBlock = "hosts:\n  \(quote(serverHost)): [\(list)]\n\n"
        }

        var y = hostsBlock + coreHeader(dns: dns)
        y += "proxies:\n\(proxyBlock)\n"
        y += "proxy-groups:\n"
        y += "  - name: \(quote("GLOBAL"))\n    type: select\n    proxies:\n      - \(quote(ProxyName))\n      - DIRECT\n"
        y += "rules:\n"
        y += "  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve\n"
        y += "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve\n"
        y += "  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve\n"
        y += "  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve\n"
        // Само-обновление тянется с GitHub Releases напрямую (в РФ доступно без VPN):
        // через дальнюю ноду один TCP-поток упирается в BDP и апдейт еле качается.
        y += "  - DOMAIN-SUFFIX,github.com,DIRECT\n"
        y += "  - DOMAIN-SUFFIX,githubusercontent.com,DIRECT\n"
        y += "  - DOMAIN-SUFFIX,github.io,DIRECT\n"
        // Bypass-петля: трафик к самому VPN-серверу идёт напрямую.
        if isIPLiteral(serverHost) {
            y += "  - IP-CIDR,\(serverHost)/32,DIRECT,no-resolve\n"
        } else if !serverHost.isEmpty {
            y += "  - DOMAIN,\(serverHost),DIRECT\n"
        }
        // Пользовательские правила (JS уже проставил цель GLOBAL/DIRECT). Пишем ВСЕГДА,
        // а не только в сплите — иначе в режиме «весь трафик» REJECT-блокировки молчали бы.
        for r in normalizedRules(rules) { y += "  - \(quote(r))\n" }
        // Fall-through: только «по приложениям» непойманное идёт мимо VPN; в инверсном
        // сплите и «весь трафик» — через VPN.
        y += (route == "apps" ? "  - MATCH,DIRECT\n" : "  - MATCH,GLOBAL\n")
        return y
    }

    /// Общая шапка (контроллер, TUN, DNS, sniffer) — одна и та же для туннеля и
    /// блокировки, иначе они разъедутся. На loopback без secret: монитор/keep-alive
    /// ходят в контроллер без авторизации.
    private static func coreHeader(dns: String) -> String {
        var s = ""
        s += "# Auto-generated by CloudVPN (macOS)\n"
        s += "mixed-port: 7897\n"
        s += "allow-lan: false\n"
        s += "mode: rule\n"
        s += "log-level: warning\n"
        s += "ipv6: false\n"
        s += "tcp-concurrent: true\n"
        s += "external-controller: \(Const.mihomoController)\n"
        // Резолв процесса-владельца соединения: нужен для PROCESS-NAME правил и
        // вкладки «Соединения».
        s += "find-process-mode: always\n"
        s += "tun:\n"
        s += "  enable: true\n"
        // system-стек: весь трафик, включая DIRECT в сплите, через ядро macOS. gvisor
        // добавлял джиттер на UDP (пинг в играх скакал). 1400 MTU — запас под VLESS/TLS.
        s += "  stack: system\n"
        s += "  auto-route: true\n"
        s += "  auto-detect-interface: true\n"
        s += "  mtu: 1400\n"
        s += "  dns-hijack:\n    - any:53\n"
        // Гео-базы для GEOSITE/GEOIP — mihomo тянет с GitHub (в РФ доступно; и мы
        // всё равно гоним github напрямую правилом выше).
        s += "geodata-mode: true\n"
        s += "geo-auto-update: false\n"
        s += "geox-url:\n"
        s += "  geoip: \"https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat\"\n"
        s += "  geosite: \"https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat\"\n"
        s += "dns:\n"
        s += "  enable: true\n"
        s += "  listen: 127.0.0.1:1053\n"
        s += "  ipv6: false\n"
        s += "  enhanced-mode: fake-ip\n"
        s += "  fake-ip-range: 198.18.0.1/16\n"
        s += "  fake-ip-filter:\n    - \"*.lan\"\n    - \"*.local\"\n"
        // Бутстрап для DoH-хостнеймов (dns.google/adguard); IP-DoH (1.1.1.1) их не требует.
        s += "  default-nameserver:\n    - 77.88.8.8\n    - 1.1.1.1\n"
        s += "  nameserver:\n"
        for ns in dnsServers(dns) { s += "    - \(ns)\n" }
        // Sniffer: восстанавливаем реальный домен из TLS SNI / HTTP Host / QUIC даже
        // когда приложение резолвит DNS само (браузеры с DoH, прямой IP). Без него
        // DOMAIN/GEOSITE-сплит молча не срабатывал для такого трафика.
        s += "sniffer:\n"
        s += "  enable: true\n"
        s += "  override-destination: true\n"
        s += "  force-dns-mapping: true\n"
        s += "  parse-pure-ip: true\n"
        s += "  sniff:\n"
        s += "    HTTP:\n      ports: [80, 8080-8880]\n      override-destination: true\n"
        s += "    TLS:\n      ports: [443, 8443]\n"
        s += "    QUIC:\n      ports: [443]\n"
        return s
    }

    /// Выбор DNS: auto (Cloudflare+Google) | cloudflare | google | adguard |
    /// произвольный (IP / IP:порт / DoH-URL, можно несколько через запятую).
    private static func dnsServers(_ dns: String?) -> [String] {
        let auto = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"]
        let raw = (dns ?? "auto").trimmingCharacters(in: .whitespaces)
        switch raw.lowercased() {
        case "cloudflare": return ["https://1.1.1.1/dns-query"]
        case "google":     return ["https://dns.google/dns-query"]
        case "adguard":    return ["https://dns.adguard-dns.com/dns-query"]
        case "auto", "":   return auto
        default:
            // Чистим до безопасного набора символов, чтобы не сломать YAML.
            let allowed = CharacterSet(charactersIn:
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.:/_-")
            let parts = raw.split { $0 == "," || $0 == " " }
                .map { token -> String in
                    String(String.UnicodeScalarView(token.unicodeScalars.filter { allowed.contains($0) }))
                }
                .filter { !$0.isEmpty }
            return parts.isEmpty ? auto : parts
        }
    }

    /// Правила из UI: цель (GLOBAL/DIRECT) уже проставлена в JS. macOS: имена
    /// процессов без .exe (UI мог сохранить старые Windows-правила).
    private static func normalizedRules(_ rules: [String]) -> [String] {
        rules.compactMap { rule in
            let clean = rule.trimmingCharacters(in: .whitespaces)
            if clean.isEmpty { return nil }
            var fields = clean.components(separatedBy: ",")
            if fields.first == "PROCESS-NAME", fields.count >= 2 {
                fields[1] = fields[1].replacingOccurrences(
                    of: ".exe", with: "", options: [.caseInsensitive, .anchored, .backwards])
            }
            return fields.joined(separator: ",")
        }
    }

    // MARK: helpers

    /// YAML-безопасная строка в двойных кавычках. Правило целиком берём в кавычки:
    /// значение с YAML-значимым символом (": ") иначе превратило бы item в map.
    private static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Строка — валидный IPv4/IPv6-литерал (для безопасного hosts:/bypass).
    private static func isIPLiteral(_ s: String) -> Bool {
        if s.isEmpty { return false }
        var v4 = in_addr(), v6 = in6_addr()
        return s.withCString { inet_pton(AF_INET, $0, &v4) == 1 || inet_pton(AF_INET6, $0, &v6) == 1 }
    }
}
