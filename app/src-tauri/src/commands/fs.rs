use tauri::{State, Emitter};
use grammers_client::types::{Media, Peer};
use grammers_client::InputMessage;
use grammers_tl_types as tl;
use crate::TelegramState;
use crate::models::{FolderMetadata, FileMetadata};
use crate::bandwidth::BandwidthManager;
use crate::commands::utils::{resolve_peer, map_error};
use crate::commands::locks::LockState;

fn ext_from_mime(mime: Option<&str>) -> Option<&'static str> {
    Some(match mime? {
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        "video/webm" => "webm",
        "video/x-msvideo" => "avi",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/flac" => "flac",
        "audio/opus" => "opus",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/x-tar" => "tar",
        "application/gzip" | "application/x-gzip" => "gz",
        "text/plain" => "txt",
        _ => return None,
    })
}

#[tauri::command]
pub async fn cmd_create_folder(
    name: String,
    state: State<'_, TelegramState>,
) -> Result<FolderMetadata, String> {
    let client_opt = {
        state.client.lock().await.clone()
    };
    
    // --- MOCK ---
    if client_opt.is_none() {
        let mock_id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        log::info!("[MOCK] Created folder '{}' with ID {}", name, mock_id);
        return Ok(FolderMetadata {
            id: mock_id,
            name,
            parent_id: None,
        });
    }
    // -----------
    let client = client_opt.unwrap();
    log::info!("Creating Telegram Channel: {}", name);
    
    let result = client.invoke(&tl::functions::channels::CreateChannel {
        broadcast: true,
        megagroup: false,
        title: format!("{} [TD]", name),
        about: "Telegram Drive Storage Folder\n[telegram-drive-folder]".to_string(),
        geo_point: None,
        address: None,
        for_import: false,
        forum: false,
        ttl_period: None, // Initial creation TTL
    }).await.map_err(map_error)?;
    
    let (chat_id, access_hash) = match result {
        tl::enums::Updates::Updates(u) => {
             let chat = u.chats.first().ok_or("No chat in updates")?;
             match chat {
                 tl::enums::Chat::Channel(c) => (c.id, c.access_hash.unwrap_or(0)),
                 _ => return Err("Created chat is not a channel".to_string()),
             }
        },
        _ => return Err("Unexpected response (not Updates::Updates)".to_string()), 
    };

    // Explicitly Disable TTL
    let _input_channel = tl::enums::InputChannel::Channel(tl::types::InputChannel {
         channel_id: chat_id,
         access_hash,
    });

    let _ = client.invoke(&tl::functions::messages::SetHistoryTtl {
        peer: tl::enums::InputPeer::Channel(tl::types::InputPeerChannel { channel_id: chat_id, access_hash }),
        period: 0, 
    }).await;

    Ok(FolderMetadata {
        id: chat_id,
        name,
        parent_id: None,
    })
}

#[tauri::command]
pub async fn cmd_delete_folder(
    folder_id: i64,
    app: tauri::AppHandle,
    state: State<'_, TelegramState>,
    lock_state: State<'_, crate::commands::locks::LockState>,
) -> Result<bool, String> {
    let client_opt = {
        state.client.lock().await.clone()
    };

    if client_opt.is_none() {
        log::info!("[MOCK] Deleted folder ID {}", folder_id);
        crate::commands::locks::forget_folder_lock(&app, &lock_state, Some(folder_id)).await;
        return Ok(true);
    }
    let client = client_opt.unwrap();
    log::info!("Deleting folder/channel: {}", folder_id);

    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;

    let input_channel = match peer {
        Peer::Channel(c) => {
             let chan = &c.raw;
             tl::enums::InputChannel::Channel(tl::types::InputChannel {
                 channel_id: chan.id,
                 access_hash: chan.access_hash.ok_or("No access hash for channel")?,
             })
        },
        _ => return Err("Only channels (folders) can be deleted.".to_string()),
    };

    client.invoke(&tl::functions::channels::DeleteChannel {
        channel: input_channel,
    }).await.map_err(|e| format!("Failed to delete channel: {}", e))?;

    // Channel is gone — drop any stale password metadata so the sidebar's
    // "X locked" indicator doesn't keep counting a folder that no longer exists.
    crate::commands::locks::forget_folder_lock(&app, &lock_state, Some(folder_id)).await;

    Ok(true)
}


