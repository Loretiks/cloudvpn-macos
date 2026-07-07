import Foundation

/// vless:// → полный mihomo-конфиг (как это делает C#-хост Windows-клиента).
/// Поддержка: security = reality | tls | none; transport = tcp | ws | grpc;
/// flow (vision), fp, sni, pbk/sid (Reality).
enum MihomoConfigBuilder {
    struct Built {
        let yaml: String
        let serverHost: String
    }

    enum BuildError: LocalizedError {
        case badURI(String)
        var errorDescription: String? {
            switch self { case .badURI(let m): return "не удалось разобрать vless-ссылку: \(m)" }
        }
    }

    /// Извлечь host из vless без полной сборки — чтобы заранее резолвить IP сервера
    /// для kill switch (и потом закрепить их через `hosts:`).
    static func serverHost(fromVless vless: String) -> String? {
        let trimmed = vless.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let noFragment = trimmed.split(separator: "#", maxSplits: 1).first,
              let uri = URL(string: String(noFragment)),
              let host = uri.host, !host.isEmpty else { return nil }
        return host
    }

    /// `pinnedServerIPs` — если заданы, mihomo будет коннектиться к серверу ровно по
    /// этим IP (через `hosts:`). Нужно для kill switch: pf разрешает только эти IP,
    /// и без закрепления mihomo мог бы (через свой DoH/GeoDNS) выбрать другой IP,
    /// который pf зарежет и оборвёт туннель.
    static func build(vless: String, tun: Bool, route: String, rules: [String],
                      pinnedServerIPs: [String] = []) throws -> Built {
        // remark после # часто содержит эмодзи/кириллицу — URL(string:) на macOS 13
        // такое не парсит, а нам fragment и не нужен. .first, чтобы пустой/«#»-only
        // vless бросал BuildError, а не крашил на out-of-range.
        let trimmed = vless.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let noFragment = trimmed.split(separator: "#", maxSplits: 1).first else {
            throw BuildError.badURI("пустая ссылка")
        }
        guard let uri = URL(string: String(noFragment)),
              uri.scheme?.lowercased() == "vless",
              let host = uri.host, !host.isEmpty,
              let uuid = uri.user, !uuid.isEmpty
        else { throw BuildError.badURI("нет host/uuid") }

        let port = uri.port ?? 443
        var q: [String: String] = [:]
        for item in URLComponents(url: uri, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            q[item.name.lowercased()] = item.value ?? ""
        }

        let security = (q["security"] ?? "none").lowercased()
        let network = (q["type"] ?? "tcp").lowercased()
        let sni = q["sni"] ?? q["servername"] ?? ""
        let flow = q["flow"] ?? ""
        let fp = q["fp"] ?? "chrome"

        var p = """
          - name: PROXY
            type: vless
            server: \(quote(host))
            port: \(port)
            uuid: \(quote(uuid))
            udp: true
            network: \(network)
        """
        if !flow.isEmpty { p += "\n    flow: \(quote(flow))" }
        switch security {
        case "reality":
            guard let pbk = q["pbk"], !pbk.isEmpty else { throw BuildError.badURI("reality без pbk") }
            p += """
            \n    tls: true
                servername: \(quote(sni.isEmpty ? host : sni))
                client-fingerprint: \(quote(fp))
                reality-opts:
                  public-key: \(quote(pbk))
                  short-id: \(quote(q["sid"] ?? ""))
            """
        case "tls":
            p += """
            \n    tls: true
                servername: \(quote(sni.isEmpty ? host : sni))
                client-fingerprint: \(quote(fp))
            """
            if q["allowinsecure"] == "1" || q["insecure"] == "1" { p += "\n    skip-cert-verify: true" }
        default:
            break
        }
        switch network {
        case "ws":
            let path = q["path"] ?? "/"
            let wsHost = q["host"] ?? sni
            p += "\n    ws-opts:\n      path: \(quote(path))"
            if !wsHost.isEmpty { p += "\n      headers:\n        Host: \(quote(wsHost))" }
        case "grpc":
            if let svc = q["servicename"], !svc.isEmpty {
                p += "\n    grpc-opts:\n      grpc-service-name: \(quote(svc))"
            }
        default:
            break
        }
        let proxyBlock = p

        // Правила из UI целятся в GLOBAL (windows-хост) — переводим policy-поле на нашу
        // группу PROXY. Меняем именно 3-е CSV-поле (политику), а не любое вхождение
        // «GLOBAL» — иначе значение вида DOMAIN-SUFFIX,global.example,GLOBAL испортилось бы.
        let userRules = rules.map { rule -> String in
            var fields = rule.components(separatedBy: ",")
            if fields.count >= 3, fields[2] == "GLOBAL" { fields[2] = "PROXY" }
            // macOS: имена процессов без .exe (UI мог сохранить старые Windows-правила)
            if fields.first == "PROCESS-NAME", fields.count >= 2 {
                fields[1] = fields[1]
                    .replacingOccurrences(of: ".exe", with: "", options: [.caseInsensitive, .anchored, .backwards])
            }
            return fields.joined(separator: ",")
        }
        let ruleLines = (route == "apps" ? userRules + ["MATCH,DIRECT"] : ["MATCH,PROXY"])
            .map { "  - \(quote($0))" }
            .joined(separator: "\n")

        // Закрепляем IP сервера, если заданы (kill switch): mihomo будет резолвить
        // host сервера ровно в эти адреса — те же, что разрешил pf.
        let validPins = pinnedServerIPs.filter { isIPLiteral($0) }
        var hostsBlock = ""
        if !validPins.isEmpty {
            let list = validPins.map { quote($0) }.joined(separator: ", ")
            hostsBlock = "hosts:\n  \(quote(host)): [\(list)]\n\n"
        }

        var yaml = hostsBlock + """
        mixed-port: 7897
        external-controller: \(Const.mihomoController)
        mode: rule
        log-level: info
        dns:
          enable: true
          enhanced-mode: fake-ip
          fake-ip-range: 198.18.0.1/16
          default-nameserver:
            - 77.88.8.8
            - 1.1.1.1
          nameserver:
            - https://1.1.1.1/dns-query
            - https://8.8.8.8/dns-query

        """
        if tun {
            yaml += """
            tun:
              enable: true
              stack: system
              auto-route: true
              auto-detect-interface: true
              dns-hijack:
                - any:53

            """
        }
        yaml += "proxies:\n\(proxyBlock)\n\nrules:\n\(ruleLines)\n"
        return Built(yaml: yaml, serverHost: host)
    }

    /// YAML-безопасная строка в двойных кавычках.
    private static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Строка — валидный IPv4/IPv6-литерал (для безопасного hosts: закрепления).
    private static func isIPLiteral(_ s: String) -> Bool {
        var v4 = in_addr(), v6 = in6_addr()
        return s.withCString { inet_pton(AF_INET, $0, &v4) == 1 || inet_pton(AF_INET6, $0, &v6) == 1 }
    }
}
