import Foundation

/// Разворачивает вход из UI (vless:// или URL Remnawave-подписки) в список
/// vless-ссылок — ровно то, что JS ждёт в ответе `sub:{"items":[…]}`.
enum SubscriptionImporter {
    enum ImportError: LocalizedError {
        case badInput
        case emptyList
        case http(Int)
        var errorDescription: String? {
            switch self {
            case .badInput: return "вставь vless:// или ссылку подписки"
            case .emptyList: return "в подписке не нашлось vless-конфигов"
            case .http(let c): return "подписка недоступна (HTTP \(c))"
            }
        }
    }

    static func fetchItems(from input: String) async throws -> [String] {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("vless://") { return [trimmed] }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { throw ImportError.badInput }

        // v2ray-совместимый UA: Remnawave отдаёт на него plain/base64 список ссылок
        // (а не clash-yaml, который шлёт клиентам с clash-UA).
        var req = URLRequest(url: url)
        req.setValue("v2rayN/6.45", forHTTPHeaderField: "User-Agent")
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        // HWID-заголовки Remnawave: регистрируют это устройство в лимите слотов
        // подписки (иначе Mac не появится в списке «Устройства»).
        req.setValue(DeviceID.hwid, forHTTPHeaderField: "x-hwid")
        req.setValue("macos", forHTTPHeaderField: "x-device-os")
        req.setValue(DeviceID.osVersion, forHTTPHeaderField: "x-ver-os")
        req.setValue(DeviceID.model, forHTTPHeaderField: "x-device-model")
        req.timeoutInterval = 20
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw ImportError.http(code) }
        guard let body = String(data: data, encoding: .utf8) else { throw ImportError.emptyList }

        let items = extractLinks(from: body)
        guard !items.isEmpty else { throw ImportError.emptyList }
        return items
    }

    static func extractLinks(from body: String) -> [String] {
        var text = body
        // Подписка может прийти в base64 (стандарт v2ray-подписок).
        let compact = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if !compact.contains("://") {
            // Убираем ВСЕ пробелы/переносы (base64 часто приходит построчно) до
            // расчёта паддинга — иначе длина учитывает \n и «=» добавится неверно.
            var b64 = compact
                .components(separatedBy: .whitespacesAndNewlines).joined()
                .replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
            if let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
               let decoded = String(data: d, encoding: .utf8) {
                text = decoded
            }
        }
        return text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.lowercased().hasPrefix("vless://") }
    }
}