#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    id: String,
    percent: u8,
}

#[tauri::command]
pub async fn cmd_upload_file(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<Option<FileMetadata>, String> {
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    bw_state.can_transfer(size)?;

    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Uploaded file {} to {:?}", path, folder_id);
        bw_state.add_up(size);
        return Ok(None);
    }
    let client = client_opt.unwrap();

    // Emit start progress
    if !tid.is_empty() {
        let _ = app_handle.emit("upload-progress", ProgressPayload { id: tid.clone(), percent: 0 });
    }

    let path_clone = path.clone();
    let client_clone = client.clone();

    let uploaded_file = tauri::async_runtime::spawn(async move {
        client_clone.upload_file(&path_clone).await
    }).await.map_err(|e| format!("Task join error: {}", e))?
      .map_err(map_error)?;

    let message = InputMessage::new().text("").file(uploaded_file);

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let sent = client.send_message(&peer, message).await.map_err(map_error)?;

    bw_state.add_up(size);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit("upload-progress", ProgressPayload { id: tid, percent: 100 });
    }

    // Build FileMetadata from the just-sent message so the frontend can
    // splice it directly into its React Query cache. Without this, the
    // caller has to invalidate-and-refetch — which races Telegram's
    // GetHistory replication lag.
    //
    // Prefer the Message-derived metadata since it has the canonical mime
    // type from Telegram. Fall back to local-file-derived metadata if
    // Message.media() isn't populated cleanly — grammers occasionally
    // returns a Message without its media attribute resolved when
    // Telegram's SendMedia response doesn't include the full updates
    // payload, and we'd otherwise drop the optimistic insert and force
    // the frontend to wait on the trailing reconcile.
    let metadata = {
        let mut tmp = Vec::new();
        push_file_from_message(&mut tmp, &sent, folder_id);
        tmp.into_iter().next().unwrap_or_else(|| {
            let p = std::path::Path::new(&path);
            let name = p.file_name()
                .and_then(|s| s.to_str())
                .map(String::from)
                .unwrap_or_else(|| format!("File_{}", sent.id()));
            let file_ext = p.extension()
                .and_then(|s| s.to_str())
                .map(String::from);
            FileMetadata {
                id: sent.id() as i64,
                folder_id,
                name,
                size,
                mime_type: None,
                file_ext,
                created_at: sent.date().to_string(),
                icon_type: "file".into(),
                duration_secs: None,
            }
        })
    };
    Ok(Some(metadata))
}

#[tauri::command]
pub async fn cmd_delete_file(
    message_id: i32,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
         log::info!("[MOCK] Deleted message {} from folder {:?}", message_id, folder_id);
        return Ok(true); 
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    client.delete_messages(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_download_file(
    message_id: i32,
    save_path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
        log::info!("[MOCK] Downloaded message {} from {:?} to {}", message_id, folder_id, save_path);
        if let Err(e) = std::fs::write(&save_path, b"Mock Content") { return Err(e.to_string()); }
        return Ok("Download successful".to_string());
    }
    let client = client_opt.unwrap();
    
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    // Use get_messages_by_id for efficient message lookup (same as server.rs)
    let messages = client.get_messages_by_id(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    
    let msg = messages.into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "Message not found".to_string())?;

    let media = msg.media()
        .ok_or_else(|| "No media in message".to_string())?;

    let total_size = match &media {
        Media::Document(d) => d.size() as u64,
        Media::Photo(_) => 1024 * 1024,
        _ => 0,
    };
    
    bw_state.can_transfer(total_size)?;

    // Emit start
    if !tid.is_empty() {
        let _ = app_handle.emit("download-progress", ProgressPayload { id: tid.clone(), percent: 0 });
    }

    // Stream download with per-chunk progress
    let mut download_iter = client.iter_download(&media);
    let mut file = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;

    while let Some(chunk) = download_iter.next().await.transpose() {
        let bytes = chunk.map_err(|e| format!("Download chunk error: {}", e))?;
        std::io::Write::write_all(&mut file, &bytes).map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        
        if !tid.is_empty() && total_size > 0 {
            let percent = ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8;
            // Only emit when percent actually changes to avoid event spam
            if percent != last_percent {
                last_percent = percent;
                let _ = app_handle.emit("download-progress", ProgressPayload { id: tid.clone(), percent });
            }
        }
    }

    bw_state.add_down(total_size);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit("download-progress", ProgressPayload { id: tid, percent: 100 });
    }

    Ok("Download successful".to_string())
}

