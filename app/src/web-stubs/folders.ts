// Web counterpart to commands/fs.rs folder + file ops. Mirrors the Rust
// surface so callsites and the React UI don't need to branch.
//
// IDs: gramjs returns BigInt for channel/message IDs. We convert to Number
// at the boundary to match TelegramFolder/TelegramFile which use plain
// numbers. Channel IDs and message IDs both fit comfortably below 2^53 in
// practice, so this is safe — but flag any narrowing surprises here first.

import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { ensureClient } from "./client";
import * as locks from "./locks";

type TelegramFolder = { id: number; name: string; parent_id: number | null };
type FileMetadata = {
  id: number;
  folder_id: number | null;
  name: string;
  size: number;
  mime_type: string | null;
  file_ext: string | null;
  created_at: string;
  icon_type: string;
  duration_secs?: number | null;
};

const TD_MARK = /\s*\[td\]\s*/gi;

function cleanName(title: string): string {
  return title.replace(TD_MARK, "").trim();
}

function asNumber(v: bigInt.BigInteger | number | undefined): number {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  return v.toJSNumber();
}

function extractFilename(doc: Api.Document, mime: string | undefined): { name: string; ext: string | null } {
  const fromAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
  );
  if (fromAttr?.fileName) {
    const idx = fromAttr.fileName.lastIndexOf(".");
    return { name: fromAttr.fileName, ext: idx >= 0 ? fromAttr.fileName.slice(idx + 1) : null };
  }
  const ext = extFromMime(mime);
  const prefix = mime?.startsWith("video/") ? "Video"
    : mime?.startsWith("audio/") ? "Audio"
    : mime?.startsWith("image/") ? "Image"
    : "File";
  return { name: ext ? `${prefix}_${asNumber(doc.id)}.${ext}` : `${prefix}_${asNumber(doc.id)}`, ext };
}

function extFromMime(mime: string | undefined): string | null {
  if (!mime) return null;
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/x-matroska": "mkv",
    "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a",
    "application/pdf": "pdf", "application/zip": "zip",
  };
  return map[mime] ?? null;
}

export async function scanFolders(): Promise<TelegramFolder[]> {
  const c = await ensureClient();
  const out: TelegramFolder[] = [];
  const seen = new Set<number>();

  // Main folder.
  for await (const dialog of c.iterDialogs({})) {
    consumeDialog(dialog, out, seen);
  }
  // Archived [TD] folders also need to surface — iterDialogs defaults to
  // folder_id=0 and won't hit them otherwise. Best-effort: some accounts
  // may not have an archive folder configured.
  try {
    for await (const dialog of c.iterDialogs({ archived: true })) {
      consumeDialog(dialog, out, seen);
    }
  } catch { /* ignore — archive walk is best-effort */ }

  return out;
}

function consumeDialog(
  dialog: { entity?: Api.TypeChat | Api.TypeUser },
  out: TelegramFolder[],
  seen: Set<number>,
): void {
  const entity = dialog.entity;
  if (!(entity instanceof Api.Channel)) return;
  if (entity.megagroup) return;
  const id = asNumber(entity.id);
  if (seen.has(id)) return;
  const title = entity.title ?? "";
  if (title.toLowerCase().includes("[td]")) {
    seen.add(id);
    out.push({ id, name: cleanName(title), parent_id: null });
  }
}

export async function createFolder(name: string): Promise<TelegramFolder> {
  const c = await ensureClient();
  const result = await c.invoke(
    new Api.channels.CreateChannel({
      broadcast: true,
      megagroup: false,
      title: `${name} [TD]`,
      about: "Telegram Drive Storage Folder\n[telegram-drive-folder]",
    }),
  );
  const updates = result as Api.Updates;
  const channel = updates.chats.find((ch) => ch instanceof Api.Channel) as Api.Channel | undefined;
  if (!channel) throw new Error("Channel not in CreateChannel response");
  // Disable history TTL so files don't auto-expire.
  try {
    await c.invoke(
      new Api.messages.SetHistoryTTL({
        peer: utils.getInputPeer(channel),
        period: 0,
      }),
    );
  } catch {
    // Non-fatal — TTL only matters for some accounts.
  }
  return { id: asNumber(channel.id), name, parent_id: null };
}

