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
export async function resolveMediaUrl(folderId: number | null, messageId: number): Promise<string> {
  if (import.meta.env.VITE_TARGET === "web") {
    if (folderId == null) throw new Error("Web preview can't open a media file without a folder id");
    return `${import.meta.env.BASE_URL}td-stream/${folderId}/${messageId}`;
  }
  const info = await invoke<{ token: string; base_url: string }>("cmd_get_stream_info");
  const folderIdParam = folderId !== null ? folderId.toString() : "home";
  return `${info.base_url}/stream/${folderIdParam}/${messageId}?token=${info.token}`;
}
