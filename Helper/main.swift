import Foundation
import Security

/// Privileged LaunchDaemon (root). Its only job: run/stop the bundled mihomo binary
/// with the config the app hands it over XPC. Running as root lets mihomo create the
/// `utun` device + install routes (full-tunnel), exactly like the Windows helper.
final class HelperService: NSObject, HelperProtocol {
    private var mihomo: Process?
    private let fm = FileManager.default

    private var workDir: URL { URL(fileURLWithPath: Const.workDir, isDirectory: true) }
    private var configURL: URL { workDir.appendingPathComponent("config.yaml") }
    private var logURL: URL { workDir.appendingPathComponent("mihomo.log") }

    /// Absolute path to THIS helper executable. Under launchd the process' argv[0]
    /// is relative ("Contents/MacOS/…") and CWD is "/", so resolving argv[0] gives
    /// the wrong path — use _NSGetExecutablePath, which always returns the real path.
    private var executablePath: URL {
        var size: UInt32 = 0
        _NSGetExecutablePath(nil, &size)                       // ask for required buffer size
        var buf = [CChar](repeating: 0, count: Int(size))
        if _NSGetExecutablePath(&buf, &size) == 0 {
            return URL(fileURLWithPath: String(cString: buf)).resolvingSymlinksInPath()
        }
        // Fallback (shouldn't happen): argv[0] resolved against CWD.
        return URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    }

    /// The app bundle layout, relative to this helper at Contents/MacOS/<helper>.
    private var bundleMacOSDir: URL {
        executablePath.deletingLastPathComponent()             // …/Contents/MacOS
    }
    private var bundleResourcesDir: URL {
        bundleMacOSDir.deletingLastPathComponent().appendingPathComponent("Resources")
    }

    /// Find the mihomo binary shipped in the app bundle (embed script puts it in MacOS/).
    private func mihomoBinary() -> URL? {
        let candidates = [
            bundleMacOSDir.appendingPathComponent("mihomo"),
            bundleResourcesDir.appendingPathComponent("mihomo"),
        ]
        return candidates.first { fm.isExecutableFile(atPath: $0.path) }
    }

    /// Copy bundled geo databases into the workdir once, so mihomo doesn't have to
    /// download them from GitHub on first start (often unreachable exactly where a
    /// VPN is needed).
    private func seedGeoAssets() {
        for name in ["geoip.metadb", "geosite.dat"] {
            let dst = workDir.appendingPathComponent(name)
            let src = bundleResourcesDir.appendingPathComponent(name)
            if !fm.fileExists(atPath: dst.path), fm.fileExists(atPath: src.path) {
                try? fm.copyItem(at: src, to: dst)
            }
        }
    }

    func start(config: String, killSwitch: Bool, allowedIPs: [String],
               withReply reply: @escaping (Bool, String) -> Void) {
        do {
            // Новый коннект — снимаем прошлый kill switch, чтобы не заблокировать
            // связь с (возможно новым) сервером ещё до подъёма туннеля.
            KillSwitch.disarm()

            try? fm.createDirectory(at: workDir, withIntermediateDirectories: true)
            try config.write(to: configURL, atomically: true, encoding: .utf8)
            seedGeoAssets()
            guard let bin = mihomoBinary() else { reply(false, "mihomo binary not found in bundle"); return }

            mihomo?.terminate(); mihomo = nil

            // Fresh log each run — the app/user can inspect it when a connect fails.
            fm.createFile(atPath: logURL.path, contents: nil)
            let log = try FileHandle(forWritingTo: logURL)

            let p = Process()
            p.executableURL = bin
            p.arguments = ["-d", workDir.path, "-f", configURL.path]
            p.standardOutput = log
            p.standardError = log
            try p.run()

            // mihomo exits within moments on a broken config — catch that here instead
            // of reporting a phantom "connected".
            Thread.sleep(forTimeInterval: 0.8)
            guard p.isRunning else {
                let tail = (try? String(contentsOf: logURL, encoding: .utf8))?
                    .split(separator: "\n").suffix(3).joined(separator: "\n") ?? ""
                reply(false, "mihomo exited on start. \(tail)")
                return
            }
            mihomo = p

            // Утун поднимается не мгновенно — дать ему появиться, потом взводить pf,
            // иначе в правилах не окажется tunnel-интерфейса и туннель зарежется.
            if killSwitch {
                for _ in 0..<20 {
                    if !KillSwitch.utunInterfaces().isEmpty { break }
                    Thread.sleep(forTimeInterval: 0.2)
                }
                KillSwitch.arm(allowedIPs: allowedIPs)
            }
            reply(true, "started")
        } catch {
            reply(false, error.localizedDescription)
        }
    }

    func stop(withReply reply: @escaping (Bool) -> Void) {
        KillSwitch.disarm()                 // не оставляем юзера в офлайне
        mihomo?.terminate(); mihomo = nil
        reply(true)
    }

    func setKillSwitch(enabled: Bool, allowedIPs: [String],
                       withReply reply: @escaping (Bool, String) -> Void) {
        // Взводить имеет смысл только при живом туннеле; иначе просто снимаем.
        if enabled, mihomo?.isRunning == true {
            KillSwitch.arm(allowedIPs: allowedIPs)
        } else {
            KillSwitch.disarm()
        }
        reply(true, "ok")
    }

    func status(withReply reply: @escaping (String) -> Void) {
        reply(mihomo?.isRunning == true ? "running" : "stopped")
    }

    func version(withReply reply: @escaping (String) -> Void) { reply(HelperInfo.version) }
}

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    /// Team ID this helper was signed with, read from our own code signature.
    /// nil for ad-hoc dev builds (no team).
    private static let ownTeamID: String? = {
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let code = selfCode else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let sCode = staticCode else { return nil }
        var infoCF: CFDictionary?
        guard SecCodeCopySigningInformation(sCode, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
              let info = infoCF as? [String: Any] else { return nil }
        return info[kSecCodeInfoTeamIdentifier as String] as? String
    }()

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        // Only our own app (same Team ID + bundle id, Apple-anchored) may drive this
        // root helper. Connections failing the requirement are invalidated by the OS
        // before any message is delivered.
        guard let team = Self.ownTeamID else {
            // Нет Team ID → это ad-hoc/неподписанная сборка, привязать клиента не к
            // чему. FAIL CLOSED: отклоняем ВСЕХ, иначе любой локальный процесс смог бы
            // рулить рут-хелпером (LPE до root). Подписывайте сборку своей Team.
            NSLog("CloudVPNHelper: no Team ID to pin — rejecting XPC client (sign the build)")
            return false
        }
        let requirement = """
        anchor apple generic and identifier "\(Const.appBundleID)" \
        and certificate leaf[subject.OU] = "\(team)"
        """
        c.setCodeSigningRequirement(requirement)
        c.exportedInterface = NSXPCInterface(with: HelperProtocol.self)
        c.exportedObject = HelperService()
        c.resume()
        return true
    }
}

// Стартовая очистка: если прошлая сессия/креш оставили pf-якорь взведённым,
// снимаем его сразу при запуске демона, чтобы не держать юзера в офлайне.
KillSwitch.disarm()

let delegate = ListenerDelegate()
let listener = NSXPCListener(machServiceName: Const.helperMachService)
listener.delegate = delegate
listener.resume()
RunLoop.main.run()
