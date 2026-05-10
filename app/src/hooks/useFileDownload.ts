import { useState, useEffect, useRef } from 'react';
import { invoke } from '../lib/transport';
import { save, open } from '@tauri-apps/plugin-dialog';
import { useAppSettings } from './useAppSettings';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DownloadItem, TelegramFile } from '../types';
import type { Store } from '@tauri-apps/plugin-store';

interface ProgressPayload {
    id: string;
    percent: number;
}

export function useFileDownload(store: Store | null) {
    const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());
    const { settings: appSettings } = useAppSettings();

    // Listen for progress events from Rust
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>('download-progress', (event) => {
            setDownloadQueue(q => q.map(i =>
                i.id === event.payload.id ? { ...i, progress: event.payload.percent } : i
            ));
        }).then(fn => { unlisten = fn; });
        return () => { unlisten?.(); };
    }, []);

    // Load saved queue on mount
    useEffect(() => {
        if (!store || initialized) return;
        store.get<DownloadItem[]>('downloadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved.filter(i => i.status === 'pending');
                if (pending.length > 0) {
                    setDownloadQueue(pending);
                    toast.info(`Restored ${pending.length} pending downloads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    // Save queue when it changes (only pending items)
    useEffect(() => {
        if (!store || !initialized) return;
        const pending = downloadQueue.filter(i => i.status === 'pending');
        store.set('downloadQueue', pending).then(() => store.save());
    }, [store, downloadQueue, initialized]);

    // Queue Processor
    useEffect(() => {
        if (processing) return;
        const nextItem = downloadQueue.find(i => i.status === 'pending');
        if (nextItem) {
            processItem(nextItem);
        }
    }, [downloadQueue, processing]);

    const processItem = async (item: DownloadItem) => {
        setProcessing(true);
        setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'downloading', progress: 0 } : i));

        try {
            // If the user set a default download folder, save straight there
            // (with the file's own name) and skip the OS save dialog.
            let savePath: string | null;
            if (appSettings.downloadPath) {
                const sep = appSettings.downloadPath.includes('\\') ? '\\' : '/';
                const trimmed = appSettings.downloadPath.endsWith(sep)
                    ? appSettings.downloadPath.slice(0, -1)
                    : appSettings.downloadPath;
                savePath = `${trimmed}${sep}${item.filename}`;
            } else {
                savePath = await save({ defaultPath: item.filename });
            }
            if (!savePath) {
                setDownloadQueue(q => q.filter(i => i.id !== item.id));
                setProcessing(false);
                return;
            }

            await invoke('cmd_download_file', {
                messageId: item.messageId,
                savePath,
                folderId: item.folderId,
                transferId: item.id
            });

            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                toast.success(`Downloaded: ${item.filename}`);
                import('../lib/sync').then(m => m.markDirty()).catch(() => { });
            }
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: String(e) } : i));
                toast.error(`Download failed: ${item.filename}`);
            } else {
                cancelledRef.current.delete(item.id);
            }
        } finally {
            setProcessing(false);
        }
    };

    const queueDownload = (messageId: number, filename: string, folderId: number | null) => {
        const newItem: DownloadItem = {
            id: Math.random().toString(36).substr(2, 9),
            messageId,
            filename,
            folderId,
            status: 'pending'
        };
        setDownloadQueue(prev => [...prev, newItem]);
    };

    const queueBulkDownload = async (files: TelegramFile[], folderId: number | null) => {
        const dirPath = await open({
            directory: true,
            multiple: false,
            title: "Select Download Destination"
        });
        if (!dirPath) return;

        for (const file of files) {
            const newItem: DownloadItem = {
                id: Math.random().toString(36).substr(2, 9),
                messageId: file.id,
                filename: file.name,
                folderId,
                status: 'pending'
            };
            setDownloadQueue(prev => [...prev, newItem]);
        }

        toast.info(`Queued ${files.length} files for download`);
    };

    const clearFinished = () => {
        setDownloadQueue(q => q.filter(i => i.status !== 'success'));
    };

    const cancelAll = () => {
        setDownloadQueue(q => {
            const downloading = q.find(i => i.status === 'downloading');
            if (downloading) {
                cancelledRef.current.add(downloading.id);
                invoke('cmd_cancel_transfer', { transferId: downloading.id }).catch(() => { });
            }
            return q
                .filter(i => i.status !== 'pending')
                .map(i => i.status === 'downloading' ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All downloads cancelled');
    };

    const dismissItem = (id: string) => {
        setDownloadQueue(q => q.filter(i => i.id !== id));
    };

    return {
        downloadQueue,
        queueDownload,
        queueBulkDownload,
        clearFinished,
        cancelAll,
        dismissItem,
    };
}
