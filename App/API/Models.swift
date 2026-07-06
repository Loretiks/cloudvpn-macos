import Foundation

/// The logged-in user, as returned by `GET /api/auth/me`.
/// NOTE: verify these key names against the live API response the first time you
/// wire this up — the server's `public_user` is the source of truth. All optional
/// so an extra/renamed field never breaks decoding.
struct Account: Codable, Equatable {
    var email: String?
    var name: String?
    var telegramUsername: String?
    var subStatus: String?        // "active" | "trial" | "frozen" | ...
    var subPlan: String?
    var subExpiresAt: String?     // ISO8601
    var subUrl: String?           // https://sub.cloude.tech/<short>  ← what mihomo consumes
    var admin: Bool?

    var isActive: Bool { subStatus == "active" || subStatus == "trial" }
    var isFrozen: Bool { subStatus == "frozen" }
}

/// `POST /api/auth/telegram/start` → a one-time token + the deep link to open.
struct TelegramStart: Codable {
    var token: String
    var url: String?          // t.me/cloudesvpn_bot?start=login_<token>
    var deeplink: String?     // some builds name it differently — accept both
    var link: String?
    var botUsername: String?

    var openURL: URL? {
        for s in [url, deeplink, link] { if let s, let u = URL(string: s) { return u } }
        if let t = token as String?, let bot = botUsername {
            return URL(string: "https://t.me/\(bot)?start=login_\(t)")
        }
        return nil
    }
}

enum APIError: LocalizedError {
    case http(Int, String)
    case decode(String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .http(let c, let m): return "Server \(c): \(m)"
        case .decode(let m): return "Bad response: \(m)"
        case .network(let m): return m
        }
    }
}