#[tauri::command]
pub async fn cmd_move_files(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    if source_folder_id == target_folder_id { return Ok(Vec::new()); }
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Moved msgs {:?} from {:?} to {:?}", message_ids, source_folder_id, target_folder_id);
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();

    let source_peer = resolve_peer(&client, source_folder_id, &state.peer_cache).await?;
    let target_peer = resolve_peer(&client, target_folder_id, &state.peer_cache).await?;

    // forward_messages returns the new Message in the destination peer for
    // each forwarded id (or None if Telegram dropped it). We use those to
    // build FileMetadata so the frontend can optimistic-insert into the
    // target folder cache instead of waiting for a refetch — same pattern
    // as cmd_upload_file. Otherwise the user sees an instant disappear
    // from source but a 1-min wait before the file shows in target.
    let forwarded: Vec<Option<grammers_client::types::Message>> = client
        .forward_messages(&target_peer, &message_ids, &source_peer)
        .await
        .map_err(|e| format!("Forward failed: {}", e))?;

    if let Err(e) = client.delete_messages(&source_peer, &message_ids).await {
        return Err(format!("Delete original failed: {}", e));
    }

    let mut new_files: Vec<FileMetadata> = Vec::new();
    for msg in forwarded.into_iter().flatten() {
        push_file_from_message(&mut new_files, &msg, target_folder_id);
    }
    Ok(new_files)
}

#[tauri::command]
pub async fn cmd_get_files(
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
    locks: State<'_, LockState>,
    app: tauri::AppHandle,
) -> Result<Vec<FileMetadata>, String> {
    if crate::commands::locks::cmd_is_folder_locked(folder_id, app, locks).await? {
        return Err("LOCKED".into());
    }
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Returning mock files for folder {:?}", folder_id);
        return Ok(Vec::new()); // No mock files for now
    }
    let client = client_opt.unwrap();

    let my_gen = state.generation.load(std::sync::atomic::Ordering::SeqCst);

    // Walk every message and let push_file_from_message decide. Earlier
    // versions used messages.Search with media-type filters for Saved
    // Messages to skip text noise, but Telegram's filter classification
    // is quirky — certain documents (epub, pages, xlsx, audio with
    // metadata) didn't surface, and chasing every category would mean
    // running 7+ filtered searches and still missing edge cases. The
    // generation token cancels orphan walks on webview reload.
    //
    // The walk runs in its own attempt loop: if iter_messages errors
    // mid-walk (gramjs disconnect, stale access_hash, FLOOD_WAIT, etc.)
    // we evict the peer from the cache to force a fresh resolve via
    // iter_dialogs, then retry once. This unsticks the "loaded once,
    // now stuck — clicking Sync fixes it" pattern. Without the eviction,
    // a stale cached peer would just keep failing.
    let mut files = Vec::new();
    let mut attempts = 0u32;
    loop {
        files.clear();
        let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
        let mut msgs = client.iter_messages(&peer);
        let mut walk_failed: Option<String> = None;
        loop {
            match msgs.next().await {
                Ok(Some(msg)) => {
                    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
                        log::info!("[fs] cmd_get_files cancelled at {} files", files.len());
                        return Ok(files);
                    }
                    push_file_from_message(&mut files, &msg, folder_id);
                }
                Ok(None) => break,
                Err(e) => {
                    walk_failed = Some(e.to_string());
                    break;
                }
            }
        }
        match walk_failed {
            None => break,
            Some(err) if attempts == 0 => {
                attempts += 1;
                log::warn!(
                    "[fs] cmd_get_files iter_messages failed ({}): evicting peer cache and retrying",
                    err,
                );
                if let Some(fid) = folder_id {
                    state.peer_cache.write().await.remove(&fid);
                }
                continue;
            }
            Some(err) => return Err(err),
        }
    }

    Ok(files)
}

