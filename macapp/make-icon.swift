// Draws the app icon (1024×1024 PNG): the Harmonia mark ("Lyre": six strings in the six teammates' colours on a white
// frame) on a graphite macOS rounded square. Same geometry as docs/brand/app-icon.svg
// (docs/brand/make-brand.py); keep the two in step.
// Usage: swift make-icon.swift out.png [--small]   (--small: the 16 and 32 px cut, a heavier mark on a fuller tile)
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
rgb(0x202328).setFill()
tile.fill()
NSGraphicsContext.current?.restoreGraphicsState()
NSGraphicsContext.current?.saveGraphicsState()
tile.addClip()
NSGradient(colors: [rgb(0x2E3036), rgb(0x141518)])!.draw(in: tile.bounds, angle: 90)  // flipped: 90° runs top to bottom
NSGraphicsContext.current?.restoreGraphicsState()

// The mark ("Lyre", docs/brand/make-brand.py) on its 256 canvas, scaled about the centre (512, 512).
let scale: CGFloat = small ? 3.5 : 2.9
let off: CGFloat = 512 - 128 * scale
func P(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: off + x * scale, y: off + y * scale) }
// The small cut: a heavier frame, wider strings with smaller gaps.
let (frameW, stringW, x0, x1): (CGFloat, CGFloat, CGFloat, CGFloat) = small ? (24, 9, 89, 167) : (16, 5, 94, 162)
let yokeY: CGFloat = 84, boxX: CGFloat = 58, boxY: CGFloat = 194, boxH: CGFloat = 20
let frameColor = NSColor.white

// Six strings, one per starter teammate, left to right: Dali, Leo, Elliot, Sherlock, Murphy, Emily.
let team: [UInt32] = [0xEAB308, 0x3B82F6, 0x22C55E, 0xA855F7, 0xEF4444, 0x06B6D4]
for (k, hex) in team.enumerated() {
  let x = x0 + CGFloat(k) * (x1 - x0) / 5
  let r = NSRect(x: off + (x - stringW / 2) * scale, y: off + yokeY * scale, width: stringW * scale, height: (boxY - yokeY + 2) * scale)
  rgb(hex).setFill()
  NSBezierPath(roundedRect: r, xRadius: stringW * scale / 2, yRadius: stringW * scale / 2).fill()
}

// The frame: two horn arms (the right one mirrors the left), the yoke across them, and the sound box.
let frame = NSBezierPath()
for side: CGFloat in [1, -1] {
  func Q(_ x: CGFloat, _ y: CGFloat) -> NSPoint { P(side == 1 ? x : 256 - x, y) }
  frame.move(to: Q(80, 196))
  frame.curve(to: Q(66, 84), controlPoint1: Q(62, 164), controlPoint2: Q(56, 120))
  frame.curve(to: Q(50, 42), controlPoint1: Q(72, 64), controlPoint2: Q(64, 48))
}
frame.move(to: P(54, yokeY))
frame.line(to: P(202, yokeY))
frame.lineWidth = frameW * scale
frame.lineCapStyle = .round
frame.lineJoinStyle = .round
frameColor.setStroke()
frame.stroke()
frameColor.setFill()
let box = NSRect(x: off + boxX * scale, y: off + boxY * scale, width: (256 - 2 * boxX) * scale, height: boxH * scale)
NSBezierPath(roundedRect: box, xRadius: boxH * scale / 2, yRadius: boxH * scale / 2).fill()

image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
