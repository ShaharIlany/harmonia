// Outlines the wordmark from Poppins (Google Fonts, SIL Open Font License) into SVG path data, so the logo files need
// no font. Needs Poppins installed (fonts.google.com/specimen/Poppins). make-brand.py reads the output.
// Usage: swift outline-wordmark.swift [Poppins-Medium] > wordmark-poppins.json
import CoreText
import Foundation

let fontName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Poppins-Medium"
let text = "Harmonia"
let capHeight: CGFloat = 106  // on the 256-high canvas
let baseline: CGFloat = 180

let probe = CTFontCreateWithName(fontName as CFString, 1000, nil)
guard (CTFontCopyPostScriptName(probe) as String) == fontName else {
  FileHandle.standardError.write("\(fontName) isn't installed\n".data(using: .utf8)!)
  exit(1)
}
let size = 1000 * capHeight / CTFontGetCapHeight(probe)
let font = CTFontCreateWithName(fontName as CFString, size, nil)
let line = CTLineCreateWithAttributedString(
  NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font]))

func n(_ v: CGFloat) -> String { String(format: "%.2f", v).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression) }
var d = ""
var minX = CGFloat.infinity, maxX = -CGFloat.infinity
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let count = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: count)
  var positions = [CGPoint](repeating: .zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
  for (g, p) in zip(glyphs, positions) {
    // Font space is y up; SVG is y down from the baseline.
    var t = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: p.x, ty: baseline)
    guard let path = CTFontCreatePathForGlyph(font, g, &t) else { continue }
    let box = path.boundingBoxOfPath
    minX = min(minX, box.minX); maxX = max(maxX, box.maxX)
    path.applyWithBlock { el in
      let e = el.pointee, pts = e.points
      switch e.type {
      case .moveToPoint: d += "M\(n(pts[0].x)) \(n(pts[0].y))"
      case .addLineToPoint: d += "L\(n(pts[0].x)) \(n(pts[0].y))"
      case .addQuadCurveToPoint: d += "Q\(n(pts[0].x)) \(n(pts[0].y)) \(n(pts[1].x)) \(n(pts[1].y))"
      case .addCurveToPoint: d += "C\(n(pts[0].x)) \(n(pts[0].y)) \(n(pts[1].x)) \(n(pts[1].y)) \(n(pts[2].x)) \(n(pts[2].y))"
      case .closeSubpath: d += "Z"
      @unknown default: break
      }
    }
  }
}
let out: [String: Any] = ["font": fontName, "text": text, "d": d, "left": minX, "right": maxX, "capHeight": capHeight, "baseline": baseline]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
