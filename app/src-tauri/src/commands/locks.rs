use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::RwLock;

const STORE_FILE: &str = "folder-locks.json";
const ATTEMPTS_FILE: &str = "lock-attempts.json";

/// Per-session set of folder keys that have been unlocked. Keys map 1:1 to
/// folder_key(folder_id). Saved Messages uses "home" as its key.
#[derive(Default, Clone)]
pub struct LockState {
    pub unlocked: Arc<RwLock<HashSet<String>>>,
}

impl LockState {
    pub fn new() -> Self {
        Self {
            unlocked: Arc::new(RwLock::new(HashSet::new())),
        }
    }
}

fn folder_key(folder_id: Option<i64>) -> String {
    match folder_id {
        Some(id) => id.to_string(),
        None => "home".to_string(),
    }
}

fn store_get_hash(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    let v = store.get(key)?;
    v.as_str().map(String::from)
}

fn store_set_hash(app: &AppHandle, key: &str, hash: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(key, serde_json::Value::String(hash.to_string()));
    store.save().map_err(|e| e.to_string())
}

fn store_remove_hash(app: &AppHandle, key: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(key);
    store.save().map_err(|e| e.to_string())
}

fn store_keys(app: &AppHandle) -> Vec<String> {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    store.keys()
}

pub const PASSCODE_ATTEMPTS_KEY: &str = "_passcode";

// Failed-unlock counter, used by the killswitch feature. Persistent across
// restarts so an attacker can't bypass by killing and re-launching the app.
pub fn attempts_get(app: &AppHandle, key: &str) -> u32 {
    let store = match app.store(ATTEMPTS_FILE) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    store.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(0)
}

fn attempts_set(app: &AppHandle, key: &str, n: u32) {
    if let Ok(store) = app.store(ATTEMPTS_FILE) {
        store.set(key, serde_json::Value::from(n));
        let _ = store.save();
    }
}

pub fn attempts_increment(app: &AppHandle, key: &str) -> u32 {
    let n = attempts_get(app, key) + 1;
    attempts_set(app, key, n);
    n
}

pub fn attempts_reset(app: &AppHandle, key: &str) {
    if let Ok(store) = app.store(ATTEMPTS_FILE) {
        store.delete(key);
        let _ = store.save();
    }
}

#[tauri::command]
pub async fn cmd_get_lock_attempts(
    folder_id: Option<i64>,
    app: AppHandle,
) -> Result<u32, String> {
    Ok(attempts_get(&app, &folder_key(folder_id)))
}

/// Drop any lock metadata for a folder that has been (or is being) deleted on
/// Telegram. No password verification — the channel itself is gone, so the
/// hash is meaningless. Called from cmd_delete_folder to prevent stale entries
/// from surfacing in the sidebar's "X locked folder(s)" indicator.
pub async fn forget_folder_lock(
    app: &AppHandle,
    state: &LockState,
    folder_id: Option<i64>,
) {
    let key = folder_key(folder_id);
    let _ = store_remove_hash(app, &key);
    state.unlocked.write().await.remove(&key);
}

/// Prune lock entries for folders that no longer exist in the user's known
/// folder list. Called by the frontend whenever the folder list is loaded —
/// catches orphans left over from deletions that happened before the cleanup
/// path was wired up, or from folders deleted on another device.
///
/// "home" (Saved Messages) is always preserved since Saved Messages always
/// exists. Anything else whose i64 form isn't in `valid_folder_ids` is dropped.
#[tauri::command]
pub async fn cmd_prune_orphan_locks(
    valid_folder_ids: Vec<i64>,
    app: AppHandle,
    state: State<'_, LockState>,
) -> Result<u32, String> {
    let valid: HashSet<String> = valid_folder_ids.iter().map(|id| id.to_string()).collect();
    let mut removed = 0u32;
    for key in store_keys(&app) {
        if key == "home" || valid.contains(&key) {
            continue;
        }
        if store_remove_hash(&app, &key).is_ok() {
            state.unlocked.write().await.remove(&key);
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("[locks] pruned {} orphan lock entr{}", removed, if removed == 1 { "y" } else { "ies" });
    }
    Ok(removed)
}

#[tauri::command]
pub async fn cmd_lock_folder(
    folder_id: Option<i64>,
    password: String,
    app: AppHandle,
    state: State<'_, LockState>,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("Password cannot be empty".into());
    }
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| e.to_string())?
        .to_string();
    let key = folder_key(folder_id);
    store_set_hash(&app, &key, &hash)?;
    // Newly locked: drop any prior in-memory unlock so it has to be re-entered.
    state.unlocked.write().await.remove(&key);
    Ok(())
}

#[tauri::command]
pub async fn cmd_unlock_folder(
    folder_id: Option<i64>,
    password: String,
    app: AppHandle,
    state: State<'_, LockState>,
) -> Result<bool, String> {
    let key = folder_key(folder_id);
    let stored = match store_get_hash(&app, &key) {
        Some(h) => h,
        None => return Ok(true), // not locked
    };
    let parsed = PasswordHash::new(&stored).map_err(|e| e.to_string())?;
    if Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
    {
        attempts_reset(&app, &key);
        state.unlocked.write().await.insert(key);
        Ok(true)
    } else {
        attempts_increment(&app, &key);
        Ok(false)
    }
}

#[tauri::command]
pub async fn cmd_remove_lock(
    folder_id: Option<i64>,
    password: String,
    app: AppHandle,
    state: State<'_, LockState>,
) -> Result<bool, String> {
    let key = folder_key(folder_id);
    let stored = match store_get_hash(&app, &key) {
        Some(h) => h,
        None => return Ok(true),
    };
    let parsed = PasswordHash::new(&stored).map_err(|e| e.to_string())?;
    if Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
    {
        store_remove_hash(&app, &key)?;
        attempts_reset(&app, &key);
        state.unlocked.write().await.insert(key);
        Ok(true)
    } else {
        attempts_increment(&app, &key);
        Ok(false)
    }
}

/// Returns folder keys that are locked AND not currently unlocked this session.
/// Frontend uses this to hide them from the sidebar / file grid.
#[tauri::command]
pub async fn cmd_list_locked_keys(
    app: AppHandle,
    state: State<'_, LockState>,
) -> Result<Vec<String>, String> {
    let keys = store_keys(&app);
    let unlocked = state.unlocked.read().await;
    Ok(keys.into_iter().filter(|k| !unlocked.contains(k)).collect())
}

/// Returns all folder keys that have a password set (regardless of unlock state).
/// Used by the "Show locked folders" toggle UI.
#[tauri::command]
pub async fn cmd_list_all_locked_keys(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(store_keys(&app))
}

#[tauri::command]
pub async fn cmd_is_folder_locked(
    folder_id: Option<i64>,
    app: AppHandle,
    state: State<'_, LockState>,
) -> Result<bool, String> {
    let key = folder_key(folder_id);
    if store_get_hash(&app, &key).is_none() {
        return Ok(false);
    }
    Ok(!state.unlocked.read().await.contains(&key))
}

/// Re-lock a folder for this session (without removing the password).
#[tauri::command]
pub async fn cmd_relock_folder(
    folder_id: Option<i64>,
    state: State<'_, LockState>,
) -> Result<(), String> {
    let key = folder_key(folder_id);
    state.unlocked.write().await.remove(&key);
    Ok(())
}
