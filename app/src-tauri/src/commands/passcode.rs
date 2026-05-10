//! Local app passcode — separate from Telegram's cloud 2FA password.
//!
//! Encrypts the on-disk `telegram.session` SQLite file with a key derived
//! from the user's chosen passcode (Argon2id → 32-byte key) and AES-256-GCM
//! authenticated encryption. The plaintext SQLite file only exists on disk
//! while the app is unlocked and running; on graceful shutdown it's
//! re-encrypted into `telegram.session.enc` and the plaintext is wiped.
//!
//! Storage layout under `app_data_dir`:
//!
//!   passcode.json        — { v, salt, verifier_nonce, verifier_ct }
//!                          - `v`: format version (1)
//!                          - `salt`: 16-byte salt for Argon2id (base64)
//!                          - `verifier_*`: AES-GCM-encrypted constant
//!                            payload used to validate that an entered
//!                            passcode produces the right key without
//!                            having to decrypt the entire session.
//!   telegram.session     — plaintext SQLite, exists only while unlocked.
//!   telegram.session.enc — encrypted blob: 12-byte nonce || ciphertext+tag.
//!
//! Threat model: protects the session against an attacker with read-only
//! access to the user's home directory at rest. Does NOT protect against an
//! attacker with code-execution or memory access while the app is running.

use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

use crate::TelegramState;

const SESSION_PLAINTEXT: &str = "telegram.session";
const SESSION_ENCRYPTED: &str = "telegram.session.enc";
const PASSCODE_META_FILE: &str = "passcode.json";

// Argon2id parameters. 64 MiB memory, 3 iterations, 1 thread is the modern
// "interactive" recommendation — fast enough on a desktop, painful for an
// offline brute-force.
const ARGON2_MEM_KIB: u32 = 64 * 1024;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;
const KEY_LEN: usize = 32; // AES-256
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const VERIFIER_PAYLOAD: &[u8] = b"telegram-drive-passcode-v1";

#[derive(Debug, Serialize, Deserialize)]
struct PasscodeMeta {
    v: u32,
    salt: String,
    verifier_nonce: String,
    verifier_ct: String,
}

/// What the frontend needs to know to decide which screen to render.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PasscodeStatus {
    /// No passcode has ever been configured. App is open.
    Disabled,
    /// Passcode is configured and the app has not been unlocked yet.
    Locked,
    /// Passcode is configured and has been verified this session.
    Unlocked,
}

fn paths(app_data_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        app_data_dir.join(SESSION_PLAINTEXT),
        app_data_dir.join(SESSION_ENCRYPTED),
        app_data_dir.join(PASSCODE_META_FILE),
    )
}

fn derive_key(passcode: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let params = Params::new(ARGON2_MEM_KIB, ARGON2_ITERATIONS, ARGON2_PARALLELISM, Some(KEY_LEN))
        .map_err(|e| format!("argon2 params: {}", e))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passcode.as_bytes(), salt, &mut out)
        .map_err(|e| format!("argon2 hash: {}", e))?;
    Ok(out)
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

fn aead_encrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad: b"" })
        .map_err(|e| format!("encrypt: {}", e))
}

fn aead_decrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad: b"" })
        .map_err(|e| format!("decrypt: {}", e))
}

fn read_meta(meta_path: &Path) -> Result<Option<PasscodeMeta>, String> {
    if !meta_path.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(meta_path).map_err(|e| e.to_string())?;
    let m: PasscodeMeta = serde_json::from_str(&s).map_err(|e| format!("bad meta: {}", e))?;
    Ok(Some(m))
}

fn write_meta(meta_path: &Path, meta: &PasscodeMeta) -> Result<(), String> {
    let s = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path, s).map_err(|e| e.to_string())
}

/// Read meta + verify passcode + return the derived key. Used by every
/// passcode-bearing command path that needs to act on the session.
fn verify_and_derive(meta: &PasscodeMeta, passcode: &str) -> Result<[u8; KEY_LEN], String> {
    let salt = B64.decode(&meta.salt).map_err(|e| format!("bad salt: {}", e))?;
    if salt.len() != SALT_LEN {
        return Err("salt length wrong".into());
    }
    let nonce_bytes = B64.decode(&meta.verifier_nonce).map_err(|e| format!("bad verifier nonce: {}", e))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("verifier nonce length wrong".into());
    }
    let ct = B64.decode(&meta.verifier_ct).map_err(|e| format!("bad verifier ct: {}", e))?;

    let key = derive_key(passcode, &salt)?;
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&nonce_bytes);
    match aead_decrypt(&key, &nonce, &ct) {
        Ok(pt) if pt == VERIFIER_PAYLOAD => Ok(key),
        Ok(_) => {
            // Same key worked but verifier payload differs — meta corrupted.
            Err("Passcode verifier mismatch".into())
        }
        Err(_) => Err("Incorrect passcode".into()),
    }
}

