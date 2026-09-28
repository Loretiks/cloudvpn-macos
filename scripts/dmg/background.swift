// Рисует фон окна установщика (DMG) в двух масштабах: 1x и 2x (Retina).
// Координаты совпадают с раскладкой в dmg-settings.py: окно 640×400,
// значок приложения по центру (170, 205), «Программы» — (470, 205).
//
//   swift scripts/dmg/background.swift <out-dir>
//   → <out-dir>/background.png, background@2x.png
import AppKit

let W: CGFloat = 640, H: CGFloat = 400
let appX: CGFloat = 170, appsX: CGFloat = 470, iconY: CGFloat = 205
let brand = NSColor(srgbRed: 0x3C/255, green: 0x7C/255, blue: 0xFF/255, alpha: 1)
let ink = NSColor(srgbRed: 0x12/255, green: 0x1B/255, blue: 0x33/255, alpha: 1)
let muted = NSColor(srgbRed: 0x5B/255, green: 0x67/255, blue: 0x85/255, alpha: 1)
let faint = NSColor(srgbRed: 0x8C/255, green: 0x96/255, blue: 0xAE/255, alpha: 1)

func render(scale: CGFloat, to url: URL) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    // Рисуем в координатах Finder: начало сверху слева.
    ctx.cgContext.translateBy(x: 0, y: H)
    ctx.cgContext.scaleBy(x: 1, y: -1)

    // Фон: светлый холодный градиент + мягкое сияние бренд-цвета за стрелкой.
    NSGradient(starting: NSColor(srgbRed: 0.975, green: 0.982, blue: 1, alpha: 1),
               ending: NSColor(srgbRed: 0.918, green: 0.941, blue: 1, alpha: 1))!
        .draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: 90)
    // Радиальное сияние гаснет до нуля ДО края — без видимой границы; сплющено по вертикали.
    let glow = NSGradient(colors: [brand.withAlphaComponent(0.11), brand.withAlphaComponent(0)])!
    NSGraphicsContext.saveGraphicsState()
    let squash = NSAffineTransform()
    squash.translateX(by: W/2, yBy: iconY); squash.scaleX(by: 1, yBy: 0.62); squash.concat()
    glow.draw(fromCenter: .zero, radius: 0, toCenter: .zero, radius: 230, options: [])
    NSGraphicsContext.restoreGraphicsState()

    func text(_ s: String, _ font: NSFont, _ color: NSColor, y: CGFloat, kern: CGFloat = 0) {
        let para = NSMutableParagraphStyle(); para.alignment = .center
        let a = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color,
                                                           .paragraphStyle: para, .kern: kern])
        let h = a.size().height
        // Текст рисуем в неперевёрнутой системе, чтобы глифы не отразились.
        NSGraphicsContext.saveGraphicsState()
        let t = NSAffineTransform(); t.translateX(by: 0, yBy: H); t.scaleX(by: 1, yBy: -1); t.concat()
        a.draw(in: NSRect(x: 0, y: H - y - h, width: W, height: h))
        NSGraphicsContext.restoreGraphicsState()
    }
    text("Cloud VPN", .systemFont(ofSize: 24, weight: .semibold), ink, y: 42, kern: -0.3)
    text("Перетащите Cloud VPN в папку «Программы»", .systemFont(ofSize: 13, weight: .regular), muted, y: 76)

    // Стрелка: от правого края значка приложения к «Программам», с лёгким изгибом.
    let x0 = appX + 78, x1 = appsX - 78, y0 = iconY - 6
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: x0, y: y0))
    arrow.curve(to: NSPoint(x: x1, y: y0), controlPoint1: NSPoint(x: x0 + 45, y: y0 - 26),
                controlPoint2: NSPoint(x: x1 - 45, y: y0 - 26))
    arrow.lineWidth = 3; arrow.lineCapStyle = .round
    arrow.setLineDash([0.1, 9], count: 2, phase: 0)
    brand.withAlphaComponent(0.85).setStroke(); arrow.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: x1 - 13, y: y0 - 11))
    head.line(to: NSPoint(x: x1 + 1, y: y0))
    head.line(to: NSPoint(x: x1 - 14, y: y0 + 8))
    head.lineWidth = 3; head.lineCapStyle = .round; head.lineJoinStyle = .round
    brand.setStroke(); head.stroke()

    // Подсказка внизу: приложение не нотаризовано — первый запуск через «Открыть».
    let sep = NSBezierPath(rect: NSRect(x: 120, y: 330, width: W - 240, height: 0.5))
    brand.withAlphaComponent(0.14).setFill(); sep.fill()
    text("Первый запуск: правый клик по Cloud VPN → «Открыть»", .systemFont(ofSize: 11.5, weight: .regular),
         faint, y: 346)

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: url)
}

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
render(scale: 1, to: out.appendingPathComponent("background.png"))
render(scale: 2, to: out.appendingPathComponent("background@2x.png"))
print("✓ background.png, background@2x.png → \(out.path)")
