use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::State;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use grammers_client::Client;
use grammers_client::types::{Downloadable, Media};
use grammers_client::types::photo_sizes::PhotoSize;
use base64::{Engine as _, engine::general_purpose};
use crate::TelegramState;
use crate::bandwidth::BandwidthManager;
use crate::commands::utils::resolve_peer;

/// Per-(folder_id, message_id) async locks. Concurrent callers requesting the
/// same preview serialize on the lock; the first does the actual download, the
/// rest see the populated cache file and return immediately. Without this the
/// prefetch path and main-load path can race on the same `save_path`, with the
/// second caller deleting the "empty" file the first is mid-write to.
type PreviewLockMap =
    tokio::sync::Mutex<HashMap<(Option<i64>, i32), Arc<tokio::sync::Mutex<()>>>>;
static PREVIEW_KEY_LOCKS: OnceLock<PreviewLockMap> = OnceLock::new();

async fn acquire_preview_lock(key: (Option<i64>, i32)) -> Arc<tokio::sync::Mutex<()>> {
    let map = PREVIEW_KEY_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let mut guard = map.lock().await;
    guard.entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Global concurrency cap on network thumb downloads. The earlier tokio
/// `fs::File` drop race was making *every* parallel download_media call
/// drop bytes silently — that's now fixed (we use std::fs), but a large
/// file-card grid still benefits from a small cap to avoid hammering
/// Telegram with dozens of concurrent GetFile requests on first paint.
static THUMB_DOWNLOAD_SEMAPHORE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

// Bumped whenever the thumbnail-selection logic changes in a way that makes
// previously-cached files lower quality than what the current code would
// produce (e.g. "smallest by bytes" -> "prefer 'x'"). On startup we compare
// the stored version against this constant; on mismatch we nuke the
// thumbnails cache so old low-res files get re-fetched at current quality.
const THUMB_CACHE_VERSION: u32 = 2;
static THUMB_CACHE_VERSIONED: OnceLock<()> = OnceLock::new();

fn ensure_thumb_cache_version(thumbs_dir: &std::path::Path) {
    THUMB_CACHE_VERSIONED.get_or_init(|| {
        let version_file = thumbs_dir.join(".v");
        let stored: Option<u32> = std::fs::read_to_string(&version_file)
            .ok()
            .and_then(|s| s.trim().parse().ok());
        if stored == Some(THUMB_CACHE_VERSION) {
            return;
        }
        if thumbs_dir.exists() {
            log::info!(
                "Thumbnail cache version mismatch (stored={:?}, current={}); wiping {}",
                stored, THUMB_CACHE_VERSION, thumbs_dir.display(),
            );
            let _ = std::fs::remove_dir_all(thumbs_dir);
        }
        let _ = std::fs::create_dir_all(thumbs_dir);
        let _ = std::fs::write(&version_file, THUMB_CACHE_VERSION.to_string());
    });
}
fn thumb_download_semaphore() -> &'static tokio::sync::Semaphore {
    THUMB_DOWNLOAD_SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(4))
}

