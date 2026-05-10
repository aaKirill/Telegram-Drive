import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HardDrive, Folder, FolderLock, FolderOpen, Plus, RefreshCw, LogOut, Eye, EyeOff } from 'lucide-react';
import { SidebarItem } from './SidebarItem';
import { BandwidthWidget } from './BandwidthWidget';
import { FolderLockModal, LockModalMode } from './FolderLockModal';
import { TelegramFolder, BandwidthStats } from '../../types';
import { toast } from 'sonner';
import { useFolderKillswitch } from '../../hooks/useFolderKillswitch';
import { folderKey, type useFolderLocks } from '../../hooks/useFolderLocks';

type FolderLocks = ReturnType<typeof useFolderLocks>;

export type FolderSelection = { kind: 'none' } | { kind: 'home' } | { kind: 'folder'; id: number };

interface SidebarProps {
    folders: TelegramFolder[];
    /** Folder ids the user has marked as hidden via Settings → Hidden folders.
     *  These never appear in the sidebar (even with "Show locked" toggled on)
     *  and are excluded from the locked-count pill so it doesn't tease the
     *  user with entries they can't surface from here. */
    hiddenFolderIds: Set<number>;
    selection: FolderSelection;
    setSelection: (s: FolderSelection) => void;
    onDrop: (e: React.DragEvent, folderId: number | null) => void;
    onDelete: (id: number, name: string) => void;
    onCreate: (name: string, options?: { hidden?: boolean }) => Promise<TelegramFolder | null>;
    onReorderFolders: (orderedIds: number[]) => void;
    isSyncing: boolean;
    isConnected: boolean;
    onSync: () => void;
    onLogout: () => void;
    bandwidth: BandwidthStats | null;
    locks: FolderLocks;
    /** True when the viewport is mobile. The sidebar becomes a slide-in
     *  drawer in that case — the parent controls visibility via
     *  `mobileOpen` and dismisses via `onMobileClose` (backdrop click,
     *  Esc, or after the user picks a folder). */
    isMobile?: boolean;
    mobileOpen?: boolean;
    onMobileClose?: () => void;
}

interface PendingLockAction {
    folderId: number | null;
    folderName: string;
    mode: LockModalMode;
}

const selectionFolderId = (s: FolderSelection): number | null | undefined =>
    s.kind === 'home' ? null : s.kind === 'folder' ? s.id : undefined;

