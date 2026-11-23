// harmonia-transcribe: a voice message as text, with macOS's own on-device dictation (Speech's DictationTranscriber,
// macOS 26 and later). Nothing leaves the Mac and nothing asks for permission. The first time a language is used, macOS
// downloads its dictation model (a few hundred MB, once).
//
//   harmonia-transcribe <audio file> [language …]
//
// The languages are BCP 47 tags ("he-IL", "en-US"); without any, the Mac's preferred languages. With more than one, the
// audio is transcribed in each and the one the recognizer is surest of wins, so a Hebrew voice note on a Mac set to
// English and Hebrew comes out in Hebrew. Prints one line of JSON: {"text": "…", "language": "he-IL", "confidence": 64}
// (percent), or
// {"error": "…", "code": "…"} and exits 1. Code "unreadable": AVFoundation can't open the file (a WebM or Ogg voice
// note); convert it to WAV and try again.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String, _ code: String) -> Never {
  emit(["error": message, "code": code])
  exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let path = args.first else { fail("usage: harmonia-transcribe <audio file> [language …]", "usage") }

@available(macOS 26.0, *)
func languages(_ asked: [String]) async -> [Locale] {
  var out: [Locale] = []
  for tag in asked.isEmpty ? Locale.preferredLanguages : asked {
    guard let l = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: tag)) else { continue }
    // One try per language: "en-IL" and "en-US" are both English.
    if out.contains(where: { $0.language.languageCode == l.language.languageCode }) { continue }
    out.append(l)
    if out.count == 3 { break }
  }
  return out
}

/// The audio in one language: its text and how sure the recognizer was (0–1, averaged over the words).
@available(macOS 26.0, *)
func transcribe(_ url: URL, _ locale: Locale) async throws -> (text: String, confidence: Double) {
  let t = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [.transcriptionConfidence])
  if await AssetInventory.status(forModules: [t]) != .installed, let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
    try await req.downloadAndInstall()
  }
  let analyzer = SpeechAnalyzer(modules: [t])
  let file: AVAudioFile
  do { file = try AVAudioFile(forReading: url) } catch { fail("can't read the audio: \(error.localizedDescription)", "unreadable") }
  async let collected: (String, Double, Int) = t.results.reduce(("", 0.0, 0)) { acc, r in
    var (text, sum, n) = acc
    let piece = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
    if !piece.isEmpty { text += (text.isEmpty ? "" : " ") + piece }
    for run in r.text.runs {
      if let c = run.transcriptionConfidence {
        let chars = r.text[run.range].characters.count
        sum += c * Double(chars)
        n += chars
      }
    }
    return (text, sum, n)
  }
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  let (text, sum, n) = try await collected
  // Dictation marks right-to-left text with a leading RLM: the text is plain here.
  let clean = text.replacingOccurrences(of: "\u{200F}", with: "").replacingOccurrences(of: "\u{200E}", with: "")
  return (clean.trimmingCharacters(in: .whitespacesAndNewlines), n > 0 ? sum / Double(n) : 0)
}

guard #available(macOS 26.0, *) else { fail("voice messages need macOS 26 or later", "unsupported") }
let url = URL(fileURLWithPath: path)
guard FileManager.default.isReadableFile(atPath: path) else { fail("no such file: \(path)", "missing") }

let done = DispatchSemaphore(value: 0)
Task {
  let locales = await languages(Array(args.dropFirst()))
  if locales.isEmpty { fail("macOS has no dictation for \(args.count > 1 ? args.dropFirst().joined(separator: ", ") : Locale.preferredLanguages.joined(separator: ", "))", "language") }
  var best: (text: String, confidence: Double, locale: Locale)?
  var lastError: Error?
  for l in locales {
    do {
      let r = try await transcribe(url, l)
      if !r.text.isEmpty, best == nil || r.confidence > best!.confidence { best = (r.text, r.confidence, l) }
    } catch {
      lastError = error
    }
  }
  if let b = best {
    emit(["text": b.text, "language": b.locale.identifier(.bcp47), "confidence": Int((b.confidence * 100).rounded())])
    exit(0)
  }
  if let e = lastError { fail("dictation failed: \(e.localizedDescription)", "failed") }
  fail("no speech in it", "empty")
}
done.wait()
