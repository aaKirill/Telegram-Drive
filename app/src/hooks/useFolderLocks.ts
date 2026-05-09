import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../lib/transport';

export const folderKey = (folderId: number | null) => folderId === null ? 'home' : folderId.toString();

export function useFolderLocks() {
    const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set());
    const [allLockedKeys, setAllLockedKeys] = useState<Set<string>>(new Set());

    const refresh = useCallback(async () => {
        try {
            const [hidden, all] = await Promise.all([
                invoke<string[]>('cmd_list_locked_keys'),
                invoke<string[]>('cmd_list_all_locked_keys'),
            ]);
            setLockedKeys(new Set(hidden));
            setAllLockedKeys(new Set(all));
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const isLocked = useCallback((folderId: number | null) => lockedKeys.has(folderKey(folderId)), [lockedKeys]);
    const hasPassword = useCallback((folderId: number | null) => allLockedKeys.has(folderKey(folderId)), [allLockedKeys]);

    const markSyncDirty = () => {
        import('../lib/sync').then(m => m.markDirty()).catch(() => { });
    };

    const setPassword = useCallback(async (folderId: number | null, password: string) => {
        await invoke('cmd_lock_folder', { folderId, password });
        await refresh();
        markSyncDirty();
    }, [refresh]);

    const unlock = useCallback(async (folderId: number | null, password: string): Promise<boolean> => {
        const ok = await invoke<boolean>('cmd_unlock_folder', { folderId, password });
        if (ok) await refresh();
        markSyncDirty();
        return ok;
    }, [refresh]);

    const removeLock = useCallback(async (folderId: number | null, password: string): Promise<boolean> => {
        const ok = await invoke<boolean>('cmd_remove_lock', { folderId, password });
        if (ok) await refresh();
        markSyncDirty();
        return ok;
    }, [refresh]);

    const relock = useCallback(async (folderId: number | null) => {
        await invoke('cmd_relock_folder', { folderId });
        await refresh();
    }, [refresh]);

    return { lockedKeys, allLockedKeys, isLocked, hasPassword, setPassword, unlock, removeLock, relock, refresh };
}