export function Sidebar({
    folders, hiddenFolderIds, selection, setSelection, onDrop, onDelete, onCreate, onReorderFolders,
    isSyncing, isConnected, onSync, onLogout, bandwidth, locks,
    isMobile = false, mobileOpen = false, onMobileClose,
}: SidebarProps) {
    const [reorderDragId, setReorderDragId] = useState<number | null>(null);
    const [reorderOverId, setReorderOverId] = useState<number | null>(null);
    const [reorderOverPosition, setReorderOverPosition] = useState<'before' | 'after'>('before');
    const REORDER_TYPE = 'application/x-td-folder-reorder';
    const killswitch = useFolderKillswitch();
    const [showNewFolderInput, setShowNewFolderInput] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [newFolderPassword, setNewFolderPassword] = useState("");
    const [newFolderHidden, setNewFolderHidden] = useState(false);
    const [creating, setCreating] = useState(false);
    const [showLocked, setShowLocked] = useState(false);
    const [pending, setPending] = useState<PendingLockAction | null>(null);

    const activeFolderId = selectionFolderId(selection);

    const resetCreateForm = () => {
        setNewFolderName("");
        setNewFolderPassword("");
        setNewFolderHidden(false);
        setShowNewFolderInput(false);
    };

    const submitCreate = async () => {
        const name = newFolderName.trim();
        if (!name || creating) return;
        const pw = newFolderPassword;
        const hidden = newFolderHidden;
        setCreating(true);
        try {
            const created = await onCreate(name, { hidden });
            if (created && pw) {
                try {
                    await locks.setPassword(created.id, pw);
                } catch (e) {
                    toast.error("Folder created, but failed to set password: " + e);
                }
            }
            resetCreateForm();
        } catch {
            // create-folder error already toasted by parent — keep the form open
            // so the user can retry without retyping the password.
        } finally {
            setCreating(false);
        }
    };

    // Top section: every visible un-locked folder. The locked folders go
    // in their own group below the divider when the user toggles "Show
    // locked" so they read as a clearly separate, password-gated set
    // rather than getting silently appended to the main list.
    const visibleFolders = useMemo(
        () => folders.filter(f =>
            !hiddenFolderIds.has(f.id) && !locks.lockedKeys.has(folderKey(f.id))
        ),
        [folders, hiddenFolderIds, locks.lockedKeys],
    );
    const lockedFolders = useMemo(
        () => folders.filter(f =>
            !hiddenFolderIds.has(f.id) && locks.lockedKeys.has(folderKey(f.id))
        ),
        [folders, hiddenFolderIds, locks.lockedKeys],
    );

    const lockStateOf = (folderId: number | null): 'none' | 'unlocked' | 'locked' => {
        const key = folderKey(folderId);
        if (!locks.allLockedKeys.has(key)) return 'none';
        return locks.lockedKeys.has(key) ? 'locked' : 'unlocked';
    };

    const savedMessagesState = lockStateOf(null);
    const showSavedMessages = savedMessagesState !== 'locked' || showLocked;

    const handleFolderClick = (folderId: number | null) => {
        const key = folderKey(folderId);
        if (locks.lockedKeys.has(key)) {
            const folderName = folderId === null ? 'Saved Messages' : (folders.find(f => f.id === folderId)?.name ?? '');
            setPending({ folderId, folderName, mode: 'unlock' });
        } else {
            setSelection(folderId === null ? { kind: 'home' } : { kind: 'folder', id: folderId });
            // On mobile the sidebar is a drawer over the content — once a
            // folder is picked there's nothing useful left to do here, so
            // auto-dismiss to reveal the file grid.
            if (isMobile && onMobileClose) onMobileClose();
        }
    };

    const openManageAction = (folderId: number | null, folderName: string) => {
        const state = lockStateOf(folderId);
        const mode: LockModalMode = state === 'none' ? 'set' : 'remove';
        setPending({ folderId, folderName, mode });
    };

    const lockNow = async (folderId: number | null) => {
        await locks.relock(folderId);
        // If we just locked the folder we're viewing, navigate away.
        if (activeFolderId === folderId) {
            setSelection({ kind: 'none' });
        }
    };

    const onModalSubmit = async (password: string): Promise<boolean> => {
        if (!pending) return false;
        switch (pending.mode) {
            case 'set':
                await locks.setPassword(pending.folderId, password);
                // If we just locked the folder we're currently viewing, redirect away.
                if (activeFolderId === pending.folderId) {
                    setSelection({ kind: 'none' });
                }
                return true;
            case 'unlock': {
                const ok = await locks.unlock(pending.folderId, password);
                if (ok) setSelection(pending.folderId === null ? { kind: 'home' } : { kind: 'folder', id: pending.folderId });
                else await killswitch.check(pending.folderId);
                return ok;
            }
            case 'remove': {
                const ok = await locks.removeLock(pending.folderId, password);
                if (!ok) await killswitch.check(pending.folderId);
                return ok;
            }
        }
    };

    // Don't count password-locked folders that are also fully-hidden — there's
    // no way to surface them from the sidebar even with "Show locked" toggled,
    // so showing a non-zero pill that doesn't reveal anything would be a lie.
    const hiddenLockCount = useMemo(() => {
        let n = 0;
        locks.lockedKeys.forEach(k => {
            if (k === 'home') { n += 1; return; }
            const id = parseInt(k, 10);
            if (!Number.isNaN(id) && !hiddenFolderIds.has(id)) n += 1;
        });
        return n;
    }, [locks.lockedKeys, hiddenFolderIds]);

    // On mobile the sidebar is rendered as a fixed slide-in drawer with a
    // dim backdrop. On desktop it stays an in-flow column at its natural
    // width — same `w-64` as before.
    const asideClass = isMobile
        ? `fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] bg-telegram-surface border-r border-telegram-border flex flex-col transform transition-transform duration-200 ease-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`
        : 'w-64 bg-telegram-surface border-r border-telegram-border flex flex-col';

    return (
        <>
            {isMobile && mobileOpen && (
                <div
                    className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm transition-opacity"
                    onClick={onMobileClose}
                    aria-hidden="true"
                />
            )}
            <aside className={asideClass} onClick={e => e.stopPropagation()}>
            <div className="p-4 flex items-center gap-2">
                <img
                    src={`${import.meta.env.BASE_URL}logo-transparent.png`}
                    className="w-8 h-8 drop-shadow-lg"
                    alt="Logo"
                />
                <span className="font-bold text-lg text-telegram-text tracking-tight">Telegram Drive</span>
                {/* Create-folder button lives next to the title so it's
                    visually anchored to the sidebar identity rather than
                    floating in dead space at the bottom of the folder list. */}
                {!showNewFolderInput && (
                    <button
                        type="button"
                        onClick={() => setShowNewFolderInput(true)}
                        title="Create folder"
                        aria-label="Create folder"
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="ml-auto w-7 h-7 flex items-center justify-center rounded-md bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 active:bg-telegram-primary/25 transition-colors"
                    >
                        <Plus className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                )}
            </div>

            {hiddenLockCount > 0 && (
                <div className="px-2 pb-2">
                    <button
                        onClick={() => setShowLocked(s => !s)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-xs text-telegram-subtext hover:bg-telegram-hover hover:text-telegram-text transition-colors"
                        title={showLocked ? 'Hide locked folders' : 'Show locked folders'}
                    >
                        {showLocked ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {showLocked ? 'Hide locked' : `Show locked (${hiddenLockCount})`}
                    </button>
                </div>
            )}

            <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto min-h-0">
                {/* Locked section sits at the very top so the password-gated
                    set is visually first when the user toggles "Show locked".
                    Saved Messages and the regular folder list follow below. */}
                <AnimatePresence initial={false}>
                    {showLocked && lockedFolders.length > 0 && (
                        <motion.div
                            key="locked-section"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="overflow-hidden"
                        >
                            <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide text-telegram-subtext/70">
                                Locked
                            </div>
                            <div className="space-y-1 mb-2 pb-2 border-b border-telegram-border">
                                {lockedFolders.map((folder, idx) => {
                                    const state = lockStateOf(folder.id);
                                    const isActive = selection.kind === 'folder' && selection.id === folder.id && state !== 'locked';
                                    return (
                                        <motion.div
                                            key={folder.id}
                                            initial={{ opacity: 0, x: -10 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={{ duration: 0.18, delay: idx * 0.025 }}
                                        >
                                            <SidebarItem
                                                icon={state === 'locked' ? FolderLock : FolderOpen}
                                                label={folder.name}
                                                active={isActive}
                                                onClick={() => handleFolderClick(folder.id)}
                                                onDrop={(e: React.DragEvent) => onDrop(e, folder.id)}
                                                onDelete={() => onDelete(folder.id, folder.name)}
                                                folderId={folder.id}
                                                onManagePassword={() => openManageAction(folder.id, folder.name)}
                                                onLockNow={() => lockNow(folder.id)}
                                                lockState={state}
                                            />
                                        </motion.div>
                                    );
                                })}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {showSavedMessages && (
                    <SidebarItem
                        icon={savedMessagesState === 'locked' ? FolderLock : savedMessagesState === 'unlocked' ? FolderOpen : HardDrive}
                        label="Saved Messages"
                        active={selection.kind === 'home' && savedMessagesState !== 'locked'}
                        onClick={() => handleFolderClick(null)}
                        onDrop={(e: React.DragEvent) => onDrop(e, null)}
                        folderId={null}
                        onManagePassword={() => openManageAction(null, 'Saved Messages')}
                        onLockNow={() => lockNow(null)}
                        lockState={savedMessagesState}
                    />
                )}

                {visibleFolders.map(folder => {
                    const state = lockStateOf(folder.id);
                    const isActive = selection.kind === 'folder' && selection.id === folder.id && state !== 'locked';
                    return (
                        <div
                            key={folder.id}
                            draggable={!isMobile}
                            onDragStart={(e) => {
                                e.dataTransfer.setData(REORDER_TYPE, String(folder.id));
                                e.dataTransfer.effectAllowed = 'move';
                                setReorderDragId(folder.id);
                            }}
                            onDragOver={(e) => {
                                if (!e.dataTransfer.types.includes(REORDER_TYPE)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                e.dataTransfer.dropEffect = 'move';
                                const rect = e.currentTarget.getBoundingClientRect();
                                const pos: 'before' | 'after' =
                                    e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                                if (reorderOverId !== folder.id) setReorderOverId(folder.id);
                                if (reorderOverPosition !== pos) setReorderOverPosition(pos);
                            }}
                            onDragLeave={(e) => {
                                if (!e.dataTransfer.types.includes(REORDER_TYPE)) return;
                                // Only clear when truly leaving the wrapper bounds. Cursor
                                // crossing into a child element fires dragleave on the
                                // wrapper too, which would flicker the indicator off.
                                const rect = e.currentTarget.getBoundingClientRect();
                                if (e.clientX < rect.left || e.clientX > rect.right
                                    || e.clientY < rect.top || e.clientY > rect.bottom) {
                                    if (reorderOverId === folder.id) setReorderOverId(null);
                                }
                            }}
                            onDrop={(e) => {
                                if (!e.dataTransfer.types.includes(REORDER_TYPE)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                const rawId = e.dataTransfer.getData(REORDER_TYPE);
                                const draggedId = parseInt(rawId, 10);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const insertAfter = e.clientY >= rect.top + rect.height / 2;
                                setReorderDragId(null);
                                setReorderOverId(null);
                                if (Number.isNaN(draggedId) || draggedId === folder.id) return;
                                const order = folders.map(f => f.id);
                                const fromIdx = order.indexOf(draggedId);
                                let toIdx = order.indexOf(folder.id);
                                if (fromIdx < 0 || toIdx < 0) return;
                                // Remove first, then adjust target index because
                                // anything past `fromIdx` shifted up by one.
                                order.splice(fromIdx, 1);
                                if (fromIdx < toIdx) toIdx -= 1;
                                if (insertAfter) toIdx += 1;
                                order.splice(toIdx, 0, draggedId);
                                onReorderFolders(order);
                            }}
                            onDragEnd={() => { setReorderDragId(null); setReorderOverId(null); }}
                            className={`${reorderDragId === folder.id ? 'opacity-50' : ''} ${
                                reorderOverId === folder.id && reorderDragId !== folder.id
                                    ? (reorderOverPosition === 'before'
                                        ? 'border-t-2 border-telegram-primary'
                                        : 'border-b-2 border-telegram-primary')
                                    : ''
                            }`}
                        >
                        <SidebarItem
                            icon={state === 'locked' ? FolderLock : state === 'unlocked' ? FolderOpen : Folder}
                            label={folder.name}
                            active={isActive}
                            onClick={() => handleFolderClick(folder.id)}
                            onDrop={(e: React.DragEvent) => {
                                // SidebarItem's drop handler runs for both file
                                // moves and folder reorders. The reorder is
                                // handled by our outer wrapper above; if the
                                // payload is a reorder, swallow it here so we
                                // don't accidentally treat a folder id as a
                                // file id and fail noisily.
                                if (e.dataTransfer.types.includes(REORDER_TYPE)) return;
                                onDrop(e, folder.id);
                            }}
                            onDelete={() => onDelete(folder.id, folder.name)}
                            folderId={folder.id}
                            onManagePassword={() => openManageAction(folder.id, folder.name)}
                            onLockNow={() => lockNow(folder.id)}
                            lockState={state}
                        />
                        </div>
                    );
                })}

            </nav>

            {showNewFolderInput && (
                <div className="px-2 pb-2 border-b border-telegram-border">
                    <div className="px-3 py-2 space-y-1.5">
                        <input
                            autoFocus
                            type="text"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            className="w-full bg-white/10 rounded px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-telegram-primary disabled:opacity-50"
                            placeholder="Folder Name"
                            value={newFolderName}
                            disabled={creating}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') submitCreate();
                                if (e.key === 'Escape') resetCreateForm();
                            }}
                        />
                        <input
                            type="password"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            className="w-full bg-white/10 rounded px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-telegram-primary disabled:opacity-50"
                            placeholder="Password (optional)"
                            value={newFolderPassword}
                            disabled={creating}
                            onChange={e => setNewFolderPassword(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') submitCreate();
                                if (e.key === 'Escape') resetCreateForm();
                            }}
                        />
                        <label className="flex items-center gap-2 text-xs text-telegram-subtext cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={newFolderHidden}
                                disabled={creating}
                                onChange={e => setNewFolderHidden(e.target.checked)}
                                className="accent-telegram-primary"
                            />
                            <span>Hide from sidebar (search exact name to open)</span>
                        </label>
                        <div className="flex gap-1.5 pt-0.5">
                            <button
                                type="button"
                                onClick={submitCreate}
                                disabled={!newFolderName.trim() || creating}
                                className="flex-1 px-2 py-1 rounded text-xs font-medium bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {creating ? 'Creating…' : 'Create'}
                            </button>
                            <button
                                type="button"
                                onClick={resetCreateForm}
                                disabled={creating}
                                className="px-2 py-1 rounded text-xs text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover transition disabled:opacity-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="p-4 border-t border-telegram-border">
                <div className="flex items-center gap-2 text-telegram-subtext text-xs">
                    <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                    <span>{isConnected ? 'Connected to Telegram' : 'Disconnected from Telegram'}</span>
                </div>

                <div className="flex gap-2 mt-4">
                    <button
                        onClick={onSync}
                        disabled={isSyncing}
                        className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-blue-500 hover:text-blue-600 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors ${isSyncing ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Scan for existing folders"
                    >
                        <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Syncing...' : 'Sync'}
                    </button>
                    <button
                        onClick={onLogout}
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-red-500 hover:text-red-600 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors"
                        title="Sign Out"
                    >
                        <LogOut className="w-3 h-3" />
                        Logout
                    </button>
                </div>

                {bandwidth && <BandwidthWidget bandwidth={bandwidth} />}
            </div>

            {pending && (
                <FolderLockModal
                    mode={pending.mode}
                    folderName={pending.folderName}
                    folderId={pending.folderId}
                    onClose={() => setPending(null)}
                    onSubmit={onModalSubmit}
                />
            )}
        </aside>
        </>
    );
}