fn push_file_from_message(
    files: &mut Vec<FileMetadata>,
    msg: &grammers_client::types::Message,
    folder_id: Option<i64>,
) {
    let media = match msg.media() { Some(m) => m, None => return };
    let (name, size, mime, ext) = match media {
        Media::Document(d) => {
            let raw_name = d.name().to_string();
            let s = d.size();
            let m = d.mime_type().map(|s| s.to_string());
            let (n, e) = if raw_name.is_empty() {
                let ext = ext_from_mime(m.as_deref());
                let prefix = match m.as_deref() {
                    Some(mt) if mt.starts_with("video/") => "Video",
                    Some(mt) if mt.starts_with("audio/") => "Audio",
                    Some(mt) if mt.starts_with("image/") => "Image",
                    _ => "File",
                };
                let n = match ext {
                    Some(ext) => format!("{}_{}.{}", prefix, msg.id(), ext),
                    None => format!("{}_{}", prefix, msg.id()),
                };
                (n, ext.map(String::from))
            } else {
                let ext = std::path::Path::new(&raw_name)
                    .extension()
                    .and_then(|os| os.to_str())
                    .map(|s| s.to_string());
                (raw_name, ext)
            };
            (n, s, m, e)
        }
        Media::Photo(p) => {
            let s = p.thumbs().iter().map(|ps| ps.size() as i64).max().unwrap_or(0);
            ("Photo.jpg".to_string(), s, Some("image/jpeg".into()), Some("jpg".into()))
        }
        // Skip stickers, contacts, polls, geo, dice, venues, geolive, webpage — not files
        _ => return,
    };
    // Pull video duration from raw attributes when present. grammers'
    // Media::Document doesn't expose attributes() directly, but Photo's
    // raw and Document's raw both surface them through `.raw` access via
    // a serialisable form. We re-derive via the message's raw view to
    // keep the function self-contained.
    let duration_secs = match msg.media() {
        Some(Media::Document(d)) => extract_video_duration_secs(&d),
        _ => None,
    };
    files.push(FileMetadata {
        id: msg.id() as i64,
        folder_id,
        name,
        size: size as u64,
        mime_type: mime,
        file_ext: ext,
        created_at: msg.date().to_string(),
        icon_type: "file".into(),
        duration_secs,
    });
}

/// Pull video duration (seconds) from a grammers Document; None for
/// non-video documents. grammers exposes the underlying
/// DocumentAttributeVideo through `Document::duration()` as f64 seconds.
fn extract_video_duration_secs(doc: &grammers_client::types::media::Document) -> Option<u32> {
    doc.duration().map(|d| d.ceil() as u32)
}

