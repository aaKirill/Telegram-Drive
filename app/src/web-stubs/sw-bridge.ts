// Page-side counterpart to public/sw.js. Listens for "td-stream" messages
// from the Service Worker, drives gramjs `iterDownload` for the requested
// byte range, and streams chunks back over the supplied MessageChannel
// port.
//
// gramjs offset must be aligned to the requestSize (64KB). When the
// browser asks for a non-aligned start we round down to the previous
// boundary and discard the prefix on the first chunk.

import { Api } from "telegram";
import bigInt from "big-integer";
import { ensureClient } from "./client";

const REQUEST_SIZE = 64 * 1024;

export function registerServiceWorkerBridge(): void {
  if (!("serviceWorker" in navigator)) return;

  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  navigator.serviceWorker
    .register(swUrl, { scope: import.meta.env.BASE_URL })
    .catch((err) => console.warn("[td] service worker registration failed:", err));

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "td-stream") return;
    const port = event.ports[0];
    if (!port) return;
    void handleStreamRequest(port, data.folderId, data.messageId, data.start, data.end);
  });
}

async function handleStreamRequest(
  port: MessagePort,
  folderId: number,
  messageId: number,
  start: number,
  end: number,
): Promise<void> {
  let cancelled = false;
  port.onmessage = (e) => {
    if ((e.data as { kind?: string } | undefined)?.kind === "cancel") cancelled = true;
  };

  try {
    const c = await ensureClient();
    const entity = await c.getInputEntity(bigInt(folderId));
    const messages = await c.getMessages(entity, { ids: [messageId] });
    const msg = messages[0];
    if (!msg || !msg.media) {
      port.postMessage({ kind: "meta", error: "no-media" });
      return;
    }

    let total = 0;
    let contentType = "application/octet-stream";
    if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
      const doc = msg.media.document;
      total = Number(doc.size);
      contentType = doc.mimeType || contentType;
    } else if (msg.media instanceof Api.MessageMediaPhoto && msg.media.photo instanceof Api.Photo) {
      const sizes = msg.media.photo.sizes;
      total = sizes
        .map((s) => ("size" in s ? Number((s as { size: number }).size) : 0))
        .reduce((a, b) => Math.max(a, b), 0);
      contentType = "image/jpeg";
    }

    port.postMessage({ kind: "meta", size: total, contentType });

    const reqEnd = end === -1 ? Math.max(total - 1, 0) : end;
    const length = total === 0 ? undefined : reqEnd - start + 1;
    const alignedStart = Math.floor(start / REQUEST_SIZE) * REQUEST_SIZE;
    let dropPrefix = start - alignedStart;
    let remaining = length ?? Number.MAX_SAFE_INTEGER;

    type IterDownloadArg = Parameters<typeof c.iterDownload>[0];
    const iter = c.iterDownload({
      file: msg.media as IterDownloadArg["file"],
      offset: bigInt(alignedStart),
      requestSize: REQUEST_SIZE,
    });

    for await (const raw of iter) {
      if (cancelled) break;
      let bytes = raw as Uint8Array;
      if (dropPrefix > 0) {
        if (dropPrefix >= bytes.length) {
          dropPrefix -= bytes.length;
          continue;
        }
        bytes = bytes.subarray(dropPrefix);
        dropPrefix = 0;
      }
      if (remaining < bytes.length) {
        bytes = bytes.subarray(0, remaining);
      }
      // Copy out of any shared backing buffer before transferring, since
      // gramjs may slice multiple chunks from one ArrayBuffer.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      port.postMessage({ kind: "chunk", bytes: copy }, [copy.buffer]);
      remaining -= copy.byteLength;
      if (remaining <= 0) break;
    }
    if (!cancelled) port.postMessage({ kind: "end" });
  } catch (e) {
    const message = String((e as { message?: string })?.message ?? e);
    try { port.postMessage({ kind: "error", message }); } catch { /* port closed */ }
  } finally {
    try { port.close(); } catch { /* noop */ }
  }
}
