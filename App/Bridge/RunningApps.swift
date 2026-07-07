import AppKit

/// Список запущенных приложений с видимым UI — для пикера split-tunneling.
/// Формат элементов тот же, что у C#-хоста: {name, binary, icon?} — binary
/// уходит в mihomo-правило PROCESS-NAME.
@MainActor
enum RunningApps {
    static func listJSON() -> String {
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { app -> [String: String]? in
                guard let binary = app.executableURL?.lastPathComponent,
                      binary != "CloudVPN" else { return nil }
                var entry: [String: String] = [
                    "name": app.localizedName ?? binary,
                    "binary": binary,
                ]
                if let icon = app.icon, let dataURL = pngDataURL(icon, side: 32) {
                    entry["icon"] = dataURL
                }
                return entry
            }
            .sorted { ($0["name"] ?? "").localizedCaseInsensitiveCompare($1["name"] ?? "") == .orderedAscending }
        guard let data = try? JSONSerialization.data(withJSONObject: apps),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    private static func pngDataURL(_ image: NSImage, side: CGFloat) -> String? {
        let target = NSImage(size: NSSize(width: side, height: side))
        target.lockFocus()
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side),
                   from: .zero, operation: .sourceOver, fraction: 1)
        target.unlockFocus()
        guard let tiff = target.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}
