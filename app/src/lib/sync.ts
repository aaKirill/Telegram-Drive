// Cross-device settings sync via a dedicated Telegram channel
// (`Telegram Drive Sync` with `[telegram-drive-sync]` in the about field).
// Whole-snapshot, last-write-wins.
//
// Transport:
//   `cmd_sync_read()`  -> latest snapshot bytes (or empty array)
//   `cmd_sync_write({bytes})` -> upload as a new document
// Both Tauri (commands/sync.rs) and web (web-stubs/sync.ts) implement these.

import { invoke } from "./transport";
import { Store } from "@tauri-apps/plugin-store";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  getCurrentSettings,
  getSyncFolderIdLocalTs,
  setSettingsFromSync,
} from "../hooks/useAppSettings";
import {
  type FolderPrefs,
  getCurrentPrefs,
  setPrefsFromSync,
} from "../hooks/useFolderPrefs";
import type { TelegramFolder } from "../types";

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
  // Optional in v=1 so older clients that don't write this field stay
  // forward-compatible (they just ignore the key on parse). Carries the
  // ordered folder list — without it, deletes/reorders never propagate.
  folders?: TelegramFolder[];
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
      // sync, push the *current local* state to BOTH locations:
      //   - OLD: serves as a redirect — clients still reading there pick
      //     up the new syncFolderId from settings and migrate themselves.
      //   - NEW: ensures the new location reflects current state. Without
      //     this, a stale snapshot left at the new location from a prior
      //     visit (e.g. you toggle null → X → null → X again) would be
      //     pulled-and-applied below and silently roll us back.
      // After both writes we save and return — there's nothing useful to
      // pull this cycle (we just authored the network), and any concurrent
      // remote update will surface on the next runSync.
      const currentFolder = getCurrentSettings().syncFolderId ?? null;
      const previousFolder = loadLastFolder();
      if (previousFolder !== undefined && previousFolder !== currentFolder) {
        try {
          const local = await buildLocalSnapshot();
          local.ts = Math.max(Date.now(), lastSeenTs + 1);
          try { await pushSnapshotTo(previousFolder, local); }
          catch (e) { console.warn("[td] sync redirect write at old folder failed:", e); }
          try { await pushSnapshotTo(currentFolder, local); }
          catch (e) { console.warn("[td] sync write at new folder failed:", e); }
          lastSeenTs = local.ts;
          saveLastSeen(local.ts);
          dirty = false;
          saveLastFolder(currentFolder);
        } catch (e) {
          console.warn("[td] sync migration failed:", e);
        }
        return;
      }

      const dirtyAtStart = dirty;
      const remote = await pullSnapshot();
      let appliedRemote = false;
      if (remote && remote.ts > lastSeenTs) {
        await applySnapshot(remote);
        lastSeenTs = remote.ts;
        saveLastSeen(remote.ts);
        appliedRemote = true;
        // Whole-snapshot LWW: any concurrent local changes during the
        // pull window are accepted as overwritten. We DON'T clear dirty
        // here — if the user made a real local change before this run,
        // we still want to push our current (post-apply, post-merge)
        // state out so other clients see it.
      }

      if (dirty || dirtyAtStart || (!remote && hasMeaningfulLocalState())) {
        const local = await buildLocalSnapshot();
        local.ts = Math.max(Date.now(), lastSeenTs + 1);
        try {
          await pushSnapshot(local);
          lastSeenTs = local.ts;
          saveLastSeen(local.ts);
          dirty = false;
        } catch (e) {
          console.warn("[td] sync push failed:", e);
          // Leave dirty=true so the next runSync retries.
        }
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
  const folderId = getCurrentSettings().syncFolderId ?? null;
  await pushSnapshotTo(folderId, snap);
}

async function pushSnapshotTo(folderId: number | null, snap: Snapshot): Promise<void> {
  const json = JSON.stringify(snap);
  const bytes = new TextEncoder().encode(json);
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
    folders: await readFoldersFromStore(),
  };
}

async function readFoldersFromStore(): Promise<TelegramFolder[]> {
  try {
    let store = await Store.load("config.json");
    let folders = await store.get<TelegramFolder[]>("folders");
    if (!folders) {
      store = await Store.load("settings.json");
      folders = await store.get<TelegramFolder[]>("folders");
    }
    return folders ?? [];
  } catch {
    return [];
  }
}

async function writeFoldersToStore(folders: TelegramFolder[]): Promise<void> {
  try {
    const store = await Store.load("config.json");
    await store.set("folders", folders);
    await store.save();
  } catch { /* non-fatal — the UI's td:sync-applied listener won't pick up
                 the change but next focus rescan will */ }
}

async function applySnapshot(snap: Snapshot): Promise<void> {
  if (snap.settings) {
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...snap.settings } as AppSettings;
    // Don't let an older remote snapshot clobber a freshly-made local
    // syncFolderId choice — when you toggle the sync location back to a
    // previous one, the redirect we left at the destination still has
    // syncFolderId=<other> and would otherwise drag us back. Other
    // settings still apply normally (LWW on whole snapshot).
    const localTs = getSyncFolderIdLocalTs();
    if (localTs > 0 && snap.ts < localTs) {
      merged.syncFolderId = getCurrentSettings().syncFolderId;
    }
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
  if (snap.folders) {
    // LWW replace: write the remote folder list verbatim so deletes /
    // reorders propagate. Dispatch via CustomEvent with the payload
    // attached because Tauri's Store plugin hands out per-call handles
    // with their own in-memory cache — a listener that just re-reads
    // its own handle would see the stale value, not what we just
    // persisted from a different handle here.
    await writeFoldersToStore(snap.folders);
    window.dispatchEvent(new CustomEvent("td:sync-folders-applied", { detail: snap.folders }));
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
