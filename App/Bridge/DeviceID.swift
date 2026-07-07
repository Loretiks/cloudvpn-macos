import Foundation

/// Стабильный идентификатор устройства для Remnawave HWID-лимита. Тот же приём,
/// что у десктоп-клиентов: аппаратный UUID машины, чтобы одно устройство
/// занимало ровно один слот подписки между перезапусками.
enum DeviceID {
    /// Аппаратный UUID (одинаковый между запусками; меняется только при смене железа).
    static let hwid: String = {
        var bytes = [UInt8](repeating: 0, count: 16)
        var wait = timespec(tv_sec: 5, tv_nsec: 0)
        if gethostuuid(&bytes, &wait) == 0 {
            return NSUUID(uuidBytes: bytes).uuidString
        }
        // Фолбэк: единожды сгенерированный и сохранённый UUID.
        let key = "cloudvpn.hwid.fallback"
        if let s = UserDefaults.standard.string(forKey: key) { return s }
        let s = UUID().uuidString
        UserDefaults.standard.set(s, forKey: key)
        return s
    }()

    /// Модель Mac (напр. "MacBookPro18,3") — Remnawave кладёт в подпись устройства.
    static let model: String = {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return "Mac" }
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &buf, &size, nil, 0)
        return String(cString: buf)
    }()

    /// Версия macOS ("14.5.1").
    static let osVersion: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }()
}
