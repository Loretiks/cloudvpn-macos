import Foundation

/// Values shared between the app and the privileged helper.
enum Const {
    /// Central API base. IMPORTANT: `cloude.tech` is throttled by SNI on some RU
    /// networks — the very users who need the VPN. Point this at an endpoint that
    /// is reachable there (a non-blocked api domain, the origin IP with a Host
    /// override, or a fronting/CDN domain). Override via the `CLOUDVPN_API_BASE`
    /// env var during development.
    static let apiBase: URL = {
        if let s = ProcessInfo.processInfo.environment["CLOUDVPN_API_BASE"],
           let u = URL(string: s) { return u }
        return URL(string: "https://cloude.tech/api")!
    }()

    /// Bundle identifiers (keep in sync with project.yml).
    static let appBundleID = "tech.cloude.vpn.mac"
    static let helperBundleID = "tech.cloude.vpn.mac.helper"

    /// Mach service the helper's XPC listener publishes (must match Launchd.plist).
    static let helperMachService = "tech.cloude.vpn.mac.helper"

    /// mihomo control API the helper exposes on loopback (external-controller).
    static let mihomoController = "127.0.0.1:9191"

    /// Where the helper keeps the working config + geo assets (root-owned).
    static let workDir = "/Library/Application Support/CloudVPN"
}
