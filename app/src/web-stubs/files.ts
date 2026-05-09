// Web counterparts to the Tauri file commands. Uploads use the registered
// File object from dialog.ts; downloads materialise as Blob URLs and trigger
// <a download>; thumbnails/previews return Blob URLs cached by message id.
//
// Streaming (cmd_get_stream_info) is intentionally omitted — running an
// HTTP server isn't possible in a PWA and a Service-Worker-backed range
// pipeline is its own milestone.

import { Api } from "telegram";
import bigInt from "big-integer";
import { ensureClient } from "./client";
import { emitWebEvent } from "./event";
import { mapMessageToFile } from "./folders";

type UploadResult = ReturnType<typeof mapMessageToFile>;

// Cap concurrent network reads (downloadMedia / iterDownload) to avoid
// triggering Telegram's per-DC FLOOD_WAIT when a freshly painted file grid
// fires 30+ thumbnail requests at once. Mirrors the Rust
// THUMB_DOWNLOAD_SEMAPHORE pattern but applies to all reads, not just thumbs.
class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

const readSem = new Semaphore(4);

// Active transfer tracking — used to propagate cancellation from the React
// queue UI down into our own loops. gramjs's high-level downloadMedia/sendFile
// don't expose abort tokens, but we can drop progress events and skip
// follow-on work after a cancel signal arrives.
const cancelledTransfers = new Set<string>();
export function cancelTransfer(transferId: string): void {
  cancelledTransfers.add(transferId);
}
function isCancelled(id: string): boolean {
  return cancelledTransfers.has(id);
}
function clearCancellation(id: string): void {
  cancelledTransfers.delete(id);
}

// --- File registry: dialog.open -> upload --------------------------------

const fileRegistry = new Map<string, File>();
let nextFileId = 1;

export function registerFile(file: File): string {
  const token = `web-file:${nextFileId++}`;
  fileRegistry.set(token, file);
  return token;
}

function takeRegisteredFile(token: string): File | undefined {
  const f = fileRegistry.get(token);
  fileRegistry.delete(token);
  return f;
}

// --- Upload --------------------------------------------------------------

export async function uploadFile(
  pathOrToken: string,
  folderId: number | null,
  transferId: string,
): Promise<UploadResult> {
  const file = takeRegisteredFile(pathOrToken);
  if (!file) {
    throw new Error("No registered file for upload — did the picker run?");
  }
  clearCancellation(transferId);
  const c = await ensureClient();
  // null = Saved Messages, gramjs's "me" sentinel resolves to self.
  const entity = folderId == null ? "me" : await c.getInputEntity(bigInt(folderId));
  try {
    const sent = await c.sendFile(entity, {
      file,
      forceDocument: true,
      progressCallback: (p) => {
        // Throwing inside the progress callback bubbles up from sendFile
        // and stops further chunk uploads. Telegram's CDN garbage-collects
        // partial uploads automatically; nothing leaks server-side.
        if (isCancelled(transferId)) throw new Error("Cancelled");
        const pct = typeof p === "number"
          ? Math.max(0, Math.min(100, Math.floor(p * 100)))
          : 0;
        emitWebEvent("upload-progress", { id: transferId, percent: pct });
      },
    });
    emitWebEvent("upload-progress", { id: transferId, percent: 100 });

    // Optimistic insert: build FileMetadata immediately so the frontend
    // doesn't have to wait on Telegram's GetHistory replication lag. Try
    // the message-derived metadata first (canonical mime from Telegram),
    // then fall back to local file info if the returned Message's media
    // attribute didn't surface cleanly — gramjs occasionally returns a
    // Message without the media field resolved when Telegram's SendMedia
    // response is missing the full updates payload.
    if (sent && sent instanceof Api.Message) {
      const fromMsg = mapMessageToFile(
        sent as unknown as { id: number; date: number; media?: unknown },
        folderId,
      );
      if (fromMsg) return fromMsg;
      const sentMsg = sent as unknown as { id: number | bigInt.BigInteger; date: number };
      const dotIdx = file.name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? file.name.slice(dotIdx + 1) : null;
      return {
        id: typeof sentMsg.id === "number" ? sentMsg.id : Number(sentMsg.id),
        folder_id: folderId,
        name: file.name,
        size: file.size,
        mime_type: file.type || null,
        file_ext: ext,
        created_at: new Date(Number(sentMsg.date) * 1000).toISOString(),
        icon_type: "file",
      };
    }
    return null;
  } finally {
    clearCancellation(transferId);
  }
}

