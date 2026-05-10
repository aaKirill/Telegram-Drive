use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::collections::{HashMap, HashSet};
use tokio::sync::Mutex;
use grammers_client::{Client};
use grammers_client::types::{LoginToken, PasswordToken, Peer};

/// Tracks the lifecycle of the Telegram connection
/// 
/// IMPORTANT: The `runner_shutdown` field is critical for preventing stack overflow.
/// When reconnecting, we MUST shutdown the old runner before spawning a new one.
/// Without this, runner tasks accumulate and exhaust the thread stack.
#[derive(Clone)]
pub struct TelegramState {
    pub client: Arc<Mutex<Option<Client>>>,
    pub login_token: Arc<Mutex<Option<LoginToken>>>,
    pub password_token: Arc<Mutex<Option<PasswordToken>>>,
    pub api_id: Arc<Mutex<Option<i32>>>,
    /// Send to this channel to request runner shutdown.
    /// Uses std::sync::Mutex (not tokio) so it can be locked from synchronous
    /// contexts like the RunEvent::Exit handler.
    pub runner_shutdown: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Counter for debugging runner lifecycle
    pub runner_count: Arc<std::sync::atomic::AtomicU32>,
    /// Cache of folder_id → Peer to avoid O(N) dialog scanning on every operation.
    /// Populated lazily on first resolve_peer call, eagerly during cmd_scan_folders.
    /// Cleared on logout.
    pub peer_cache: Arc<tokio::sync::RwLock<HashMap<i64, Peer>>>,
    /// True if the local app passcode (if any is set) has been verified for
    /// this session. When `false` and a passcode is configured on disk, all
    /// session-touching commands refuse to run. Cleared on app start.
    pub passcode_unlocked: Arc<AtomicBool>,
    /// Argon2id-derived key from the user's passcode, kept in memory only
    /// while the app is unlocked. Used by the RunEvent::Exit handler to
    /// re-encrypt the live `telegram.session` on graceful shutdown without
    /// re-prompting the user. Zeroized on logout / re-lock.
    pub passcode_key: Arc<std::sync::Mutex<Option<[u8; 32]>>>,
    /// Bumped on every cmd_connect (which fires on every webview reload).
    /// Long-running walk commands (cmd_get_files, cmd_scan_folders,
    /// cmd_sync_read, cmd_search_global) capture this value at start and
    /// re-check between iterations — when it changes they bail, freeing
    /// grammers' sender for the fresh request that just came in. Without
    /// this, orphan walks from prior sessions stack and serialize behind
    /// each other on reload.
    pub generation: Arc<AtomicU64>,
    /// Transfer ids the user has cancelled. Insert here from cmd_cancel_transfer;
    /// the upload progress task and the download chunk loop both poll this set
    /// and abort early. Entries are removed by the cancelled command path itself
    /// once the in-flight transfer notices and returns "Transfer cancelled".
    pub cancelled_transfers: Arc<tokio::sync::RwLock<HashSet<String>>>,
}

pub mod auth;
pub mod fs;
pub mod preview;
pub mod utils;
pub mod network;
pub mod streaming;
pub mod locks;
pub mod passcode;
pub mod sync;

pub use auth::*;
pub use fs::*;
pub use preview::*;
pub use utils::*;
pub use network::*;
pub use streaming::*;
pub use locks::*;
pub use passcode::*;
pub use sync::*;
