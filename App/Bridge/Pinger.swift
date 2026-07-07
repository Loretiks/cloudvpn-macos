import Foundation

/// ICMP-пинг через системный /sbin/ping (не требует прав и raw-сокетов).
/// Возвращает миллисекунды или nil, если хост не ответил.
enum Pinger {
    static func ping(host: String, timeoutSeconds: Int = 4) async -> Int? {
        // только hostname/IP — никакой возможности внедрить флаги
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:")
        guard !host.isEmpty, host.unicodeScalars.allSatisfy(allowed.contains) else { return nil }

        return await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/sbin/ping")
                p.arguments = ["-c", "1", "-t", String(timeoutSeconds), host]
                let pipe = Pipe()
                p.standardOutput = pipe
                p.standardError = FileHandle.nullDevice
                do {
                    try p.run()
                } catch {
                    cont.resume(returning: nil)
                    return
                }
                p.waitUntilExit()
                guard p.terminationStatus == 0,
                      let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8),
                      let range = out.range(of: #"time=([0-9.]+) ms"#, options: .regularExpression)
                else {
                    cont.resume(returning: nil)
                    return
                }
                let ms = out[range].dropFirst(5).dropLast(3)
                cont.resume(returning: Double(ms).map { max(1, Int($0.rounded())) })
            }
        }
    }
}