// --- Download ------------------------------------------------------------

export async function downloadFile(
  messageId: number,
  savePath: string | null,
  folderId: number | null,
  transferId: string,
): Promise<void> {
  clearCancellation(transferId);
  await readSem.run(async () => {
    const c = await ensureClient();
    const entity = folderId == null ? "me" : await c.getInputEntity(bigInt(folderId));
    const messages = await c.getMessages(entity, { ids: [messageId] });
    const msg = messages[0];
    if (!msg || !msg.media) throw new Error("Message has no media");

    // iterDownload yields chunks under our own loop, so a cancel flips the
    // flag and we break out — no extra bytes are read after that point.
    const chunks: Uint8Array[] = [];
    let total = 0;
    let receivedTotal = 0;
    if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
      total = toFiniteNumber(msg.media.document.size) ?? 0;
    }
    type IterArg = Parameters<typeof c.iterDownload>[0];
    for await (const chunk of c.iterDownload({
      file: msg.media as IterArg["file"],
      requestSize: 64 * 1024,
    })) {
      if (isCancelled(transferId)) {
        clearCancellation(transferId);
        throw new Error("Cancelled");
      }
      chunks.push(chunk as Uint8Array);
      receivedTotal += (chunk as Uint8Array).byteLength;
      if (total > 0) {
        const pct = Math.max(0, Math.min(100, Math.floor((receivedTotal / total) * 100)));
        emitWebEvent("download-progress", { id: transferId, percent: pct });
      }
    }

    const filename = filenameForMessage(msg) ?? lastSegment(savePath) ?? `file-${messageId}`;
    const buffer = concatChunks(chunks);
    triggerBlobDownload(buffer, filename, "application/octet-stream");
    emitWebEvent("download-progress", { id: transferId, percent: 100 });
  });
  clearCancellation(transferId);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// --- Thumbnails / previews ----------------------------------------------

// LRU cache that revokes its own object URLs on eviction so memory doesn't
// climb unbounded. Two pools because thumbs and full media have very
// different sizes — keeping 200 thumbs is fine; keeping 200 full videos is
// not.
class BlobLRU {
  private map = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  constructor(private max: number) {}

