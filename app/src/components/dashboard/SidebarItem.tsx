import { useEffect, useRef, useState } from 'react';
import { MoreVertical, Lock, KeyRound, Trash2 } from 'lucide-react';

const FILE_DRAG_TYPE = 'application/x-telegram-file-id';

/** Whether this dragover is something we should treat as a file-into-folder
 *  drop. Without this check we'd swallow the event for folder-reorder drags
 *  (which bubble up from the inner button to the outer reorder wrapper),
 *  preventing reorder from working at all. */
function isFileDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes(FILE_DRAG_TYPE);
}

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    active: boolean;
    onClick: () => void;
    onDrop: (e: React.DragEvent) => void;
    onDelete?: () => void;
    folderId: number | null;
    /** Set or remove password depending on lockState */
    onManagePassword?: () => void;
    /** Re-lock (clear from in-memory unlocked set) */
    onLockNow?: () => void;
    lockState?: 'none' | 'unlocked' | 'locked';
}

export function SidebarItem({ icon: Icon, label, active = false, onClick, onDrop, onDelete, onManagePassword, onLockNow, lockState = 'none' }: SidebarItemProps) {
    const [isOver, setIsOver] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    // Click-outside / Esc to dismiss the popover.
    useEffect(() => {
        if (!menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    const showMenuButton = !!(onDelete || onManagePassword || (lockState === 'unlocked' && onLockNow));

    return (
        <div className="relative">
            <button
                onClick={onClick}
                onDragEnter={(e) => {
                    if (!isFileDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOver(true);
                }}
                onDragOver={(e) => {
                    if (!isFileDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                }}
                onDragLeave={(e) => {
                    if (!isFileDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX;
                    const y = e.clientY;
                    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                        setIsOver(false);
                    }
                }}
                onDrop={(e) => {
                    if (!isFileDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOver(false);
                    if (onDrop) onDrop(e);
                }}
                onContextMenu={(e) => {
                    if (showMenuButton) {
                        e.preventDefault();
                        setMenuOpen(true);
                    }
                }}
                className={`group w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${active
                    ? 'bg-telegram-primary/10 text-telegram-primary'
                    : isOver
                        ? 'bg-telegram-primary/30 text-telegram-text ring-2 ring-telegram-primary scale-[1.02] shadow-lg'
                        : 'text-telegram-subtext hover:bg-telegram-hover hover:text-telegram-text'
                    }`}
            >
                <Icon className={`w-4 h-4 ${isOver ? 'text-telegram-primary' : ''}`} />
                <span className="flex-1 text-left truncate">{label}</span>
                {showMenuButton && (
                    <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(s => !s); }}
                        className={`p-1 rounded transition-opacity hover:bg-telegram-hover/60 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        title="More"
                    >
                        <MoreVertical className="w-3.5 h-3.5" />
                    </span>
                )}
            </button>

            {menuOpen && (
                <div
                    ref={menuRef}
                    className="absolute right-1 top-full mt-1 z-30 min-w-[160px] bg-telegram-surface border border-telegram-border rounded-md shadow-lg py-1 text-sm"
                    onClick={(e) => e.stopPropagation()}
                >
                    {lockState === 'unlocked' && onLockNow && (
                        <button
                            onClick={() => { setMenuOpen(false); onLockNow(); }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-telegram-text hover:bg-telegram-hover"
                        >
                            <Lock className="w-3.5 h-3.5" /> Lock now
                        </button>
                    )}
                    {lockState !== 'locked' && onManagePassword && (
                        <button
                            onClick={() => { setMenuOpen(false); onManagePassword(); }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-telegram-text hover:bg-telegram-hover"
                        >
                            <KeyRound className="w-3.5 h-3.5" />
                            {lockState === 'unlocked' ? 'Remove password' : 'Set password'}
                        </button>
                    )}
                    {onDelete && (
                        <button
                            onClick={() => { setMenuOpen(false); onDelete(); }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-red-500/10"
                        >
                            <Trash2 className="w-3.5 h-3.5" /> Delete folder
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