/// Open a file path with the OS default application.
/// Replaces the JS-side openExternal/shell.open call which is restricted
/// to URL schemes by tauri-plugin-shell's default scope regex.
#[tauri::command]
pub fn cmd_open_path(
    app_handle: tauri::AppHandle,
    path: String,
    filename: Option<String>,
) -> Result<(), String> {
    let _ = filename; // Web-only hint, ignored on desktop.
    let _ = &app_handle;
    let exists = std::path::Path::new(&path).exists();
    log::info!("cmd_open_path invoked: path={} exists={}", path, exists);
    if !exists {
        return Err(format!("file does not exist: {}", path));
    }

    // The tauri-plugin-opener `open_path` was returning Ok without
    // actually launching the OS file association — likely because its
    // internal URL construction misbehaves with cache paths that
    // contain spaces / double-underscores. Drop down to the native
    // shell command per platform; it's a one-line process spawn and
    // gives us a real exit status to surface back to the user.
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let status = Command::new("open").arg(&path).status();
        if let Ok(s) = &status {
            if s.success() {
                log::info!("cmd_open_path: `open` succeeded for {}", path);
                return Ok(());
            }
        }
        // No app claims the file (`kLSApplicationNotFoundErr`) — typical
        // for niche extensions like `.pages` when iWork isn't installed.
        // Falling back to `open -R` reveals the file in Finder so the
        // user can right-click → Open With, drag it elsewhere, or send
        // it to a different machine. Leaving the error opaque ("Open
        // failed: open exited with status 1") was useless for them.
        log::warn!("cmd_open_path: no default app — revealing in Finder instead");
        let reveal = Command::new("open").arg("-R").arg(&path).status();
        return match reveal {
            Ok(s) if s.success() => {
                Err("No app is installed to open this file. Showing it in Finder.".to_string())
            }
            _ => {
                let original = match status {
                    Ok(s) => format!("open exited with {}", s),
                    Err(e) => format!("failed to spawn open: {}", e),
                };
                log::error!("cmd_open_path: reveal also failed; original error: {}", original);
                Err(original)
            }
        };
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let status = Command::new("cmd").args(["/C", "start", "", &path]).status();
        return match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("start exited with {}", s)),
            Err(e) => Err(format!("failed to spawn start: {}", e)),
        };
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let status = Command::new("xdg-open").arg(&path).status();
        return match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("xdg-open exited with {}", s)),
            Err(e) => Err(format!("failed to spawn xdg-open: {}", e)),
        };
    }

    #[allow(unreachable_code)]
    {
        match app_handle.opener().open_path(&path, None::<&str>) {
            Ok(()) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

const PREVIEW_CACHE_MAX_FILES: usize = 30;
const PREVIEW_CACHE_MAX_TOTAL_BYTES: u64 = 80 * 1024 * 1024;

/// Parse the seconds-to-wait out of a grammers FLOOD_WAIT error string.
/// Returns Some(secs) if matched, capped at 30s to avoid stalling the UI.
/// Strip filesystem-unsafe characters from a Telegram-supplied filename so
/// it can be appended to a cache path. Replaces path separators and
/// shell-meta characters with `_`; preserves dots and unicode letters.
/// Caps length at 96 chars so we don't blow past path limits with a
/// pathological filename.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' | '\n' | '\r' | '\t' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        return String::from("file");
    }
    if trimmed.chars().count() > 96 {
        // Keep the tail (which usually carries the extension) by chopping
        // from the front. Take last 96 chars by char count, not byte.
        let chars: Vec<char> = trimmed.chars().collect();
        let start = chars.len() - 96;
        return chars[start..].iter().collect();
    }
    trimmed.to_string()
}

fn parse_flood_wait_secs(err: &str) -> Option<u64> {
    if !err.contains("FLOOD_WAIT") { return None; }
    let idx = err.find("value:")?;
    let tail = &err[idx + "value:".len()..];
    let digits: String = tail.chars().skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok().map(|s| s.min(30))
}

/// Last-ditch fallback: write a PhotoSize's inline bytes (Cached/Stripped/Path)
/// directly to disk. Use when grammers' download_media returns Ok with 0 bytes —
/// occasionally happens for older photos whose downloadable sizes (Size/Progressive)
/// the server no longer serves but whose inline thumb data is still attached.
fn write_inline_thumb(thumb: &PhotoSize, save_path: &std::path::Path) -> bool {
    let Some(bytes) = thumb.to_data() else { return false };
    if bytes.is_empty() { return false; }
    std::fs::write(save_path, &bytes).is_ok()
}

