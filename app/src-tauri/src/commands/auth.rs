use tauri::State;
use tauri::Manager;
use grammers_client::Client;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use tokio::sync::oneshot;
use tokio::time::Duration;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use grammers_tl_types as tl;

use crate::TelegramState;
use crate::models::{AuthResult};
use crate::commands::utils::map_error;
use grammers_client::SignInError;

/// Ensures the Telegram client is initialized.
/// 
/// IMPORTANT: This function properly manages runner lifecycle to prevent stack overflow.
/// Before spawning a new runner, it signals the old runner to shutdown.
pub async fn ensure_client_initialized(
    app_handle: &tauri::AppHandle,
    state: &State<'_, TelegramState>,
    api_id: i32,
) -> Result<Client, String> {
    let mut client_guard = state.client.lock().await;

    if let Some(client) = client_guard.as_ref() {
        return Ok(client.clone());
    }

    // Defense in depth: if a passcode is configured but not yet unlocked,
    // refuse to bring the client up. The frontend's normal flow shows the
    // lock screen first, but any direct caller (e.g. a tauri command run
    // before unlock) should hit a hard wall here.
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let passcode_meta = app_data_dir.join("passcode.json");
    if passcode_meta.exists()
        && !state.passcode_unlocked.load(Ordering::SeqCst)
    {
        return Err("App is locked. Enter passcode to continue.".into());
    }

    // CRITICAL: Shutdown existing runner before creating a new one
    // This prevents runner task accumulation which causes stack overflow
    let did_shutdown_old_runner = {
        let mut guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = guard.take() {
            log::info!("Signaling old runner to shutdown...");
            let _ = shutdown_tx.send(());
            true
        } else {
            false
        }
    }; // MutexGuard dropped here — before the await
    if did_shutdown_old_runner {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let runner_num = state.runner_count.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!("Initializing Telegram Client #{} with API ID: {}", runner_num, api_id);

    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    
    let session_path = app_data_dir.join("telegram.session");
    let session_path_str = session_path.to_string_lossy().to_string();
    log::info!("Opening session at: {}", session_path_str);
    
    // Grammers initialization with conservative recovery.
    //
    // Old behaviour: any SqliteSession::open error deleted telegram.session
    // (and -wal / -shm). That was reckless — transient errors like "database
    // is locked" (common during a tauri-dev rebuild while the OS hasn't fully
    // released the previous handle) would silently destroy a perfectly good
    // session. The next start would mint a fresh auth key, which invalidates
    // the old one server-side, leading to AUTH_KEY_UNREGISTERED.
    //
    // We now retry with backoff for likely-transient failures and only
    // recreate when SQLite explicitly tells us the file is corrupt.
    let session = {
        const MAX_ATTEMPTS: u32 = 5;
        let mut last_err = String::new();
        let mut opened: Option<SqliteSession> = None;
        for attempt in 1..=MAX_ATTEMPTS {
            match SqliteSession::open(&session_path_str) {
                Ok(s) => { opened = Some(s); break; }
                Err(e) => {
                    let msg = e.to_string();
                    last_err = msg.clone();
                    let lower = msg.to_lowercase();
                    let likely_transient = lower.contains("locked")
                        || lower.contains("busy")
                        || lower.contains("io error")
                        || lower.contains("interrupted");
                    let likely_corrupt = lower.contains("malformed")
                        || lower.contains("not a database")
                        || lower.contains("file is not a database")
                        || lower.contains("disk image");
                    if likely_transient && attempt < MAX_ATTEMPTS {
                        log::warn!(
                            "Session open transient error (attempt {}/{}): {}. Retrying...",
                            attempt, MAX_ATTEMPTS, msg,
                        );
                        tokio::time::sleep(Duration::from_millis(150 * attempt as u64)).await;
                        continue;
                    }
                    if likely_corrupt {
                        log::error!("Session file is corrupted ({}); recreating", msg);
                        let _ = std::fs::remove_file(&session_path);
                        let _ = std::fs::remove_file(format!("{}-wal", session_path_str));
                        let _ = std::fs::remove_file(format!("{}-shm", session_path_str));
                        opened = Some(SqliteSession::open(&session_path_str)
                            .map_err(|e| format!("Failed to open session after recreation: {}", e))?);
                        break;
                    }
                    // Unknown error — surface it instead of nuking the session.
                    return Err(format!("Failed to open session: {}", msg));
                }
            }
        }
        opened.ok_or_else(|| format!("Failed to open session after retries: {}", last_err))?
    };
        
    let session = Arc::new(session);
    let pool = SenderPool::new(session, api_id);
    let client = Client::new(&pool);
    
    // Create shutdown channel for this runner
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *state.runner_shutdown.lock().unwrap() = Some(shutdown_tx);
    
    // Spawn the network runner with shutdown support
    let SenderPool { runner, .. } = pool;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            // Normal runner operation
            _ = runner.run() => {
                log::info!("Runner #{} exited normally", runner_num);
            }
            // Shutdown requested
            _ = shutdown_rx => {
                log::info!("Runner #{} shutdown requested, exiting", runner_num);
            }
        }
    });
    
    *client_guard = Some(client.clone());
    Ok(client)
}

