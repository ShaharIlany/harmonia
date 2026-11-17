// Draws the app icon (1024×1024 PNG): a speech bubble on the sidebar's aubergine, in a macOS rounded square.
// Usage: swift make-icon.swift out.png
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// The macOS icon grid: an 824-point rounded square, centred.
let inset: CGFloat = 100
let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let shape = NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185)
NSGraphicsContext.current?.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
NSGradient(colors: [NSColor(srgbRed: 0.33, green: 0.20, blue: 0.40, alpha: 1), NSColor(srgbRed: 0.17, green: 0.12, blue: 0.20, alpha: 1)])!
  .draw(in: shape, angle: -90)
NSGraphicsContext.current?.restoreGraphicsState()

// The six teammates' colours as a thin band along the bottom edge.
let colors: [(CGFloat, CGFloat, CGFloat)] = [
  (0.92, 0.70, 0.03), (0.23, 0.51, 0.96), (0.13, 0.77, 0.37), (0.66, 0.33, 0.97), (0.94, 0.27, 0.27), (0.02, 0.71, 0.83),
]
NSGraphicsContext.current?.saveGraphicsState()
shape.addClip()
let band = rect.width / CGFloat(colors.count)
for (i, c) in colors.enumerated() {
  NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1).setFill()
  NSRect(x: rect.minX + CGFloat(i) * band, y: rect.minY, width: band + 1, height: 56).fill()
}
NSGraphicsContext.current?.restoreGraphicsState()

let emoji = "💬" as NSString
let font = NSFont.systemFont(ofSize: 470)
let attrs: [NSAttributedString.Key: Any] = [.font: font]
let textSize = emoji.size(withAttributes: attrs)
emoji.draw(at: NSPoint(x: (size - textSize.width) / 2, y: (size - textSize.height) / 2 + 30), withAttributes: attrs)

image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