#[tauri::command]
pub async fn cmd_search_global(
    query: String,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();
    let mut files = Vec::new();
    
    log::info!("Searching global for: {}", query);

    let result = client.invoke(&tl::functions::messages::SearchGlobal {
        q: query,
        filter: tl::enums::MessagesFilter::InputMessagesFilterDocument,
        min_date: 0,
        max_date: 0,
        offset_rate: 0,
        offset_peer: tl::enums::InputPeer::Empty,
        offset_id: 0,
        limit: 50,
        folder_id: None,
        broadcasts_only: false,
        groups_only: false,
        users_only: false,
    }).await.map_err(map_error)?;

    let (raw_messages, raw_chats) = match result {
        tl::enums::messages::Messages::Messages(m) => (m.messages, m.chats),
        tl::enums::messages::Messages::Slice(s) => (s.messages, s.chats),
        _ => (Vec::new(), Vec::new()),
    };

    // Seed the peer cache from the chats list returned by SearchGlobal. Without
    // this, opening a search-result file from a channel that does not surface
    // in `iter_dialogs` (e.g. a [TD] folder that hasn't bubbled to the top
    // recently, or a channel grammers' dialog iterator misses) hits
    // resolve_peer's slow path and fails with "Folder/Chat NNN not found".
    {
        let mut cache = state.peer_cache.write().await;
        let mut added = 0usize;
        for chat in &raw_chats {
            match chat {
                tl::enums::Chat::Channel(c) => {
                    let id = c.id;
                    if !cache.contains_key(&id) {
                        cache.insert(id, Peer::from_raw(chat.clone()));
                        added += 1;
                    }
                }
                tl::enums::Chat::ChannelForbidden(c) => {
                    let id = c.id;
                    if !cache.contains_key(&id) {
                        cache.insert(id, Peer::from_raw(chat.clone()));
                        added += 1;
                    }
                }
                _ => {} // Empty/Chat/Forbidden — basic-group chats, not used by [TD]
            }
        }
        if added > 0 {
            log::info!("[search] populated peer cache with {} channel(s) from search results", added);
        }
    }

    for msg in raw_messages {
        if let tl::enums::Message::Message(m) = msg {
            if let Some(tl::enums::MessageMedia::Document(d)) = m.media {
                if let tl::enums::Document::Document(doc) = d.document.unwrap() {
                    let name = doc.attributes.iter().find_map(|a| match a {
                        tl::enums::DocumentAttribute::Filename(f) => Some(f.file_name.clone()),
                        _ => None
                    }).unwrap_or("Unknown".to_string());
                    let size = doc.size as u64;
                    let mime = doc.mime_type.clone();
                    let ext = std::path::Path::new(&name).extension().map(|os| os.to_str().unwrap_or("").to_string());
                    let folder_id = match m.peer_id {
                        tl::enums::Peer::Channel(c) => Some(c.channel_id),
                        tl::enums::Peer::User(u) => Some(u.user_id),
                        tl::enums::Peer::Chat(c) => Some(c.chat_id),
                    };
                    let duration_secs = doc.attributes.iter().find_map(|a| match a {
                        tl::enums::DocumentAttribute::Video(v) => Some(v.duration.ceil() as u32),
                        _ => None,
                    });
                    files.push(FileMetadata {
                        id: m.id as i64, folder_id, name, size,
                        mime_type: Some(mime), file_ext: ext,
                        created_at: m.date.to_string(), icon_type: "file".into(),
                        duration_secs,
                    });
                }
            }
        }
    }

    Ok(files)
}

fn match_channel_folder(folders: &mut Vec<FolderMetadata>, id: i64, name: String) {
    if !name.to_lowercase().contains("[td]") {
        return;
    }
    log::info!(" -> MATCH via Title: {}", name);
    let display_name = name
        .replace(" [TD]", "")
        .replace(" [td]", "")
        .replace("[TD]", "")
        .replace("[td]", "")
        .trim()
        .to_string();
    folders.push(FolderMetadata { id, name: display_name, parent_id: None });
}

