import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { useAppSettings } from './useAppSettings';
import { TelegramFolder } from '../types';

const KILLSWITCH_THRESHOLD = 10;

/** Drop the folder from every persistent client-side store so a reload
 *  doesn't resurrect a tombstone. Called from both the per-folder killswitch
 *  and the full-wipe path. */
async function purgeFolderLocally(folderId: number) {
    // Folder list lives in either config.json (modern) or settings.json (legacy).
    for (const file of ['config.json', 'settings.json']) {
        try {
            const s = await load(file);
            const list = await s.get<TelegramFolder[]>('folders');
            if (list && list.some(f => f.id === folderId)) {
                await s.set('folders', list.filter(f => f.id !== folderId));
                await s.save();
            }
        } catch {}
    }
    // Per-folder thumbnail / hidden preferences.
    try {
        const prefs = await load('folder-prefs.json');
        await prefs.delete(folderId.toString());
        await prefs.save();
    } catch {}
    // Lock metadata + attempt counter for this folder.
    try {
        const locks = await load('folder-locks.json');
        await locks.delete(folderId.toString());
        await locks.save();
    } catch {}
    try {
        const attempts = await load('lock-attempts.json');
        await attempts.delete(folderId.toString());
        await attempts.save();
    } catch {}
}

/** Killswitch helper for folder-level password attempts. Caller is expected to
 *  invoke `check(folderId)` *after* a failed unlock or remove-lock attempt. If
 *  the killswitch setting is enabled and the per-folder attempt counter has
 *  hit the threshold, this wipes the folder (deletes the channel + drops the
 *  lock metadata + cleans local store) and reloads. Returns true if a wipe
 *  was triggered so the caller can short-circuit further UI work. */
export function useFolderKillswitch() {
    const { settings } = useAppSettings();

    const check = async (folderId: number | null): Promise<boolean> => {
        if (!settings.killswitchEnabled) return false;
        try {
            const attempts = await invoke<number>('cmd_get_lock_attempts', { folderId });
            if (attempts < KILLSWITCH_THRESHOLD) return false;
            // Saved Messages can't be deleted — for "home" we just clear the
            // lock metadata so the user can recover access via Settings.
            if (folderId === null) return false;
            try {
                await invoke('cmd_delete_folder', { folderId });
            } catch {
                // best-effort — even if Telegram delete failed, still wipe
                // local state so the dead folder doesn't keep showing up.
            }
            await purgeFolderLocally(folderId);
            window.location.reload();
            return true;
        } catch {
            return false;
        }
    };

    return { check };
}
