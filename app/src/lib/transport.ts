// Transport seam. The Tauri build re-exports the real APIs; a web build
// (planned: VITE_TARGET=web on GitHub Pages) will swap this module for a
// gramjs-backed implementation. Components must not import @tauri-apps/api/core
// directly — go through here.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export { invoke, convertFileSrc };

// Resolve a playable URL for a media message. Tauri uses its localhost
// streaming server; the web build returns a path the Service Worker
// (public/sw.js) intercepts and answers via the page's gramjs client over
// MessageChannel — full Range-request support, no full-file buffering.
//
// "home" sentinel = Saved Messages (folderId null). Both targets accept
// it; web's SW regex matches /td-stream/home|<digits>/<digits>$ and the
// page-side handler resolves "home" to the self peer.
export async function resolveMediaUrl(folderId: number | null, messageId: number): Promise<string> {
  const folderIdParam = folderId !== null ? folderId.toString() : "home";
  if (import.meta.env.VITE_TARGET === "web") {
    return `${import.meta.env.BASE_URL}td-stream/${folderIdParam}/${messageId}`;
  }
  const info = await invoke<{ token: string; base_url: string }>("cmd_get_stream_info");
  return `${info.base_url}/stream/${folderIdParam}/${messageId}?token=${info.token}`;
}
