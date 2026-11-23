// Draws the app icon (1024×1024 PNG): the Harmonia lyre (white, six strings red to violet, a soft halo) on a navy
// macOS rounded square with faint clouds toward the edges. The same drawing as docs/brand/app-icon.svg, from the numbers
// in docs/brand/make-brand.py; keep the two in step. The clouds are noise made here, so their shapes differ from the SVG's.
// Usage: swift make-icon.swift out.png [--small]   (--small: the 16 and 32 px cut, a heavier flat lyre on a fuller tile)
import AppKit
import CoreImage

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : "icon-1024.png"
let small = args.contains("--small")
let N = 1024
let size = CGFloat(N)
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: sRGB, components: [CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, a])!
}
func gradient(_ stops: [(CGFloat, UInt32)]) -> CGGradient {
  CGGradient(colorsSpace: sRGB, colors: stops.map { rgb($0.1) } as CFArray, locations: stops.map { $0.0 })!
}

/// A transparent 1024 bitmap drawn in SVG coordinates (y down).
func canvas() -> CGContext {
  let c = CGContext(data: nil, width: N, height: N, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  c.translateBy(x: 0, y: size)
  c.scaleBy(x: 1, y: -1)
  return c
}
/// Draws an image made with canvas() back in, upright.
func put(_ image: CGImage, on c: CGContext) {
  c.saveGState()
  c.translateBy(x: 0, y: size)
  c.scaleBy(x: 1, y: -1)
  c.interpolationQuality = .high
  c.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
  c.restoreGState()
}
// No colour management in Core Image: every layer blurred here is one colour, and the mask's greys are used as they are,
// as an SVG luminance mask uses them.
let ci = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
func render(_ image: CIImage) -> CGImage {
  ci.createCGImage(image, from: CGRect(x: 0, y: 0, width: size, height: size), format: .RGBA8, colorSpace: sRGB)!
}
func blur(_ image: CGImage, _ sigma: CGFloat, clamp: Bool = false) -> CIImage {
  let input = CIImage(cgImage: image)
  return (clamp ? input.clampedToExtent() : input).applyingGaussianBlur(sigma: Double(sigma)).cropped(to: input.extent)
}

// The lyre (docs/brand/make-brand.py) on its 256 canvas: the left half of the outline, from the point at the bottom up
// the outside, round the beak and the knob of the horn, down the inside of the arm and along the top of the sound box
// to the middle. [control 1, control 2, end] per curve; the right half mirrors it about x = 128.
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
let start = p(128, 218.04)
let left: [[CGPoint]] = [
  [p(119.28, 203.98), p(106.88, 202.71), p(93.64, 198.11)],
  [p(68.74, 189.47), p(43.18, 168.62), p(43.18, 140.38)],
  [p(43.18, 122.29), p(50.66, 111.54), p(59.2, 98.87)],
  [p(64.61, 90.83), p(70.31, 82.81), p(70.31, 72.71)],
  [p(70.31, 61.52), p(63.76, 54.89), p(53.17, 54.89)],
  [p(49.36, 54.89), p(46.84, 55.4), p(42.33, 57.88)],
  [p(42.17, 57.22), p(41.18, 56.78), p(41.18, 53.52)],
  [p(41.18, 42.53), p(50.65, 38.6), p(60.15, 38.6)],
  [p(76.97, 38.6), p(87.66, 50.4), p(87.66, 68.52)],
  [p(87.66, 79.42), p(83.17, 90.6), p(78.51, 100.27)],
  [p(73.93, 109.75), p(67.4, 122.72), p(67.4, 133.41)],
  [p(67.4, 165.99), p(104.8, 181.5), p(128.0, 186.88)],
]
typealias Curve = (CGPoint, CGPoint, CGPoint, CGPoint)
func curves(_ first: Int, _ last: Int) -> [Curve] {
  var out: [Curve] = [], at = start
  for (k, c) in left.enumerated() {
    if k >= first && k < last { out.append((at, c[0], c[1], c[2])) }
    at = c[2]
  }
  return out
}
func mirrored(_ cs: [Curve]) -> [Curve] {
  func m(_ q: CGPoint) -> CGPoint { p(256 - q.x, q.y) }
  return cs.reversed().map { (m($0.3), m($0.2), m($0.1), m($0.0)) }
}
func path(_ cs: [Curve], _ t: CGAffineTransform) -> CGPath {
  let out = CGMutablePath()
  out.move(to: cs[0].0, transform: t)
  for c in cs { out.addCurve(to: c.3, control1: c.1, control2: c.2, transform: t) }
  out.closeSubpath()
  return out
}
// The strings fan out from a point far above the lyre; they run from y 65 down under the sound box.
func stringX(_ k: Int, _ y: CGFloat, _ spread: CGFloat) -> CGFloat { 128 + (CGFloat(k) - 2.5) * (12.9 + 0.0335 * (y - 128)) * spread }
let (y0, y1): (CGFloat, CGFloat) = (65, 189)
let flatStrings: [UInt32] = [0xF25165, 0xF28E2E, 0xF5CA40, 0x48DABF, 0x4298EF, 0x8968F7]  // red to violet
// Shaded strings: deeper at the top, brightest in the middle, darker where they meet the box.
let fadeY: [CGFloat] = [63.5, 119.3, 154.2, 178.6]
let fades: [[UInt32]] = [
  [0xEF506A, 0xF76C63, 0xF06E68, 0xE87A74],
  [0xF2772F, 0xF8A639, 0xF0A43C, 0xDC9240],
  [0xF1C641, 0xF8D04D, 0xF2C848, 0xD9B243],
  [0x41D7BB, 0x4DDDC4, 0x3BC0C2, 0x2E9FBB],
  [0x438CEC, 0x42ACF6, 0x3F9CEE, 0x3A82D6],
  [0x8963F4, 0x8E75F7, 0x8F70EF, 0x765FD9],
]
let body = gradient([(0, 0xFBF8F1), (0.4, 0xF7F3EF), (0.72, 0xECE9EB), (1, 0xE4E2E8)])  // warm white to cool grey
let sky = gradient([(0, 0x161D38), (0.5, 0x171E39), (0.8, 0x1F2640), (1, 0x2B3148)])     // navy, lighter at the edges

// The tile: the macOS icon grid (824 square inset 100, radius 185) with the lyre at scale 2.6; the small cut fills more
// (inset 40, radius 220) with the flat lyre at scale 3.5, and leaves out the clouds and the halo.
let inset: CGFloat = small ? 40 : 100
let radius: CGFloat = small ? 220 : 185
let scale: CGFloat = small ? 3.5 : 2.6
let off = 512 - 128 * scale
let t = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: off, ty: off)
func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { p(off + x * scale, off + y * scale) }
let lyre = path(curves(0, 12) + mirrored(curves(0, 12)), t)
let insideU = path(curves(8, 12) + mirrored(curves(8, 12)), t)  // closed across the tops of the knobs

