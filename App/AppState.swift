import SwiftUI
import AppKit

@MainActor
final class AppState: ObservableObject {
    enum Phase { case loggedOut, loggingIn, ready }
    enum VPNState: Equatable { case off, connecting, on, failed(String) }

    @Published var phase: Phase = .loggedOut
    @Published var account: Account?
    @Published var vpn: VPNState = .off
    @Published var loginURL: URL?
    @Published var error: String?

    private var pollTask: Task<Void, Never>?

    /// Restore an existing session (cookie) and current tunnel state on launch.
    func bootstrap() async {
        if let acc = try? await CloudVPNAPI.shared.me() {
            account = acc
            phase = .ready
        }
        vpn = (await HelperClient.shared.status()) == "running" ? .on : .off
    }

    // MARK: Auth

    func beginTelegramLogin() async {
        error = nil
        do {
            let start = try await CloudVPNAPI.shared.telegramStart()
            loginURL = start.openURL
            if let u = loginURL { NSWorkspace.shared.open(u) }
            phase = .loggingIn
            pollTask?.cancel()
            pollTask = Task { [token = start.token] in await self.pollLogin(token: token) }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func pollLogin(token: String) async {
        for _ in 0..<120 {                       // ~4 minutes at 2s intervals
            if Task.isCancelled { return }
            if let acc = try? await CloudVPNAPI.shared.telegramPoll(token: token) {
                account = acc
                phase = .ready
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        if phase == .loggingIn { phase = .loggedOut; error = "Время входа истекло, попробуй снова." }
    }

    func cancelLogin() {
        pollTask?.cancel()
        phase = .loggedOut
    }

    func logout() async {
        pollTask?.cancel()
        await disconnect()
        await CloudVPNAPI.shared.logout()
        account = nil
        phase = .loggedOut
    }

    // MARK: VPN

    func connect() async {
        guard let acc = account else { return }
        error = nil
        vpn = .connecting
        do {
            guard acc.isActive else { throw APIError.network("Подписка не активна") }
            let subURL = try await CloudVPNAPI.shared.subscriptionURL()
            let config = try await MihomoConfig.build(fromSubscription: subURL)
            try await HelperClient.shared.start(config: config)
            vpn = .on
        } catch {
            vpn = .failed(error.localizedDescription)
            self.error = error.localizedDescription
        }
    }

    func disconnect() async {
        await HelperClient.shared.stop()
        vpn = .off
    }

    func toggle() async {
        switch vpn {
        case .on, .connecting: await disconnect()
        default: await connect()
        }
    }
}