/// Encrypt the live plaintext session file with `key` and wipe the plaintext.
/// Called by the RunEvent::Exit handler in `lib.rs` and after a successful
/// `cmd_passcode_set` / `cmd_passcode_change`. Safe to call when the
/// plaintext file does not exist (no-op).
pub fn seal_session_with_key(app_data_dir: &Path, key: &[u8; KEY_LEN]) -> Result<(), String> {
    let (plain, enc, _) = paths(app_data_dir);
    if !plain.exists() {
        return Ok(());
    }
    let mut bytes = std::fs::read(&plain).map_err(|e| e.to_string())?;
    let nonce_v = random_bytes(NONCE_LEN);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&nonce_v);
    let ct = aead_encrypt(key, &nonce, &bytes)?;
    bytes.zeroize();

    // Atomic-ish replace: write to .tmp then rename.
    let tmp = enc.with_extension("enc.tmp");
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    std::fs::write(&tmp, &blob).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &enc).map_err(|e| e.to_string())?;

    // Best-effort wipe of the plaintext file. SQLite WAL/SHM sidecars are
    // also derived from the session and should not leak.
    let _ = std::fs::remove_file(&plain);
    let _ = std::fs::remove_file(plain.with_extension("session-wal"));
    let _ = std::fs::remove_file(plain.with_extension("session-shm"));
    Ok(())
}

/// Decrypt the encrypted blob into the plaintext session path. Used by
/// cmd_passcode_unlock to bring the session online.
fn unseal_session_with_key(app_data_dir: &Path, key: &[u8; KEY_LEN]) -> Result<(), String> {
    let (plain, enc, _) = paths(app_data_dir);
    if !enc.exists() {
        return Err("No encrypted session found".into());
    }
    let blob = std::fs::read(&enc).map_err(|e| e.to_string())?;
    if blob.len() < NONCE_LEN + 16 {
        return Err("Encrypted session is truncated".into());
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&blob[..NONCE_LEN]);
    let ct = &blob[NONCE_LEN..];
    let mut pt = aead_decrypt(key, &nonce, ct)
        .map_err(|_| "Failed to decrypt session — passcode wrong or session corrupted".to_string())?;
    std::fs::write(&plain, &pt).map_err(|e| e.to_string())?;
    pt.zeroize();
    Ok(())
}

#[tauri::command]
pub fn cmd_passcode_status(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<PasscodeStatus, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_path = app_data_dir.join(PASSCODE_META_FILE);
    if !meta_path.exists() {
        return Ok(PasscodeStatus::Disabled);
    }
    if state.passcode_unlocked.load(std::sync::atomic::Ordering::SeqCst) {
        Ok(PasscodeStatus::Unlocked)
    } else {
        Ok(PasscodeStatus::Locked)
    }
}

