import { useCallback, useEffect, useReducer } from 'react';
import { Store, load } from '@tauri-apps/plugin-store';

const STORE_FILE = 'app-settings.json';

export type ViewMode = 'grid' | 'list';
export type SortField = 'name' | 'size' | 'date';
export type SortDir = 'asc' | 'desc';

export interface AppSettings {
    autoLockMinutes: number | null;       // null = off
    defaultView: ViewMode;
    defaultSortField: SortField;
    defaultSortDir: SortDir;
    updateCheckEnabled: boolean;
    downloadPath: string | null;          // null = ask each time
    hideThumbnailsGlobal: boolean;
    hideThumbnailsForNewFolders: boolean;
    /** When enabled, 10 consecutive wrong folder password attempts wipe that
     *  folder; 10 wrong app-passcode attempts wipe everything. Default off. */
    killswitchEnabled: boolean;
    /** Folder where cross-device sync snapshots (td-sync.json) live.
     *  null = Saved Messages (default). Otherwise a [TD] folder id. */
    syncFolderId: number | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
    autoLockMinutes: 20,
    defaultView: 'grid',
    defaultSortField: 'date',
    defaultSortDir: 'desc',
    updateCheckEnabled: true,
    downloadPath: null,
    hideThumbnailsGlobal: false,
    hideThumbnailsForNewFolders: false,
    killswitchEnabled: false,
    syncFolderId: null,
};

// Module-level shared state. Without this, every component calling
// useAppSettings() gets its own React state — updating from the Settings
// page only re-renders the Settings component itself, leaving the rest of
// the UI showing stale values until the user reloads. By colocating state
// at the module level and notifying all subscribers on update, every
// useAppSettings() consumer re-renders when anything changes.
let _settings: AppSettings = { ...DEFAULT_SETTINGS };
let _loaded = false;
let _store: Store | null = null;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach(fn => fn());

let _initPromise: Promise<void> | null = null;
function init(): Promise<void> {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        _store = await load(STORE_FILE);
        const next: AppSettings = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
            const v = await _store.get(key);
            if (v !== undefined && v !== null) (next as any)[key] = v;
        }
        _settings = next;
        _loaded = true;
        notify();
    })();
    return _initPromise;
}

export async function updateAppSettingValue<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    _settings = { ..._settings, [key]: value };
    notify();
    if (!_store) _store = await load(STORE_FILE);
    await _store.set(key, value as any);
    await _store.save();
    // Lazy import keeps the sync module out of the cold-start path.
    import('../lib/sync').then(m => m.markDirty()).catch(() => { });
}

export function getCurrentSettings(): AppSettings {
    return _settings;
}

/** Replace the whole settings object from a remote sync snapshot, without
 *  triggering another sync push. */
export async function setSettingsFromSync(next: AppSettings): Promise<void> {
    _settings = { ...next };
    notify();
    if (!_store) _store = await load(STORE_FILE);
    for (const key of Object.keys(_settings) as (keyof AppSettings)[]) {
        await _store.set(key, _settings[key] as any);
    }
    await _store.save();
}

export function useAppSettings() {
    const [, force] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        subscribers.add(force);
        if (!_loaded) init();
        return () => { subscribers.delete(force); };
    }, []);

    const update = useCallback(updateAppSettingValue, []);

    return { settings: _settings, loaded: _loaded, update };
}
