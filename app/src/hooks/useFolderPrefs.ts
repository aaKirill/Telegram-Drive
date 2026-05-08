import { useCallback, useEffect, useReducer } from 'react';
import { Store, load } from '@tauri-apps/plugin-store';

const STORE_FILE = 'folder-prefs.json';

export interface FolderPref {
    hideThumbnails?: boolean;
    /** "Ultra-secret" — folder is hidden from the sidebar entirely until the
     *  user types its exact name in the search bar. */
    hidden?: boolean;
}

export type FolderPrefs = Record<string, FolderPref>;

const folderKey = (folderId: number | null) => folderId === null ? 'home' : folderId.toString();

// Module-level shared state — same rationale as useAppSettings: multiple
// useFolderPrefs() callers must re-render when any one of them mutates.
let _prefs: FolderPrefs = {};
let _loaded = false;
let _store: Store | null = null;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach(fn => fn());

let _initPromise: Promise<void> | null = null;
function init(): Promise<void> {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        _store = await load(STORE_FILE);
        const next: FolderPrefs = {};
        for (const key of await _store.keys()) {
            const v = await _store.get<FolderPref>(key);
            if (v) next[key] = v;
        }
        _prefs = next;
        _loaded = true;
        notify();
    })();
    return _initPromise;
}

async function updatePref(folderId: number | null, patch: FolderPref) {
    const key = folderKey(folderId);
    const merged = { ...(_prefs[key] ?? {}), ...patch };
    const cleaned: FolderPref = {};
    if (merged.hideThumbnails) cleaned.hideThumbnails = true;
    if (merged.hidden) cleaned.hidden = true;
    if (!_store) _store = await load(STORE_FILE);
    if (Object.keys(cleaned).length === 0) {
        await _store.delete(key);
        const { [key]: _, ...rest } = _prefs;
        _prefs = rest;
    } else {
        await _store.set(key, cleaned);
        _prefs = { ..._prefs, [key]: cleaned };
    }
    await _store.save();
    notify();
}

async function removePref(folderId: number | null) {
    const key = folderKey(folderId);
    if (!_store) _store = await load(STORE_FILE);
    await _store.delete(key);
    await _store.save();
    const { [key]: _, ...rest } = _prefs;
    _prefs = rest;
    notify();
}

export function useFolderPrefs() {
    const [, force] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        subscribers.add(force);
        if (!_loaded) init();
        return () => { subscribers.delete(force); };
    }, []);

    const get = useCallback((folderId: number | null): FolderPref =>
        _prefs[folderKey(folderId)] ?? {}, []);

    const update = useCallback(updatePref, []);
    const remove = useCallback(removePref, []);

    return { prefs: _prefs, loaded: _loaded, get, update, remove };
}
