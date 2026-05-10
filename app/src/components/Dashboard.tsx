import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '../lib/transport';
import { toast } from 'sonner';

import { TelegramFile, BandwidthStats } from '../types';
import { formatBytes, isMediaFile, isPdfFile } from '../utils';

// Components
import { Sidebar, FolderSelection } from './dashboard/Sidebar';
import { TopBar } from './dashboard/TopBar';
import { FileExplorer } from './dashboard/FileExplorer';
import { TransferQueue } from './dashboard/TransferQueue';
import { MoveToFolderModal } from './dashboard/MoveToFolderModal';
import { PreviewModal } from './dashboard/PreviewModal';
import { DragDropOverlay } from './dashboard/DragDropOverlay';
import { ExternalDropBlocker } from './dashboard/ExternalDropBlocker';

// Heavy panels split into their own chunks. PDF.js (~700KB) and Settings
// shouldn't sit in the first-load bundle when the user only ever views the
// file grid.
const MediaPlayer = lazy(() => import('./dashboard/MediaPlayer').then(m => ({ default: m.MediaPlayer })));
const PdfViewer = lazy(() => import('./dashboard/PdfViewer').then(m => ({ default: m.PdfViewer })));
const Settings = lazy(() => import('./Settings').then(m => ({ default: m.Settings })));

// Hooks
import { useTelegramConnection } from '../hooks/useTelegramConnection';
import { useFileOperations } from '../hooks/useFileOperations';
import { useFileUpload } from '../hooks/useFileUpload';
import { useFileDownload } from '../hooks/useFileDownload';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useFolderLocks, folderKey } from '../hooks/useFolderLocks';
import { useAppSettings } from '../hooks/useAppSettings';
import { useFolderPrefs } from '../hooks/useFolderPrefs';
import { FolderLockModal } from './dashboard/FolderLockModal';
import { useFolderKillswitch } from '../hooks/useFolderKillswitch';
import { useIsMobile } from '../hooks/useIsMobile';