let ctx = canvas()
let tile = CGPath(roundedRect: CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset),
                  cornerWidth: radius, cornerHeight: radius, transform: nil)
if !small {  // a soft shadow under the tile
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x000000, 0.3))
  ctx.addPath(tile)
  ctx.setFillColor(rgb(0x161D38))
  ctx.fillPath()
  ctx.restoreGState()
}
ctx.addPath(tile)
ctx.clip()
ctx.drawRadialGradient(sky, startCenter: p(512, 512), startRadius: 0, endCenter: p(512, 512),
                       endRadius: (size - 2 * inset) / 2 * 1.414, options: [.drawsAfterEndLocation])

if !small {
  // Clouds: five octaves of value noise, shown where they're above the middle, mostly toward the edges.
  let cw = 512, step = 1024.0 / Double(cw), freq = 0.0055
  func lattice(_ x: Int, _ y: Int, _ o: Int) -> Double {
    var h = UInt32(truncatingIfNeeded: x &* 374_761_393 &+ y &* 668_265_263 &+ o &* 2_147_483_647 &+ 31)
    h = (h ^ (h >> 13)) &* 1_274_126_177
    return Double(h ^ (h >> 16)) / Double(UInt32.max)
  }
  func noise(_ x: Double, _ y: Double, _ o: Int) -> Double {
    let xf = floor(x), yf = floor(y), xi = Int(xf), yi = Int(yf)
    let u = (x - xf) * (x - xf) * (3 - 2 * (x - xf)), v = (y - yf) * (y - yf) * (3 - 2 * (y - yf))
    let a = lattice(xi, yi, o), b = lattice(xi + 1, yi, o), c = lattice(xi, yi + 1, o), d = lattice(xi + 1, yi + 1, o)
    let top = a + (b - a) * u, bottom = c + (d - c) * u
    return top + (bottom - top) * v
  }
  let r = Double(size - 2 * inset) / 2 * 1.414
  func edge(_ d: Double) -> Double {  // the SVG's radial mask: .1 at 40% out, .5 at 75%, 1 at the corner
    let s = d / r
    if s <= 0.4 { return 0.1 }
    if s <= 0.75 { return 0.1 + (s - 0.4) / 0.35 * 0.4 }
    return min(1, 0.5 + (s - 0.75) / 0.25 * 0.5)
  }
  var px = [UInt8](repeating: 0, count: cw * cw * 4)
  for j in 0..<cw {
    for i in 0..<cw {
      let x = (Double(i) + 0.5) * step, y = (Double(j) + 0.5) * step
      var n = 0.0, amp = 1.0, sum = 0.0, f = freq
      for o in 0..<5 { n += noise(x * f, y * f, o) * amp; sum += amp; amp *= 0.5; f *= 2 }
      n /= sum
      let a = max(0, min(1, 2.6 * n - 1.12)) * edge(hypot(x - 512, y - 512)) * 0.3
      let k = (j * cw + i) * 4
      px[k] = UInt8(0.78 * 255 * a); px[k + 1] = UInt8(0.81 * 255 * a); px[k + 2] = UInt8(0.9 * 255 * a); px[k + 3] = UInt8(255 * a)
    }
  }
  let clouds = CGContext(data: &px, width: cw, height: cw, bitsPerComponent: 8, bytesPerRow: cw * 4, space: sRGB,
                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
  put(clouds, on: ctx)

  // The halo: a soft light band round the lyre, fainter inside the U, with a darker gap right at the lyre's edge.
  let band = canvas()
  band.addPath(lyre)
  band.setLineWidth(51 * scale)
  band.setLineJoin(.round)
  band.setStrokeColor(rgb(0x4A5472, 0.62))
  band.strokePath()
  let mask = canvas()
  mask.setFillColor(rgb(0xFFFFFF))
  mask.fill(CGRect(x: 0, y: 0, width: size, height: size))
  mask.addPath(insideU)
  mask.setFillColor(rgb(0x000000, 0.6))
  mask.fillPath()
  let halo = blur(band.makeImage()!, 9.4 * scale).applyingFilter("CIBlendWithMask", parameters: [
    kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: blur(mask.makeImage()!, 6 * scale, clamp: true)])
  put(render(halo), on: ctx)
  let gap = canvas()
  gap.addPath(lyre)
  gap.setLineWidth(15.4 * scale)
  gap.setLineJoin(.round)
  gap.setStrokeColor(rgb(0x161D38, 0.7))
  gap.strokePath()
  put(render(blur(gap.makeImage()!, 3.9 * scale)), on: ctx)
}

// The strings, then the lyre over their ends.
let spread: CGFloat = small ? 1.15 : 1
for k in 0..<6 {
  ctx.saveGState()
  ctx.move(to: at(stringX(k, y0, spread), y0))
  ctx.addLine(to: at(stringX(k, y1, spread), y1))
  ctx.setLineWidth((small ? 9 : 5.2) * scale)
  ctx.setLineCap(.round)
  if small {
    ctx.setStrokeColor(rgb(flatStrings[k]))
    ctx.strokePath()
  } else {
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    ctx.drawLinearGradient(gradient(zip(fadeY, fades[k]).map { (($0 - fadeY[0]) / (fadeY[3] - fadeY[0]), $1) }),
                           start: at(0, fadeY[0]), end: at(0, fadeY[3]), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }
  ctx.restoreGState()
}
ctx.saveGState()
ctx.addPath(lyre)
if small {  // the small cut: flat white, thickened by a 6-unit stroke
  ctx.setFillColor(rgb(0xFFFFFF))
  ctx.setStrokeColor(rgb(0xFFFFFF))
  ctx.setLineWidth(6 * scale)
  ctx.setLineJoin(.round)
  ctx.drawPath(using: .fillStroke)
} else {
  ctx.clip()
  ctx.drawLinearGradient(body, start: at(0, 38.6), end: at(0, 218), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}
ctx.restoreGState()

let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
