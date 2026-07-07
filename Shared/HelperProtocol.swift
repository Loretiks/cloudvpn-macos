import Foundation

/// XPC contract between the app and the privileged helper. Compiled into BOTH
/// targets. Keep it `@objc`-compatible (NSXPCConnection requirement).
@objc public protocol HelperProtocol {
    /// Persist `config` (mihomo YAML) and (re)start mihomo with a utun device.
    /// If `killSwitch` is true, arm a pf firewall once the tunnel is up that
    /// blocks all outbound traffic except through the tunnel + to `allowedIPs`
    /// (the VPN server), so the real IP can't leak if mihomo dies.
    /// Replies (ok, message).
    func start(config: String, killSwitch: Bool, allowedIPs: [String],
               withReply reply: @escaping (Bool, String) -> Void)

    /// Stop mihomo, tear the tunnel down, and always disarm the kill switch.
    func stop(withReply reply: @escaping (Bool) -> Void)

    /// Arm/disarm the kill switch at runtime (toggle flipped while connected).
    func setKillSwitch(enabled: Bool, allowedIPs: [String],
                       withReply reply: @escaping (Bool, String) -> Void)

    /// "running" | "stopped" | "error: …"
    func status(withReply reply: @escaping (String) -> Void)

    /// Helper build version, for the app to detect a stale installed helper.
    func version(withReply reply: @escaping (String) -> Void)
}

public enum HelperInfo {
    /// Bump on every helper change so the app can re-install a newer helper.
    public static let version = "0.2.2"
}
