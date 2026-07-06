import Foundation

/// Turns a Cloud VPN subscription link into a mihomo (Clash.Meta) config that runs
/// in TUN mode with a loopback control API. Remnawave serves a Clash-format config
/// when the request carries a clash User-Agent.
enum MihomoConfig {
    static func build(fromSubscription subURL: String) async throws -> String {
        guard let url = URL(string: subURL) else { throw APIError.network("bad subscription url") }
        var req = URLRequest(url: url)
        req.setValue("clash-meta", forHTTPHeaderField: "User-Agent")   // ← ask Remnawave for clash format
        req.setValue("*/*", forHTTPHeaderField: "Accept")

        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code),
              let yaml = String(data: data, encoding: .utf8), !yaml.isEmpty
        else { throw APIError.http(code, "subscription fetch failed") }

        // Inject the essentials for a full-tunnel client, only if the upstream
        // config doesn't already declare them (Remnawave clash configs normally
        // ship just proxies/groups/rules). For robust merging, swap this string
        // approach for Yams later.
        var out = ""
        if !yaml.contains("external-controller") {
            out += "external-controller: \(Const.mihomoController)\n"
        }
        if yaml.range(of: #"(?m)^\s*tun:"#, options: .regularExpression) == nil {
            out += tunBlock
        }
        out += yaml
        return out
    }

    private static let tunBlock = """
    tun:
      enable: true
      stack: system
      auto-route: true
      auto-detect-interface: true
      dns-hijack:
        - any:53

    """
}
