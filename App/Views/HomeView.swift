import SwiftUI

struct HomeView: View {
    @EnvironmentObject var state: AppState

    private var isOn: Bool { state.vpn == .on }
    private var isBusy: Bool { state.vpn == .connecting }

    var body: some View {
        VStack(spacing: 22) {
            header

            Button(action: { Task { await state.toggle() } }) {
                ZStack {
                    Circle()
                        .fill(isOn ? Color.green.opacity(0.15) : Color.secondary.opacity(0.12))
                        .frame(width: 168, height: 168)
                    if isBusy {
                        ProgressView().controlSize(.large)
                    } else {
                        VStack(spacing: 6) {
                            Image(systemName: isOn ? "bolt.horizontal.circle.fill" : "power")
                                .font(.system(size: 52))
                                .foregroundStyle(isOn ? .green : .secondary)
                            Text(isOn ? "Подключено" : "Отключено")
                                .font(.headline)
                                .foregroundStyle(isOn ? .green : .secondary)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(isBusy || (state.account?.isActive == false))

            statusLine

            Spacer()
            footer
        }
        .padding(28)
    }

    private var header: some View {
        VStack(spacing: 4) {
            Text(state.account?.email ?? state.account?.name ?? "Аккаунт")
                .font(.headline)
            if let acc = state.account {
                if acc.isFrozen {
                    Label("Подписка заморожена", systemImage: "snowflake")
                        .font(.callout).foregroundStyle(.blue)
                } else if let plan = acc.subPlan {
                    Text("\(plan) · до \(prettyDate(acc.subExpiresAt))")
                        .font(.callout).foregroundStyle(.secondary)
                } else if acc.isActive == false {
                    Text("Нет активной подписки")
                        .font(.callout).foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder private var statusLine: some View {
        switch state.vpn {
        case .failed(let m):
            Text(m).font(.callout).foregroundStyle(.red).multilineTextAlignment(.center)
        case .connecting:
            Text("Подключаемся…").font(.callout).foregroundStyle(.secondary)
        default:
            if let e = state.error {
                Text(e).font(.callout).foregroundStyle(.red).multilineTextAlignment(.center)
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Выйти") { Task { await state.logout() } }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            Spacer()
            Text("Cloud VPN").font(.caption).foregroundStyle(.tertiary)
        }
    }

    private func prettyDate(_ iso: String?) -> String {
        guard let iso else { return "—" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let d else { return iso }
        let out = DateFormatter(); out.dateStyle = .medium
        return out.string(from: d)
    }
}
