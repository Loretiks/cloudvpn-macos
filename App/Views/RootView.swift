import SwiftUI

struct RootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            switch state.phase {
            case .loggedOut, .loggingIn: LoginView()
            case .ready:                 HomeView()
            }
        }
        .animation(.default, value: state.phase)
    }
}