/// Stream a document via `iter_download` to a `.partial` file, then atomic-rename
/// to `save_path` on success. Mirrors `cmd_download_file`'s pattern (sync std::fs::File +
/// explicit chunk loop + flush + sync_all) which is known to work where
/// `download_media(&Media, ...)` was occasionally returning Ok with a 0-byte file
/// for documents (Telegram returning empty bytes on the first chunk is silently
/// swallowed by `iter_download::next` as `Ok(None)`).
///
/// Returns `Ok(true)` if the file is on disk with non-zero size after the rename,
/// `Ok(false)` if Telegram delivered zero bytes (no error), or `Err(...)` on
/// transport failure.
async fn download_document_streaming(
    client: &Client,
    media: &Media,
    save_path: &std::path::Path,
    message_id: i32,
) -> Result<bool, String> {
    let partial_path: std::path::PathBuf = {
        let mut p = save_path.to_path_buf();
        let new_name = match save_path.file_name().map(|s| s.to_string_lossy().to_string()) {
            Some(n) => format!("{}.partial", n),
            None => return Err("invalid save_path".to_string()),
        };
        p.set_file_name(new_name);
        p
    };
    if partial_path.exists() {
        log::warn!("[doc {}] stale .partial exists, removing: {:?}", message_id, partial_path);
        let _ = std::fs::remove_file(&partial_path);
    }

    if let Media::Document(d) = media {
        log::info!(
            "[doc {}] streaming start mime={:?} declared_size={} name={:?}",
            message_id,
            d.mime_type(),
            d.size(),
            d.name(),
        );
    } else {
        log::info!("[doc {}] streaming start (non-document Media variant)", message_id);
    }
    log::info!("[doc {}] partial path: {:?}", message_id, partial_path);

    let mut iter = client.iter_download(media);
    let mut file = std::fs::File::create(&partial_path).map_err(|e| {
        log::error!("[doc {}] create partial failed: {}", message_id, e);
        e.to_string()
    })?;

    let mut total: u64 = 0;
    let mut chunk_count: u32 = 0;
    loop {
        match iter.next().await {
            Ok(Some(bytes)) => {
                chunk_count += 1;
                total += bytes.len() as u64;
                log::debug!(
                    "[doc {}] chunk #{} size={} cumulative={}",
                    message_id, chunk_count, bytes.len(), total,
                );
                if let Err(e) = std::io::Write::write_all(&mut file, &bytes) {
                    log::error!("[doc {}] write_all failed at chunk {}: {}", message_id, chunk_count, e);
                    let _ = std::fs::remove_file(&partial_path);
                    return Err(e.to_string());
                }
            }
            Ok(None) => {
                log::info!(
                    "[doc {}] stream end: chunks={} total_bytes={}",
                    message_id, chunk_count, total,
                );
                break;
            }
            Err(e) => {
                let msg = e.to_string();
                log::error!(
                    "[doc {}] chunk error after {} chunks ({} bytes): {}",
                    message_id, chunk_count, total, msg,
                );
                let _ = std::fs::remove_file(&partial_path);
                return Err(msg);
            }
        }
    }

    if let Err(e) = std::io::Write::flush(&mut file) {
        log::error!("[doc {}] flush failed: {}", message_id, e);
    }
    if let Err(e) = file.sync_all() {
        log::error!("[doc {}] sync_all failed: {}", message_id, e);
    }
    drop(file);

    let on_disk = std::fs::metadata(&partial_path).map(|m| m.len()).unwrap_or(0);
    log::info!("[doc {}] partial on disk: {} bytes", message_id, on_disk);
    if on_disk == 0 {
        let _ = std::fs::remove_file(&partial_path);
        log::error!("[doc {}] Telegram returned no bytes for this document — file_reference likely stale or server refused", message_id);
        return Ok(false);
    }

    if let Err(e) = std::fs::rename(&partial_path, save_path) {
        log::error!("[doc {}] rename {:?} → {:?} failed: {}", message_id, partial_path, save_path, e);
        let _ = std::fs::remove_file(&partial_path);
        return Err(e.to_string());
    }
    log::info!("[doc {}] saved to {:?} ({} bytes)", message_id, save_path, on_disk);
    Ok(true)
}

/// Inline-only thumb: write whichever PhotoSize has embedded inline data
/// (Stripped/Cached/Path) without ever hitting the network. Used for FileCard
/// thumbnails where we just need a tiny grid icon and cannot afford to spam
/// upload.getFile and trip FLOOD_WAIT.
fn try_inline_thumbs_only(thumbs: &[PhotoSize], save_path: &std::path::Path) -> bool {
    for thumb in thumbs {
        if write_inline_thumb(thumb, save_path) {
            let len = save_path.metadata().map(|m| m.len()).unwrap_or(0);
            log::debug!(
                "Inline thumb '{}' wrote {} bytes (no network)",
                thumb.photo_type(), len,
            );
            return true;
        }
    }
    false
}