#[tauri::command]
pub fn cmd_passcode_set(
    passcode: String,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    if passcode.len() < 4 {
        return Err("Passcode must be at least 4 characters".into());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    let meta_path = app_data_dir.join(PASSCODE_META_FILE);
    if meta_path.exists() {
        return Err("Passcode already set — use cmd_passcode_change".into());
    }

    // Derive key and verifier
    let salt = random_bytes(SALT_LEN);
    let key = derive_key(&passcode, &salt)?;
    let verifier_nonce_v = random_bytes(NONCE_LEN);
    let mut verifier_nonce = [0u8; NONCE_LEN];
    verifier_nonce.copy_from_slice(&verifier_nonce_v);
    let verifier_ct = aead_encrypt(&key, &verifier_nonce, VERIFIER_PAYLOAD)?;

    let meta = PasscodeMeta {
        v: 1,
        salt: B64.encode(&salt),
        verifier_nonce: B64.encode(verifier_nonce),
        verifier_ct: B64.encode(&verifier_ct),
    };
    write_meta(&meta_path, &meta)?;

    // Do NOT seal+unseal the live plaintext here. cmd_passcode_set runs while
    // grammers already has the SQLite session open; deleting that file under
    // it (seal wipes the plaintext) and writing a fresh one (unseal) leaves
    // grammers holding a stale inode. The next write inside grammers panics
    // with "attempt to write a readonly database" and poisons its session
    // mutex. We just stash the key + flip the unlocked flag — the Exit
    // handler in lib.rs::RunEvent::Exit will run seal_session_with_key on
    // graceful shutdown, which is when the grammers runner is being torn
    // down anyway.
    *state.passcode_key.lock().unwrap() = Some(key);
    state.passcode_unlocked.store(true, std::sync::atomic::Ordering::SeqCst);

    Ok(())
}

/// Force the app back into the locked state without quitting. Called by the
/// idle auto-lock timer and by an explicit "Lock now" button. Idempotent —
/// no-op when no passcode is configured. Drops the cached key from memory.
#[tauri::command]
pub fn cmd_passcode_lock(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_path = app_data_dir.join(PASSCODE_META_FILE);
    if !meta_path.exists() {
        return Ok(());
    }
    if let Ok(mut k) = state.passcode_key.lock() {
        if let Some(mut bytes) = k.take() {
            bytes.zeroize();
        }
    }
    state.passcode_unlocked.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn cmd_passcode_unlock(
    passcode: String,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_path = app_data_dir.join(PASSCODE_META_FILE);
    let meta = read_meta(&meta_path)?
        .ok_or_else(|| "No passcode is set".to_string())?;

    let key = match verify_and_derive(&meta, &passcode) {
        Ok(k) => k,
        Err(e) => {
            // Increment killswitch counter on a wrong passcode. Other errors
            // (corrupt meta, missing files) shouldn't punish the user.
            if e == "Incorrect passcode" {
                crate::commands::locks::attempts_increment(&app, crate::commands::locks::PASSCODE_ATTEMPTS_KEY);
            }
            return Err(e);
        }
    };

    // Bring session bytes back to disk. If a stale plaintext session is
    // already present (e.g. ungraceful shutdown), trust it — the encrypted
    // copy may be older. Either way, the passcode entry has gated access.
    let (plain, enc, _) = paths(&app_data_dir);
    if !plain.exists() && enc.exists() {
        unseal_session_with_key(&app_data_dir, &key)?;
    }

    *state.passcode_key.lock().unwrap() = Some(key);
    state.passcode_unlocked.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::commands::locks::attempts_reset(&app, crate::commands::locks::PASSCODE_ATTEMPTS_KEY);
    Ok(())
}

#[tauri::command]
pub fn cmd_get_passcode_attempts(app: AppHandle) -> Result<u32, String> {
    Ok(crate::commands::locks::attempts_get(&app, crate::commands::locks::PASSCODE_ATTEMPTS_KEY))
}

#[tauri::command]
pub fn cmd_passcode_change(
    old_passcode: String,
    new_passcode: String,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    if new_passcode.len() < 4 {
        return Err("New passcode must be at least 4 characters".into());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_path = app_data_dir.join(PASSCODE_META_FILE);
    let meta = read_meta(&meta_path)?
        .ok_or_else(|| "No passcode is set".to_string())?;

    let _old_key = verify_and_derive(&meta, &old_passcode)?;

    // Build a fresh meta + key under the new passcode.
    let salt = random_bytes(SALT_LEN);
    let new_key = derive_key(&new_passcode, &salt)?;
    let verifier_nonce_v = random_bytes(NONCE_LEN);
    let mut verifier_nonce = [0u8; NONCE_LEN];
    verifier_nonce.copy_from_slice(&verifier_nonce_v);
    let verifier_ct = aead_encrypt(&new_key, &verifier_nonce, VERIFIER_PAYLOAD)?;
    let new_meta = PasscodeMeta {
        v: 1,
        salt: B64.encode(&salt),
        verifier_nonce: B64.encode(verifier_nonce),
        verifier_ct: B64.encode(&verifier_ct),
    };
    write_meta(&meta_path, &new_meta)?;

    // Same constraint as cmd_passcode_set: grammers has the SQLite session
    // open right now, so we must not delete + recreate the plaintext file.
    // Just rotate the cached key — the Exit handler will encrypt the live
    // plaintext under new_key on graceful shutdown.
    *state.passcode_key.lock().unwrap() = Some(new_key);
    state.passcode_unlocked.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Nuclear "forgot passcode" reset. Drops the encrypted session + the
/// passcode metadata + any leftover plaintext SQLite without verifying any
/// passcode. The caller is *required* to follow up with a fresh re-auth
/// because there is no remaining session to use. Frontend gates this
/// behind a confirmation dialog.
#[tauri::command]
pub fn cmd_passcode_reset(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (plain, enc, meta) = paths(&app_data_dir);
    let _ = std::fs::remove_file(&plain);
    let _ = std::fs::remove_file(plain.with_extension("session-wal"));
    let _ = std::fs::remove_file(plain.with_extension("session-shm"));
    let _ = std::fs::remove_file(&enc);
    let _ = std::fs::remove_file(&meta);

    if let Ok(mut k) = state.passcode_key.lock() {
        if let Some(mut bytes) = k.take() {
            bytes.zeroize();
        }
    }
    state.passcode_unlocked.store(false, std::sync::atomic::Ordering::SeqCst);
    log::info!("Passcode reset: passcode metadata and session wiped");
    Ok(())
}

#[tauri::command]
pub fn cmd_passcode_remove(
    passcode: String,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_path = app_data_dir.join(PASSCODE_META_FILE);
    let meta = read_meta(&meta_path)?
        .ok_or_else(|| "No passcode is set".to_string())?;
    let key = verify_and_derive(&meta, &passcode)?;

    // Make sure the live plaintext session exists before we drop the
    // encrypted blob and meta — otherwise we'd lose the session entirely.
    let (plain, enc, _) = paths(&app_data_dir);
    if !plain.exists() && enc.exists() {
        unseal_session_with_key(&app_data_dir, &key)?;
    }
    let _ = std::fs::remove_file(&enc);
    let _ = std::fs::remove_file(&meta_path);

    // Drop the cached key + flag — there's no passcode anymore.
    let mut k = state.passcode_key.lock().unwrap();
    if let Some(mut bytes) = k.take() {
        bytes.zeroize();
    }
    state.passcode_unlocked.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}
