import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Eye, HardDrive, Trash2, FolderOpen, Pencil, Play, FileText, Copy } from 'lucide-react';
import { TelegramFile } from '../../types';
import { isMediaFile, isPdfFile, isImageFile } from '../../utils';

interface ContextMenuProps {
    x: number;
    y: number;
    file: TelegramFile;
    onClose: () => void;
    onDownload: () => void;
    onDelete: () => void;
    onPreview: () => void;
    /** Optional — when present, image files get a "Copy image" entry. */
    onCopyImage?: () => void;
}

export function ContextMenu({ x, y, file, onClose, onDownload, onDelete, onPreview, onCopyImage }: ContextMenuProps) {
    // Single-pass position: render at click point, then useLayoutEffect
    // reads the menu's bounding box and snaps to bounds-adjusted pos in
    // the same paint cycle. No opacity dance, no animation — the menu
    // appears instantly at the right spot. Earlier two-phase / animated
    // designs caused the "menu briefly appears at one place, then jumps"
    // bug on iOS Safari (long-press synthesizes a chain of events that
    // clashed with rAF-deferred state).
    const [pos, setPos] = useState<{ x: number; y: number }>({ x, y });
    const menuRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const margin = 8;
        let newX = x;
        let newY = y;
        if (x + rect.width > window.innerWidth - margin) newX = Math.max(margin, x - rect.width);
        if (y + rect.height > window.innerHeight - margin) newY = Math.max(margin, y - rect.height);
        if (newX !== pos.x || newY !== pos.y) setPos({ x: newX, y: newY });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [x, y]);

    // Close on outside click / right-click / tap-away.
    //
    // Listeners are attached synchronously rather than after a setTimeout
    // because parents commonly pass `onClose` as a fresh inline arrow
    // every render. That re-runs this effect, and a setTimeout-based
    // attach gets repeatedly cleared before it fires, leaving the menu
    // un-dismissable.
    //
    // To avoid dismissing on the very event that *opened* the menu (the
    // initial right-click's `contextmenu` event, or the trailing `click`
    // a long-press leaves behind on iOS), we ignore any event that
    // arrives within 100ms of mount.
    //
    // touchstart covers iOS taps on non-interactive areas (empty grid
    // space, page background) where Safari doesn't synthesize a click.
    useEffect(() => {
        const mountedAt = Date.now();
        const handleOutside = (e: Event) => {
            if (Date.now() - mountedAt < 100) return;
            if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
            onClose();
        };
        const handleResize = () => onClose();
        window.addEventListener('click', handleOutside, true);
        window.addEventListener('contextmenu', handleOutside, true);
        window.addEventListener('touchstart', handleOutside, { passive: true, capture: true });
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('click', handleOutside, true);
            window.removeEventListener('contextmenu', handleOutside, true);
            window.removeEventListener('touchstart', handleOutside, true);
            window.removeEventListener('resize', handleResize);
        };
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            className="fixed z-50 min-w-[200px] bg-telegram-surface/95 backdrop-blur-xl border border-telegram-border rounded-lg shadow-lg p-1.5 flex flex-col gap-0.5"
            style={{ left: pos.x, top: pos.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
        >
            <div className="px-2 py-1.5 border-b border-telegram-border mb-1 max-w-[220px]">
                <div className="text-xs text-telegram-text font-medium truncate" title={file.name}>{file.name}</div>
                {file.type !== 'folder' && file.sizeStr && (
                    <div className="text-[10px] text-telegram-subtext mt-0.5">{file.sizeStr}</div>
                )}
            </div>

            {file.type !== 'folder' && (
                <button type="button" onClick={onPreview} className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full">
                    {isMediaFile(file.name) ? (
                        <>
                            <Play className="w-4 h-4 text-telegram-primary" />
                            Play
                        </>
                    ) : isPdfFile(file.name) ? (
                        <>
                            <FileText className="w-4 h-4 text-red-400" />
                            View PDF
                        </>
                    ) : (
                        <>
                            <Eye className="w-4 h-4 text-blue-500" />
                            Preview
                        </>
                    )}
                </button>
            )}

            {file.type === 'folder' && (
                <button type="button" onClick={onPreview} className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full">
                    <FolderOpen className="w-4 h-4 text-yellow-500" />
                    Open
                </button>
            )}

            <button type="button" onClick={onDownload} className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full">
                <HardDrive className="w-4 h-4 text-green-500" />
                Download
            </button>

            {onCopyImage && file.type !== 'folder' && isImageFile(file.name) && (
                <button type="button" onClick={onCopyImage} className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full">
                    <Copy className="w-4 h-4 text-blue-400" />
                    Copy image
                </button>
            )}

            <button type="button" disabled className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-subtext hover:bg-telegram-hover rounded transition-colors text-left w-full cursor-not-allowed opacity-50">
                <Pencil className="w-4 h-4" />
                Rename
            </button>

            <div className="h-px bg-telegram-border my-1" />

            <button type="button" onClick={onDelete} className="flex items-center gap-2 px-2 py-1.5 text-sm text-red-500 hover:bg-red-500/10 rounded transition-colors text-left w-full">
                <Trash2 className="w-4 h-4" />
                Delete
            </button>
        </div>
    );
}
