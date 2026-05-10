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
  // Per-device daily bandwidth contributions, keyed by a stable device id.
  // The displayed "Used Today" sums every entry whose date matches today.
  // Each device only writes its own slot; we replay every other device's
  // slot from local cache when building the snapshot, so concurrent
  // pushes don't lose contributions.
  bandwidthByDevice?: Record<string, { date: string; up: number; down: number }>;
}

const DEVICE: "web" | "tauri" =
  import.meta.env.VITE_TARGET === "web" ? "web" : "tauri";

const LAST_SEEN_KEY = "_sync_last_seen_ts";

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

// Settings keys that are intentionally NOT synced — each device keeps its
// own value. defaultView is per-device because users naturally want
// different layouts on phone vs. a 27" monitor; gridColumnsDesktop is
// only meaningful on desktop and at different display widths;
// syncFolderId is the location *this device* reads/writes to and would
// be self-referential if shared — letting one device dictate everyone
// else's sync target was confusing and made selection changes ricochet.
const PER_DEVICE_SETTINGS = ['defaultView', 'gridColumnsDesktop', 'syncFolderId'] as const satisfies ReadonlyArray<keyof AppSettings>;

// Stable per-device id, generated once. Used to slot this device's
// bandwidth contribution into the shared snapshot without overwriting
// other devices' slots.
const DEVICE_ID_KEY = "_td_device_id_v1";
function getOrCreateDeviceId(): string {
  if (typeof localStorage === "undefined") return DEVICE;
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `${DEVICE}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* private mode */ }
  }
  return id;
}

// Cache of every other device's most-recent bandwidth slot. Replayed into
// each outgoing snapshot so a concurrent push doesn't drop slots we
// learned about earlier.
const REMOTE_BW_KEY = "_td_remote_bandwidth_v1";
type BwSlotMap = Record<string, { date: string; up: number; down: number }>;
function loadRemoteBandwidth(): BwSlotMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const v = JSON.parse(localStorage.getItem(REMOTE_BW_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as BwSlotMap) : {};
  } catch { return {}; }
}
function saveRemoteBandwidth(map: BwSlotMap): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(REMOTE_BW_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sum of every OTHER device's bandwidth contribution for today. The
 *  caller (BandwidthWidget) adds this to its own local up/down totals. */
export function getRemoteBandwidthToday(): { up: number; down: number } {
  const map = loadRemoteBandwidth();
  const today = todayUtc();
  let up = 0, down = 0;
  const myId = getOrCreateDeviceId();
  for (const [id, slot] of Object.entries(map)) {
    if (id === myId) continue;
    if (!slot || slot.date !== today) continue;
    up += Number(slot.up) || 0;
    down += Number(slot.down) || 0;
  }
  return { up, down };
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

  // Strip per-device keys from the pushed snapshot so they don't propagate
  // to other devices' AppSettings on apply.
  const sharedSettings: Partial<AppSettings> = { ...settings };
  for (const k of PER_DEVICE_SETTINGS) delete (sharedSettings as Partial<AppSettings>)[k];

  // Bandwidth: replay every cached remote slot, then write our own slot
  // for today on top. This avoids dropping contributions from devices
  // that pushed since we last pulled.
  let bandwidthByDevice: BwSlotMap | undefined;
  try {
    const localBw = await invoke<{ up_bytes: number; down_bytes: number }>("cmd_get_bandwidth");
    const merged: BwSlotMap = { ...loadRemoteBandwidth() };
    merged[getOrCreateDeviceId()] = {
      date: todayUtc(),
      up: Number(localBw?.up_bytes) || 0,
      down: Number(localBw?.down_bytes) || 0,
    };
    bandwidthByDevice = merged;
  } catch { /* desktop missing the cmd in older builds — non-fatal */ }

  return {
    v: 1,
    ts: Date.now(),
    device: DEVICE,
    settings: sharedSettings,
    folderPrefs,
    folderLocks,
    lockAttempts,
    folders: await readFoldersFromStore(),
    bandwidthByDevice,
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
    // Per-device settings are never overwritten by a remote snapshot.
    // (Old snapshots written before this filter went in may carry these
    //  keys; ignore them.)
    const local = getCurrentSettings();
    for (const k of PER_DEVICE_SETTINGS) {
      (merged as AppSettings)[k] = local[k] as never;
    }
    await setSettingsFromSync(merged);
  }
  // Empty-snapshot guard for folderPrefs. setPrefsFromSync still does
  // wholesale-replace (prefs are less load-bearing than locks and a
  // user genuinely clearing every pref should propagate). We just refuse
  // to replace populated local prefs with empty incoming, which catches
  // the "freshly-wiped device pushes first" case.
  const localPrefsCount = Object.keys(getCurrentPrefs()).length;
  const hasIncomingPrefs = snap.folderPrefs && Object.keys(snap.folderPrefs).length > 0;
  if (hasIncomingPrefs || (snap.folderPrefs && localPrefsCount === 0)) {
    await setPrefsFromSync(snap.folderPrefs ?? {});
  }
  // Folder locks: import is merge-add at the command layer (see
  // cmd_import_folder_locks / web-stubs/locks.ts:importLocks). Always
  // forward — empty maps are no-ops there.
  if (snap.folderLocks) {
    try {
      await invoke("cmd_import_folder_locks", { locks: snap.folderLocks });
    } catch { /* older Tauri builds skip; non-fatal */ }
  }
  const hasIncomingAttempts = snap.lockAttempts && Object.keys(snap.lockAttempts).length > 0;
  if (hasIncomingAttempts) {
    try {
      await invoke("cmd_import_lock_attempts", { attempts: snap.lockAttempts });
    } catch { /* same */ }
  }
  if (snap.bandwidthByDevice) {
    // Cache other devices' slots so the widget can sum them. We never
    // overwrite our own slot here — it's whatever cmd_get_bandwidth
    // reports locally.
    const incoming = snap.bandwidthByDevice;
    const map = { ...loadRemoteBandwidth() };
    const myId = getOrCreateDeviceId();
    for (const [id, slot] of Object.entries(incoming)) {
      if (id === myId) continue;
      if (!slot || typeof slot !== "object") continue;
      map[id] = {
        date: String((slot as { date?: unknown }).date ?? ""),
        up: Number((slot as { up?: unknown }).up) || 0,
        down: Number((slot as { down?: unknown }).down) || 0,
      };
    }
    saveRemoteBandwidth(map);
    window.dispatchEvent(new Event("td:bandwidth-applied"));
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
