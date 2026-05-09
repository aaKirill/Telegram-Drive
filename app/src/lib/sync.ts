// Cross-device settings sync via a dedicated Telegram channel
// (`Telegram Drive Sync` with `[telegram-drive-sync]` in the about field).
// Whole-snapshot, last-write-wins.
//
// Transport:
//   `cmd_sync_read()`  -> latest snapshot bytes (or empty array)
//   `cmd_sync_write({bytes})` -> upload as a new document
// Both Tauri (commands/sync.rs) and web (web-stubs/sync.ts) implement these.

import { invoke } from "./transport";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  getCurrentSettings,
  setSettingsFromSync,
} from "../hooks/useAppSettings";
import {
  type FolderPrefs,
  getCurrentPrefs,
  setPrefsFromSync,
} from "../hooks/useFolderPrefs";

// Folder-lock verifiers are PHC-encoded Argon2id hash strings — same format
// on Tauri and web — so a verifier hashed by either client can be checked
// by the other.
type FolderLockPhc = string;

interface Snapshot {
  v: 1;
  ts: number;
  device: "web" | "tauri";
  settings: Partial<AppSettings>;
  folderPrefs: FolderPrefs;
  folderLocks: Record<string, FolderLockPhc>;
  lockAttempts: Record<string, number>;
}

const DEVICE: "web" | "tauri" =
  import.meta.env.VITE_TARGET === "web" ? "web" : "tauri";

const LAST_SEEN_KEY = "_sync_last_seen_ts";
// Folder id we last successfully read/wrote sync data to. When the user
// changes the sync folder selection, we purge td-sync.json messages from
// the OLD location before the next push so abandoned snapshots don't
// pile up. Stringified ("home" for null = Saved Messages) since
// localStorage only takes strings.
const LAST_FOLDER_KEY = "_sync_last_folder_id";

let lastSeenTs = 0;
let dirty = false;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let initialised = false;

function loadLastSeen(): number {
  if (typeof localStorage === "undefined") return 0;
  return Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0) || 0;
}
function saveLastSeen(ts: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LAST_SEEN_KEY, String(ts));
}

function loadLastFolder(): number | null | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const v = localStorage.getItem(LAST_FOLDER_KEY);
  if (v == null) return undefined;
  if (v === "home") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function saveLastFolder(folderId: number | null): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LAST_FOLDER_KEY, folderId == null ? "home" : String(folderId));
}

function ensureInit(): void {
  if (initialised) return;
  lastSeenTs = loadLastSeen();
  initialised = true;
}

// Public API ---------------------------------------------------------------

export function markDirty(): void {
  ensureInit();
  dirty = true;
  if (dirtyTimer) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    runSync().catch(() => { /* sync errors are non-fatal */ });
  }, 1500);
}

