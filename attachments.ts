// Files attached to messages: dropped, pasted or picked in the app, or attached in a linked Slack conversation.
//
// Each file is copied into the data folder, `attachments/<channel id>/<file id>/<its name>`, where every teammate can
// read it (it's outside the folders the sandbox blocks, unlike ~/Downloads or ~/Desktop where it may have come from).
// The message keeps a short record of it (meta.files), and the teammates read the message with the file's path under
// it, so they can open it with Read (images and PDFs too) or hand the path to a job.
//
// A file uploaded from the app waits here (staged) until its message is sent. One that never was, because you took it
// off or closed the window, is deleted the next time the server starts.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { DATA } from "./paths";
import type { Message } from "./store";

export type Attachment = {
  id: string; // its folder under the channel's: 12 hex characters
  name: string; // the file's name, made safe for the disk
  type: string; // its MIME type
  size: number; // bytes
  slack?: string; // the same file in Slack (F…), when it came from there or went there
};

export const ATTACH_DIR = join(DATA, "attachments");
/** The largest file you can attach: 100 MB (Bun takes request bodies up to 128 MB). */
export const MAX_FILE = 100 * 1024 * 1024;
/** Files on one message, as in Slack. */
export const MAX_FILES = 10;
const STAGED_KEPT_MS = 24 * 3600_000;

const ID = /^[0-9a-f]{12}$/;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/** Where an attachment's file is. */
export const attachmentPath = (channelId: string, a: Pick<Attachment, "id" | "name">) => join(ATTACH_DIR, channelId, a.id, a.name);

/** A name that's safe as one path segment: no slashes, control characters or leading dots, at most 120 characters. */
export function safeName(name: string): string {
  let n = String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  if (n.length > 120) {
    const ext = extname(n).slice(0, 16);
    n = n.slice(0, 120 - ext.length).trim() + ext;
  }
  return n || "file";
}

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", log: "text/plain",
  json: "application/json", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", html: "text/html", htm: "text/html",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  key: "application/vnd.apple.keynote", pages: "application/vnd.apple.pages", numbers: "application/vnd.apple.numbers",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** The file's MIME type: the one given when it looks like one, else from its extension. */
export function fileType(name: string, given?: string): string {
  const g = String(given ?? "").trim().toLowerCase().split(";")[0];
  if (/^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(g) && g !== "application/octet-stream") return g;
  return TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** 1.2 MB, 340 KB, 12 bytes. */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Saves a file for a channel and returns its record. `data` is the file itself, or a Response whose body is (a
 * download, or the page's upload): it's streamed to disk. Fails past MAX_FILE.
 */
export async function saveAttachment(channelId: string, name: string, type: string | undefined, data: Blob | Response | Uint8Array): Promise<Attachment> {
  const a = { id: newId(), name: safeName(name) };
  const dir = join(ATTACH_DIR, channelId, a.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, a.name);
  try {
    const size = data instanceof Response ? await Bun.write(path, data) : await Bun.write(path, new Blob([data]));
    if (size > MAX_FILE) throw new Error(`it's over ${fileSize(MAX_FILE)}`);
    return { ...a, type: fileType(a.name, type), size };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// ---------- Staged: uploaded from the page, not sent yet ----------

const staged = new Map<string, { channelId: string; file: Attachment; at: number }>();

export function stage(channelId: string, file: Attachment) {
  staged.set(file.id, { channelId, file, at: Date.now() });
  for (const [id, s] of staged) if (Date.now() - s.at > STAGED_KEPT_MS) staged.delete(id);
}

/** The staged files with these ids, for a message in this channel. A string when one isn't there. */
export function takeStaged(channelId: string, ids: unknown): Attachment[] | string {
  if (!Array.isArray(ids) || !ids.length) return [];
  if (ids.length > MAX_FILES) return `Up to ${MAX_FILES} files on one message.`;
  const files: Attachment[] = [];
  for (const id of ids) {
    const s = typeof id === "string" ? staged.get(id) : undefined;
    if (!s || s.channelId !== channelId || !existsSync(attachmentPath(channelId, s.file))) return "An attached file is gone. Attach it again.";
    files.push(s.file);
  }
  for (const f of files) staged.delete(f.id);
  return files;
}

/** A file of this channel by id: on one of its messages, or staged for one. */
export function findAttachment(channelId: string, list: Message[], id: string): Attachment | undefined {
  if (!ID.test(id)) return;
  const s = staged.get(id);
  if (s?.channelId === channelId) return s.file;
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i].meta?.files?.find((x) => x.id === id);
    if (f) return f;
  }
}

/**
 * At start: files uploaded for a message that was never sent (anything not on a message, older than an hour, so a
 * page that's still open can send what it just uploaded).
 */
export function dropUnsent(all: Map<string, Message[]>) {
  if (!existsSync(ATTACH_DIR)) return;
  let dropped = 0;
  for (const channelId of readdirSync(ATTACH_DIR)) {
    const dir = join(ATTACH_DIR, channelId);
    const used = new Set((all.get(channelId) ?? []).flatMap((m) => m.meta?.files?.map((f) => f.id) ?? []));
    try {
      for (const id of readdirSync(dir)) {
        const sub = join(dir, id);
        if (used.has(id) || Date.now() - statSync(sub).mtimeMs < 3600_000) continue;
        rmSync(sub, { recursive: true, force: true });
        dropped++;
      }
    } catch {}
  }
  if (dropped) console.log(`Deleted ${dropped} attachment${dropped === 1 ? "" : "s"} that never went out`);
}

/** How a teammate reads a message's files: one line each, under the message, with the path to open. */
export function filesLines(channelId: string, files: Attachment[] | undefined): string {
  return (files ?? []).map((f) => `\n  attached file: ${attachmentPath(channelId, f)} (${f.type}, ${fileSize(f.size)})`).join("");
}

/** A file can be shown in the page as it is (a picture), rather than handed over to open. */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|bmp|avif)$/;
