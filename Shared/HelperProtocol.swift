import Foundation

/// XPC contract between the app and the privileged helper. Compiled into BOTH
/// targets. Keep it `@objc`-compatible (NSXPCConnection requirement).
@objc public protocol HelperProtocol {
    /// Persist `config` (mihomo YAML) and (re)start mihomo with a utun device.
    /// Replies (ok, message).
    func start(config: String, withReply reply: @escaping (Bool, String) -> Void)

    /// Stop mihomo and tear the tunnel down.
    func stop(withReply reply: @escaping (Bool) -> Void)

    /// "running" | "stopped" | "error: …"
    func status(withReply reply: @escaping (String) -> Void)

    /// Helper build version, for the app to detect a stale installed helper.
    func version(withReply reply: @escaping (String) -> Void)
}

public enum HelperInfo {
    /// Bump on every helper change so the app can re-install a newer helper.
    public static let version = "0.1.0"
}
