use std::collections::HashMap;
use std::io::Cursor;
use std::sync::OnceLock;

use grammers_client::{Client, InputMessage};
use grammers_client::types::{Media, Peer};
use grammers_tl_types as tl;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex as TokioMutex;

use super::TelegramState;
use super::utils::map_error;

// Cross-device sync rides on Saved Messages — the user's own private chat
// with themselves. Always exists, syncs across every Telegram client by
// design, and avoids the duplicate-channel hazard the previous channel-
// based scheme had. Our snapshots are documents named `td-sync.json`;
// reading just searches Saved Messages for the latest document with that
// filename, writing uploads a new one and prunes older copies so the
// chat doesn't accumulate clutter.

const SYNC_FILENAME: &str = "td-sync.json";

// Legacy migration: an earlier build created a dedicated channel for sync
// data. We match it by exact title ("Telegram Drive Sync") so we can find
// and delete duplicates without a per-channel GetFullChannel round trip
// — that was costing dozens of API calls per startup and contending with
// foreground commands on grammers' single sender. Bounded to the first
// 100 dialogs since the leftover channels are recent and surface at the
// top of iter_dialogs.
const LEGACY_CHANNEL_TITLE: &str = "Telegram Drive Sync";
const LEGACY_DIALOG_WALK_LIMIT: usize = 100;
const LEGACY_MIGRATION_STORE: &str = "sync.json";
const LEGACY_MIGRATION_KEY: &str = "legacy_channel_cleanup_done";

const ATTEMPTS_FILE: &str = "lock-attempts.json";

// --- Saved Messages peer ------------------------------------------------

async fn saved_peer(client: &Client) -> Result<Peer, String> {
    let me = client.get_me().await.map_err(map_error)?;
    Ok(Peer::User(me))
}

// Resolve the sync target: a [TD] folder if folder_id is Some, otherwise
// Saved Messages. The user can pick which folder hosts the td-sync.json
// snapshots from Settings (default = Saved Messages).
async fn sync_peer(
    client: &Client,
    folder_id: Option<i64>,
    state: &TelegramState,
) -> Result<Peer, String> {
    if let Some(fid) = folder_id {
        super::utils::resolve_peer(client, Some(fid), &state.peer_cache).await
    } else {
        saved_peer(client).await
    }
}

// --- Legacy channel cleanup (one-time migration) ------------------------

// Serializes concurrent cleanup invocations. cmd_sync_read and
// cmd_sync_write can both fire during the same runSync() (read first,
// then push if local is newer); a debounced markDirty can stack a third
// runSync on top. Without this lock all three would TOCTOU past the
// migration flag check, walk dialogs three times in parallel, and queue
// 3× the API ops on grammers' single sender — exactly what was making
// "click Saved Messages" go from 5 s to 2 min on first launch.
static MIGRATION_LOCK: OnceLock<TokioMutex<()>> = OnceLock::new();

async fn cleanup_legacy_channels(app: &AppHandle, client: &Client) -> Result<(), String> {
    let lock = MIGRATION_LOCK.get_or_init(|| TokioMutex::new(()));
    let _guard = lock.lock().await;

    let store = match app.store(LEGACY_MIGRATION_STORE) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    // Re-check flag after acquiring the lock — a previous holder may have
    // just finished and set it.
    if store.get(LEGACY_MIGRATION_KEY).and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(());
    }

    // Collect first; delete after the walk closes its iterator. We pair
    // (id, access_hash) for the InputChannel each delete needs.
    let mut to_delete: Vec<(i64, i64)> = Vec::new();
    let mut walked = 0usize;
    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if walked >= LEGACY_DIALOG_WALK_LIMIT {
            break;
        }
        walked += 1;
        if let Peer::Channel(c) = &dialog.peer {
            let chan = &c.raw;
            if chan.megagroup {
                continue;
            }
            if chan.title == LEGACY_CHANNEL_TITLE {
                to_delete.push((chan.id, chan.access_hash.unwrap_or(0)));
            }
        }
    }

    let mut deleted = 0u32;
    for (id, access_hash) in to_delete {
        let input_chan = tl::enums::InputChannel::Channel(tl::types::InputChannel {
            channel_id: id,
            access_hash,
        });
        match client
            .invoke(&tl::functions::channels::DeleteChannel { channel: input_chan })
            .await
        {
            Ok(_) => {
                deleted += 1;
                log::info!("[sync] deleted legacy sync channel {}", id);
            }
            Err(e) => log::warn!(
                "[sync] failed to delete legacy sync channel {}: {}",
                id, e,
            ),
        }
    }

    store.set(LEGACY_MIGRATION_KEY, serde_json::Value::Bool(true));
    let _ = store.save();
    log::info!(
        "[sync] legacy channel cleanup complete: scanned {} dialog(s), removed {} sync channel(s)",
        walked, deleted,
    );
    Ok(())
}

