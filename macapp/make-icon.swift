// Draws the app icon (1024×1024 PNG): the Team Chat mark ("Table": your message bubble in the middle, the six
// teammates around it) on a warm-ink macOS rounded square. Same geometry as docs/brand/app-icon.svg
// (docs/brand/make-brand.py); keep the two in step.
// Usage: swift make-icon.swift out.png [--small]   (--small: the 16 and 32 px cut, bigger dots on a fuller tile)
import AppKit

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : "icon-1024.png"
let small = args.contains("--small")
let size: CGFloat = 1024

func rgb(_ hex: UInt32) -> NSColor {
  NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}
func point(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ deg: CGFloat) -> NSPoint {
  let a = deg * .pi / 180
  return NSPoint(x: cx + r * cos(a), y: cy + r * sin(a))
}

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
// Work in SVG coordinates (y down), like the masters.
ctx.translateBy(x: 0, y: size)
ctx.scaleBy(x: 1, y: -1)

// The tile: the macOS icon grid (824 square inset 100, radius 185); the small cut fills more (inset 40, radius 220).
let inset: CGFloat = small ? 40 : 100
let radius: CGFloat = small ? 220 : 185
let tile = NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset), xRadius: radius, yRadius: radius)
NSGraphicsContext.current?.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(small ? 0 : 0.3)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: 10)  // flipped context: positive y is down
shadow.set()
rgb(0x2A211E).setFill()
tile.fill()
NSGraphicsContext.current?.restoreGraphicsState()
NSGraphicsContext.current?.saveGraphicsState()
tile.addClip()
NSGradient(colors: [rgb(0x3A2D28), rgb(0x211A17)])!.draw(in: tile.bounds, angle: 90)  // flipped: 90° runs top to bottom
NSGraphicsContext.current?.restoreGraphicsState()

// The mark on its 256 canvas, centred at (512, 512).
let scale: CGFloat = small ? 3.0 : 2.2
let (bubbleR, dotR, ring): (CGFloat, CGFloat, CGFloat) = small ? (56, 27, 98) : (50, 21, 100)
let c: CGFloat = 512

// Bubble: a circle whose tail leaves it at 125° ± 24° and meets at 1.76 r, 4° further round.
let br = bubbleR * scale
let bubble = NSBezierPath()
bubble.move(to: point(c, c, br, 149))
bubble.line(to: point(c, c, br * 1.76, 129))
bubble.line(to: point(c, c, br, 101))
bubble.appendArc(withCenter: NSPoint(x: c, y: c), radius: br, startAngle: 101, endAngle: 149, clockwise: true)
bubble.close()
rgb(0xE0583A).setFill()
bubble.fill()

// The six teammates, clockwise from the top (same colours as docs/brand/mark.svg).
let dots: [(CGFloat, UInt32)] = [(-90, 0xEAB308), (-30, 0x22C55E), (30, 0x06B6D4), (90, 0x3B82F6), (150, 0xA855F7), (210, 0xEF4444)]
for (deg, hex) in dots {
  let p = point(c, c, ring * scale, deg)
  let r = dotR * scale
  rgb(hex).setFill()
  NSBezierPath(ovalIn: NSRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)).fill()
}

image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