#[tauri::command]
pub async fn cmd_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    api_id: i32,
) -> Result<bool, String> {
    // Store API ID for auto-reconnect
    *state.api_id.lock().await = Some(api_id);
    ensure_client_initialized(&app_handle, &state, api_id).await?;
    Ok(true)
}

/// Called exactly once per fresh JS context (cold start + every webview
/// reload) from main.tsx. Bumps the generation counter so any in-flight
/// walk commands from a prior context bail on their next iteration
/// check, freeing grammers' sender for the fresh React tree's requests.
///
/// We intentionally don't tie this to cmd_connect — multiple hooks call
/// cmd_connect during a single mount and we don't want each one to
/// cancel the others' work.
#[tauri::command]
pub async fn cmd_app_mount(state: State<'_, TelegramState>) -> Result<(), String> {
    let new_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!("cmd_app_mount: generation bumped to {}", new_gen);
    Ok(())
}

#[tauri::command]
pub async fn cmd_check_connection(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // 1. Check if client exists and is responsive
    let client_msg_opt = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(client) = client_msg_opt {
        // Ping (e.g., get_me)
        match client.get_me().await {
            Ok(_) => return Ok(true),
            Err(e) => {
                let msg = e.to_string();
                // 401 means the session itself is no longer authorized — no
                // amount of reconnection will help. Surface unauthenticated
                // immediately so the UI can offer the auth wizard cleanly
                // instead of spawning a doomed reconnect.
                if msg.contains("AUTH_KEY_UNREGISTERED") || msg.contains("AUTH_KEY_INVALID")
                    || msg.contains("USER_DEACTIVATED") || msg.contains("SESSION_REVOKED")
                    || msg.contains(" 401 ") || msg.contains("(401)")
                {
                    log::warn!("Session is no longer authorized ({}); will need to re-login", msg);
                    return Ok(false);
                }
                log::warn!("Connection check failed (get_me): {}. Attempting reconnect...", msg);
            }
        }
    } else {
         log::warn!("Connection check: No client found. Checking for saved API ID...");
    }

    // 2. Reconnect Logic
    let api_id_opt = *state.api_id.lock().await;
    if let Some(api_id) = api_id_opt {
        // Force re-init: Clear old client first to ensure fresh pool
        *state.client.lock().await = None;
        
        match ensure_client_initialized(&app_handle, &state, api_id).await {
            Ok(c) => {
                match c.get_me().await {
                    Ok(_) => {
                        log::info!("Auto-reconnect successful.");
                        return Ok(true);
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        log::warn!("Reconnect ping failed: {}", msg);
                        if msg.contains("AUTH_KEY_UNREGISTERED") || msg.contains("AUTH_KEY_INVALID")
                            || msg.contains("USER_DEACTIVATED") || msg.contains("SESSION_REVOKED")
                            || msg.contains(" 401 ") || msg.contains("(401)")
                        {
                            return Ok(false);
                        }
                        return Err(format!("Reconnect succeeded but ping failed: {}", msg));
                    }
                }
            },
            Err(e) => return Err(format!("Auto-reconnect failed: {}", e))
        }
    }

    Ok(false) // Not connected and no credentials to reconnect
}