#[tauri::command]
pub async fn cmd_scan_folders(
    state: State<'_, TelegramState>,
) -> Result<Vec<FolderMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();

    let my_gen = state.generation.load(std::sync::atomic::Ordering::SeqCst);
    let mut folders = Vec::new();
    let mut dialogs = client.iter_dialogs();

    log::info!("Starting Folder Scan...");

    let mut peer_cache = state.peer_cache.write().await;

    while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
            log::info!("[fs] cmd_scan_folders cancelled by newer connect at {} folders", folders.len());
            return Ok(folders);
        }
        match &dialog.peer {
            Peer::Channel(c) => {
                let id = c.raw.id;
                peer_cache.insert(id, dialog.peer.clone());

                let name = c.raw.title.clone();
                match_channel_folder(&mut folders, id, name);
            },
            Peer::User(u) => {
                peer_cache.insert(u.raw.id(), dialog.peer.clone());
                log::debug!("[SCAN] Cached User Peer: {}", u.raw.id());
            },
            peer => {
                log::debug!("[SCAN] Skipped Peer: {:?}", peer);
            }
        }
    }

    // Telegram's archive lives in folder_id=1 and isn't traversed by iter_dialogs.
    // Walk it directly via the raw API so [TD] folders the user has archived still appear.
    log::info!("[SCAN] Walking archive (folder_id=1)...");
    let mut archive_offset_date = 0i32;
    let mut archive_offset_id = 0i32;
    let mut archive_offset_peer = tl::enums::InputPeer::Empty;
    let mut archive_seen = 0usize;

    loop {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
            log::info!("[fs] cmd_scan_folders archive walk cancelled by newer connect");
            return Ok(folders);
        }
        let req = tl::functions::messages::GetDialogs {
            exclude_pinned: false,
            folder_id: Some(1),
            offset_date: archive_offset_date,
            offset_id: archive_offset_id,
            offset_peer: archive_offset_peer.clone(),
            limit: 100,
            hash: 0,
        };

        let (dialogs_out, messages_out, users_out, chats_out, is_last) =
            match client.invoke(&req).await.map_err(|e| e.to_string())? {
                tl::enums::messages::Dialogs::Dialogs(d) =>
                    (d.dialogs, d.messages, d.users, d.chats, true),
                tl::enums::messages::Dialogs::Slice(d) => {
                    let last = d.dialogs.len() < 100;
                    (d.dialogs, d.messages, d.users, d.chats, last)
                }
                tl::enums::messages::Dialogs::NotModified(_) => break,
            };

        if dialogs_out.is_empty() {
            break;
        }
        archive_seen += dialogs_out.len();

        for chat in &chats_out {
            if let tl::enums::Chat::Channel(c) = chat {
                let id = c.id;
                if !peer_cache.contains_key(&id) {
                    peer_cache.insert(id, Peer::from_raw(chat.clone()));
                }
                let name = c.title.clone();
                match_channel_folder(&mut folders, id, name);
            }
        }

        if is_last {
            break;
        }

        let last_dialog = match dialogs_out.last() {
            Some(tl::enums::Dialog::Dialog(d)) => d.clone(),
            _ => break,
        };
        archive_offset_id = last_dialog.top_message;
        archive_offset_date = messages_out.iter().find_map(|m| match m {
            tl::enums::Message::Message(mm) if mm.id == archive_offset_id => Some(mm.date),
            tl::enums::Message::Service(ms) if ms.id == archive_offset_id => Some(ms.date),
            _ => None,
        }).unwrap_or(0);
        archive_offset_peer = match &last_dialog.peer {
            tl::enums::Peer::User(p) => {
                let access_hash = users_out.iter().find_map(|u| match u {
                    tl::enums::User::User(uu) if uu.id == p.user_id => uu.access_hash,
                    _ => None,
                }).unwrap_or(0);
                tl::enums::InputPeer::User(tl::types::InputPeerUser { user_id: p.user_id, access_hash })
            }
            tl::enums::Peer::Chat(p) =>
                tl::enums::InputPeer::Chat(tl::types::InputPeerChat { chat_id: p.chat_id }),
            tl::enums::Peer::Channel(p) => {
                let access_hash = chats_out.iter().find_map(|c| match c {
                    tl::enums::Chat::Channel(ch) if ch.id == p.channel_id => ch.access_hash,
                    tl::enums::Chat::ChannelForbidden(ch) if ch.id == p.channel_id => Some(ch.access_hash),
                    _ => None,
                }).unwrap_or(0);
                tl::enums::InputPeer::Channel(tl::types::InputPeerChannel { channel_id: p.channel_id, access_hash })
            }
        };
    }

    log::info!("Scan complete. Found {} folders ({} archived dialogs walked). Peer cache size: {}.", folders.len(), archive_seen, peer_cache.len());
    Ok(folders)
}