export async function runSync(): Promise<void> {
  ensureInit();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // If the sync folder selection has changed since the last successful
      // sync, purge the old location's td-sync.json snapshots before doing
      // anything else. We compare to a localStorage-recorded "last folder"
      // (undefined = no previous record).
      const currentFolder = getCurrentSettings().syncFolderId ?? null;
      const previousFolder = loadLastFolder();
      if (previousFolder !== undefined && previousFolder !== currentFolder) {
        try {
          await invoke("cmd_sync_purge", { folderId: previousFolder });
        } catch (e) {
          // Non-fatal — if the old folder is no longer reachable (deleted
          // by the user, etc.) we just move on. The orphan snapshots
          // will sit there inert.
          console.warn("[td] sync_purge of old folder failed:", e);
        }
        // Reset lastSeenTs because the new folder's snapshot timeline is
        // independent — without this we'd refuse to apply a remote that
        // happens to have a smaller ts than what we'd seen at the OLD
        // location.
        lastSeenTs = 0;
        saveLastSeen(0);
      }

      const remote = await pullSnapshot();
      let appliedRemote = false;
      if (remote && remote.ts > lastSeenTs) {
        await applySnapshot(remote);
        lastSeenTs = remote.ts;
        saveLastSeen(remote.ts);
        appliedRemote = true;
        // Whole-snapshot LWW: any concurrent local changes during the
        // pull window are accepted as overwritten. The dirty flag is
        // cleared because the push below would re-write whatever we just
        // applied; not what the user wants.
        dirty = false;
      }

      if (dirty || (!remote && hasMeaningfulLocalState())) {
        const local = await buildLocalSnapshot();
        local.ts = Math.max(Date.now(), lastSeenTs + 1);
        await pushSnapshot(local);
        lastSeenTs = local.ts;
        saveLastSeen(local.ts);
        dirty = false;
      }
      // Record the folder we just read from / wrote to so a later
      // selection change can detect the divergence and purge.
      saveLastFolder(currentFolder);
      void appliedRemote;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Implementation ----------------------------------------------------------

async function pullSnapshot(): Promise<Snapshot | null> {
  try {
    const folderId = getCurrentSettings().syncFolderId ?? null;
    const result = await invoke<number[] | Uint8Array | null>("cmd_sync_read", { folderId });
    if (!result) return null;
    const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
    if (bytes.byteLength === 0) return null;
    const text = new TextDecoder().decode(bytes);
    const snap = JSON.parse(text) as Snapshot;
    if (!snap || snap.v !== 1 || typeof snap.ts !== "number") return null;
    return snap;
  } catch {
    return null;
  }
}

async function pushSnapshot(snap: Snapshot): Promise<void> {
  const json = JSON.stringify(snap);
  const bytes = new TextEncoder().encode(json);
  const folderId = getCurrentSettings().syncFolderId ?? null;
  await invoke("cmd_sync_write", { bytes: Array.from(bytes), folderId });
}

async function buildLocalSnapshot(): Promise<Snapshot> {
  const settings = getCurrentSettings();
  const folderPrefs = getCurrentPrefs();

  let folderLocks: Record<string, FolderLockPhc> = {};
  let lockAttempts: Record<string, number> = {};
  try {
    folderLocks = await invoke<Record<string, FolderLockPhc>>("cmd_export_folder_locks");
  } catch { /* command absent on older builds */ }
  try {
    lockAttempts = await invoke<Record<string, number>>("cmd_export_lock_attempts");
  } catch { /* same */ }

  return {
    v: 1,
    ts: Date.now(),
    device: DEVICE,
    settings,
    folderPrefs,
    folderLocks,
    lockAttempts,
  };
}

async function applySnapshot(snap: Snapshot): Promise<void> {
  if (snap.settings) {
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...snap.settings } as AppSettings;
    await setSettingsFromSync(merged);
  }
  if (snap.folderPrefs) {
    await setPrefsFromSync(snap.folderPrefs);
  }
  if (snap.folderLocks) {
    try {
      await invoke("cmd_import_folder_locks", { locks: snap.folderLocks });
    } catch { /* older Tauri builds skip; non-fatal */ }
  }
  if (snap.lockAttempts) {
    try {
      await invoke("cmd_import_lock_attempts", { attempts: snap.lockAttempts });
    } catch { /* same */ }
  }
  // Notify React-side caches that depend on this data to re-fetch.
  // useFolderLocks listens for this and re-runs cmd_list_*_locked_keys
  // so the sidebar lock badges update without a reload. useAppSettings
  // and useFolderPrefs already update their module-level state directly
  // via setSettingsFromSync / setPrefsFromSync.
  window.dispatchEvent(new Event("td:sync-applied"));
}

function hasMeaningfulLocalState(): boolean {
  // Avoid pushing an empty snapshot on first ever launch when nothing has
  // been configured yet — we'd just create churn in the sync channel.
  const s = getCurrentSettings();
  const hasSettings = JSON.stringify(s) !== JSON.stringify(DEFAULT_SETTINGS);
  const hasPrefs = Object.keys(getCurrentPrefs()).length > 0;
  return hasSettings || hasPrefs;
}
