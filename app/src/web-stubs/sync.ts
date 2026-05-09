// Web side of the cross-device sync. Snapshots are stored as documents in
// the user's Saved Messages chat (their own chat with themselves). Saved
// Messages always exists, syncs across every Telegram client by design,
// and avoids the duplicate-channel hazard that plagued the previous
// dedicated-channel scheme. Document filename is `td-sync.json` so a
// server-side messages.search filtered to documents picks them out
// without scanning the whole chat history.

import { Api } from "telegram";
import bigInt from "big-integer";
import { get as idbGet, set as idbSet } from "idb-keyval";
import { ensureClient } from "./client";

const SYNC_FILENAME = "td-sync.json";

// Legacy migration: an older build created a dedicated channel for sync
// data. We match it by exact title and bound the dialog walk so a chatty
// account doesn't pay for a full GetFullChannel-per-channel scan that
// contends with foreground commands on the gramjs request queue.
const LEGACY_CHANNEL_TITLE = "Telegram Drive Sync";
const LEGACY_DIALOG_WALK_LIMIT = 100;
const LEGACY_MIGRATION_KEY = "td:legacy-sync-cleanup-done";

// Single in-flight Promise dedupes concurrent migration calls. The
// previous "let migrationRan = false" pattern had a TOCTOU between the
// synchronous `if (migrationRan) return` and the `await idbGet(...)`
// that followed — two concurrent calls would both pass the check and
// both walk dialogs. Holding one Promise removes that window.
let migrationPromise: Promise<void> | null = null;

function runLegacyMigration(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if ((await idbGet<boolean>(LEGACY_MIGRATION_KEY)) === true) return;
    const c = await ensureClient();
    const toDelete: Api.Channel[] = [];
    let walked = 0;
    try {
      for await (const d of c.iterDialogs({})) {
        if (walked >= LEGACY_DIALOG_WALK_LIMIT) break;
        walked++;
        const e = d.entity;
        if (!(e instanceof Api.Channel)) continue;
        if (e.megagroup) continue;
        if (e.title === LEGACY_CHANNEL_TITLE) {
          toDelete.push(e);
        }
      }
    } catch (err) {
      console.warn("[td] legacy migration walk hit an error (non-fatal):", err);
    }
    let deleted = 0;
    for (const ch of toDelete) {
      try {
        await c.invoke(
          new Api.channels.DeleteChannel({
            channel: new Api.InputChannel({
              channelId: ch.id,
              accessHash: ch.accessHash ?? bigInt(0),
            }),
          }),
        );
        deleted++;
        console.log("[td] deleted legacy sync channel", ch.id.toString());
      } catch (err) {
        console.warn("[td] failed to delete legacy sync channel", ch.id.toString(), err);
      }
    }
    await idbSet(LEGACY_MIGRATION_KEY, true);
    console.log(`[td] legacy cleanup: scanned ${walked} dialog(s), removed ${deleted} sync channel(s)`);
  })();
  return migrationPromise;
}

async function pruneOldSnapshots(folderId: number | null, keepMessageId: number): Promise<void> {
  const c = await ensureClient();
  const target = folderId == null ? "me" : bigInt(folderId);
  const messages = await c.getMessages(target, {
    search: SYNC_FILENAME,
    filter: new Api.InputMessagesFilterDocument(),
    limit: 50,
  });
  const toDelete: number[] = [];
  for (const msg of messages) {
    if (!(msg instanceof Api.Message)) continue;
    if (msg.id === keepMessageId) continue;
    if (!(msg.media instanceof Api.MessageMediaDocument)) continue;
    if (!(msg.media.document instanceof Api.Document)) continue;
    const attr = msg.media.document.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    if (attr?.fileName === SYNC_FILENAME) {
      toDelete.push(msg.id);
    }
  }
  if (toDelete.length === 0) return;
  try {
    await c.deleteMessages(target, toDelete, { revoke: true });
    console.log(`[td] pruned ${toDelete.length} old td-sync.json snapshot(s)`);
  } catch (err) {
    console.warn("[td] failed to prune old td-sync.json messages:", err);
  }
}

async function syncTarget(folderId: number | null): Promise<"me" | bigInt.BigInteger> {
  return folderId == null ? "me" : bigInt(folderId);
}

// Delete every td-sync.json document at the given location. Frontend
// invokes this when the sync folder selection changes so stale snapshots
// don't linger in the abandoned target.
export async function syncPurge(folderId: number | null): Promise<number> {
  const c = await ensureClient();
  const target = folderId == null ? "me" : bigInt(folderId);
  const messages = await c.getMessages(target, {
    search: SYNC_FILENAME,
    filter: new Api.InputMessagesFilterDocument(),
    limit: 100,
  });
  const ids: number[] = [];
  for (const msg of messages) {
    if (!(msg instanceof Api.Message)) continue;
    if (!(msg.media instanceof Api.MessageMediaDocument)) continue;
    if (!(msg.media.document instanceof Api.Document)) continue;
    const attr = msg.media.document.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    if (attr?.fileName === SYNC_FILENAME) ids.push(msg.id);
  }
  if (ids.length === 0) return 0;
  try {
    await c.deleteMessages(target, ids, { revoke: true });
  } catch (err) {
    console.warn("[td] sync purge failed:", err);
    throw err;
  }
  return ids.length;
}

export async function syncRead(folderId: number | null): Promise<Uint8Array | null> {
  await runLegacyMigration();
  const c = await ensureClient();
  const target = await syncTarget(folderId);
  const messages = await c.getMessages(target, {
    search: SYNC_FILENAME,
    filter: new Api.InputMessagesFilterDocument(),
    limit: 20,
  });
  let latest: Api.Message | null = null;
  for (const msg of messages) {
    if (!(msg instanceof Api.Message)) continue;
    if (!(msg.media instanceof Api.MessageMediaDocument)) continue;
    if (!(msg.media.document instanceof Api.Document)) continue;
    const attr = msg.media.document.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    if (attr?.fileName === SYNC_FILENAME) {
      latest = msg;
      break;
    }
  }
  if (!latest || !latest.media) return null;
  const buf = await c.downloadMedia(latest);
  return (buf as Uint8Array | undefined) ?? null;
}

export async function syncWrite(bytes: number[] | Uint8Array, folderId: number | null): Promise<void> {
  await runLegacyMigration();
  const c = await ensureClient();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const file = new File([data], SYNC_FILENAME, { type: "application/json" });
  const target = await syncTarget(folderId);

  const sentMsg = await c.sendFile(target, { file, forceDocument: true });
  // sendFile returns the resulting message; its id is what we want to
  // preserve through the cleanup pass.
  const keepId = sentMsg && "id" in sentMsg ? Number((sentMsg as { id: number | bigInt.BigInteger }).id) : -1;
  await pruneOldSnapshots(folderId, keepId);
}
