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

export async function deleteFolder(folderId: number): Promise<boolean> {
  const c = await ensureClient();
  const entity = await c.getInputEntity(bigInt(folderId));
  if (!(entity instanceof Api.InputPeerChannel)) {
    throw new Error("Folder is not a channel");
  }
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
  const target: "me" | Awaited<ReturnType<typeof c.getInputEntity>> =
    folderId == null ? "me" : await c.getInputEntity(bigInt(folderId));
  const out: FileMetadata[] = [];
  // 2000-message cap. Removing the cap entirely caused gramjs to hang /
  // time out mid-walk on chats with thousands of items (browser is
  // slower than grammers in Rust, and the WSS connection drops on long
  // walks), leaving the UI stuck on "Loading your files...". 2000 covers
  // the typical [TD] folder fully and gives Saved Messages the most
  // recent ~2000 messages worth of media.
  for await (const msg of c.iterMessages(target, { limit: 2000 })) {
    const m = mapMessageToFile(msg, folderId);
    if (m) out.push(m);
  }
  return out;
}

export async function deleteFile(messageId: number, folderId: number | null): Promise<boolean> {
  const c = await ensureClient();
  // For Saved Messages (folderId null), pass "me" so gramjs resolves to
  // the self peer. Passing undefined here makes deleteMessages do a
  // global "find this message anywhere" which is wrong.
  const entity = folderId == null ? "me" : await c.getInputEntity(bigInt(folderId));
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
  const src = sourceFolderId == null ? "me" : await c.getInputEntity(bigInt(sourceFolderId));
  const dst = targetFolderId == null ? "me" : await c.getInputEntity(bigInt(targetFolderId));
  // forwardMessages returns the freshly-created Message objects in the
  // destination peer. We map them to FileMetadata so the frontend can
  // optimistic-insert into the target folder cache without waiting on
  // the GetHistory replication lag.
  const forwarded = await c.forwardMessages(dst, { messages: messageIds, fromPeer: src });
  await c.deleteMessages(src, messageIds, { revoke: true });
  const out: FileMetadata[] = [];
  for (const msg of forwarded ?? []) {
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
    return {
      id: msg.id,
      folder_id: folderId,
      name,
      size: asNumber(doc.size),
      mime_type: mime ?? null,
      file_ext: ext,
      created_at: date,
      icon_type: "file",
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
