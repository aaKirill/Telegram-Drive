import { useState, useEffect, useRef } from 'react';
import { invoke } from '../lib/transport';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { QueueItem, TelegramFile } from '../types';
import { useFileDrop } from './useFileDrop';
import { formatBytes } from '../utils';
import type { Store } from '@tauri-apps/plugin-store';

interface ProgressPayload {
    id: string;
    percent: number;
}

export function useFileUpload(activeFolderId: number | null, store: Store | null) {
    const queryClient = useQueryClient();
    const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());

    // Listen for progress events from Rust
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>('upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id ? { ...i, progress: event.payload.percent } : i
            ));
        }).then(fn => { unlisten = fn; });
        return () => { unlisten?.(); };
    }, []);

    useEffect(() => {
        if (!store || initialized) return;
        store.get<QueueItem[]>('uploadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved.filter(i => i.status === 'pending');
                if (pending.length > 0) {
                    setUploadQueue(pending);
                    toast.info(`Restored ${pending.length} pending uploads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    useEffect(() => {
        if (!store || !initialized) return;
        const pending = uploadQueue.filter(i => i.status === 'pending');
        store.set('uploadQueue', pending).then(() => store.save());
    }, [store, uploadQueue, initialized]);

    useEffect(() => {
        if (processing) return;
        const nextItem = uploadQueue.find(i => i.status === 'pending');
        if (nextItem) {
            processItem(nextItem);
        }
    }, [uploadQueue, processing]);

    const processItem = async (item: QueueItem) => {
        setProcessing(true);
        setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'uploading', progress: 0 } : i));
        try {
            const meta = await invoke<TelegramFile | null>('cmd_upload_file', {
                path: item.path,
                folderId: item.folderId,
                transferId: item.id,
            });
            // Check if cancelled during upload
            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                // Optimistic insert: cmd_upload_file returns the metadata
                // for the just-sent message, so we splice it into the
                // React Query cache without waiting for Telegram's
                // GetHistory replication lag.
                //
                // No trailing invalidate. An earlier version scheduled one
                // per upload, but in a 10-upload burst those refetches
                // would land mid-burst, return the server's still-
                // propagating view, and clobber files that had been
                // optimistic-inserted between the refetch starting and
                // returning. The send_message response we built `meta`
                // from is server-confirmed, so the optimistic data is
                // authoritative for the files we just sent. Refetch
                // happens when the user navigates folders or clicks Sync.
                if (meta) {
                    const newFile: TelegramFile = { ...meta, sizeStr: formatBytes(meta.size) };
                    queryClient.setQueriesData<TelegramFile[]>(
                        { queryKey: ['files', item.folderId] },
                        (old) => {
                            if (!old) return [newFile];
                            if (old.some(f => f.id === newFile.id)) return old;
                            return [newFile, ...old];
                        },
                    );
                } else {
                    // Belt-and-braces for the unlikely case where the
                    // Rust side couldn't synthesise metadata at all.
                    queryClient.invalidateQueries({ queryKey: ['files', item.folderId] });
                }
            }
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: String(e) } : i));
                toast.error(`Upload failed for ${item.path.split('/').pop()}: ${e}`);
            } else {
                cancelledRef.current.delete(item.id);
            }
        } finally {
            setProcessing(false);
        }
    };

    const handleManualUpload = async () => {
        try {
            const selected = await open({ multiple: true, directory: false });
            if (selected) {
                const paths = Array.isArray(selected) ? selected : [selected];
                const newItems: QueueItem[] = paths.map((path: string) => ({
                    id: Math.random().toString(36).substr(2, 9),
                    path,
                    folderId: activeFolderId,
                    status: 'pending'
                }));
                setUploadQueue(prev => [...prev, ...newItems]);
                toast.info(`Queued ${paths.length} files for upload`);
            }
        } catch {
            toast.error("Failed to open file dialog");
        }
    };

    const cancelAll = () => {
        setUploadQueue(q => {
            const uploading = q.find(i => i.status === 'uploading');
            if (uploading) {
                cancelledRef.current.add(uploading.id);
                // Best-effort cancel signal: the web build wires this into
                // gramjs progress checks; the Tauri build doesn't have a
                // matching command and the .catch swallows the rejection.
                invoke('cmd_cancel_transfer', { transferId: uploading.id }).catch(() => { });
            }
            return q
                .filter(i => i.status !== 'pending')
                .map(i => i.status === 'uploading' ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All uploads cancelled');
    };

    const { isDragging } = useFileDrop();

    return {
        uploadQueue,
        setUploadQueue,
        handleManualUpload,
        cancelAll,
        isDragging
    };
}
