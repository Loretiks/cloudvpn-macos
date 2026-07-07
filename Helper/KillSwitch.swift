import Foundation

/// Kill switch на базе macOS pf (packet filter), выполняется в рут-хелпере.
///
/// Идея: пока туннель поднят и kill switch включён, весь исходящий трафик,
/// кроме идущего через утун-интерфейсы, к VPN-серверу и по loopback, блокируется.
/// Если mihomo падает и утун исчезает — приложения пытаются идти напрямую и
/// упираются в `block drop out` → реальный IP не утекает.
///
/// Правила грузятся в pf-якорь `cloudvpn` (на который один раз добавляется ссылка
/// в /etc/pf.conf). Снятие — просто флаш якоря; ссылка остаётся пустой и безвредной.
/// После перезагрузки якорь пуст (правила грузятся динамически, не из pf.conf),
/// так что залипнуть в офлайне между сессиями невозможно.
enum KillSwitch {
    private static let anchor = "cloudvpn"
    private static let pfConf = "/etc/pf.conf"
    private static let tokenFile = "/Library/Application Support/CloudVPN/.pf-token"
    private static let anchorMarker = "anchor \"cloudvpn\""

    /// Взвести: разрешить lo0 + текущие утуны + allowedIPs, заблокировать остальной out.
    static func arm(allowedIPs: [String]) {
        // Снимаем прошлое состояние перед взводом: иначе повторный arm вызвал бы
        // `pfctl -E` ещё раз и утёк бы счётчик ссылок pf (один -X не выключит pf).
        disarm()
        ensureAnchorReferenced()
        let rules = buildRules(allowedIPs: allowedIPs)
        let rulesPath = "/Library/Application Support/CloudVPN/killswitch.pf"
        try? rules.write(toFile: rulesPath, atomically: true, encoding: .utf8)
        // Загрузить правила в якорь и включить pf со счётчиком ссылок (-E даёт токен).
        _ = run("/sbin/pfctl", ["-a", anchor, "-f", rulesPath])
        if let out = runCapture("/sbin/pfctl", ["-E"]),
           let token = out.split(separator: "\n").first(where: { $0.contains("Token :") })?
               .split(separator: ":").last?.trimmingCharacters(in: .whitespaces) {
            try? token.write(toFile: tokenFile, atomically: true, encoding: .utf8)
        }
    }

    /// Снять: очистить правила якоря и отпустить нашу ссылку на pf.
    static func disarm() {
        _ = run("/sbin/pfctl", ["-a", anchor, "-F", "rules"])
        if let token = try? String(contentsOfFile: tokenFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            _ = run("/sbin/pfctl", ["-X", token])
            try? FileManager.default.removeItem(atPath: tokenFile)
        }
    }

    // MARK: rules

    private static func buildRules(allowedIPs: [String]) -> String {
        var lines = [
            "pass quick on lo0 all",
        ]
        // Разрешаем все текущие утун-интерфейсы (туннель mihomo уже поднят).
        for iface in utunInterfaces() {
            lines.append("pass out quick on \(iface) all")
        }
        // Доступ к самому VPN-серверу (зашифрованный туннель идёт по физическому иф.).
        // icmp — чтобы работал наш ping до сервера при включённом kill switch.
        for ip in allowedIPs where isValidIP(ip) {
            lines.append("pass out quick proto { tcp udp icmp } to \(ip)")
        }
        // DHCP, чтобы сеть могла переинициализироваться.
        lines.append("pass out quick proto udp to any port { 67 68 }")
        // Всё остальное исходящее — заблокировать.
        lines.append("block drop out quick all")
        return lines.joined(separator: "\n") + "\n"
    }

    /// Имена активных утун-интерфейсов через getifaddrs.
    static func utunInterfaces() -> [String] {
        var names = Set<String>()
        var ptr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ptr) == 0, let first = ptr else { return [] }
        defer { freeifaddrs(ptr) }
        var cur: UnsafeMutablePointer<ifaddrs>? = first
        while let c = cur {
            let name = String(cString: c.pointee.ifa_name)
            if name.hasPrefix("utun") { names.insert(name) }
            cur = c.pointee.ifa_next
        }
        return names.sorted()
    }

    private static func isValidIP(_ s: String) -> Bool {
        var v4 = in_addr(), v6 = in6_addr()
        return s.withCString { inet_pton(AF_INET, $0, &v4) == 1 || inet_pton(AF_INET6, $0, &v6) == 1 }
    }

    // MARK: pf.conf wiring (once)

    /// Возвращает true, если якорь `cloudvpn` действительно объявлен в главном
    /// наборе pf. Если объявить не удалось (pf.conf нечитаем и т.п.) — правила якоря
    /// грузятся, но НЕ вычисляются ⇒ kill switch молча не фильтрует. Сигналим в лог.
    @discardableResult
    private static func ensureAnchorReferenced() -> Bool {
        guard let conf = try? String(contentsOfFile: pfConf, encoding: .utf8) else {
            NSLog("KillSwitch: /etc/pf.conf unreadable — anchor NOT referenced, kill switch will NOT filter")
            return false
        }
        if !conf.contains(anchorMarker) {
            // Дописываем ссылку на якорь и перечитываем pf.conf (правила якоря грузим
            // потом динамически — тут только объявляем сам якорь).
            let appended = conf + "\n# CloudVPN kill switch anchor\n\(anchorMarker)\n"
            do {
                try appended.write(toFile: pfConf, atomically: true, encoding: .utf8)
            } catch {
                NSLog("KillSwitch: cannot write /etc/pf.conf (%@) — kill switch will NOT filter", "\(error)")
                return false
            }
            _ = run("/sbin/pfctl", ["-f", pfConf])
        }
        // Проверяем, что главный набор реально ссылается на наш якорь.
        let referenced = runCapture("/sbin/pfctl", ["-sr"])?.contains("anchor \"cloudvpn\"") ?? false
        if !referenced {
            NSLog("KillSwitch: anchor 'cloudvpn' not present in loaded ruleset — kill switch will NOT filter")
        }
        return referenced
    }

    // MARK: subprocess

    @discardableResult
    private static func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus }
        catch { return -1 }
    }

    private static func runCapture(_ path: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe   // pfctl -E пишет "Token : …" в stderr
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }
}
