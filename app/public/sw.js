// Service Worker for the web build. Intercepts requests for
// `${scope}td-stream/<folderId>/<messageId>` and streams Telegram media
// through the page's gramjs client (which holds the auth keys).
//
// Wire format (page <-> sw, over a per-request MessageChannel):
//   page → sw: { kind: "meta",  size, contentType }
//   page → sw: { kind: "chunk", bytes }       (zero or more, in order)
//   page → sw: { kind: "end" }
//   page → sw: { kind: "error", message }
//   sw   → page: { kind: "cancel" }            (browser dropped the response)

// "home" matches Saved Messages (the self peer); a numeric id matches a
// channel. Both shapes flow through to the page-side handler, which
// resolves "home" to "me" before calling iterDownload.
const STREAM_PATH_RE = /\/td-stream\/(home|-?\d+)\/(-?\d+)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(STREAM_PATH_RE);
  if (!m) return;
  const folderId = m[1] === "home" ? null : Number(m[1]);
  event.respondWith(handleStream(event, folderId, Number(m[2])));
});

async function handleStream(event, folderId, messageId) {
  const range = event.request.headers.get("range") || "";
  const parsed = /bytes=(\d+)-(\d*)/.exec(range);
  const start = parsed ? Number(parsed[1]) : 0;
  const end = parsed && parsed[2] ? Number(parsed[2]) : -1;

  const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (clientList.length === 0) {
    return new Response("No active page client", { status: 503 });
  }
  // First focused client; otherwise first in list. The page handler is the
  // only one that holds gramjs and can answer.
  const client = clientList.find((c) => c.focused) ?? clientList[0];

  const channel = new MessageChannel();
  let metaResolve;
  let metaReject;
  const metaPromise = new Promise((resolve, reject) => {
    metaResolve = resolve;
    metaReject = reject;
  });

  let streamController = null;
  const earlyChunks = [];
  let endedEarly = false;
  let errorEarly = null;

  channel.port1.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.kind) {
      case "meta":
        if (msg.error) metaReject(new Error(msg.error));
        else metaResolve(msg);
        break;
      case "chunk":
        if (streamController) streamController.enqueue(msg.bytes);
        else earlyChunks.push(msg.bytes);
        break;
      case "end":
        if (streamController) streamController.close();
        else endedEarly = true;
        break;
      case "error":
        if (streamController) streamController.error(new Error(msg.message || "stream error"));
        else errorEarly = new Error(msg.message || "stream error");
        break;
    }
  };

  client.postMessage({ type: "td-stream", folderId, messageId, start, end }, [channel.port2]);

  let meta;
  try {
    meta = await metaPromise;
  } catch (e) {
    return new Response(String(e?.message ?? e), { status: 502 });
  }
  const total = Number(meta.size) || 0;
  const reqEnd = end === -1 || end >= total ? Math.max(total - 1, 0) : end;
  const length = total === 0 ? 0 : reqEnd - start + 1;

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      for (const chunk of earlyChunks) controller.enqueue(chunk);
      earlyChunks.length = 0;
      if (errorEarly) controller.error(errorEarly);
      else if (endedEarly) controller.close();
    },
    cancel() {
      try { channel.port1.postMessage({ kind: "cancel" }); } catch { /* noop */ }
    },
  });

  const headers = new Headers({
    "Content-Type": meta.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  if (total > 0) headers.set("Content-Length", String(length));
  if (range && total > 0) headers.set("Content-Range", `bytes ${start}-${reqEnd}/${total}`);

  return new Response(stream, { status: range ? 206 : 200, headers });
}