/**
 * Resolve a [TD] folder id (positive raw channel id, the way we store it
 * locally) to an `InputPeerChannel`. gramjs's `getInputEntity(rawNumber)`
 * defaults to interpreting positive numbers as user ids, so on a fresh
 * page-load — before iterDialogs has populated the entity cache — calls
 * like `deleteFolder` raise `Could not find the input entity for
 * {userId, PeerUser}`. This helper:
 *
 *   1. asks gramjs explicitly for an `Api.PeerChannel`, which bypasses the
 *      user-first heuristic;
 *   2. on cache miss, runs `iterDialogs` (both inbox + archive) once so
 *      gramjs caches accessHashes for every channel the account knows
 *      about, then retries.
 */
async function resolveChannelInput(c: Awaited<ReturnType<typeof ensureClient>>, folderId: number): Promise<Api.InputPeerChannel> {
  const peer = new Api.PeerChannel({ channelId: bigInt(folderId) });
  let entity;
  try {
    entity = await c.getInputEntity(peer);
  } catch {
    // Force-populate the entity cache. iterDialogs is the cheapest known
    // way to make gramjs commit accessHashes for every visible channel
    // into its session storage.
    try {
      for await (const _ of c.iterDialogs({ limit: 200 })) { void _; }
    } catch { /* non-fatal */ }
    try {
      for await (const _ of c.iterDialogs({ archived: true, limit: 200 })) { void _; }
    } catch { /* non-fatal */ }
    entity = await c.getInputEntity(peer);
  }
  if (!(entity instanceof Api.InputPeerChannel)) {
    throw new Error("Folder is not a channel");
  }
  return entity;
}

export async function deleteFolder(folderId: number): Promise<boolean> {
  const c = await ensureClient();
  const entity = await resolveChannelInput(c, folderId);
  await c.invoke(
    new Api.channels.DeleteChannel({
      channel: new Api.InputChannel({ channelId: entity.channelId, accessHash: entity.accessHash }),
    }),
  );
  return true;
}