/// Stream a single thumb to disk via `iter_download` + sync `std::fs::File`,
/// matching the working pattern in `cmd_download_file`.
///
/// Why not `client.download_media(&thumb, path)`? Empirically, that wrapper
/// occasionally writes a 0-byte file for both inline (`Stripped`) and network
/// (`Size`/`Progressive`) thumbs even when the underlying data is fine —
/// `tokio::fs::File::create + write_all + drop` is dropped without flushing in
/// some scheduling orderings, so the bytes never reach the filesystem. Using
/// sync std::fs::File with explicit flush + sync_all eliminates that race.
///
/// Returns the number of bytes actually written.
async fn download_one_thumb(
    client: &Client,
    thumb: &PhotoSize,
    save_path: &std::path::Path,
) -> Result<u64, String> {
    use std::io::Write;

    // Inline thumbs (Stripped/Cached/Path) carry their bytes in-message. Skip
    // iter_download entirely — `to_data()` already gives us the reconstructed
    // JPEG/PNG bytes for these variants.
    if let Some(data) = thumb.to_data() {
        if data.is_empty() {
            return Ok(0);
        }
        std::fs::write(save_path, &data).map_err(|e| e.to_string())?;
        return Ok(data.len() as u64);
    }

    // Network thumb: stream via iter_download.
    let mut iter = client.iter_download(thumb);
    let mut file = std::fs::File::create(save_path).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    let mut chunk_no: u32 = 0;
    loop {
        match iter.next().await {
            Ok(Some(bytes)) => {
                chunk_no += 1;
                total += bytes.len() as u64;
                Write::write_all(&mut file, &bytes).map_err(|e| e.to_string())?;
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(save_path);
                return Err(e.to_string());
            }
        }
    }
    Write::flush(&mut file).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    log::debug!("[thumb] wrote {} bytes in {} chunk(s) to {:?}", total, chunk_no, save_path);
    Ok(total)
}

/// Try downloading photo thumbs in order. First one that produces a non-empty file wins.
/// Returns Ok(true) if a thumb succeeded, Ok(false) if all attempts produced 0 bytes.
async fn try_download_photo_thumbs(
    client: &Client,
    mut thumbs: Vec<PhotoSize>,
    save_path: &std::path::Path,
) -> Result<bool, String> {
    // Largest first — if it works we keep the best quality. We fall back to
    // smaller sizes only when the larger one fails (Telegram occasionally
    // returns empty bytes for specific thumb_size requests).
    thumbs.sort_by(|a, b| b.size().cmp(&a.size()));
    log::info!("Trying {} photo thumb(s): {:?}", thumbs.len(),
        thumbs.iter().map(|t| format!("{}({}b)", t.photo_type(), t.size())).collect::<Vec<_>>());
    for thumb in thumbs {
        let label = format!("thumb '{}'", thumb.photo_type());

        // Inline thumbs are local writes — no point retrying or hitting
        // the network semaphore.
        let is_inline = thumb.to_data().is_some();

        let mut got_bytes = false;
        let attempts: u32 = if is_inline { 1 } else { 2 };
        for attempt in 1..=attempts {
            if attempt > 1 {
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            }
            let res = if is_inline {
                download_one_thumb(client, &thumb, save_path).await
            } else {
                // Hold a permit only across the actual network call. Concurrent
                // same-DC GetFile calls were correlated with Telegram returning
                // empty bytes for every parallel request.
                let permit = thumb_download_semaphore().acquire().await
                    .map_err(|e| format!("semaphore closed: {}", e))?;
                let r = download_one_thumb(client, &thumb, save_path).await;
                drop(permit);
                r
            };
            match res {
                Ok(0) => {
                    let _ = std::fs::remove_file(save_path);
                    log::warn!("{} returned 0 bytes (attempt {})", label, attempt);
                }
                Ok(n) => {
                    log::info!("Got {} bytes from {} (attempt {})", n, label, attempt);
                    got_bytes = true;
                    break;
                }
                Err(e) => {
                    let _ = std::fs::remove_file(save_path);
                    if let Some(secs) = parse_flood_wait_secs(&e) {
                        log::warn!("{} FLOOD_WAIT {}s (attempt {})", label, secs, attempt);
                        if attempt < attempts {
                            tokio::time::sleep(std::time::Duration::from_secs(secs + 1)).await;
                            continue;
                        }
                    } else {
                        log::warn!("{} failed (attempt {}): {}", label, attempt, e);
                    }
                    break;
                }
            }
        }
        if got_bytes {
            return Ok(true);
        }
        log::warn!("{} produced no bytes; trying next size", label);
    }
    Ok(false)
}

