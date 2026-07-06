import SwiftUI

@main
struct CloudVPNApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup("Cloud VPN") {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 380, minHeight: 500)
                .task { await state.bootstrap() }
        }
        .windowResizability(.contentSize)
    }
}