export async function getFiles(folderId: number | null): Promise<FileMetadata[]> {
  // Lock gate: a folder with a password set must be in the in-memory
  // unlockedFolders set before getFiles will read it. Mirrors Tauri's
  // cmd_get_files which refuses with "LOCKED" via cmd_is_folder_locked.
  // Without this, web freely served any passworded folder's contents,
  // and hidden folders revealed via search bypassed the password modal.
  if (await locks.isFolderLockedAsync(folderId)) {
    throw new Error("LOCKED");
  }
  const c = await ensureClient();
  // Saved Messages = the user's chat with themselves. gramjs accepts the
  // "me" sentinel and resolves to the self peer. For [TD] folders we
  // resolve the channel by id like before.
  const target: "me" | Api.InputPeerChannel =
    folderId == null ? "me" : await resolveChannelInput(c, folderId);
  // Server-side filtered walks: one filter per media class. Telegram's
  // InputMessagesFilterDocument only catches "file" docs — audio, voice,
  // and gifs are separate filters, and missing them dropped the audio /
  // music files entirely. Photos are their own filter; videos too. Sticker
  // filtering happens in mapMessageToFile, not here.
  //
  // Each walk runs independently via Promise.allSettled so a single failure
  // (transient WSS drop on reload, peer hash refresh) doesn't sink the
  // others — the user still sees photos when the docs walk fails and vice
  // versa. One retry per walk covers the most common case (a single WSS
  // hiccup mid-load). Per-walk timeout prevents a hung iterator from
  // leaving the React Query promise pending forever.
  const FILTER_TIMEOUT_MS = 60_000;
  const walkOnce = async (filter: Api.TypeMessagesFilter): Promise<FileMetadata[]> => {
    const found: FileMetadata[] = [];
    let to: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      for await (const msg of c.iterMessages(target, { limit: 2000, filter })) {
        const m = mapMessageToFile(msg, folderId);
        if (m) found.push(m);
      }
      return found;
    })();
    try {
      return await Promise.race([
        work,
        new Promise<FileMetadata[]>((_, reject) => {
          to = setTimeout(() => reject(new Error("iter_messages timeout")), FILTER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (to) clearTimeout(to);
    }
  };
  const walk = async (filter: Api.TypeMessagesFilter): Promise<FileMetadata[]> => {
    try { return await walkOnce(filter); }
    catch { return await walkOnce(filter); }
  };
  // Run walks SEQUENTIALLY rather than via Promise.allSettled — the
  // previous parallel kickoff fired 7 GetHistory streams at once which
  // promptly tripped Telegram's per-DC FLOOD_WAIT on mobile (spamming
  // "Sleeping for 30s on flood wait" warnings into the console). Mobile
  // networks make this even worse because the DC has fewer concurrent
  // request slots per-IP. Sequential is slower but actually completes;
  // most folders return well under the timeout.
  const filters: Api.TypeMessagesFilter[] = [
    // Backstop first — covers most files in one walk for small folders,
    // so the user sees something before we fan out the typed filters.
    new Api.InputMessagesFilterEmpty(),
    new Api.InputMessagesFilterPhotos(),
    new Api.InputMessagesFilterDocument(),
    new Api.InputMessagesFilterVideo(),
    new Api.InputMessagesFilterMusic(),
    new Api.InputMessagesFilterVoice(),
    new Api.InputMessagesFilterGif(),
  ];
  const results: PromiseSettledResult<FileMetadata[]>[] = [];
  for (const f of filters) {
    try {
      const v = await walk(f);
      results.push({ status: "fulfilled", value: v });
    } catch (e) {
      results.push({ status: "rejected", reason: e });
    }
  }
  const seen = new Set<number>();
  const out: FileMetadata[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const m of r.value) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  // If both walks failed outright, surface the first error so React Query
  // retries the whole thing instead of caching an empty list as success.
  if (out.length === 0 && results.every(r => r.status === "rejected")) {
    const first = results[0] as PromiseRejectedResult;
    throw new Error(String(first.reason?.message ?? first.reason ?? "scan failed"));
  }
  return out;
}

export async function deleteFile(messageId: number, folderId: number | null): Promise<boolean> {
  const c = await ensureClient();
  // For Saved Messages (folderId null), pass "me" so gramjs resolves to
  // the self peer. Passing undefined here makes deleteMessages do a
  // global "find this message anywhere" which is wrong.
  const entity: "me" | Api.InputPeerChannel =
    folderId == null ? "me" : await resolveChannelInput(c, folderId);
  await c.deleteMessages(entity, [messageId], { revoke: true });
  return true;
}

export async function moveFiles(
  messageIds: number[],
  sourceFolderId: number | null,
  targetFolderId: number | null,
): Promise<FileMetadata[]> {
  if (sourceFolderId === targetFolderId) return [];
  const c = await ensureClient();
  // null folderId == Saved Messages — gramjs resolves "me" to the self
  // peer, same shape forwardMessages / deleteMessages accept.
  const src: "me" | Api.InputPeerChannel =
    sourceFolderId == null ? "me" : await resolveChannelInput(c, sourceFolderId);
  const dst: "me" | Api.InputPeerChannel =
    targetFolderId == null ? "me" : await resolveChannelInput(c, targetFolderId);
  // forwardMessages returns the freshly-created Message objects in the
  // destination peer. We map them to FileMetadata so the frontend can
  // optimistic-insert into the target folder cache without waiting on
  // the GetHistory replication lag (Saved Messages especially can take
  // ~1 min before iter_messages sees a forwarded message).
  //
  // Shape note: gramjs's forwardMessages groups messages by source chat
  // and pushes one chunk-result per group, where each chunk-result is
  // itself an array of Messages (the array branch of _getResponseMessage
  // for ForwardMessages.randomId). So the outer value is array-of-arrays;
  // we flatten one level before mapping.
  const forwarded = await c.forwardMessages(dst, { messages: messageIds, fromPeer: src });
  await c.deleteMessages(src, messageIds, { revoke: true });
  const flat: unknown[] = [];
  for (const item of forwarded ?? []) {
    if (Array.isArray(item)) flat.push(...item);
    else flat.push(item);
  }
  const out: FileMetadata[] = [];
  for (const msg of flat) {
    if (!(msg instanceof Api.Message)) continue;
    const m = mapMessageToFile(
      msg as unknown as { id: number; date: number; media?: unknown },
      targetFolderId,
    );
    if (m) out.push(m);
  }
  return out;
}

export async function searchGlobal(query: string): Promise<FileMetadata[]> {
  const c = await ensureClient();
  const result = await c.invoke(
    new Api.messages.SearchGlobal({
      q: query,
      filter: new Api.InputMessagesFilterDocument(),
      minDate: 0,
      maxDate: 0,
      offsetRate: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      offsetId: 0,
      limit: 50,
    }),
  );
  const messages = "messages" in result ? result.messages : [];
  const out: FileMetadata[] = [];
  for (const msg of messages) {
    if (!(msg instanceof Api.Message)) continue;
    const folderId = peerToFolderId(msg.peerId);
    const m = mapMessageToFile(msg as unknown as { id: number; date: number; media: unknown }, folderId);
    if (m) out.push(m);
  }
  return out;
}

function peerToFolderId(peer: Api.TypePeer | undefined): number | null {
  if (!peer) return null;
  if (peer instanceof Api.PeerChannel) return asNumber(peer.channelId);
  if (peer instanceof Api.PeerUser) return asNumber(peer.userId);
  if (peer instanceof Api.PeerChat) return asNumber(peer.chatId);
  return null;
}

export function mapMessageToFile(
  msg: { id: number; date: number; media?: unknown },
  folderId: number | null,
): FileMetadata | null {
  const media = msg.media;
  if (!media) return null;
  const date = new Date(msg.date * 1000).toISOString();

  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    // Stickers are Documents with a Sticker attribute — Tauri's
    // grammers Media enum splits them out (Media::Sticker), but gramjs
    // returns them under MessageMediaDocument so we have to filter
    // explicitly. Otherwise stickers leak into the file list.
    const isSticker = doc.attributes.some(
      (a) => a instanceof Api.DocumentAttributeSticker,
    );
    if (isSticker) return null;
    const mime = doc.mimeType;
    const { name, ext } = extractFilename(doc, mime);
    const videoAttr = doc.attributes.find(
      (a): a is Api.DocumentAttributeVideo => a instanceof Api.DocumentAttributeVideo,
    );
    const duration_secs = videoAttr ? Math.ceil(Number(videoAttr.duration ?? 0)) : null;
    return {
      id: msg.id,
      folder_id: folderId,
      name,
      size: asNumber(doc.size),
      mime_type: mime ?? null,
      file_ext: ext,
      created_at: date,
      icon_type: "file",
      duration_secs,
    };
  }
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    const photo = media.photo;
    const largest = photo.sizes
      .map((s) => ("size" in s ? Number((s as { size: number }).size) : 0))
      .reduce((a: number, b: number) => Math.max(a, b), 0);
    return {
      id: msg.id,
      folder_id: folderId,
      name: "Photo.jpg",
      size: largest,
      mime_type: "image/jpeg",
      file_ext: "jpg",
      created_at: date,
      icon_type: "file",
    };
  }
  return null;
}