  async get(key: string, work: () => Promise<string>): Promise<string> {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const next = (async () => {
      try {
        const url = await work();
        this.put(key, url);
        return url;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, next);
    return next;
  }

  private put(key: string, url: string): void {
    while (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const stale = this.map.get(oldest);
      this.map.delete(oldest);
      if (stale) URL.revokeObjectURL(stale);
    }
    this.map.set(key, url);
  }

  clear(): void {
    for (const url of this.map.values()) URL.revokeObjectURL(url);
    this.map.clear();
  }
}

const thumbLRU = new BlobLRU(200);
const mediaLRU = new BlobLRU(20);

export function clearAllBlobs(): void {
  thumbLRU.clear();
  mediaLRU.clear();
}

export async function getThumbnail(messageId: number, folderId: number | null): Promise<string> {
  const key = `t:${folderId ?? "home"}:${messageId}`;
  return thumbLRU.get(key, () => fetchThumbBlob(messageId, folderId, "thumbnail"));
}

export async function getPreview(messageId: number, folderId: number | null): Promise<string> {
  const key = `p:${folderId ?? "home"}:${messageId}`;
  return thumbLRU.get(key, () => fetchThumbBlob(messageId, folderId, "preview"));
}

async function fetchThumbBlob(
  messageId: number,
  folderId: number | null,
  kind: "thumbnail" | "preview",
): Promise<string> {
  return readSem.run(async () => {
    const c = await ensureClient();
    const entity = folderId == null ? "me" : await c.getInputEntity(bigInt(folderId));
    const messages = await c.getMessages(entity, { ids: [messageId] });
    const msg = messages[0];
    if (!msg || !msg.media) return "";

    const isPhoto = msg.media instanceof Api.MessageMediaPhoto;
    const isImageDoc = msg.media instanceof Api.MessageMediaDocument
      && msg.media.document instanceof Api.Document
      && (msg.media.document.mimeType ?? "").startsWith("image/");

    if (kind === "preview" && (isPhoto || isImageDoc) && isPhoto) {
      const buffer = await c.downloadMedia(msg, { thumb: -1 });
      if (buffer) return URL.createObjectURL(new Blob([buffer as Uint8Array], { type: "image/jpeg" }));
    }

    const buffer = await c.downloadMedia(msg, { thumb: 0 });
    if (!buffer) return "";
    return URL.createObjectURL(new Blob([buffer as Uint8Array], { type: "image/jpeg" }));
  });
}

// --- Full media (video / PDF / audio) -----------------------------------

export async function getMediaUrl(messageId: number, folderId: number | null): Promise<string> {
  const key = `${folderId ?? "home"}:${messageId}`;
  return mediaLRU.get(key, () => readSem.run(async () => {
    const c = await ensureClient();
    const entity = folderId == null ? "me" : await c.getInputEntity(bigInt(folderId));
    const messages = await c.getMessages(entity, { ids: [messageId] });
    const msg = messages[0];
    if (!msg || !msg.media) throw new Error("Message has no media");
    const buffer = await c.downloadMedia(msg);
    if (!buffer) throw new Error("downloadMedia returned empty");
    const mime = mimeForMessage(msg) ?? "application/octet-stream";
    return URL.createObjectURL(new Blob([buffer as Uint8Array], { type: mime }));
  }));
}

function mimeForMessage(msg: Api.TypeMessage): string | null {
  if (!(msg instanceof Api.Message)) return null;
  const media = msg.media;
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    return media.document.mimeType ?? null;
  }
  if (media instanceof Api.MessageMediaPhoto) return "image/jpeg";
  return null;
}

// --- Open path -----------------------------------------------------------

export async function openPath(path: string): Promise<void> {
  // The Tauri build uses the OS shell to launch a downloaded file. In a PWA
  // the closest equivalent is opening the URL in a new tab; for blob URLs
  // produced by getPreview that gives the user a viewable image.
  if (path.startsWith("blob:")) {
    window.open(path, "_blank", "noopener,noreferrer");
    return;
  }
  throw new Error("cmd_open_path is only supported for blob URLs in the web preview");
}

// --- Stream info ---------------------------------------------------------

export async function getStreamInfo(): Promise<never> {
  throw new Error("Video/PDF streaming is not available in the web preview");
}

// --- helpers -------------------------------------------------------------

function filenameForMessage(msg: Api.TypeMessage): string | null {
  if (!(msg instanceof Api.Message)) return null;
  const media = msg.media;
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const attr = media.document.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    if (attr?.fileName) return attr.fileName;
  }
  if (media instanceof Api.MessageMediaPhoto) return `Photo_${msg.id}.jpg`;
  return null;
}

function lastSegment(p: string | null): string | null {
  if (!p) return null;
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof (v as { toJSNumber?: () => number }).toJSNumber === "function") {
    return (v as { toJSNumber: () => number }).toJSNumber();
  }
  return null;
}

function triggerBlobDownload(buffer: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
