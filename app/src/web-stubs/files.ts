// Web counterparts to the Tauri file commands. Uploads use the registered
// File object from dialog.ts; downloads materialise as Blob URLs and trigger
// <a download>; thumbnails/previews return Blob URLs cached by message id.
//
// Streaming (cmd_get_stream_info) is intentionally omitted — running an
// HTTP server isn't possible in a PWA and a Service-Worker-backed range
// pipeline is its own milestone.

import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { Buffer } from "buffer";
import bigInt from "big-integer";
import { ensureClient } from "./client";
import { emitWebEvent } from "./event";
import { mapMessageToFile } from "./folders";
import { recordDownload, recordUpload } from "./bandwidth";

// Hard timeout on any single Telegram read so a dropped WSS connection
// doesn't leave the React Query / preview promise pending forever. The
// caller's catch falls through to a "Preview Error" message instead of
// the perpetual "Loading preview..." spinner. Grid thumbnails get a
// shorter window because there are dozens contending on the readSem and
// users tolerate a fallback file icon better than a long spinner.
const PREVIEW_TIMEOUT_MS = 45_000;
const THUMB_TIMEOUT_MS = 20_000;
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(`${label} timed out after ${Math.floor(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (to) clearTimeout(to);
  }
}

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

// Decode an image File via createImageBitmap (or HTMLImageElement fallback)
// and downscale to fit a 320 px square — same target Telegram uses for the
// 'm' photo size. Result is a JPEG passed as the document's embedded thumb;
// if any step fails (browser can't decode, OOM, exotic format) we return
// null and the upload proceeds without an embedded thumb (the file just
// renders with a generic icon until preview, same as before this change).
// gramjs's _fileToMedia thumb branch accepts string | File | Buffer, but
// (unlike the main-file branch) NOT CustomFile — it falls through and
// throws "Could not create file from …". So we return a real File here.
async function generateThumbForFile(file: File): Promise<File | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await loadImageBitmap(file);
    const max = 320;
    const ratio = Math.min(max / bitmap.width, max / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);
    if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85),
    );
    if (!blob) return null;
    return new File([blob], "thumb.jpg", { type: "image/jpeg" });
  } catch {
    return null;
  }
}

async function loadImageBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return await createImageBitmap(file);
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// Probe a video File for duration + dimensions via a hidden <video> element
// so we can attach DocumentAttributeVideo on upload. Without that attribute,
// Telegram serves the file as a generic document and every client (Tauri
// included) renders it without a duration pill.
//
// Returns null on any failure — exotic codecs, decode timeouts, etc. The
// upload still succeeds; the file just won't have a duration tag.
async function probeVideoMetadata(file: File): Promise<{ duration: number; w: number; h: number } | null> {
  if (!file.type.startsWith("video/")) return null;
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.src = "";
    };
    const finish = (v: { duration: number; w: number; h: number } | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
      finish({ duration: d, w: video.videoWidth || 0, h: video.videoHeight || 0 });
    };
    video.onerror = () => finish(null);
    // Hard 5s safety timeout — some codecs never raise loadedmetadata.
    setTimeout(() => finish(null), 5000);
    video.src = url;
  });
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
  // gramjs's _fileToMedia mishandles a raw File: typeof === "object" with
  // no "read" property routes it through getInputMedia(file), which throws
  // and is silently caught — leaving media=undefined and triggering
  // "Cannot use [object File] as file." Wrapping in CustomFile + Buffer
  // skips that branch and goes through the standard upload path. Loads
  // the whole file into memory; gramjs has no streaming-from-File API.
  const arrayBuf = await file.arrayBuffer();
  const customFile = new CustomFile(file.name, file.size, "", Buffer.from(arrayBuf));
  // For image uploads, generate an embedded thumbnail client-side. grammers
  // (Tauri) auto-generates one inside upload_file, but gramjs's sendFile
  // doesn't — without this, a file uploaded from web shows a generic
  // placeholder icon on every other client (and on the desktop app once
  // the message syncs over) until the user opens the full preview.
  const thumb = await generateThumbForFile(file);
  // For video files, attach DocumentAttributeVideo so every client
  // (including ours) shows duration + correct dimensions. Without this
  // attribute, gramjs's sendFile uploads the video as a plain document
  // and the duration pill never appears.
  //
  // Heuristic: trust file.type if present, fall back to extension match
  // — some Files-app handoffs on iOS arrive with empty `type`, but the
  // browser still feeds the bytes through HTMLVideoElement just fine.
  const looksLikeVideo =
    file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);
  const videoMeta = looksLikeVideo ? await probeVideoMetadata(file) : null;
  const videoAttr = videoMeta && videoMeta.duration > 0
    ? new Api.DocumentAttributeVideo({
        duration: videoMeta.duration,
        w: videoMeta.w,
        h: videoMeta.h,
        supportsStreaming: true,
      })
    : null;
  // gramjs's docs state user-supplied `attributes` "override the inferred
  // ones" — to be safe we always include the filename attribute so it
  // isn't lost when we slot in the video one.
  const attributes: Api.TypeDocumentAttribute[] = [
    new Api.DocumentAttributeFilename({ fileName: file.name }),
  ];
  if (videoAttr) attributes.push(videoAttr);
  // Throttled emit: gramjs fires progressCallback per chunk (~hundreds of
  // times for big uploads), so we cap to ~250ms ticks and derive speed
  // from bytes-since-last-emit / dt — matches the Tauri ticker cadence.
  let lastEmitMs = 0;
  let lastEmitBytes = 0;
  emitWebEvent("upload-progress", {
    id: transferId, percent: 0, uploaded_bytes: 0, total_bytes: file.size, speed_bytes_per_sec: 0,
  });
  const onUploadProgress = (p: number) => {
    // Throwing inside the progress callback bubbles up from uploadFile and
    // stops further chunk uploads. Telegram's CDN garbage-collects partial
    // uploads automatically; nothing leaks server-side. The "Transfer
    // cancelled" wording matches the Tauri side so the hook-layer check
    // distinguishes a user-cancel from a real error.
    if (isCancelled(transferId)) throw new Error("Transfer cancelled");
    const frac = typeof p === "number" ? Math.max(0, Math.min(1, p)) : 0;
    const uploaded = Math.floor(frac * file.size);
    const now = Date.now();
    const dt = (now - lastEmitMs) / 1000;
    if (lastEmitMs !== 0 && dt < 0.25) return;
    const speed = dt > 0 ? Math.max(0, Math.floor((uploaded - lastEmitBytes) / dt)) : 0;
    const pct = Math.min(99, Math.floor(frac * 100));
    emitWebEvent("upload-progress", {
      id: transferId, percent: pct, uploaded_bytes: uploaded, total_bytes: file.size, speed_bytes_per_sec: speed,
    });
    lastEmitMs = now;
    lastEmitBytes = uploaded;
  };
  try {
    // Upload the main file ourselves with a bumped maxBufferSize. gramjs's
    // sendFile defers to uploadFile but doesn't expose the maxBufferSize
    // knob, and uploadFile's getFileBuffer routes any file >20MB through
    // CustomFile.path — which is `""` here because we have no filesystem
    // (PWA). Forcing the buffer branch via Number.MAX_SAFE_INTEGER works
    // because the bytes are already loaded in memory anyway. Then hand
    // the resulting InputFile handle to sendFile, which short-circuits
    // re-upload when it sees an InputFile and just builds the media +
    // SendMedia call.
    const fileHandle = await c.uploadFile({
      file: customFile,
      workers: 1,
      maxBufferSize: Number.MAX_SAFE_INTEGER,
      onProgress: onUploadProgress,
    });
    const sent = await c.sendFile(entity, {
      file: fileHandle,
      forceDocument: true,
      thumb: thumb ?? undefined,
      attributes,
    });
    emitWebEvent("upload-progress", {
      id: transferId, percent: 100, uploaded_bytes: file.size, total_bytes: file.size, speed_bytes_per_sec: 0,
    });
    recordUpload(file.size);

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
    let lastEmitMs = 0;
    let lastEmitBytes = 0;
    emitWebEvent("download-progress", {
      id: transferId, percent: 0, uploaded_bytes: 0, total_bytes: total, speed_bytes_per_sec: 0,
    });
    type IterArg = Parameters<typeof c.iterDownload>[0];
    for await (const chunk of c.iterDownload({
      file: msg.media as IterArg["file"],
      requestSize: 64 * 1024,
    })) {
      if (isCancelled(transferId)) {
        clearCancellation(transferId);
        // Match the Tauri error string so the hook tags this as a cancel,
        // not a red-toast error.
        throw new Error("Transfer cancelled");
      }
      chunks.push(chunk as Uint8Array);
      receivedTotal += (chunk as Uint8Array).byteLength;
      const now = Date.now();
      const dt = (now - lastEmitMs) / 1000;
      if (lastEmitMs !== 0 && dt < 0.25) continue;
      const speed = dt > 0 ? Math.max(0, Math.floor((receivedTotal - lastEmitBytes) / dt)) : 0;
      const pct = total > 0 ? Math.min(99, Math.floor((receivedTotal / total) * 100)) : 0;
      emitWebEvent("download-progress", {
        id: transferId, percent: pct, uploaded_bytes: receivedTotal, total_bytes: total, speed_bytes_per_sec: speed,
      });
      lastEmitMs = now;
      lastEmitBytes = receivedTotal;
    }

    const filename = filenameForMessage(msg) ?? lastSegment(savePath) ?? `file-${messageId}`;
    const buffer = concatChunks(chunks);
    triggerBlobDownload(buffer, filename, "application/octet-stream");
    emitWebEvent("download-progress", {
      id: transferId, percent: 100, uploaded_bytes: receivedTotal, total_bytes: total || receivedTotal, speed_bytes_per_sec: 0,
    });
    recordDownload(receivedTotal);
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

    // For image-Documents (PNGs, JPEGs sent as files / Photo.jpg saves)
    // the file IS the image, and the embedded thumbs are 24×24 stripped
    // blurs. Tauri's cmd_get_thumbnail Plan::WholeDocument downloads the
    // full file in this case; web should match — both for the card
    // thumbnail and the modal preview. Without this, the web grid shows
    // pixelated mush for every Photo.jpg in Saved Messages.
    const tmo = kind === "preview" ? PREVIEW_TIMEOUT_MS : THUMB_TIMEOUT_MS;
    if (isImageDoc) {
      const buffer = await withTimeout(
        Promise.resolve(c.downloadMedia(msg)),
        tmo,
        `download ${kind}`,
      );
      if (buffer) {
        const mime = (msg.media as Api.MessageMediaDocument).document instanceof Api.Document
          ? ((msg.media as Api.MessageMediaDocument).document as Api.Document).mimeType ?? "image/jpeg"
          : "image/jpeg";
        return URL.createObjectURL(new Blob([buffer as Uint8Array], { type: mime }));
      }
    }

    // Preview of a non-image Document: return a whole-document blob URL
    // so the "Open with system app" button (which on web routes through
    // openPath → window.open(blob:…)) can hand it to the browser, which
    // then offers the native viewer / download for zip/docx/epub/xlsx/
    // json/etc. Without this, getPreview returned "" and the button
    // failed silently.
    const isDoc = msg.media instanceof Api.MessageMediaDocument
      && msg.media.document instanceof Api.Document;
    if (kind === "preview" && !isPhoto && !isImageDoc && isDoc) {
      const buffer = await withTimeout(
        Promise.resolve(c.downloadMedia(msg)),
        PREVIEW_TIMEOUT_MS,
        "download preview",
      );
      if (buffer) {
        const doc = (msg.media as Api.MessageMediaDocument).document as Api.Document;
        const mime = doc.mimeType ?? "application/octet-stream";
        return URL.createObjectURL(new Blob([buffer as Uint8Array], { type: mime }));
      }
      return "";
    }

    // Pick a real network size (skipping PhotoStrippedSize / PhotoPathSize)
    // and pass its index. gramjs's `thumb: 0` would otherwise hand back
    // the inline 24×24 stripped blur for any photo whose `sizes[]` starts
    // with PhotoStrippedSize — which is most of them — making the file
    // grid look pixel-mush.
    const sizes: Api.TypePhotoSize[] | null = isPhoto && msg.media instanceof Api.MessageMediaPhoto
      && msg.media.photo instanceof Api.Photo
      ? msg.media.photo.sizes
      : (msg.media instanceof Api.MessageMediaDocument
          && msg.media.document instanceof Api.Document
          && msg.media.document.thumbs)
        ? msg.media.document.thumbs
        : null;
    // Try sizes in rank order, falling through on 0-bytes / error — same
    // strategy as commands/preview.rs's download_one_thumb cascade. Some
    // photos return empty bytes for their preferred network size under
    // load (Telegram's edge quirk) but a smaller size succeeds; without
    // a cascade those cards stayed icon-only.
    const ranked = sizes ? rankedThumbIndices(sizes, kind) : [];
    for (const idx of ranked) {
      try {
        const buffer = await withTimeout(
          Promise.resolve(c.downloadMedia(msg, { thumb: idx })),
          tmo,
          `download ${kind}`,
        );
        if (buffer && (buffer as Uint8Array).byteLength > 0) {
          return URL.createObjectURL(new Blob([buffer as Uint8Array], { type: "image/jpeg" }));
        }
      } catch { /* fall through to next size */ }
    }
    return "";
  });
}

// Rank network photo sizes by preference, returning indices into the
// original `sizes` array in try-order. Stripped/Path entries are skipped
// (they're inline placeholders, not network thumbs).
function rankedThumbIndices(sizes: Api.TypePhotoSize[], kind: "thumbnail" | "preview"): number[] {
  const isNetwork = (s: Api.TypePhotoSize) =>
    !(s instanceof Api.PhotoStrippedSize) && !(s instanceof Api.PhotoPathSize);
  const areaOf = (s: Api.TypePhotoSize) => {
    const w = (s as { w?: number }).w ?? 0;
    const h = (s as { h?: number }).h ?? 0;
    return w * h;
  };
  const eligible: number[] = [];
  for (let i = 0; i < sizes.length; i++) if (isNetwork(sizes[i])) eligible.push(i);
  if (kind === "preview") {
    return eligible.sort((a, b) => areaOf(sizes[b]) - areaOf(sizes[a]));
  }
  // Grid: same rank order Tauri uses (commands/preview.rs).
  const rank: Record<string, number> = { x: 0, y: 1, m: 2, w: 3, s: 4 };
  return eligible.sort((a, b) => {
    const ra = rank[(sizes[a] as { type?: string }).type ?? ""] ?? 5;
    const rb = rank[(sizes[b] as { type?: string }).type ?? ""] ?? 5;
    return ra - rb;
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

export async function openPath(path: string, filename?: string): Promise<void> {
  // The Tauri build uses the OS shell to launch a downloaded file. In a PWA
  // the closest equivalent is triggering a real download with the original
  // filename so the OS associates it with the right app on disk. Plain
  // `window.open(blob:)` left blob URLs without a filename, so the
  // browser saved them as a uuid with no extension — that's why .pages
  // (and .docx, .key, .numbers, …) downloads ended up as "an app with no
  // extension". An anchor with `download="<original.pages>"` carries the
  // filename through the download path.
  if (path.startsWith("blob:")) {
    if (filename && filename.length > 0) {
      const a = document.createElement("a");
      a.href = path;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      // Defer cleanup so Safari has time to register the download.
      setTimeout(() => { a.parentNode?.removeChild(a); }, 1000);
      return;
    }
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