// --- Read / write commands ----------------------------------------------

#[tauri::command]
pub async fn cmd_sync_read(
    folder_id: Option<i64>,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Vec<u8>, String> {
    let client_opt = { state.client.lock().await.clone() };
    let Some(client) = client_opt else { return Ok(Vec::new()); };

    if let Err(e) = cleanup_legacy_channels(&app, &client).await {
        log::warn!("[sync] legacy cleanup hit an error (non-fatal): {}", e);
    }

    let peer = sync_peer(&client, folder_id, &state).await?;

    let my_gen = state.generation.load(std::sync::atomic::Ordering::SeqCst);

    // Server-side filename search — "td-sync.json" matches both message
    // text and document filenames in messages.Search. Filter to documents
    // and walk the latest 20 hits, taking the first one whose attached
    // document filename actually equals SYNC_FILENAME.
    let mut search = client
        .search_messages(&peer)
        .query(SYNC_FILENAME)
        .filter(tl::enums::MessagesFilter::InputMessagesFilterDocument)
        .limit(20);

    while let Some(msg) = search.next().await.map_err(map_error)? {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
            return Ok(Vec::new());
        }
        let media = match msg.media() {
            Some(m) => m,
            None => continue,
        };
        if let Media::Document(doc) = &media {
            if doc.name() == SYNC_FILENAME {
                let mut iter = client.iter_download(&media);
                let mut out: Vec<u8> = Vec::new();
                while let Some(chunk) = iter.next().await.map_err(map_error)? {
                    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
                        return Ok(Vec::new());
                    }
                    out.extend_from_slice(&chunk);
                }
                return Ok(out);
            }
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
pub async fn cmd_sync_write(
    bytes: Vec<u8>,
    folder_id: Option<i64>,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    let client_opt = { state.client.lock().await.clone() };
    let Some(client) = client_opt else { return Err("Not connected".to_string()); };

    if let Err(e) = cleanup_legacy_channels(&app, &client).await {
        log::warn!("[sync] legacy cleanup hit an error (non-fatal): {}", e);
    }

    let peer = sync_peer(&client, folder_id, &state).await?;

    let size = bytes.len();
    let mut cursor = Cursor::new(bytes);
    let uploaded = client
        .upload_stream(&mut cursor, size, SYNC_FILENAME.to_string())
        .await
        .map_err(|e| e.to_string())?;

    let message = InputMessage::new().text("").file(uploaded);
    client.send_message(&peer, message).await.map_err(map_error)?;

    // Hygiene: walk the most recent td-sync.json messages and delete all
    // but the one we just sent. Without this Saved Messages would slowly
    // fill with stale snapshots. Bounded to 50 results so a Saved
    // Messages chat with thousands of unrelated entries doesn't pay for
    // a long scan — older snapshots beyond that limit eventually fall
    // off as new writes push them past the search window.
    let my_gen = state.generation.load(std::sync::atomic::Ordering::SeqCst);
    let mut to_delete: Vec<i32> = Vec::new();
    let mut keep_one = true;
    let mut search = client
        .search_messages(&peer)
        .query(SYNC_FILENAME)
        .filter(tl::enums::MessagesFilter::InputMessagesFilterDocument)
        .limit(50);
    while let Some(msg) = search.next().await.map_err(map_error)? {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
            return Ok(());
        }
        let Some(Media::Document(doc)) = msg.media() else { continue; };
        if doc.name() != SYNC_FILENAME {
            continue;
        }
        if keep_one {
            keep_one = false;
        } else {
            to_delete.push(msg.id());
        }
    }
    if !to_delete.is_empty() {
        if let Err(e) = client.delete_messages(&peer, &to_delete).await {
            log::warn!("[sync] failed to prune old td-sync.json messages: {}", e);
        } else {
            log::info!("[sync] pruned {} old td-sync.json snapshot(s)", to_delete.len());
        }
    }
    Ok(())
}

// Purge every td-sync.json document in the given peer. Called by the
// frontend when the user changes the sync folder location, so stale
// snapshots don't pile up at the abandoned target. Bounded the same way
// the post-write prune is — recent 100 results, each round trip yields a
// page of search hits.
#[tauri::command]
pub async fn cmd_sync_purge(
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<u32, String> {
    let client_opt = { state.client.lock().await.clone() };
    let Some(client) = client_opt else { return Ok(0); };
    let peer = sync_peer(&client, folder_id, &state).await?;

    let my_gen = state.generation.load(std::sync::atomic::Ordering::SeqCst);
    let mut to_delete: Vec<i32> = Vec::new();
    let mut search = client
        .search_messages(&peer)
        .query(SYNC_FILENAME)
        .filter(tl::enums::MessagesFilter::InputMessagesFilterDocument)
        .limit(100);
    while let Some(msg) = search.next().await.map_err(map_error)? {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
            return Ok(0);
        }
        let Some(Media::Document(doc)) = msg.media() else { continue; };
        if doc.name() == SYNC_FILENAME {
            to_delete.push(msg.id());
        }
    }
    if to_delete.is_empty() {
        return Ok(0);
    }
    let count = to_delete.len() as u32;
    if let Err(e) = client.delete_messages(&peer, &to_delete).await {
        log::warn!("[sync] purge failed: {}", e);
        return Err(format!("Purge failed: {}", e));
    }
    log::info!("[sync] purged {} td-sync.json snapshot(s) from old location", count);
    Ok(count)
}

// --- Folder-lock export / import ----------------------------------------
//
// Both clients now store verifiers as Argon2id PHC strings, so a snapshot
// pushed from either side can be applied to the other. Old web-only
// {salt, verifier} blobs from before the unification are skipped — the
// user has to set the folder password again to upgrade to the synced
// format.

const LOCK_STORE_FILE: &str = "folder-locks.json";

#[tauri::command]
pub async fn cmd_export_folder_locks(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let store = match app.store(LOCK_STORE_FILE) {
        Ok(s) => s,
        Err(_) => return Ok(HashMap::new()),
    };
    let mut out: HashMap<String, String> = HashMap::new();
    for key in store.keys() {
        if let Some(phc) = store.get(&key).and_then(|v| v.as_str().map(String::from)) {
            if phc.starts_with("$argon2") {
                out.insert(key, phc);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn cmd_import_folder_locks(
    locks: HashMap<String, String>,
    app: AppHandle,
    state: State<'_, super::locks::LockState>,
) -> Result<(), String> {
    let store = app.store(LOCK_STORE_FILE).map_err(|e| e.to_string())?;
    // MERGE-ADD ONLY — never delete existing entries from a sync apply.
    // Locks are user-set credentials; once set on any device they must
    // persist globally until the user explicitly removes them per-device
    // (cmd_remove_lock). The previous wholesale-replace path zeroed every
    // device's locks when a freshly-wiped device pushed an empty snapshot.
    // Trade-off: a "remove password" action doesn't propagate — the user
    // must remove on each device that has the lock. That's the intended
    // contract for global, sticky locks.
    let mut wrote = 0u32;
    for (key, phc) in locks {
        if !phc.starts_with("$argon2") {
            continue;
        }
        // Don't overwrite an existing PHC with a different one — the
        // local entry is just as authoritative as the incoming one for
        // a credential the user already has. Same key → same secret.
        if store.has(&key) {
            continue;
        }
        store.set(&key, serde_json::Value::String(phc));
        wrote += 1;
    }
    if wrote > 0 {
        store.save().map_err(|e| e.to_string())?;
        // New verifiers landed — clear cached unlock decisions for those
        // folders so the user re-enters the password.
        state.unlocked.write().await.clear();
    }
    Ok(())
}

// --- Attempt-counter export / import ------------------------------------

#[tauri::command]
pub async fn cmd_export_lock_attempts(app: AppHandle) -> Result<HashMap<String, u32>, String> {
    let store = match app.store(ATTEMPTS_FILE) {
        Ok(s) => s,
        Err(_) => return Ok(HashMap::new()),
    };
    let mut out: HashMap<String, u32> = HashMap::new();
    for key in store.keys() {
        if let Some(n) = store.get(&key).and_then(|v| v.as_u64()) {
            out.insert(key, n as u32);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn cmd_import_lock_attempts(
    attempts: HashMap<String, u32>,
    app: AppHandle,
) -> Result<(), String> {
    let store = app.store(ATTEMPTS_FILE).map_err(|e| e.to_string())?;
    // Same guard as cmd_import_folder_locks: don't let an empty incoming
    // map zero an existing attempts store.
    if attempts.is_empty() && !store.keys().is_empty() {
        return Ok(());
    }
    // Replace wholesale — the snapshot is the authoritative state.
    for key in store.keys() {
        store.delete(&key);
    }
    for (key, n) in attempts {
        store.set(&key, serde_json::Value::from(n));
    }
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
