import Foundation
import ServiceManagement

/// Installs / talks to the privileged helper (LaunchDaemon) over XPC.
/// The helper is registered with SMAppService (macOS 13+); the first time, the OS
/// asks the user to approve it in System Settings → General → Login Items.
@MainActor
final class HelperClient {
    static let shared = HelperClient()

    // Matches Helper/<label>.plist filename: "<label>.plist".
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

    private func xpcConnection() -> NSXPCConnection {
        if let c = connection { return c }
        let c = NSXPCConnection(machServiceName: Const.helperMachService, options: .privileged)
        c.remoteObjectInterface = NSXPCInterface(with: HelperProtocol.self)
        c.invalidationHandler = { [weak self] in Task { @MainActor in self?.connection = nil } }
        c.resume()
        connection = c
        return c
    }

    /// A proxy whose XPC failures resume the continuation instead of hanging it:
    /// both the error handler and the reply race safely through `Once`.
    private func proxy(onError: @escaping (Error) -> Void) throws -> HelperProtocol {
        let raw = xpcConnection().remoteObjectProxyWithErrorHandler { err in
            onError(HelperError.xpc(err.localizedDescription))
        }
        guard let p = raw as? HelperProtocol else { throw HelperError.xpc("no proxy") }
        return p
    }

    /// Returns the running helper's build version, or nil if it can't be reached.
    func installedVersion() async -> String? {
        try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            let once = Once(cont)
            do {
                let p = try proxy { once.resume(throwing: $0) }
                p.version { once.resume(returning: $0) }
            } catch {
                once.resume(throwing: error)
            }
        }
    }

    /// If an OLDER helper is already installed/running, replace it: unregister drops
    /// the stale launchd job, register loads the freshly-built binary. Without this,
    /// launchd keeps serving the previously-installed daemon even after the app bundle
    /// is updated (the running process doesn't restart on file change).
    private func reinstallIfStale() async throws {
        // Переустанавливаем ТОЛЬКО если достоверно прочитали более старую версию.
        // Если версию узнать не удалось (nil — временная недоступность/занятость),
        // НЕ трогаем живой хелпер: снос+регистрация уронили бы рабочий туннель.
        guard let installed = await installedVersion() else { return }
        guard installed != HelperInfo.version else { return }
        connection?.invalidate(); connection = nil
        try? await daemon.unregister()
        try ensureInstalled()                    // re-register the new binary
        try? await Task.sleep(nanoseconds: 800_000_000)   // let launchd spin it up
    }

    func start(config: String, killSwitch: Bool, allowedIPs: [String]) async throws {
        try ensureInstalled()
        try await reinstallIfStale()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let once = Once(cont)
            do {
                let p = try proxy { once.resume(throwing: $0) }
                p.start(config: config, killSwitch: killSwitch, allowedIPs: allowedIPs) { ok, msg in
                    ok ? once.resume() : once.resume(throwing: HelperError.xpc(msg))
                }
            } catch {
                once.resume(throwing: error)
            }
        }
    }

    func stop() async {
        _ = try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Bool, Error>) in
            let once = Once(cont)
            do {
                let p = try proxy { once.resume(throwing: $0) }
                p.stop { once.resume(returning: $0) }
            } catch {
                once.resume(throwing: error)
            }
        }
    }

    /// Взвести/снять kill switch на лету (тумблер переключили при активном туннеле).
    func setKillSwitch(enabled: Bool, allowedIPs: [String]) async {
        _ = try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Bool, Error>) in
            let once = Once(cont)
            do {
                let p = try proxy { once.resume(throwing: $0) }
                p.setKillSwitch(enabled: enabled, allowedIPs: allowedIPs) { ok, _ in once.resume(returning: ok) }
            } catch {
                once.resume(throwing: error)
            }
        }
    }

    func status() async -> String {
        (try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            let once = Once(cont)
            do {
                let p = try proxy { once.resume(throwing: $0) }
                p.status { once.resume(returning: $0) }
            } catch {
                once.resume(throwing: error)
            }
        }) ?? "stopped"
    }

    /// Синхронная остановка туннеля + снятие kill switch на выходе из приложения.
    /// Открывает разовое XPC-соединение и ждёт ответа (с таймаутом), чтобы «Выйти»
    /// никогда не оставлял pf взведённым. Reply приходит на фоновой очереди XPC —
    /// ожидание в main-потоке не даёт дедлока.
    nonisolated static func shutdownBlocking(timeout: TimeInterval = 2) {
        let c = NSXPCConnection(machServiceName: Const.helperMachService, options: .privileged)
        c.remoteObjectInterface = NSXPCInterface(with: HelperProtocol.self)
        c.resume()
        let sem = DispatchSemaphore(value: 0)
        let proxy = c.remoteObjectProxyWithErrorHandler { _ in sem.signal() } as? HelperProtocol
        if let proxy {
            proxy.stop { _ in sem.signal() }
        } else {
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + timeout)
        c.invalidate()
    }
}

/// Resumes a continuation exactly once, whichever of the XPC reply / error
/// handler fires first (they may race on different threads).
private final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<T, Error>?

    init(_ c: CheckedContinuation<T, Error>) { cont = c }

    func resume(returning value: T) { take()?.resume(returning: value) }
    func resume(throwing error: Error) { take()?.resume(throwing: error) }

    private func take() -> CheckedContinuation<T, Error>? {
        lock.lock(); defer { lock.unlock() }
        let c = cont; cont = nil
        return c
    }
}

extension Once where T == Void {
    func resume() { resume(returning: ()) }
}
