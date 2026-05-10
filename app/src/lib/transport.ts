// Transport seam. The Tauri build re-exports the real APIs; a web build
// (planned: VITE_TARGET=web on GitHub Pages) will swap this module for a
// gramjs-backed implementation. Components must not import @tauri-apps/api/core
// directly — go through here.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export { invoke, convertFileSrc };

// Resolve a playable URL for a media message.
//
// Tauri keeps its localhost streaming server (chunked range delivery, no
// full-file buffering). For the web build we now route through
// `cmd_get_media_url` instead of the Service-Worker streaming path. iOS
// Safari was returning MEDIA_ERR_SRC_NOT_SUPPORTED (HTMLMediaElement
// error code 4) for streamed mp4s — most likely because Telegram-stored
// videos commonly have their `moov` atom at the END of the file, and
// iOS refuses to start playback until it has seen the moov. Range-
// requesting the tail through the SW is brittle on iOS, so we just
// download the full file on web and hand the player a `blob:` URL. The
// upfront cost is the price of reliability; for the videos we typically
// preview (a few MB to ~100MB) it's fine, and `cmd_get_media_url`
// already caches the blob URL via `mediaLRU` so re-opens are instant.
export async function resolveMediaUrl(folderId: number | null, messageId: number): Promise<string> {
  if (import.meta.env.VITE_TARGET === "web") {
    return await invoke<string>("cmd_get_media_url", { messageId, folderId });
  }
  const folderIdParam = folderId !== null ? folderId.toString() : "home";
  const info = await invoke<{ token: string; base_url: string }>("cmd_get_stream_info");
  return `${info.base_url}/stream/${folderIdParam}/${messageId}?token=${info.token}`;
}