fn prune_preview_cache(cache_dir: &std::path::Path) {
    let read_dir = match std::fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            files.push((path, modified, meta.len()));
        }
    }
    files.sort_by_key(|(_, modified, _)| *modified);
    let mut total_bytes: u64 = files.iter().map(|(_, _, len)| *len).sum();
    while files.len() > PREVIEW_CACHE_MAX_FILES || total_bytes > PREVIEW_CACHE_MAX_TOTAL_BYTES {
        if let Some((path, _, len)) = files.first().cloned() {
            let _ = std::fs::remove_file(&path);
            total_bytes = total_bytes.saturating_sub(len);
            files.remove(0);
        } else {
            break;
        }
    }
}

#[tauri::command]
pub async fn cmd_get_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    if !cache_dir.exists() {
        let _ = std::fs::create_dir_all(&cache_dir);
    }
    prune_preview_cache(&cache_dir);
    log::info!("Using preview cache dir: {:?}", cache_dir);
    log::info!("Preview Request: msg_id={} folder_id={:?}", message_id, folder_id);

    // Serialize concurrent requests for the same (folder, msg_id). The first
    // caller does the actual download; later callers wait, then read the
    // populated cache file. Without this the prefetch path and main-load path
    // can race on the same `save_path` and corrupt each other.
    let key_lock = acquire_preview_lock((folder_id, message_id)).await;
    let _key_guard = key_lock.lock().await;
    log::debug!("Acquired preview lock for ({:?},{})", folder_id, message_id);

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let messages = client.get_messages_by_id(&peer, &[message_id])
        .await.map_err(|e| e.to_string())?;
    let target_message = messages.into_iter().flatten().next();

    if let Some(msg) = target_message {
        if let Some(media) = msg.media() {
            let ext = match &media {
                Media::Document(d) => {
                    // Prefer the document's own filename extension — that's
                    // what other clients (and the OS app launcher) use for
                    // file-type association. Fall back to a mime → ext map
                    // covering the common cases telegram clients upload as
                    // generic application/* with no filename. Without a
                    // mapping for iWork / Office types, .pages and friends
                    // were being saved as `.bin` and macOS's "Open with"
                    // refused to find Pages.app.
                    let mut e = std::path::Path::new(d.name())
                        .extension()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if e.is_empty() {
                        if let Some(mime) = d.mime_type() {
                            e = match mime {
                                "image/jpeg" => "jpg",
                                "image/png" => "png",
                                "image/gif" => "gif",
                                "image/webp" => "webp",
                                "image/heic" | "image/heif" => "heic",
                                "video/mp4" => "mp4",
                                "video/quicktime" => "mov",
                                "video/x-matroska" => "mkv",
                                "video/webm" => "webm",
                                "audio/mpeg" => "mp3",
                                "audio/ogg" => "ogg",
                                "audio/mp4" | "audio/x-m4a" => "m4a",
                                "audio/flac" | "audio/x-flac" => "flac",
                                "audio/wav" | "audio/x-wav" => "wav",
                                "application/pdf" => "pdf",
                                "application/zip" => "zip",
                                "application/x-rar-compressed" | "application/vnd.rar" => "rar",
                                "application/x-7z-compressed" => "7z",
                                "application/gzip" => "gz",
                                "application/x-tar" => "tar",
                                // iWork bundles — Telegram serves these as the
                                // application/zip bundle's actual mime, since
                                // they're zip archives at heart. Map both.
                                "application/x-iwork-pages-sffpages" | "application/vnd.apple.pages" => "pages",
                                "application/x-iwork-keynote-sffkey" | "application/vnd.apple.keynote" => "key",
                                "application/x-iwork-numbers-sffnumbers" | "application/vnd.apple.numbers" => "numbers",
                                // Office Open XML
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
                                "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
                                "application/msword" => "doc",
                                "application/vnd.ms-excel" => "xls",
                                "application/vnd.ms-powerpoint" => "ppt",
                                "application/epub+zip" => "epub",
                                "text/plain" => "txt",
                                "text/markdown" => "md",
                                "text/csv" => "csv",
                                "application/json" => "json",
                                _ => "bin",
                            }.to_string();
                        } else {
                            e = "bin".to_string();
                        }
                    }
                    e
                },
                Media::Photo(_) => "jpg".to_string(),
                _ => "bin".to_string(),
            };
            let folder_key = folder_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "home".to_string());
            // Cache file naming: when the document carries its own filename,
            // append it verbatim so the OS app launcher sees the source's
            // exact extension (e.g. `.pages`, `.pages.zip`, `.docx`). The
            // single-extension path was losing iWork bundles to `.bin`
            // whenever the mime didn't match a known case below — falling
            // back to the document's own filename is more robust than
            // trying to enumerate every mime type Telegram might serve.
            let original_name = match &media {
                Media::Document(d) => d.name().to_string(),
                _ => String::new(),
            };
            let save_path = if !original_name.is_empty() {
                cache_dir.join(format!("{}_{}__{}", folder_key, message_id, sanitize_filename(&original_name)))
            } else {
                cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext))
            };
            let save_path_str = save_path.to_string_lossy().to_string();

            let cached_len = save_path.metadata().ok().map(|m| m.len()).unwrap_or(0);
            let file_ready = if save_path.exists() && cached_len > 0 {
                log::info!("File ({}) exists in cache.", message_id);
                true
            } else {
                if save_path.exists() {
                    log::warn!("Removing empty cached preview for {}", message_id);
                    let _ = std::fs::remove_file(&save_path);
                }
                let size = match &media {
                    Media::Document(d) => d.size() as u64,
                    Media::Photo(p) => p.thumbs().iter().map(|t| t.size() as u64).max().unwrap_or(1024 * 1024),
                    _ => 0,
                };
                log::info!("Downloading preview... Size: {}", size);
                if let Err(e) = bw_state.can_transfer(size) {
                    log::warn!("Bandwidth limit hit for preview: {}", e);
                    false
                } else {
                    let ok = match &media {
                        Media::Photo(p) => {
                            // Try sizes largest-first; fall back if any returns empty bytes
                            // (some photos' "preferred" size returns nothing from Telegram).
                            try_download_photo_thumbs(&client, p.thumbs(), &save_path).await?
                        }
                        _ => {
                            // Stream chunked, with one FLOOD_WAIT-aware retry. We use
                            // iter_download + std::fs::File explicitly (rather than the
                            // higher-level download_media wrapper) to mirror the
                            // working cmd_download_file path and to log per-chunk
                            // progress — `download_media` was occasionally returning
                            // Ok with a 0-byte file because the wrapper swallows the
                            // empty-first-chunk case as a clean stream end.
                            let mut attempt: u32 = 0;
                            loop {
                                attempt += 1;
                                match download_document_streaming(&client, &media, &save_path, message_id).await {
                                    Ok(success) => break success,
                                    Err(e) => {
                                        if attempt < 2 {
                                            if let Some(secs) = parse_flood_wait_secs(&e) {
                                                log::warn!("[doc {}] FLOOD_WAIT {}s; sleeping then retrying full download", message_id, secs);
                                                tokio::time::sleep(std::time::Duration::from_secs(secs + 1)).await;
                                                continue;
                                            }
                                        }
                                        log::error!("[doc {}] streaming download error after {} attempt(s): {}", message_id, attempt, e);
                                        let _ = std::fs::remove_file(&save_path);
                                        break false;
                                    }
                                }
                            }
                        }
                    };
                    if ok {
                        log::info!("Preview download complete.");
                        bw_state.add_down(size);
                        prune_preview_cache(&cache_dir);
                        true
                    } else {
                        log::error!("Preview unavailable for {} (all sizes returned empty)", message_id);
                        let _ = std::fs::remove_file(&save_path);
                        false
                    }
                }
            };
            if file_ready {
                let lower_ext = ext.to_lowercase();
                if ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].contains(&lower_ext.as_str()) {
                    log::info!("Converting image to Base64...");
                    match std::fs::read(&save_path) {
                        Ok(bytes) => {
                            let b64 = general_purpose::STANDARD.encode(&bytes);
                            let mime = match lower_ext.as_str() {
                                "png" => "image/png",
                                "gif" => "image/gif",
                                "webp" => "image/webp",
                                "bmp" => "image/bmp",
                                "svg" => "image/svg+xml",
                                _ => "image/jpeg",
                            };
                            return Ok(format!("data:{};base64,{}", mime, b64));
                        },
                        Err(e) => {
                            log::error!("Failed to read file for base64: {}", e);
                            return Ok(save_path_str);
                        }
                    }
                }
                log::info!("Returning path preview: {}", save_path_str);
                return Ok(save_path_str);
            }
        }
    }
    Err("File not found or failed to download".to_string())
}

