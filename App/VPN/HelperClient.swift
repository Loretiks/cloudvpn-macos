import Foundation
import ServiceManagement

/// Installs / talks to the privileged helper (LaunchDaemon) over XPC.
/// The helper is registered with SMAppService (macOS 13+); the first time, the OS
/// asks the user to approve it in System Settings → General → Login Items.
@MainActor
final class HelperClient {
    static let shared = HelperClient()

    // Matches Helper/Launchd.plist filename: "<label>.plist".
    private let daemon = SMAppService.daemon(plistName: "\(Const.helperMachService).plist")

    private var connection: NSXPCConnection?

    enum HelperError: LocalizedError {
        case needsApproval          // user must enable in System Settings
        case notRegistered(String)
        case xpc(String)
        var errorDescription: String? {
            switch self {
            case .needsApproval: return "Разреши хелпер в System Settings → General → Login Items, затем повтори."
            case .notRegistered(let s): return "Не удалось установить хелпер: \(s)"
            case .xpc(let s): return "Ошибка связи с хелпером: \(s)"
            }
        }
    }

    /// Ensure the daemon is registered + approved. Throws `.needsApproval` when the
    /// user still has to flip the switch in System Settings.
    func ensureInstalled() throws {
        switch daemon.status {
        case .enabled:
            return
        case .requiresApproval:
            SMAppService.openSystemSettingsLoginItems()
            throw HelperError.needsApproval
        case .notRegistered, .notFound:
            do {
                try daemon.register()
                if daemon.status == .requiresApproval {
                    SMAppService.openSystemSettingsLoginItems()
                    throw HelperError.needsApproval
                }
            } catch {
                throw HelperError.notRegistered(error.localizedDescription)
            }
        @unknown default:
            throw HelperError.notRegistered("unknown status")
        }
    }

    private func proxy() throws -> HelperProtocol {
        if connection == nil {
            let c = NSXPCConnection(machServiceName: Const.helperMachService, options: .privileged)
            c.remoteObjectInterface = NSXPCInterface(with: HelperProtocol.self)
            c.invalidationHandler = { [weak self] in Task { @MainActor in self?.connection = nil } }
            c.resume()
            connection = c
        }
        guard let p = connection?.remoteObjectProxyWithErrorHandler({ _ in }) as? HelperProtocol else {
            throw HelperError.xpc("no proxy")
        }
        return p
    }

    func start(config: String) async throws {
        try ensureInstalled()
        let p = try proxy()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            p.start(config: config) { ok, msg in
                ok ? cont.resume() : cont.resume(throwing: HelperError.xpc(msg))
            }
        }
    }

    func stop() async {
        guard let p = try? proxy() else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            p.stop { _ in cont.resume() }
        }
    }

    func status() async -> String {
        guard let p = try? proxy() else { return "stopped" }
        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            p.status { cont.resume(returning: $0) }
        }
    }
}
