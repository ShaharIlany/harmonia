// Voice messages: a voice note recorded in Slack, as text the teammates read like a typed message.
//
// The words come from macOS's own on-device dictation (macapp/transcribe.swift, built into the app as
// harmonia-transcribe): nothing leaves the Mac and there's no key to set up. It tries each of the Mac's preferred
// languages (or settings.json's `voiceLanguages`, e.g. ["he-IL", "en-US"]) and keeps the one it's surest of. Dictation
// opens M4A, MP4, Ogg, MP3 and WAV; a WebM voice note goes through ffmpeg first when it's installed (Homebrew), or
// Slack's own MP4 copy of the clip when it has one.
//
// From the repo (`bun server.ts`) the helper is compiled from macapp/transcribe.swift into the data folder the first
// time a voice note comes in, and again when the source changes.
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMPILED, DATA, SETTINGS } from "./paths";

/** What a transcribed message carries (meta.voice): the language it was spoken in, as a BCP 47 tag ("he-IL"). */
export type Voice = { language: string };
export type Heard = { text: string; language: string } | { error: string; code: string };

/** The first run of a language downloads its dictation model, so the wait allows for that. */
const TIMEOUT = 5 * 60_000;
const READABLE = /^audio\/(mp4|x-m4a|m4a|aac|mpeg|mp3|wav|x-wav|wave|aiff|x-aiff|ogg|opus|flac|x-caf)$/i;
const AUDIO_EXT = /\.(m4a|mp4|aac|mp3|wav|aiff?|caf|ogg|oga|opus|webm|weba|flac)$/i;

/** A file that's a voice note: Slack's own audio clip, or any audio file. */
export function isVoice(f: { subtype?: string; media_display_type?: string; mimetype?: string; name?: string }): boolean {
  if (f.subtype === "slack_audio" || f.media_display_type === "audio") return true;
  if (f.subtype === "slack_video" || f.media_display_type === "video") return false;
  return /^audio\//i.test(f.mimetype ?? "") || (!f.mimetype && AUDIO_EXT.test(f.name ?? ""));
}

/** The language's name in English, "Hebrew" for "he-IL". */
export function languageName(tag: string): string {
  const code = tag.split(/[-_]/)[0];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const SOURCE = join(import.meta.dir, "macapp", "transcribe.swift");
const BUILT = join(DATA, "bin", "harmonia-transcribe");
let building: Promise<string> | undefined;

/** The helper: next to the server inside the app, or compiled from the repo's source. */
async function helper(): Promise<string> {
  if (COMPILED) return join(dirname(process.execPath), "harmonia-transcribe");
  const fresh = existsSync(BUILT) && statSync(BUILT).mtimeMs >= statSync(SOURCE).mtimeMs;
  if (fresh) return BUILT;
  building ??= (async () => {
    mkdirSync(dirname(BUILT), { recursive: true });
    const p = Bun.spawn(["xcrun", "swiftc", "-O", "-swift-version", "5", "-o", BUILT, SOURCE, "-framework", "Speech", "-framework", "AVFoundation"], { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`couldn't build the transcriber: ${err.trim().split("\n").find((l) => /error/.test(l)) ?? err.trim().slice(0, 300)}`);
    return BUILT;
  })().finally(() => (building = undefined));
  return building;
}

async function run(cmd: string[]): Promise<{ out: string; err: string; code: number; late: boolean }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let late = false;
  const timer = setTimeout(() => ((late = true), p.kill()), TIMEOUT);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { out, err, code, late };
}

/** ffmpeg, if it's installed. An app opened from the Finder doesn't have Homebrew's folders on its PATH. */
const ffmpeg = () => Bun.which("ffmpeg", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` });

/** The audio as 16 kHz mono WAV in a temporary file, with ffmpeg. Undefined: no ffmpeg, or it couldn't. */
async function toWav(path: string): Promise<string | undefined> {
  const bin = ffmpeg();
  if (!bin) return;
  const out = join(tmpdir(), `harmonia-voice-${crypto.randomUUID()}.wav`);
  const r = await run([bin, "-nostdin", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", out]);
  if (r.code === 0 && existsSync(out)) return out;
  rmSync(out, { force: true });
}

async function listen(path: string): Promise<Heard> {
  const languages: string[] = Array.isArray(SETTINGS.voiceLanguages) ? SETTINGS.voiceLanguages.map(String) : [];
  let bin: string;
  try {
    bin = await helper();
  } catch (e: any) {
    return { error: e.message, code: "helper" };
  }
  if (!existsSync(bin)) return { error: "this build of Harmonia has no transcriber (it needs macOS 26's SDK to build)", code: "helper" };
  const r = await run([bin, path, ...languages]);
  try {
    const j = JSON.parse(r.out.trim().split("\n").pop() || "{}");
    if (typeof j.text === "string" && j.text.trim()) return { text: j.text.trim(), language: String(j.language || "") };
    if (j.error) return { error: String(j.error), code: String(j.code || "failed") };
  } catch {}
  return { error: r.late ? "it took too long" : r.err.trim().slice(0, 200) || `the transcriber stopped (exit ${r.code})`, code: "failed" };
}

/**
 * A voice note's words. `type`: its MIME type. `fallback`: another copy of the same audio dictation can open (Slack's
 * MP4 of a WebM clip), fetched only when needed.
 */
export async function transcribe(path: string, type?: string, fallback?: () => Promise<string | undefined>): Promise<Heard> {
  const first = type && !READABLE.test(type) && /webm/i.test(type) ? ({ error: "WebM", code: "unreadable" } as Heard) : await listen(path);
  if (!("code" in first) || first.code !== "unreadable") return first;
  const wav = await toWav(path);
  if (wav) {
    try {
      return await listen(wav);
    } finally {
      rmSync(wav, { force: true });
    }
  }
  const other = await fallback?.().catch(() => undefined);
  if (other) {
    try {
      return await listen(other);
    } finally {
      rmSync(other, { force: true });
    }
  }
  return { error: `macOS can't open this kind of audio${type ? ` (${type})` : ""}, and ffmpeg isn't installed to convert it (brew install ffmpeg)`, code: "unreadable" };
}