#[tauri::command]
pub async fn cmd_logout(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    log::info!("Logging out...");
    
    // 1. Shutdown the network runner FIRST to prevent any operations
    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for logout...");
            let _ = shutdown_tx.send(());
        }
    }
    
    // 2. Try to sign out from Telegram (if connected)
    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        // We don't strictly care if this fails (e.g. network down), we just want to clear local state.
        let _ = client.sign_out().await; 
    }

    // 3. Clear State
    *state.client.lock().await = None;
    *state.login_token.lock().await = None;
    *state.password_token.lock().await = None;
    *state.api_id.lock().await = None;
    crate::commands::utils::clear_peer_cache(&state.peer_cache).await;
    state.cancelled_transfers.write().await.clear();

    // 4. Remove Session File (both plaintext and any encrypted blob,
    //    plus the passcode metadata — logout clears app-level passcode too,
    //    since the new account will need its own).
    let app_data_dir = app_handle.path().app_data_dir().unwrap();
    let session_path = app_data_dir.join("telegram.session");
    let _ = std::fs::remove_file(session_path);
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-wal"));
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-shm"));
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session.enc"));
    let _ = std::fs::remove_file(app_data_dir.join("passcode.json"));

    // 5. Drop the cached passcode key + flip the in-memory unlock flag back
    //    to false so a stray reconnect doesn't see a stale "unlocked" state.
    if let Ok(mut k) = state.passcode_key.lock() {
        if let Some(mut bytes) = k.take() {
            use zeroize::Zeroize;
            bytes.zeroize();
        }
    }
    state.passcode_unlocked.store(false, Ordering::SeqCst);

    log::info!("Logout complete. Runner count: {}", state.runner_count.load(Ordering::SeqCst));
    Ok(true)
}

#[tauri::command]
pub async fn cmd_auth_request_code(
    app_handle: tauri::AppHandle,
    phone: String,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client_handle = ensure_client_initialized(&app_handle, &state, api_id).await?;

    // Defensive: if the loaded session is already signed in, don't burn an
    // auth.sendCode call. Telegram applies a stiff per-phone FLOOD_WAIT
    // (often 16h+) when sendCode is called too often, and there's no need
    // to send a code when we already have a working session.
    match client_handle.is_authorized().await {
        Ok(true) => {
            log::info!("Session for {} is already authorized — skipping sendCode", phone);
            return Ok("already_authorized".to_string());
        }
        Ok(false) => {}
        Err(e) => log::warn!("is_authorized check failed (will proceed with sendCode): {}", e),
    }

    log::info!("Requesting code for {}", phone);
    
    let mut last_error = String::new();
    
    // Retry up to 2 times for AUTH_RESTART or 500
    for i in 1..=2 {
        match client_handle.request_login_code(&phone, &api_hash).await {
            Ok(token) => {
                let mut token_guard = state.login_token.lock().await;
                *token_guard = Some(token);
                return Ok("code_sent".to_string());
            },
            Err(e) => {
                let err_msg = e.to_string();
                log::warn!("Error requesting code (Attempt {}): {}", i, err_msg);
                
                if err_msg.contains("AUTH_RESTART") || err_msg.contains("500") {
                    log::info!("AUTH_RESTART error detected. Retrying...");
                    last_error = err_msg;
                    // Prepare for retry
                    continue;
                }
                
                // Other errors, fail immediately
                return Err(map_error(e));
            }
        }
    }

    Err(format!("Telegram Error after retry: {}", last_error))
}

