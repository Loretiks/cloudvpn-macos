import SwiftUI

struct LoginView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "cloud.fill")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Cloud VPN").font(.largeTitle.bold())

            if state.phase == .loggingIn {
                ProgressView()
                Text("Открой ссылку и подтверди вход в боте.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let url = state.loginURL {
                    Link("Открыть ссылку снова", destination: url)
                }
                Button("Отмена") { state.cancelLogin() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            } else {
                Text("Войди через Telegram, чтобы подключиться.")
                    .foregroundStyle(.secondary)
                Button {
                    Task { await state.beginTelegramLogin() }
                } label: {
                    Label("Войти через Telegram", systemImage: "paperplane.fill")
                        .frame(maxWidth: 220)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            if let e = state.error {
                Text(e).font(.callout).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(32)
    }
}
