// Stub for @tauri-apps/api/core in the web build. Dispatches cmd_* names
// to the gramjs-backed client and the WebCrypto passcode module. Anything
// not yet implemented (folder/file ops) rejects so the UI surfaces the gap
// instead of silently returning empty data.

import * as client from "./client";
import * as passcode from "./passcode";
import * as folders from "./folders";
import * as files from "./files";
import * as locks from "./locks";
import * as sync from "./sync";

type Handler = (args: Record<string, unknown> | undefined) => Promise<unknown> | unknown;

const HANDLERS: Record<string, Handler> = {
  cmd_passcode_status: () => passcode.status(),
  cmd_passcode_set: (a) => passcode.set(String(a?.passcode ?? "")),
  cmd_passcode_unlock: (a) => passcode.unlock(String(a?.passcode ?? "")),
  cmd_passcode_lock: () => passcode.lock(),
  cmd_passcode_change: (a) => passcode.change(String(a?.oldPasscode ?? ""), String(a?.newPasscode ?? "")),
  cmd_passcode_remove: (a) => passcode.remove(String(a?.passcode ?? "")),
  cmd_passcode_reset: () => passcode.reset(),
  cmd_get_passcode_attempts: () => locks.getAttempts(locks.PASSCODE_ATTEMPTS_KEY),
  cmd_get_lock_attempts: (a) =>
    locks.getAttempts(a?.folderId == null ? "home" : String(a.folderId)),

  cmd_lock_folder: (a) =>
    locks.setLock(a?.folderId == null ? null : Number(a.folderId), String(a?.password ?? "")),
  cmd_unlock_folder: (a) =>
    locks.unlock(a?.folderId == null ? null : Number(a.folderId), String(a?.password ?? "")),
  cmd_remove_lock: (a) =>
    locks.removeLock(a?.folderId == null ? null : Number(a.folderId), String(a?.password ?? "")),
  cmd_relock_folder: (a) => {
    locks.relock(a?.folderId == null ? null : Number(a.folderId));
    return undefined;
  },
  cmd_list_locked_keys: () => locks.listLockedKeys(),
  cmd_list_all_locked_keys: () => locks.listAllLockedKeys(),
  cmd_prune_orphan_locks: (a) =>
    locks.pruneOrphanLocks(((a?.validFolderIds as number[]) ?? []).map(Number)),

  cmd_connect: (a) => client.connect(Number(a?.apiId)),
  cmd_check_connection: () => client.checkConnection(),
  cmd_auth_request_code: (a) => client.authRequestCode(String(a?.phone ?? "")),
  cmd_auth_sign_in: (a) => client.authSignIn(String(a?.code ?? "")),
  cmd_auth_check_password: (a) => client.authCheckPassword(String(a?.password ?? "")),
  cmd_logout: () => client.logout(),

  cmd_clean_cache: () => { files.clearAllBlobs(); return undefined; },
  cmd_is_network_available: () => navigator.onLine,

  cmd_scan_folders: () => folders.scanFolders(),
  cmd_create_folder: (a) => folders.createFolder(String(a?.name ?? "")),
  cmd_delete_folder: (a) => folders.deleteFolder(Number(a?.folderId)),
  cmd_get_files: (a) => folders.getFiles(a?.folderId == null ? null : Number(a.folderId)),
  cmd_search_global: (a) => folders.searchGlobal(String(a?.query ?? "")),
  cmd_delete_file: (a) =>
    folders.deleteFile(Number(a?.messageId), a?.folderId == null ? null : Number(a.folderId)),
  cmd_move_files: (a) =>
    folders.moveFiles(
      (a?.messageIds as number[]) ?? [],
      a?.sourceFolderId == null ? null : Number(a.sourceFolderId),
      a?.targetFolderId == null ? null : Number(a.targetFolderId),
    ),
  cmd_get_bandwidth: () => ({ uploaded: 0, downloaded: 0 }),

  cmd_upload_file: (a) =>
    files.uploadFile(String(a?.path ?? ""), Number(a?.folderId), String(a?.transferId ?? "")) as Promise<unknown>,
  cmd_download_file: (a) =>
    files.downloadFile(
      Number(a?.messageId),
      a?.savePath == null ? null : String(a.savePath),
      a?.folderId == null ? null : Number(a.folderId),
      String(a?.transferId ?? ""),
    ),
  cmd_get_thumbnail: (a) =>
    files.getThumbnail(Number(a?.messageId), a?.folderId == null ? null : Number(a.folderId)),
  cmd_get_preview: (a) =>
    files.getPreview(Number(a?.messageId), a?.folderId == null ? null : Number(a.folderId)),
  cmd_get_media_url: (a) =>
    files.getMediaUrl(Number(a?.messageId), a?.folderId == null ? null : Number(a.folderId)),
  cmd_open_path: (a) => files.openPath(String(a?.path ?? "")),
  cmd_get_stream_info: () => files.getStreamInfo(),
  cmd_cancel_transfer: (a) => { files.cancelTransfer(String(a?.transferId ?? "")); return true; },

  cmd_sync_read: (a) =>
    sync.syncRead(a?.folderId == null ? null : Number(a.folderId)).then((b) => (b ? Array.from(b) : [])),
  cmd_sync_write: (a) =>
    sync.syncWrite((a?.bytes as number[]) ?? [], a?.folderId == null ? null : Number(a.folderId)),
  cmd_sync_purge: (a) =>
    sync.syncPurge(a?.folderId == null ? null : Number(a.folderId)),
  cmd_export_folder_locks: () => locks.exportLocks(),
  cmd_import_folder_locks: (a) =>
    locks.importLocks((a?.locks as Record<string, string>) ?? {}),
  cmd_export_lock_attempts: () => locks.exportAttempts(),
  cmd_import_lock_attempts: (a) =>
    locks.importAttempts((a?.attempts as Record<string, number>) ?? {}),
};

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const handler = HANDLERS[cmd];
  if (!handler) {
    return Promise.reject(new Error(`Not implemented in web preview: ${cmd}`));
  }
  return Promise.resolve().then(() => handler(args) as T);
}

export function convertFileSrc(path: string): string {
  return path;
}