#[tauri::command]
pub async fn cmd_clean_cache(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    if cache_dir.exists() {
        let _ = std::fs::remove_dir_all(cache_dir);
    }
    Ok(())
}

/// Get a small thumbnail for inline display in file cards.
/// Returns base64 data URL for images, empty string for non-image files.
/// Uses same cache as cmd_get_preview for consistency.
#[tauri::command]
pub async fn cmd_get_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    // Check if thumbnail already in cache
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");
    ensure_thumb_cache_version(&cache_dir);
    if !cache_dir.exists() {
        let _ = std::fs::create_dir_all(&cache_dir);
    }

    // Serialize concurrent fetches for the same message — file cards remount
    // and this command re-runs; without serialization we'd race on the same
    // path and (worse) re-issue the same network request.
    let key_lock = acquire_preview_lock((folder_id, message_id)).await;
    let _key_guard = key_lock.lock().await;

    // Cache filenames are scoped to (folder_id, message_id). Telegram message
    // ids are only unique within a channel, so a forwarded/moved file
    // (same id reused in another channel) would otherwise read another
    // file's thumbnail off disk. Mirrors cmd_get_preview's naming.
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());

    // Direct stat checks per known extension instead of a read_dir scan.
    // The scan version was O(cache_size) per thumbnail call, which on a
    // populated 30-card grid added perceptible refresh latency.
    for ext in &["jpg", "png", "gif", "webp"] {
        let candidate = cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext));
        let meta = match candidate.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() == 0 {
            let _ = std::fs::remove_file(&candidate);
            continue;
        }
        if let Ok(bytes) = std::fs::read(&candidate) {
            let mime = match *ext {
                "png" => "image/png",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            let b64 = general_purpose::STANDARD.encode(&bytes);
            return Ok(format!("data:{};base64,{}", mime, b64));
        }
    }

    // No cache, need to fetch from Telegram
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let messages = client.get_messages_by_id(&peer, &[message_id])
        .await.map_err(|e| e.to_string())?;
    if let Some(m) = messages.into_iter().flatten().next() {
        if let Some(media) = m.media() {
            // Decide what to download:
            //   - Photo: try thumb sizes largest-first via fallback chain
            //   - image-Document: download the document itself (it IS the image)
            //   - video-Document: try thumb sizes (poster frames) with same fallback
            //   - everything else: skip
            enum Plan {
                WholeDocument(String), // ext
                PhotoThumbs(Vec<PhotoSize>),
            }

            let plan = match &media {
                Media::Photo(p) => Plan::PhotoThumbs(p.thumbs()),
                Media::Document(d) => {
                    let mime = d.mime_type().unwrap_or("");
                    if mime.starts_with("image/") {
                        let e = match mime {
                            "image/png" => "png",
                            "image/gif" => "gif",
                            "image/webp" => "webp",
                            _ => "jpg",
                        };
                        Plan::WholeDocument(e.to_string())
                    } else if mime.starts_with("video/") {
                        Plan::PhotoThumbs(d.thumbs())
                    } else {
                        return Ok("".to_string());
                    }
                },
                _ => return Ok("".to_string()),
            };

            let ext = match &plan {
                Plan::WholeDocument(e) => e.clone(),
                Plan::PhotoThumbs(_) => "jpg".to_string(),
            };
            let save_path = cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext));
            let save_path_str = save_path.to_string_lossy().to_string();

            let ok = match plan {
                Plan::WholeDocument(_) => match client.download_media(&media, &save_path_str).await {
                    Ok(_) => save_path.metadata().ok().map(|m| m.len()).unwrap_or(0) > 0,
                    Err(e) => {
                        log::warn!("Thumbnail download error for {}: {}", message_id, e);
                        let _ = std::fs::remove_file(&save_path);
                        false
                    }
                },
                Plan::PhotoThumbs(thumbs) => {
                    if thumbs.is_empty() {
                        false
                    } else {
                        // Rank network thumbs by photo_type preference rather
                        // than byte size. The previous strategy of "smallest
                        // by bytes" picked 's' (100px) whenever it existed,
                        // which on a retina grid card looks washed out — and
                        // very old photos sometimes only have 's' available,
                        // making sort-by-date-asc surface a wall of low-res.
                        // 'm' (320px) is the sweet spot for cards; cascade
                        // outward if Telegram doesn't offer it. We try each
                        // size in order and break on first non-empty
                        // response so a per-size "0 bytes" quirk falls
                        // through without giving up.
                        let (network, inline): (Vec<_>, Vec<_>) = thumbs
                            .into_iter()
                            .partition(|t| t.to_data().is_none());

                        let mut net_ranked = network;
                        // Prefer 'x' (~800 px) for retina-friendly grid
                        // cards. 'm' (~320 px) was the previous default
                        // but visibly soft on HiDPI displays — a 300 logical
                        // card is 600 physical pixels, so a 320 px source
                        // upscales. 'x' costs ~3× the bytes per thumb but
                        // is sharp; the global semaphore plus on-disk
                        // cache mean it's a one-time hit per file.
                        net_ranked.sort_by_key(|t| match t.photo_type().as_str() {
                            "x" => 0u8,
                            "y" => 1,
                            "m" => 2,
                            "w" => 3,
                            "s" => 4,
                            _ => 5,
                        });

                        let mut got_bytes = false;
                        for thumb in &net_ranked {
                            log::debug!(
                                "Thumbnail {}: trying network size '{}' ({} bytes)",
                                message_id, thumb.photo_type(), thumb.size(),
                            );
                            let permit = thumb_download_semaphore()
                                .acquire()
                                .await
                                .map_err(|e| format!("semaphore closed: {}", e))?;
                            let r = download_one_thumb(&client, thumb, &save_path).await;
                            drop(permit);
                            match r {
                                Ok(n) if n > 0 => { got_bytes = true; break; }
                                Ok(_) => {
                                    let _ = std::fs::remove_file(&save_path);
                                    log::debug!(
                                        "Thumbnail {}: '{}' returned 0 bytes, trying next size",
                                        message_id, thumb.photo_type(),
                                    );
                                }
                                Err(e) => {
                                    let _ = std::fs::remove_file(&save_path);
                                    log::warn!(
                                        "Thumbnail {}: '{}' failed: {}",
                                        message_id, thumb.photo_type(), e,
                                    );
                                }
                            }
                        }

                        if got_bytes {
                            true
                        } else if !inline.is_empty() {
                            log::debug!(
                                "Thumbnail {}: all network sizes failed, falling back to inline",
                                message_id,
                            );
                            try_inline_thumbs_only(&inline, &save_path)
                        } else {
                            false
                        }
                    }
                }
            };

            if ok {
                match std::fs::read(&save_path) {
                    Ok(bytes) if !bytes.is_empty() => {
                        let mime = match ext.as_str() {
                            "png" => "image/png",
                            "gif" => "image/gif",
                            "webp" => "image/webp",
                            _ => "image/jpeg",
                        };
                        let b64 = general_purpose::STANDARD.encode(&bytes);
                        return Ok(format!("data:{};base64,{}", mime, b64));
                    }
                    _ => {
                        let _ = std::fs::remove_file(&save_path);
                    }
                }
            }
        }
    }

    Ok("".to_string())
}