export function Dashboard({ onLogout }: { onLogout: () => void }) {
    const queryClient = useQueryClient();


    const {
        store, folders, foldersLoaded, activeFolderId, setActiveFolderId, isSyncing, isConnected,
        handleLogout, handleSyncFolders, handleCreateFolder, handleFolderDelete, handleReorderFolders
    } = useTelegramConnection(onLogout);


    const [hasOpenedFolder, setHasOpenedFolder] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [pendingHiddenUnlock, setPendingHiddenUnlock] = useState<{ folderId: number; folderName: string } | null>(null);
    const locks = useFolderLocks();
    const { settings: appSettings, loaded: appSettingsLoaded, update: updateAppSettings } = useAppSettings();
    const folderPrefs = useFolderPrefs();
    const killswitch = useFolderKillswitch();

    // Force "no folder open" the moment the active folder enters the locked set
    // (covers lock-now button, password-set modal, or any other relock path).
    useEffect(() => {
        if (!hasOpenedFolder) return;
        if (locks.lockedKeys.has(folderKey(activeFolderId))) {
            setHasOpenedFolder(false);
        }
    }, [locks.lockedKeys, hasOpenedFolder, activeFolderId]);

    const selection: FolderSelection = !hasOpenedFolder
        ? { kind: 'none' }
        : activeFolderId === null
            ? { kind: 'home' }
            : { kind: 'folder', id: activeFolderId };

    const setSelection = useCallback((s: FolderSelection) => {
        if (s.kind === 'none') {
            setHasOpenedFolder(false);
        } else if (s.kind === 'home') {
            setHasOpenedFolder(true);
            setActiveFolderId(null);
        } else {
            setHasOpenedFolder(true);
            setActiveFolderId(s.id);
        }
    }, [setActiveFolderId]);

    const isMobile = useIsMobile();
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    /** Select mode (cross-platform). When true, clicks/taps toggle selection
     *  and drag-drop is disabled on cards. Entered via the topbar Select
     *  button. Auto-exits after a non-empty selection drains. */
    const [selectMode, setSelectMode] = useState(false);
    /** Mobile-only single-select filter (the desktop FileExplorer chrome
     *  has its own multi-select Set). Lives here so the topbar's More
     *  menu can change it without prop-drilling through FileExplorer. */
    const [mobileFilter, setMobileFilter] = useState<'all' | 'image' | 'video' | 'audio' | 'document' | 'other'>('all');

    const [previewFile, setPreviewFile] = useState<TelegramFile | null>(null);
    // viewMode is derived directly from app settings — no local copy. The
    // TopBar toggle and the Settings page "Default view" selector both go
    // through updateAppSettings('defaultView', ...) so the rendered view is
    // always in sync with what's persisted.
    const viewMode = appSettings.defaultView;
    const setViewMode = useCallback((mode: 'grid' | 'list') => {
        if (appSettingsLoaded) updateAppSettings('defaultView', mode);
    }, [appSettingsLoaded, updateAppSettings]);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [showMoveModal, setShowMoveModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [searchResults, setSearchResults] = useState<TelegramFile[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [internalDragFileId, _setInternalDragFileId] = useState<number | null>(null);
    const internalDragRef = useRef<number | null>(null);
    /** Anchor for shift-click range selection — the last id selected via a
     *  plain or cmd-click. Cleared when the visible folder changes. */
    const selectionAnchorRef = useRef<number | null>(null);
    /** True when the anchor was set via a cmd/ctrl-click. The next shift-click
     *  pivots from that anchor *additively*, even without cmd held — so the
     *  user can select 1-7, cmd-click 9, shift-click 12 and end up with
     *  1-7 + 9-12. Plain-click anchors keep the standard replace-on-shift
     *  behaviour. */
    const anchorIsAdditiveRef = useRef<boolean>(false);

    const setInternalDragFileId = (id: number | null) => {
        internalDragRef.current = id;
        _setInternalDragFileId(id);
    };
    const [playingFile, setPlayingFile] = useState<TelegramFile | null>(null);
    const [pdfFile, setPdfFile] = useState<TelegramFile | null>(null);
    const [previewContextFiles, setPreviewContextFiles] = useState<TelegramFile[]>([]);
    const [previewContextIndex, setPreviewContextIndex] = useState(-1);

    // Drop any folder-lock entries that point at folders the user no longer
    // has — leftovers from delete-folder paths that ran before the cleanup
    // fix landed, or from deletes on other devices. Without this, the
    // "Show locked (N)" sidebar pill keeps counting ghosts.
    //
    // CRITICAL: gate on foldersLoaded. The folder list is loaded async from
    // the persistent store; if we prune before it's populated, validFolderIds
    // is empty and we wipe every legitimate password — including ones the
    // user just set.
    const prunedRef = useRef(false);
    useEffect(() => {
        if (prunedRef.current) return;
        if (!foldersLoaded) return;
        prunedRef.current = true;
        invoke<number>('cmd_prune_orphan_locks', {
            validFolderIds: folders.map(f => f.id),
        }).then((removed) => {
            if (removed > 0) locks.refresh();
        }).catch(() => {});
    }, [foldersLoaded, folders, locks]);


    const { data: allFiles = [], isLoading, error } = useQuery({
        queryKey: ['files', activeFolderId, hasOpenedFolder],
        queryFn: () => invoke<any[]>('cmd_get_files', { folderId: activeFolderId }).then(res => res.map(f => ({
            ...f,
            sizeStr: formatBytes(f.size),
            type: f.icon_type || (f.name.endsWith('/') ? 'folder' : 'file')
        }))),
        enabled: !!store && hasOpenedFolder,
        // gramjs occasionally drops its WSS connection mid-walk and
        // auto-reconnects — that throws TIMEOUT inside iter_messages and
        // RQ's default of 3 retries with sub-second backoff can fall
        // entirely inside the disconnected window. Retry up to 5 times
        // with longer exponential backoff (capped at 8 s) so the next
        // attempt usually lands on a healthy connection.
        // Don't retry permanent errors like a locked folder.
        retry: (failureCount, err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'LOCKED' || msg.includes('LOCKED')) return false;
            return failureCount < 5;
        },
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
    });

    const displayedFiles = (() => {
        // Strip the cross-device sync snapshot (`td-sync.json`) from the
        // visible list — it's an internal system file, not user content.
        // Filtered here at the display layer rather than at the fetch so
        // it still gets pruned/managed by the sync logic that needs it.
        const isSystemFile = (f: TelegramFile) => f.name === 'td-sync.json';
        const lower = searchTerm.toLowerCase().trim();
        if (!lower) return allFiles.filter(f => !isSystemFile(f));
        const local = allFiles.filter((f: TelegramFile) => f.name.toLowerCase().includes(lower) && !isSystemFile(f));
        if (lower.length <= 2) return local;
        const localIds = new Set(local.map(f => f.id));
        // Telegram's messages.searchGlobal spans every chat, not just [TD]
        // folders, so without this filter the user sees random files from
        // unrelated DMs and channels. Intersect with the known folder set.
        const driveFolderIds = new Set(folders.map(f => f.id));
        const extra = searchResults.filter(f =>
            !localIds.has(f.id)
            && !isSystemFile(f)
            && f.folder_id != null
            && driveFolderIds.has(f.folder_id)
        );
        return [...local, ...extra];
    })();

    const { data: bandwidth } = useQuery({
        queryKey: ['bandwidth'],
        queryFn: () => invoke<BandwidthStats>('cmd_get_bandwidth'),
        refetchInterval: 5000,
        enabled: !!store
    });


    const {
        handleDelete, handleBulkDelete, handleBulkDownload,
        handleBulkMove, handleDownloadFolder, handleGlobalSearch

    } = useFileOperations(activeFolderId, selectedIds, setSelectedIds, displayedFiles);

    const { uploadQueue, setUploadQueue, handleManualUpload, cancelAll: cancelUploads, isDragging } = useFileUpload(activeFolderId, store);
    const { downloadQueue, queueDownload, clearFinished: clearDownloads, cancelAll: cancelDownloads, dismissItem: dismissDownload } = useFileDownload(store);


    const handleSelectAll = useCallback(() => {
        setSelectedIds(displayedFiles.map(f => f.id));
    }, [displayedFiles]);

    const handleKeyboardDelete = useCallback(() => {
        if (selectedIds.length > 0) {
            handleBulkDelete();
        }
    }, [selectedIds, handleBulkDelete]);

    const handleEscape = useCallback(() => {
        setSelectedIds([]);
        setSearchTerm("");
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
    }, []);

    const handleFocusSearch = useCallback(() => {
        const searchInput = document.querySelector('input[placeholder="Search files..."]') as HTMLInputElement;
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
    }, []);

    const handleEnter = useCallback(() => {
        if (selectedIds.length === 1) {
            const selected = displayedFiles.find(f => f.id === selectedIds[0]);
            if (selected) {
                if (selected.type === 'folder') {
                    setActiveFolderId(selected.id);
                } else {
                    handlePreview(selected, displayedFiles);
                }
            }
        }
    }, [selectedIds, displayedFiles, setActiveFolderId]);

    useKeyboardShortcuts({
        onSelectAll: handleSelectAll,
        onDelete: handleKeyboardDelete,
        onEscape: handleEscape,
        onSearch: handleFocusSearch,
        onEnter: handleEnter,
        enabled: !previewFile && !playingFile && !pdfFile && !showMoveModal // Disable when modals are open
    });


    useEffect(() => {
        setSelectedIds([]);
        setShowMoveModal(false);
        setSearchTerm("");
        setSearchResults([]);
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
        setPreviewContextFiles([]);
        setPreviewContextIndex(-1);
        selectionAnchorRef.current = null;
        anchorIsAdditiveRef.current = false;
        setSelectMode(false);
    }, [activeFolderId]);

    // Auto-exit Select mode after the selection drains (e.g. after a bulk
    // move/delete completes). Gates on "selection has been non-empty during
    // this select-mode session" — without that, we'd flip mode off the
    // instant the user taps the Select button (which enters with an empty
    // selection), and picking anything would be impossible.
    const hadSelectionInMode = useRef(false);
    useEffect(() => {
        if (!selectMode) { hadSelectionInMode.current = false; return; }
        if (selectedIds.length > 0) { hadSelectionInMode.current = true; return; }
        if (hadSelectionInMode.current) {
            setSelectMode(false);
            hadSelectionInMode.current = false;
        }
    }, [selectMode, selectedIds.length]);


    useEffect(() => {
        if (searchTerm.length <= 2) {
            setSearchResults([]);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            const results = await handleGlobalSearch(searchTerm);
            setSearchResults(results);
            setIsSearching(false);
        }, 500);

        return () => clearTimeout(timer);
    }, [searchTerm]);




    const handleFileClick = (e: React.MouseEvent, id: number, orderedIds?: number[]) => {
        e.stopPropagation();

        // Mobile: no shift/cmd, no double-click. Tap behaviour depends on
        // whether the user is in mobile Select mode (entered via topbar).
        //   - Select mode on  → tap toggles selection.
        //   - Select mode off → tap opens the file (preview / navigate).
        // Long-press always opens the context menu (handled by useLongPress
        // on the card itself).
        if (isMobile) {
            if (selectMode) {
                handleToggleSelection(id);
                return;
            }
            const file = displayedFiles.find((f) => f.id === id);
            if (file) handleFileDoubleClick(file, displayedFiles);
            return;
        }

        // Shift-click extends from the anchor to the clicked item along
        // whatever ordering FileExplorer is showing right now (sorted +
        // type-filtered). Falls back to displayedFiles only if no ordering
        // was passed (e.g. a future caller that doesn't supply it yet).
        const visibleIds = orderedIds && orderedIds.length > 0
            ? orderedIds
            : displayedFiles.map((f) => f.id);
        const anchor = selectionAnchorRef.current;
        if (e.shiftKey && anchor !== null && anchor !== id) {
            const startIdx = visibleIds.indexOf(anchor);
            const endIdx = visibleIds.indexOf(id);
            if (startIdx !== -1 && endIdx !== -1) {
                const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                const range = visibleIds.slice(lo, hi + 1);
                const additive = e.metaKey || e.ctrlKey || anchorIsAdditiveRef.current;
                if (additive) {
                    setSelectedIds((prev) => Array.from(new Set([...prev, ...range])));
                } else {
                    setSelectedIds(range);
                }
                // Anchor stays put so further shift-clicks pivot off the
                // same starting item, which is the standard Finder/Explorer behaviour.
                return;
            }
        }

        if (e.metaKey || e.ctrlKey) {
            setSelectedIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
            anchorIsAdditiveRef.current = true;
        } else if (
            // After "Select All", a plain click on an item should peel that one
            // off the selection rather than collapse to single-select. Mental
            // model: "everything's checked, click takes one off." Detected by
            // selection covering every visible id.
            visibleIds.length > 0
            && selectedIds.length === visibleIds.length
            && selectedIds.includes(id)
        ) {
            setSelectedIds((ids) => ids.filter((i) => i !== id));
            anchorIsAdditiveRef.current = true;
        } else {
            setSelectedIds([id]);
            anchorIsAdditiveRef.current = false;
        }
        selectionAnchorRef.current = id;
    };

    const handleToggleSelection = useCallback((id: number) => {
        setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
        selectionAnchorRef.current = id;
        anchorIsAdditiveRef.current = true;
    }, []);

    /** Double-click on a card opens it: folders navigate in, files preview.
     *  The preceding single-click already updated selection state, so this
     *  is purely an "open" action. */
    const handleFileDoubleClick = (file: TelegramFile, orderedFiles: TelegramFile[]) => {
        if (file.type === 'folder') {
            setActiveFolderId(file.id);
        } else {
            handlePreview(file, orderedFiles);
        }
    };

    const handlePreview = (file: TelegramFile, orderedFiles?: TelegramFile[]) => {
        const contextFiles = (orderedFiles || displayedFiles).filter((f) => f.type !== 'folder');
        const contextIndex = contextFiles.findIndex((f) => f.id === file.id);

        setPreviewContextFiles(contextFiles);
        setPreviewContextIndex(contextIndex);

        const isMedia = isMediaFile(file.name);
        const isPdf = isPdfFile(file.name);

        if (isMedia) {
            setPlayingFile(file);
            setPreviewFile(null);
            setPdfFile(null);
        } else if (isPdf) {
            setPdfFile(file);
            setPreviewFile(null);
            setPlayingFile(null);
        } else {
            setPreviewFile(file);
            setPlayingFile(null);
            setPdfFile(null);
        }
    };

    const navigatePreview = useCallback((step: 1 | -1) => {
        if (previewContextFiles.length === 0) return;

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id;
        if (!currentFileId) return;

        const currentIndex = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + step + previewContextFiles.length) % previewContextFiles.length;
        const nextFile = previewContextFiles[nextIndex];
        if (!nextFile) return;

        setPreviewContextIndex(nextIndex);

        const isMedia = isMediaFile(nextFile.name);
        const isPdf = isPdfFile(nextFile.name);

        if (isMedia) {
            setPlayingFile(nextFile);
            setPreviewFile(null);
            setPdfFile(null);
        } else if (isPdf) {
            setPdfFile(nextFile);
            setPreviewFile(null);
            setPlayingFile(null);
        } else {
            setPreviewFile(nextFile);
            setPlayingFile(null);
            setPdfFile(null);
        }
    }, [previewContextFiles, previewFile, playingFile, pdfFile]);

    const handleNextPreview = useCallback(() => {
        navigatePreview(1);
    }, [navigatePreview]);

    const handlePrevPreview = useCallback(() => {
        navigatePreview(-1);
    }, [navigatePreview]);

    const previewNeighborFiles = useCallback(() => {
        if (previewContextFiles.length === 0) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id;
        if (!currentFileId) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentIdx = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIdx === -1) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const nextIdx = (currentIdx + 1) % previewContextFiles.length;
        const prevIdx = (currentIdx - 1 + previewContextFiles.length) % previewContextFiles.length;

        return {
            nextFile: previewContextFiles[nextIdx] || null,
            prevFile: previewContextFiles[prevIdx] || null,
        };
    }, [previewContextFiles, previewFile, playingFile, pdfFile]);

    const handleDropOnFolder = async (e: React.DragEvent, targetFolderId: number | null) => {
        e.preventDefault();
        e.stopPropagation();

        const dataTransferFileId = e.dataTransfer.getData("application/x-telegram-file-id");

        if (activeFolderId === targetFolderId) return;

        const fileId = internalDragRef.current || (dataTransferFileId ? parseInt(dataTransferFileId) : null);

        if (fileId) {
            try {
                const idsToMove = selectedIds.includes(fileId) ? selectedIds : [fileId];

                const newFiles = await invoke<TelegramFile[]>('cmd_move_files', {
                    messageIds: idsToMove,
                    sourceFolderId: activeFolderId,
                    targetFolderId: targetFolderId
                });

                // Optimistic source removal — Telegram's GetHistory has a
                // read-after-write delay on deletes, so a straight invalidate
                // would refetch and see the original message still present
                // for a few hundred ms.
                const idSet = new Set(idsToMove);
                queryClient.setQueriesData<TelegramFile[]>(
                    { queryKey: ['files', activeFolderId] },
                    (old) => Array.isArray(old) ? old.filter((f) => !idSet.has(f.id)) : old,
                );
                // Optimistic target insert — cmd_move_files returns the new
                // forwarded messages' metadata so we don't have to wait for
                // a refetch (which can take a minute on Saved Messages).
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

                if (selectedIds.includes(fileId)) setSelectedIds([]);

                toast.success(`Moved ${idsToMove.length} file(s).`);

                setInternalDragFileId(null);
            } catch {
                toast.error(`Failed to move file(s).`);
            }
        }
    }

    const currentFolderName = !hasOpenedFolder
        ? null
        : activeFolderId === null
            ? "Saved Messages"
            : folders.find(f => f.id === activeFolderId)?.name || "Folder";


    const handleRootDragOver = (e: React.DragEvent) => {
        if (internalDragRef.current) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const handleRootDragEnter = (e: React.DragEvent) => {
        if (internalDragRef.current) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const previewNeighbors = previewNeighborFiles();

    return (
        <div
            className="flex h-dvh w-full overflow-hidden bg-telegram-bg relative"
            onClick={() => setSelectedIds([])}
            onDragOver={handleRootDragOver}
            onDragEnter={handleRootDragEnter}
        >

            <ExternalDropBlocker onUploadClick={handleManualUpload} />

            <AnimatePresence>
                {showMoveModal && (
                    <MoveToFolderModal
                        folders={folders.filter(f => !folderPrefs.get(f.id).hidden && !locks.isLocked(f.id))}
                        onClose={() => setShowMoveModal(false)}
                        onSelect={(targetFolderId) => handleBulkMove(targetFolderId, () => setShowMoveModal(false))}
                        activeFolderId={activeFolderId}
                        key="move-modal"
                    />
                )}
                {playingFile && (
                    <Suspense fallback={null} key="media-player">
                        <MediaPlayer
                            file={playingFile}
                            onClose={() => setPlayingFile(null)}
                            onNext={handleNextPreview}
                            onPrev={handlePrevPreview}
                            currentIndex={previewContextIndex}
                            totalItems={previewContextFiles.length}
                            activeFolderId={activeFolderId}
                        />
                    </Suspense>
                )}
                {pdfFile && (
                    <Suspense fallback={null} key="pdf-viewer">
                        <PdfViewer
                            file={pdfFile}
                            onClose={() => setPdfFile(null)}
                            onNext={handleNextPreview}
                            onPrev={handlePrevPreview}
                            currentIndex={previewContextIndex}
                            totalItems={previewContextFiles.length}
                            activeFolderId={activeFolderId}
                        />
                    </Suspense>
                )}
                {isDragging && internalDragFileId === null && <DragDropOverlay key="drag-drop-overlay" />}
            </AnimatePresence>

            {pendingHiddenUnlock && (
                <FolderLockModal
                    mode="unlock"
                    folderName={pendingHiddenUnlock.folderName}
                    folderId={pendingHiddenUnlock.folderId}
                    onClose={() => setPendingHiddenUnlock(null)}
                    onSubmit={async (password) => {
                        const ok = await locks.unlock(pendingHiddenUnlock.folderId, password);
                        if (ok) {
                            setSelection({ kind: 'folder', id: pendingHiddenUnlock.folderId });
                            setSearchTerm("");
                        } else {
                            await killswitch.check(pendingHiddenUnlock.folderId);
                        }
                        return ok;
                    }}
                />
            )}

            {showSettings && (
                <div className="fixed inset-0 z-50 bg-telegram-bg">
                    <Suspense fallback={null}>
                        <Settings
                            onClose={() => setShowSettings(false)}
                            folders={folders}
                            bandwidth={bandwidth || null}
                            locks={locks}
                        />
                    </Suspense>
                </div>
            )}

            <Sidebar
                folders={folders}
                hiddenFolderIds={new Set(folders.filter(f => folderPrefs.get(f.id).hidden).map(f => f.id))}
                selection={selection}
                setSelection={setSelection}
                onDrop={handleDropOnFolder}
                onDelete={async (id, name) => {
                    await handleFolderDelete(id, name);
                    // Backend forgets the lock entry on delete; refresh the
                    // frontend cache so the "X locked" sidebar pill drops too.
                    await locks.refresh();
                }}
                onReorderFolders={handleReorderFolders}
                onCreate={async (name, options) => {
                    const created = await handleCreateFolder(name);
                    if (created) {
                        const patch: { hideThumbnails?: boolean; hidden?: boolean } = {};
                        if (appSettings.hideThumbnailsForNewFolders) patch.hideThumbnails = true;
                        if (options?.hidden) patch.hidden = true;
                        if (Object.keys(patch).length > 0) {
                            await folderPrefs.update(created.id, patch);
                        }
                    }
                    return created;
                }}
                isSyncing={isSyncing}
                isConnected={isConnected}
                onSync={handleSyncFolders}
                onLogout={handleLogout}
                bandwidth={bandwidth || null}
                locks={locks}
                isMobile={isMobile}
                mobileOpen={mobileSidebarOpen}
                onMobileClose={() => setMobileSidebarOpen(false)}
            />

            <main
                className="flex-1 flex flex-col min-w-0"
                style={
                    isMobile && selectedIds.length > 0
                        ? { paddingBottom: `calc(3.5rem + env(safe-area-inset-bottom))` }
                        : undefined
                }
                onClick={(e) => { if (e.target === e.currentTarget) setSelectedIds([]); }}
            >
                <TopBar
                    currentFolderName={currentFolderName}
                    selectedIds={selectedIds}
                    onShowMoveModal={() => setShowMoveModal(true)}
                    onBulkDownload={handleBulkDownload}
                    onBulkDelete={handleBulkDelete}
                    onDownloadFolder={handleDownloadFolder}
                    onStartClick={() => setSelection({ kind: 'none' })}
                    onSelectAll={handleSelectAll}
                    onDeselectAll={() => setSelectedIds([])}
                    onOpenSettings={() => setShowSettings(true)}
                    hasFiles={displayedFiles.length > 0}
                    totalFiles={displayedFiles.length}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    searchTerm={searchTerm}
                    onSearchChange={setSearchTerm}
                    isMobile={isMobile}
                    onMobileMenu={() => setMobileSidebarOpen(true)}
                    selectMode={selectMode}
                    onToggleSelectMode={() => {
                        // Toggling out of select mode also clears the selection;
                        // otherwise the floating bottom action bar stays visible
                        // with stale items the user can't see "selected" because
                        // the checkboxes are hidden.
                        if (selectMode) setSelectedIds([]);
                        setSelectMode(s => !s);
                    }}
                    gridColumns={appSettings.gridColumnsDesktop}
                    onGridColumnsChange={(n) => updateAppSettings('gridColumnsDesktop', n)}
                    sortField={appSettings.defaultSortField}
                    sortDirection={appSettings.defaultSortDir}
                    onSortChange={(field, dir) => {
                        updateAppSettings('defaultSortField', field);
                        updateAppSettings('defaultSortDir', dir);
                    }}
                    mobileFilter={mobileFilter}
                    onMobileFilterChange={setMobileFilter}
                />
                {(() => {
                    const trimmed = searchTerm.trim();
                    if (!trimmed) return null;
                    // Exact, CASE-SENSITIVE match on a hidden folder reveals it
                    // as an "Open" banner. Substring/fuzzy/case-insensitive
                    // matches don't surface hidden folders — that's the whole
                    // point of "hidden". Typing "MyFolder" reveals it; typing
                    // "myfolder" or "my" does not.
                    const hiddenMatch = folders.find(f =>
                        folderPrefs.get(f.id).hidden && f.name === trimmed
                    );
                    return (
                        <>
                            {hiddenMatch && (
                                <div className="px-3 sm:px-6 pt-4">
                                    <button
                                        onClick={() => {
                                            // Sidebar's handleFolderClick gates locked folders behind
                                            // an unlock prompt; replicate that here since the hidden-
                                            // folder reveal banner bypasses the sidebar entirely.
                                            const key = folderKey(hiddenMatch.id);
                                            if (locks.lockedKeys.has(key)) {
                                                setPendingHiddenUnlock({ folderId: hiddenMatch.id, folderName: hiddenMatch.name });
                                            } else {
                                                setSelection({ kind: 'folder', id: hiddenMatch.id });
                                            }
                                        }}
                                        className="w-full flex items-center justify-between px-4 py-2 rounded-md bg-telegram-primary/10 hover:bg-telegram-primary/20 border border-telegram-primary/30 text-telegram-primary transition-colors"
                                    >
                                        <span className="text-sm">Open hidden folder <span className="font-semibold">"{hiddenMatch.name}"</span></span>
                                        <span className="text-xs">→</span>
                                    </button>
                                </div>
                            )}
                            {trimmed.length > 2 && (
                                <div className="px-3 sm:px-6 pt-4 pb-0">
                                    <h2 className="text-sm font-medium text-telegram-subtext">
                                        Search Results for <span className="text-telegram-primary">"{searchTerm}"</span>
                                    </h2>
                                </div>
                            )}
                        </>
                    );
                })()}
                {!hasOpenedFolder ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center text-telegram-subtext p-6">
                        <div className="text-base">No folder open.</div>
                        <div className="text-sm mt-1">
                            {isMobile
                                ? 'Tap the menu icon in the top-left to pick a folder.'
                                : 'Select a folder from the sidebar to view its files.'}
                        </div>
                    </div>
                ) : (
                    <FileExplorer

                        files={displayedFiles}
                        loading={isLoading || isSearching}
                        error={error instanceof Error ? error : error ? new Error(String(error)) : null}
                        viewMode={viewMode}
                        selectedIds={selectedIds}
                        activeFolderId={activeFolderId}
                        onFileClick={handleFileClick}
                        onFileDoubleClick={isMobile ? undefined : handleFileDoubleClick}
                        disableThumbnailFor={(file) => {
                            if (appSettings.hideThumbnailsGlobal) return true;
                            const folderId = file.folder_id ?? activeFolderId;
                            return !!folderPrefs.get(folderId).hideThumbnails;
                        }}
                        sortField={appSettings.defaultSortField}
                        sortDirection={appSettings.defaultSortDir}
                        onSortChange={(field, dir) => {
                            updateAppSettings('defaultSortField', field);
                            updateAppSettings('defaultSortDir', dir);
                        }}
                        onDelete={handleDelete}
                        onDownload={(id, name) => queueDownload(id, name, activeFolderId)}
                        onPreview={handlePreview}
                        onManualUpload={handleManualUpload}
                        onSelectionClear={() => setSelectedIds([])}
                        onToggleSelection={handleToggleSelection}
                        onSetSelectedIds={isMobile ? setSelectedIds : undefined}
                        onDrop={handleDropOnFolder}
                        onDragStart={(fileId) => setInternalDragFileId(fileId)}
                        onDragEnd={() => setTimeout(() => setInternalDragFileId(null), 50)}
                        selectMode={isMobile && selectMode}
                        gridColumnsDesktop={appSettings.gridColumnsDesktop}
                        mobileFilter={mobileFilter}
                    />
                )}
            </main>

            {isMobile && selectedIds.length > 0 && (
                <div
                    className="fixed bottom-0 left-0 right-0 z-30 bg-telegram-surface border-t border-telegram-border px-3 flex items-center gap-2 shadow-[0_-4px_12px_rgba(0,0,0,0.25)]"
                    // Stop click propagation here so taps on the action
                    // buttons don't bubble up to the Dashboard root
                    // `onClick` (which clears the selection) — that was
                    // the bug behind "batch move doesn't work on mobile":
                    // the Move tap opened the modal AND immediately wiped
                    // selectedIds, leaving handleBulkMove with nothing to
                    // operate on.
                    onClick={(e) => e.stopPropagation()}
                    // Inline padding combines a fixed gutter with the iOS
                    // home-bar safe-area inset; using both Tailwind pt-/pb-
                    // and a `.safe-bottom` class fights cascade ordering and
                    // sometimes leaves no visual margin below the buttons.
                    style={{
                        paddingTop: '0.75rem',
                        paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
                    }}
                >
                    <span className="text-xs text-telegram-subtext shrink-0 tabular-nums">{selectedIds.length}</span>
                    <button
                        type="button"
                        onClick={() => { setSelectedIds([]); setSelectMode(false); }}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="h-9 px-3 inline-flex items-center justify-center bg-telegram-hover hover:bg-telegram-border rounded-md text-xs text-telegram-text shrink-0"
                    >
                        Clear
                    </button>
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={() => setShowMoveModal(true)}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="h-9 px-3 inline-flex items-center justify-center bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary rounded-md text-xs font-medium"
                    >
                        Move
                    </button>
                    <button
                        type="button"
                        onClick={handleBulkDownload}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="h-9 px-3 inline-flex items-center justify-center bg-telegram-hover hover:bg-telegram-border rounded-md text-xs text-telegram-text"
                    >
                        Download
                    </button>
                    <button
                        type="button"
                        onClick={handleBulkDelete}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="h-9 px-3 inline-flex items-center justify-center bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-md text-xs"
                    >
                        Delete
                    </button>
                </div>
            )}

            {previewFile && (
                <PreviewModal
                    file={previewFile}
                    activeFolderId={activeFolderId}
                    onClose={() => setPreviewFile(null)}
                    onNext={handleNextPreview}
                    onPrev={handlePrevPreview}
                    currentIndex={previewContextIndex}
                    totalItems={previewContextFiles.length}
                    nextFile={previewNeighbors.nextFile}
                    prevFile={previewNeighbors.prevFile}
                />
            )}


            <TransferQueue
                uploads={uploadQueue}
                downloads={downloadQueue}
                onClearUploads={() => setUploadQueue(q => q.filter(i => i.status !== 'success' && i.status !== 'error' && i.status !== 'cancelled'))}
                onCancelAllUploads={cancelUploads}
                onClearDownloads={clearDownloads}
                onCancelAllDownloads={cancelDownloads}
                onDismissDownload={dismissDownload}
            />
        </div>
    );
}