#[tauri::command]
pub async fn cmd_auth_sign_in(
    code: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    log::info!("Signing in with code...");
    
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let token_guard = state.login_token.lock().await;
    let login_token = token_guard.as_ref().ok_or("No login session found (restart flow)")?;

    match client.sign_in(login_token, &code).await {
        Ok(_user) => {
             log::info!("Successfully logged in.");
             Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(SignInError::PasswordRequired(token)) => {
            let mut pw_guard = state.password_token.lock().await;
            *pw_guard = Some(token);

            Ok(AuthResult {
                success: false,
                next_step: Some("password".to_string()),
                error: None,
            })
        }
        Err(e) => {
           log::error!("Sign in error: {}", e);
           Err(format!("Sign in failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn cmd_auth_check_password(
    password: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };
    
    let mut pw_guard = state.password_token.lock().await;
    let pw_token = pw_guard.take().ok_or("No password session found")?;

    match client.check_password(pw_token, password.as_str()).await {
        Ok(_user) => {
             log::info!("2FA Success.");
             Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(e) => Err(format!("2FA Failed: {}", e))
    }
}

/// QR Login -- Step 1: Export a login token and return the
/// `tg://login?token=<base64-url-no-pad>` URL the frontend renders as a
/// QR code. The mobile Telegram client recognises this URL on scan and
/// calls auth.acceptLoginToken on the user's behalf.
#[tauri::command]
pub async fn cmd_auth_qr_login(
    app_handle: tauri::AppHandle,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    *state.api_id.lock().await = Some(api_id);

    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;

    log::info!("Requesting QR login token...");

    let result = client.invoke(&tl::functions::auth::ExportLoginToken {
        api_id,
        api_hash: api_hash.clone(),
        except_ids: vec![],
    }).await.map_err(|e| format!("ExportLoginToken failed: {}", e))?;

    match result {
        tl::enums::auth::LoginToken::Token(t) => {
            let encoded = URL_SAFE_NO_PAD.encode(&t.token);
            log::info!("QR login URL generated, expires at {}", t.expires);
            Ok(format!("tg://login?token={}", encoded))
        }
        tl::enums::auth::LoginToken::Success(_s) => {
            // The session was already authorized (e.g. user kept a stale
            // logged-in session from a prior install). Sentinel string the
            // frontend treats as "skip the QR scan, go straight in".
            log::info!("QR login: already authorized");
            Ok("__authorized__".to_string())
        }
        tl::enums::auth::LoginToken::MigrateTo(m) => {
            // Telegram occasionally returns a migrate-to-DC response on
            // first call. The wrapped `token` is still valid against the
            // target DC; render it the same way and the next poll will
            // handle the actual migration.
            log::info!("QR login: need to migrate to DC {}", m.dc_id);
            let encoded = URL_SAFE_NO_PAD.encode(&m.token);
            Ok(format!("tg://login?token={}", encoded))
        }
    }
}

/// QR Login -- Step 2: Poll for scan completion.
///
/// IMPORTANT: do NOT call auth.exportLoginToken from here for polling.
/// Each call mints a *new* token and invalidates the previous one — the
/// QR code on screen would silently stop working. Instead we poll
/// `is_authorized()`, which flips to true once the phone app accepted
/// the token via auth.acceptLoginToken on its end.
#[tauri::command]
pub async fn cmd_auth_qr_poll(
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    match client.is_authorized().await {
        Ok(true) => {
            log::info!("QR login: session authorized!");
            Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Ok(false) => Ok(AuthResult {
            success: false,
            next_step: Some("waiting".to_string()),
            error: None,
        }),
        Err(e) => {
            log::warn!("QR poll auth check failed: {}", e);
            Ok(AuthResult {
                success: false,
                next_step: Some("waiting".to_string()),
                error: None,
            })
        }
    }
}
