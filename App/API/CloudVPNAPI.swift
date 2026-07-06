import Foundation

/// Talks to the Cloud VPN central API. Auth is the captcha-free **Telegram deep-link
/// flow** (same one the desktop client uses): start → user taps the link and confirms
/// in the bot → poll until the session cookie is issued. URLSession keeps the JWT
/// session cookie automatically, so `me()` / `subscription()` just work afterwards.
///
/// (Email+password exists on the server too, but the web login requires a Cloudflare
/// Turnstile token that a native app can't easily produce — so we default to the
/// deep-link flow. Add an email path later if the server grows a native-friendly one.)
actor CloudVPNAPI {
    static let shared = CloudVPNAPI()

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpCookieAcceptPolicy = .always
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 20
        return URLSession(configuration: cfg)
    }()

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: Const.apiBase.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        do {
            let (data, resp) = try await session.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["detail"] as? String
                throw APIError.http(code, msg ?? String(data: data, encoding: .utf8) ?? "")
            }
            return data
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.network(error.localizedDescription)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decode("\(error)") }
    }

    // MARK: - Auth (Telegram deep-link)

    func telegramStart() async throws -> TelegramStart {
        let data = try await request("auth/telegram/start", method: "POST")
        return try decode(TelegramStart.self, data)
    }

    /// Poll until the user confirms in the bot. Returns the `Account` once the
    /// session cookie is set, or `nil` while still pending.
    func telegramPoll(token: String) async throws -> Account? {
        do {
            let data = try await request("auth/telegram/poll?token=\(token)")
            // Some servers return the user directly; some wrap it. Try both.
            if let acc = try? decode(Account.self, data), acc.subUrl != nil || acc.email != nil {
                return acc
            }
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let u = obj["user"] as? [String: Any] {
                let d = try JSONSerialization.data(withJSONObject: u)
                return try? decode(Account.self, d)
            }
            return nil
        } catch APIError.http(let code, _) where code == 404 || code == 425 {
            return nil   // still pending
        }
    }

    func me() async throws -> Account {
        let data = try await request("auth/me")
        if let acc = try? decode(Account.self, data) { return acc }
        // fallback if wrapped as { user: {...} }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let u = obj["user"] as? [String: Any] {
            return try decode(Account.self, JSONSerialization.data(withJSONObject: u))
        }
        throw APIError.decode("unexpected /auth/me shape")
    }

    func logout() async {
        _ = try? await request("auth/logout", method: "POST")
        HTTPCookieStorage.shared.cookies?.forEach(HTTPCookieStorage.shared.deleteCookie)
    }

    /// Best-effort resolve of the subscription URL that mihomo will import.
    func subscriptionURL() async throws -> String {
        let acc = try await me()
        if let s = acc.subUrl, !s.isEmpty { return s }
        // Fallback to /api/subscription if /me didn't carry it.
        if let data = try? await request("subscription"),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["subUrl", "sub_url", "subscriptionUrl", "url"] {
                if let s = obj[key] as? String, !s.isEmpty { return s }
                if let sub = obj["subscription"] as? [String: Any], let s = sub[key] as? String, !s.isEmpty { return s }
            }
        }
        throw APIError.decode("no subscription URL for this account")
    }
}
