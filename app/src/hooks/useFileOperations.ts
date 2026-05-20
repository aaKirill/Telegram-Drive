import { invoke } from '../lib/transport';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFile } from '../types';
import { formatBytes } from '../utils';

export function useFileOperations(
    activeFolderId: number | null,
    selectedIds: number[],
    setSelectedIds: (ids: number[]) => void,
) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();

    /** Drop the given ids from any cached `['files', activeFolderId, ...]` lists.
     *  Telegram's GetHistory has a brief read-after-write delay where a deleted
     *  message can still appear in `iter_messages` for a few hundred ms after
     *  delete_messages returns Ok — without optimistic removal, the UI seems
     *  to ignore the delete until refetchOnWindowFocus fires on alt-tab. */
    const removeIdsFromCache = (ids: number[]) => {
        if (ids.length === 0) return;
        const ids_set = new Set(ids);
        queryClient.setQueriesData(
            { queryKey: ['files', activeFolderId] },
            (old: TelegramFile[] | undefined) =>
                Array.isArray(old) ? old.filter((f) => !ids_set.has(f.id)) : old,
        );
    };

    const handleDelete = async (id: number) => {
        if (!await confirm({ title: "Delete File", message: "Are you sure you want to delete this file?", confirmText: "Delete", variant: 'danger' })) return;
        try {
            await invoke('cmd_delete_file', { messageId: id, folderId: activeFolderId });
            removeIdsFromCache([id]);
            queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
            toast.success("File deleted");
        } catch (e) {
            toast.error(`Delete failed: ${e}`);
        }
    }

    const handleBulkDelete = async () => {
        if (selectedIds.length === 0) return;
        if (!await confirm({ title: "Delete Files", message: `Are you sure you want to delete ${selectedIds.length} files?`, confirmText: "Delete All", variant: 'danger' })) return;

        let success = 0;
        let fail = 0;
        const successfullyDeleted: number[] = [];
        for (const id of selectedIds) {
            try {
                await invoke('cmd_delete_file', { messageId: id, folderId: activeFolderId });
                successfullyDeleted.push(id);
                success++;
            } catch {
                fail++;
            }
        }
        setSelectedIds([]);
        removeIdsFromCache(successfullyDeleted);
        queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
        if (success > 0) toast.success(`Deleted ${success} files.`);
        if (fail > 0) toast.error(`Failed to delete ${fail} files.`);
    }

    const handleDownload = async (id: number, name: string) => {
        try {
            const savePath = await import('@tauri-apps/plugin-dialog').then(d => d.save({
                defaultPath: name,
            }));
            if (!savePath) return;
            toast.info(`Download started: ${name}`);
            await invoke('cmd_download_file', { messageId: id, savePath, folderId: activeFolderId });
            toast.success(`Download complete: ${name}`);
        } catch (e) {
            toast.error(`Download failed: ${e}`);
        }
    }

    const handleBulkMove = async (targetFolderId: number | null, onSuccess?: () => void) => {
        if (selectedIds.length === 0) return;
        const movedIds = [...selectedIds];
        try {
            const newFiles = await invoke<TelegramFile[]>('cmd_move_files', {
                messageIds: selectedIds,
                sourceFolderId: activeFolderId,
                targetFolderId: targetFolderId
            });
            toast.success(`Moved ${selectedIds.length} files.`);
            removeIdsFromCache(movedIds);
            // Optimistic insert into target folder cache. cmd_move_files
            // returns the freshly-forwarded messages' metadata so we
            // don't have to wait on the GetHistory replication lag —
            // Saved Messages especially can take ~1 min before iter_messages
            // sees a forwarded message.
            if (Array.isArray(newFiles) && newFiles.length > 0) {
                const inserted: TelegramFile[] = newFiles.map((f) => ({
                    ...f,
                    sizeStr: formatBytes(f.size),
                }));
                queryClient.setQueriesData<TelegramFile[]>(
                    { queryKey: ['files', targetFolderId] },
                    (old) => {
                        if (!old) return inserted;
                        const existingIds = new Set(old.map((x) => x.id));
                        const additions = inserted.filter((x) => !existingIds.has(x.id));
                        return additions.length > 0 ? [...additions, ...old] : old;
                    },
                );
            }
            queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
            setSelectedIds([]);
            if (onSuccess) onSuccess();
        } catch {
            toast.error('Failed to move files');
        }
    };

    return {
        handleDelete,
        handleBulkDelete,
        handleDownload,
        handleBulkMove,
        handleGlobalSearch: async (query: string) => {
            try {
                return await invoke<TelegramFile[]>('cmd_search_global', { query });
            } catch {
                return [];
            }
        }
    };
}
