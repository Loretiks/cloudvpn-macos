import Foundation

/// Privileged LaunchDaemon (root). Its only job: run/stop the bundled mihomo binary
/// with the config the app hands it over XPC. Running as root lets mihomo create the
/// `utun` device + install routes (full-tunnel), exactly like the Windows helper.
final class HelperService: NSObject, HelperProtocol {
    private var mihomo: Process?
    private let fm = FileManager.default

    private var workDir: URL { URL(fileURLWithPath: Const.workDir, isDirectory: true) }
    private var configURL: URL { workDir.appendingPathComponent("config.yaml") }

    /// Find the mihomo binary shipped in the app bundle, relative to this helper's
    /// own executable. Adjust the candidates to match your Xcode copy phase.
    private func mihomoBinary() -> URL? {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let dir = exe.deletingLastPathComponent()          // …/Contents/MacOS
        let candidates = [
            dir.appendingPathComponent("mihomo"),
            dir.deletingLastPathComponent().appendingPathComponent("Resources/mihomo"),
        ]
        return candidates.first { fm.isExecutableFile(atPath: $0.path) }
    }

    func start(config: String, withReply reply: @escaping (Bool, String) -> Void) {
        do {
            try? fm.createDirectory(at: workDir, withIntermediateDirectories: true)
            try config.write(to: configURL, atomically: true, encoding: .utf8)
            guard let bin = mihomoBinary() else { reply(false, "mihomo binary not found in bundle"); return }
            mihomo?.terminate(); mihomo = nil
            let p = Process()
            p.executableURL = bin
            p.arguments = ["-d", workDir.path, "-f", configURL.path]
            try p.run()
            mihomo = p
            reply(true, "started")
        } catch {
            reply(false, error.localizedDescription)
        }
    }

    func stop(withReply reply: @escaping (Bool) -> Void) {
        mihomo?.terminate(); mihomo = nil
        reply(true)
    }

    func status(withReply reply: @escaping (String) -> Void) {
        reply(mihomo?.isRunning == true ? "running" : "stopped")
    }

    func version(withReply reply: @escaping (String) -> Void) { reply(HelperInfo.version) }
}

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        // SECURITY TODO: before trusting the caller, verify its code signature against
        // a designated requirement (same Team ID + our app's bundle id) using the
        // connection's `auditToken` + SecCode APIs. Otherwise any local process could
        // drive this root helper. Ship this check before any public release.
        c.exportedInterface = NSXPCInterface(with: HelperProtocol.self)
        c.exportedObject = HelperService()
        c.resume()
        return true
    }
}

let delegate = ListenerDelegate()
let listener = NSXPCListener(machServiceName: Const.helperMachService)
listener.delegate = delegate
listener.resume()
RunLoop.main.run()
