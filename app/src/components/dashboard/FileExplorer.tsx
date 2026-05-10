import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Plus, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import { FileCard } from './FileCard';
import { EmptyState } from './EmptyState';
import { TelegramFile } from '../../types';
import { ContextMenu } from './ContextMenu';
import { FileListItem } from './FileListItem';
import { categorizeFile, FileTypeCategory, isImageFile } from '../../utils';
import { copyImageToClipboard } from '../../lib/copyImage';

type SortField = 'name' | 'size' | 'date';
type ConcreteCategory = Exclude<FileTypeCategory, 'all'>;

const TYPE_FILTERS: { value: ConcreteCategory; label: string }[] = [
    { value: 'image', label: 'Images' },
    { value: 'video', label: 'Videos' },
    { value: 'audio', label: 'Audio' },
    { value: 'document', label: 'Documents' },
    { value: 'other', label: 'Other' },
];

interface FileExplorerProps {
    files: TelegramFile[];
    loading: boolean;
    error: Error | null;
    viewMode: 'grid' | 'list';
    selectedIds: number[];
    activeFolderId: number | null;
    /** Called on every card/list click. The third argument is the ids of every
     *  visible file in current sort+filter order — Dashboard uses it to slice
     *  shift-click ranges along what the user actually sees, not the raw
     *  unsorted upstream list. */
    onFileClick: (e: React.MouseEvent, id: number, orderedIds: number[]) => void;
    onFileDoubleClick?: (file: TelegramFile, orderedFiles: TelegramFile[]) => void;
    onDelete: (id: number) => void;
    onDownload: (id: number, name: string) => void;
    onPreview: (file: TelegramFile, orderedFiles?: TelegramFile[]) => void;
    onManualUpload: () => void;
    onSelectionClear: () => void;
    onToggleSelection: (id: number) => void;
    /** Mobile-only: gallery-style swipe-to-select. Touch starts on a card's
     *  cell; subsequent finger movement over other cards extends the
     *  range. The Photos-app rule applies: if the START item was already
     *  selected, dragging across cards DESELECTS them; otherwise it
     *  selects. This requires a setter, not an "add", so we expose the
     *  full setSelectedIds. The Set form keeps mutation O(range size). */
    onSetSelectedIds?: (ids: number[]) => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
    disableThumbnailFor?: (file: TelegramFile) => boolean;
    sortField: 'name' | 'size' | 'date';
    sortDirection: 'asc' | 'desc';
    onSortChange: (field: 'name' | 'size' | 'date', direction: 'asc' | 'desc') => void;
    /** Mobile-only: when true, tap toggles selection instead of preview.
     *  Drives the `data-select-mode` attribute on the scroll container so
     *  CSS / cards can adapt their tap targets. Currently used to keep
     *  hover-icons hidden in select mode. */
    selectMode?: boolean;
    /** Desktop grid column count from app settings. Mobile is always 3 —
     *  the design is iOS-Photos-style fixed three columns at small width
     *  regardless of the user's desktop preference. */
    gridColumnsDesktop?: number;
    /** Mobile single-select filter. When set (and not 'all'), overrides
     *  the typeFilters Set the desktop chrome controls — the in-grid
     *  filter row is hidden on mobile anyway. */
    mobileFilter?: 'all' | ConcreteCategory;
}


function useGridColumns(
    containerRef: React.RefObject<HTMLDivElement | null>,
    desktopColumns: number,
) {
    // Initialise from window width so the first paint is already correct on
    // mobile. The previous default of `desktopColumns` (e.g. 6) caused a
    // visible flash where the grid briefly rendered 6 columns before the
    // ResizeObserver fired and snapped it back to 3 — most noticeable when
    // navigating back from Settings, which fully remounts the grid.
    const initialIsMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    const [columns, setColumns] = useState(initialIsMobile ? 3 : desktopColumns);
    const [containerWidth, setContainerWidth] = useState(
        typeof window !== 'undefined' ? window.innerWidth : 800,
    );

    useEffect(() => {
        if (!containerRef.current) return;

        const updateColumns = () => {
            const width = containerRef.current?.clientWidth ?? 0;
            // Skip updates while the container hasn't been laid out yet
            // (clientWidth = 0). The previous fallback to 800 produced a
            // momentary 6-column flash on mobile when the user navigated
            // back from Settings — the loading spinner branch had a
            // 0-width container and we'd snap columns to desktop default
            // before settling back to 3.
            if (width === 0) return;
            setContainerWidth(width);
            // Mobile (anything below the md Tailwind breakpoint of 768px)
            // is locked to a 3-col Photos-style grid regardless of the
            // user's desktop preference.
            if (width < 768) setColumns(3);
            else setColumns(desktopColumns);
        };

        updateColumns();
        const observer = new ResizeObserver(updateColumns);
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [containerRef, desktopColumns]);

    return { columns, containerWidth };
}

export function FileExplorer({
    files, loading, error, viewMode, selectedIds, activeFolderId,
    onFileClick, onFileDoubleClick, onDelete, onDownload, onPreview, onManualUpload, onSelectionClear, onToggleSelection, onSetSelectedIds, onDrop, onDragStart, onDragEnd, disableThumbnailFor,
    sortField, sortDirection, onSortChange,
    selectMode = false, gridColumnsDesktop = 6, mobileFilter = 'all',
}: FileExplorerProps) {
    const [typeFilters, setTypeFilters] = useState<Set<ConcreteCategory>>(new Set());
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: TelegramFile } | null>(null);

    const toggleTypeFilter = (cat: ConcreteCategory) => {
        setTypeFilters(prev => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat); else next.add(cat);
            return next;
        });
    };

    const parentRef = useRef<HTMLDivElement>(null);
    const { columns, containerWidth } = useGridColumns(parentRef, gridColumnsDesktop);
    const isMobileWidth = containerWidth < 768;

    // On mobile, Photos-style: zero gap, square cards. On desktop, keep
    // small gutters and a 1:1 aspect — the previous 4:3 + 150px floor
    // produced a vertical-letterboxed layout at 6+ columns where rows
    // had a giant empty band below each card.
    const GAP = isMobileWidth ? 0 : 6;
    const cardWidth = (containerWidth - (GAP * (columns - 1))) / columns;
    const cardHeight = cardWidth; // square on every breakpoint now
    const rowHeight = isMobileWidth ? cardHeight : cardHeight + GAP;

    const handleContextMenu = useCallback((e: React.MouseEvent, file: TelegramFile) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, file });
    }, []);

    const sortedFiles = useMemo(() => {
        // mobileFilter (single-select, set from the topbar More menu) wins
        // when not 'all'. The width-gate that used to live here was
        // causing the filter to silently no-op when the React-side hook
        // and the container's clientWidth disagreed at the breakpoint.
        // Desktop's multi-select chrome (typeFilters) only ever runs when
        // mobileFilter is 'all', because the chrome itself is hidden on
        // mobile widths.
        const filtered = mobileFilter !== 'all'
            ? files.filter((f) => f.type === 'folder' || categorizeFile(f.name) === mobileFilter)
            : (typeFilters.size === 0
                ? files
                : files.filter((f) => f.type === 'folder' || typeFilters.has(categorizeFile(f.name))));

        return [...filtered].sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'size':
                    comparison = (a.size || 0) - (b.size || 0);
                    break;
                case 'date':
                    comparison = (a.created_at || '').localeCompare(b.created_at || '');
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });
    }, [files, sortField, sortDirection, typeFilters, mobileFilter]);

    const handlePreviewRequest = useCallback((file: TelegramFile) => {
        onPreview(file, sortedFiles);
    }, [onPreview, sortedFiles]);

    /** All visible file ids in current display order. Always pass this to
     *  the click handler so shift-click range selection slices the same
     *  sequence the user sees. */
    const visibleOrderedIds = useMemo(
        () => sortedFiles.map((f) => f.id),
        [sortedFiles],
    );
    const handleFileClickWithOrder = useCallback(
        (e: React.MouseEvent, id: number) => onFileClick(e, id, visibleOrderedIds),
        [onFileClick, visibleOrderedIds],
    );
    const handleFileDoubleClickWithOrder = useCallback(
        (file: TelegramFile) => {
            if (onFileDoubleClick) onFileDoubleClick(file, sortedFiles);
        },
        [onFileDoubleClick, sortedFiles],
    );


    const gridRows = useMemo(() => {
        const rows: (TelegramFile | 'upload')[][] = [];
        const itemsWithUpload: (TelegramFile | 'upload')[] = ['upload', ...sortedFiles];
        for (let i = 0; i < itemsWithUpload.length; i += columns) {
            rows.push(itemsWithUpload.slice(i, i + columns));
        }
        return rows;
    }, [sortedFiles, columns]);


    const listItems = useMemo(() => {
        return activeFolderId === null ? ['upload' as const, ...sortedFiles] : sortedFiles;
    }, [sortedFiles, activeFolderId]);


    const gridVirtualizer = useVirtualizer({
        count: gridRows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: useCallback(() => rowHeight, [rowHeight]),
        overscan: 2,
        gap: GAP,
    });


    useEffect(() => {
        gridVirtualizer.measure();
    }, [rowHeight, gridVirtualizer]);

    // Gallery-style range drag-to-select. Active only in selection mode
    // (selectedIds.length > 0) so vertical scroll keeps working when the
    // user isn't picking files. Once a finger is moving on a card, the
    // range from the touch's *start card* to the *current card* — in
    // visible (sorted+filtered) order — is added to the selection.
    //
    // Refs let us read fresh selectedIds / visibleOrderedIds inside the
    // listeners without re-binding on every render.
    const selectedRef = useRef(selectedIds);
    selectedRef.current = selectedIds;
    const orderedRef = useRef(visibleOrderedIds);
    orderedRef.current = visibleOrderedIds;
    const selectModeRef = useRef(selectMode);
    selectModeRef.current = selectMode;
    useEffect(() => {
        if (!onSetSelectedIds) return;
        const root = parentRef.current;
        if (!root) return;

        const state = {
            active: false,
            dragging: false,
            startId: null as number | null,
            startX: 0,
            startY: 0,
            // Snapshot the selection at gesture start. The drag operation
            // then re-derives the result from snapshot ± current range,
            // so the user can swipe forward to select and *back* to
            // deselect within the same gesture (Photos-app behaviour).
            startSelected: [] as number[],
            startWasSelected: false,
        };

        const idAtPoint = (x: number, y: number): number | null => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            const card = (el as HTMLElement).closest('[data-file-id]');
            if (!card) return null;
            const raw = card.getAttribute('data-file-id');
            const n = raw ? Number(raw) : NaN;
            return Number.isFinite(n) ? n : null;
        };

        const onStart = (e: TouchEvent) => {
            if (e.touches.length !== 1) {
                state.active = false;
                return;
            }
            const t = e.touches[0];
            const id = idAtPoint(t.clientX, t.clientY);
            if (id === null) { state.active = false; return; }
            state.active = true;
            state.dragging = false;
            state.startId = id;
            state.startX = t.clientX;
            state.startY = t.clientY;
            state.startSelected = [...selectedRef.current];
            state.startWasSelected = state.startSelected.includes(id);
        };

        const onMove = (e: TouchEvent) => {
            if (!state.active) return;
            const t = e.touches[0];
            const dx = t.clientX - state.startX;
            const dy = t.clientY - state.startY;
            if (!state.dragging) {
                if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
                state.dragging = true;
            }
            // Outside Select mode and with empty selection, leave the
            // gesture to be a vertical scroll. Inside select mode (or with
            // an existing selection) the gesture commandeers.
            if (!selectModeRef.current && state.startSelected.length === 0) return;
            if (e.cancelable) e.preventDefault();
            const currentId = idAtPoint(t.clientX, t.clientY);
            if (currentId === null || state.startId === null) return;
            const ordered = orderedRef.current;
            const a = ordered.indexOf(state.startId);
            const b = ordered.indexOf(currentId);
            if (a < 0 || b < 0) return;
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const rangeIds = ordered.slice(lo, hi + 1);
            // Photos rule: items in the range take the OPPOSITE state of
            // the start item — so dragging from an unselected item adds,
            // and dragging from a selected item removes. Items outside
            // the range stay at whatever they were when the gesture began.
            const next = new Set(state.startSelected);
            const targetSelected = !state.startWasSelected;
            for (const id of rangeIds) {
                if (targetSelected) next.add(id);
                else next.delete(id);
            }
            onSetSelectedIds(Array.from(next));
        };

        const onEnd = (e: TouchEvent) => {
            if (state.dragging && (selectModeRef.current || state.startSelected.length > 0)) {
                // Prevent the synthetic click that follows a touchend so a
                // 200px drag-select doesn't also fire onClick on the card
                // where the finger lifted (which would either open preview
                // or toggle, both wrong here). `cancelable` guards against
                // a Chrome console intervention warning when this event
                // fires mid-scroll where preventDefault is a no-op anyway.
                if (e.cancelable) e.preventDefault();
                const blockClick = (ev: Event) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    document.removeEventListener('click', blockClick, true);
                };
                document.addEventListener('click', blockClick, true);
                window.setTimeout(() => {
                    document.removeEventListener('click', blockClick, true);
                }, 400);
            }
            state.active = false;
            state.dragging = false;
            state.startId = null;
        };

        const onCancel = () => {
            state.active = false;
            state.dragging = false;
            state.startId = null;
        };

        root.addEventListener('touchstart', onStart, { passive: true });
        root.addEventListener('touchmove', onMove, { passive: false });
        root.addEventListener('touchend', onEnd, { passive: false });
        root.addEventListener('touchcancel', onCancel);
        return () => {
            root.removeEventListener('touchstart', onStart);
            root.removeEventListener('touchmove', onMove);
            root.removeEventListener('touchend', onEnd);
            root.removeEventListener('touchcancel', onCancel);
        };
    }, [onSetSelectedIds]);

    const listVirtualizer = useVirtualizer({
        count: listItems.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 48,
        overscan: 5,
    });

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            onSortChange(field, sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            onSortChange(field, 'asc');
        }
    };

    const SortIcon = ({ field }: { field: SortField }) => {
        if (sortField !== field) return <ArrowUpDown className="w-3 h-3 opacity-30" />;
        return sortDirection === 'asc'
            ? <ArrowUp className="w-3 h-3 text-telegram-primary" />
            : <ArrowDown className="w-3 h-3 text-telegram-primary" />;
    };

    // Always render the parentRef'd container — the loading / error /
    // empty branches now sit *inside* it so the touch-listener effect
    // (which attaches to parentRef.current) actually finds the element
    // on first commit. The previous early-return versions left
    // parentRef.current === null on first effect run, and because the
    // effect's deps never changed afterwards it never re-attached, which
    // is what made swipe-select silently stop working.
    if (loading) {
        return (
            <div ref={parentRef} className="flex-1 p-3 sm:p-6 flex justify-center items-center text-telegram-subtext flex-col gap-4">
                <div className="w-8 h-8 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                Loading your files...
            </div>
        )
    }

    if (error) {
        return <div ref={parentRef} className="flex-1 p-3 sm:p-6 flex justify-center items-center text-red-400">Error loading files</div>
    }

    if (files.length === 0) {
        return (
            <div ref={parentRef} className="flex-1 p-3 sm:p-6 overflow-auto">
                <EmptyState onUpload={onManualUpload} />
            </div>
        );
    }

    return (
        <div
            ref={parentRef}
            className="flex-1 overflow-auto custom-scrollbar p-0 sm:p-6"
            data-select-mode={selectMode ? 'on' : 'off'}
            onClick={(e) => {
                if (e.target === e.currentTarget) onSelectionClear();
            }}
        >
            {viewMode === 'grid' ? (
                <>

                    {/* Sort / type-filter toolbar — desktop only. The mobile
                        grid is intentionally chrome-free; sort lives in Settings. */}
                    <div className="hidden sm:flex items-center gap-2 mb-4 text-xs text-telegram-subtext flex-wrap">
                        <span>Sort by:</span>
                        <button
                            onClick={() => handleSort('name')}
                            className={`px-2 py-1 rounded flex items-center gap-1 hover:bg-white/5 ${sortField === 'name' ? 'text-telegram-primary' : ''}`}
                        >
                            Name <SortIcon field="name" />
                        </button>
                        <button
                            onClick={() => handleSort('size')}
                            className={`px-2 py-1 rounded flex items-center gap-1 hover:bg-white/5 ${sortField === 'size' ? 'text-telegram-primary' : ''}`}
                        >
                            Size <SortIcon field="size" />
                        </button>
                        <button
                            onClick={() => handleSort('date')}
                            className={`px-2 py-1 rounded flex items-center gap-1 hover:bg-white/5 ${sortField === 'date' ? 'text-telegram-primary' : ''}`}
                        >
                            Date <SortIcon field="date" />
                        </button>
                        <div className="ml-auto flex items-center gap-2 flex-wrap">
                            <span>Type:</span>
                            <button
                                onClick={() => setTypeFilters(new Set())}
                                className={`px-2 py-1 rounded hover:bg-white/5 ${typeFilters.size === 0 ? 'text-telegram-primary bg-white/5' : ''}`}
                            >
                                All
                            </button>
                            {TYPE_FILTERS.map((opt) => (
                                <button
                                    key={opt.value}
                                    onClick={() => toggleTypeFilter(opt.value)}
                                    className={`px-2 py-1 rounded hover:bg-white/5 ${typeFilters.has(opt.value) ? 'text-telegram-primary bg-white/5' : ''}`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>


                    <div
                        className="relative w-full"
                        style={{ height: `${gridVirtualizer.getTotalSize()}px` }}
                    >
                        {gridVirtualizer.getVirtualItems().map((virtualRow) => {
                            const row = gridRows[virtualRow.index];
                            return (
                                <div
                                    key={virtualRow.key}
                                    className="absolute top-0 left-0 w-full grid"
                                    style={{
                                        height: `${cardHeight}px`,
                                        transform: `translateY(${virtualRow.start}px)`,
                                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                                        gap: `${GAP}px`,
                                    }}
                                >
                                    {row.map((item) => {
                                        if (item === 'upload') {
                                            return (
                                                // Wrap in a div whose box matches FileCard's outer
                                                // wrapper exactly (`w-full h-full` + explicit pixel
                                                // height). Without this wrapper, the bare <button>
                                                // can pick up user-agent-default padding/border
                                                // that nudges its height a hair past the file
                                                // cards next to it — which is what made the upload
                                                // tile look slightly larger than every other cell.
                                                <div
                                                    key="upload"
                                                    className="w-full h-full"
                                                    style={{ height: `${cardHeight}px` }}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={(e) => { e.stopPropagation(); onManualUpload(); }}
                                                        className={`w-full h-full flex flex-col items-center justify-center transition-all group p-0 m-0 ${
                                                            isMobileWidth
                                                                ? 'bg-telegram-primary/15 text-telegram-primary active:bg-telegram-primary/25'
                                                                : 'border-2 border-dashed border-telegram-border rounded-xl text-telegram-subtext hover:border-telegram-primary hover:text-telegram-primary'
                                                        }`}
                                                    >
                                                        <Plus className={`${isMobileWidth ? 'w-7 h-7 mb-1' : 'w-8 h-8 mb-2'} group-hover:scale-110 transition-transform`} />
                                                        <span className={isMobileWidth ? 'text-xs font-medium' : 'text-sm font-medium'}>Upload</span>
                                                    </button>
                                                </div>
                                            );
                                        }
                                        const file = item;
                                        return (
                                            <FileCard
                                                key={file.id}
                                                file={file}
                                                isSelected={selectedIds.includes(file.id)}
                                                onClick={(e) => handleFileClickWithOrder(e, file.id)}
                                                onDoubleClick={() => handleFileDoubleClickWithOrder(file)}
                                                onContextMenu={(e) => handleContextMenu(e, file)}
                                                onDelete={() => onDelete(file.id)}
                                                onDownload={() => onDownload(file.id, file.name)}
                                                onPreview={() => handlePreviewRequest(file)}
                                                onDrop={onDrop}
                                                onDragStart={onDragStart}
                                                onDragEnd={onDragEnd}
                                                activeFolderId={activeFolderId}
                                                height={cardHeight}
                                                onToggleSelection={() => onToggleSelection(file.id)}
                                                disableThumbnail={disableThumbnailFor ? disableThumbnailFor(file) : false}
                                                selectMode={selectMode}
                                            />
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                </>
            ) : (
                <div className="flex flex-col w-full">
                    {/* List Header */}
                    <div className="grid grid-cols-[2rem_2fr_5rem] sm:grid-cols-[2rem_2fr_6rem_8rem] gap-3 sm:gap-4 px-2 sm:px-4 py-2 text-xs font-semibold text-telegram-subtext border-b border-telegram-border mb-2 select-none items-center">
                        <div className="text-center">#</div>
                        <button onClick={() => handleSort('name')} className="flex items-center gap-1 hover:text-telegram-text transition-colors">
                            Name <SortIcon field="name" />
                        </button>
                        <button onClick={() => handleSort('size')} className="flex items-center gap-1 justify-end hover:text-telegram-text transition-colors">
                            Size <SortIcon field="size" />
                        </button>
                        <button onClick={() => handleSort('date')} className="hidden sm:flex items-center gap-1 justify-end hover:text-telegram-text transition-colors">
                            Date <SortIcon field="date" />
                        </button>
                    </div>


                    <div
                        className="relative w-full"
                        style={{ height: `${listVirtualizer.getTotalSize()}px` }}
                    >
                        {listVirtualizer.getVirtualItems().map((virtualItem) => {
                            const item = listItems[virtualItem.index];
                            if (item === 'upload') {
                                return (
                                    <div
                                        key="upload"
                                        className="absolute top-0 left-0 w-full"
                                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                                    >
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onManualUpload(); }}
                                            className="flex items-center gap-4 px-4 py-3 rounded-lg cursor-pointer border border-dashed border-telegram-border text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover w-full"
                                        >
                                            <div className="w-5 h-5 flex items-center justify-center"><Plus className="w-4 h-4" /></div>
                                            <span className="text-sm font-medium">Upload Files...</span>
                                        </button>
                                    </div>
                                );
                            }
                            const file = item;
                            return (
                                <div
                                    key={file.id}
                                    className="absolute top-0 left-0 w-full"
                                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                                >
                                    <FileListItem
                                        file={file}
                                        selectedIds={selectedIds}
                                        onFileClick={handleFileClickWithOrder}
                                        onFileDoubleClick={() => handleFileDoubleClickWithOrder(file)}
                                        handleContextMenu={handleContextMenu}
                                        onDragStart={onDragStart}
                                        onDragEnd={onDragEnd}
                                        onDrop={onDrop}
                                        onPreview={handlePreviewRequest}
                                        onDownload={onDownload}
                                        onDelete={onDelete}
                                        selectMode={selectMode}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    // Re-mount on every open so the two-phase reveal
                    // (off-screen measure → fade in) always starts from
                    // ready=false. Without the key, a re-open with new
                    // x/y reuses the previous mount whose `ready` is
                    // already true → the user sees the menu briefly at
                    // the old position before the new one paints.
                    key={`${contextMenu.x},${contextMenu.y},${contextMenu.file.id}`}
                    x={contextMenu.x}
                    y={contextMenu.y}
                    file={contextMenu.file}
                    onClose={() => setContextMenu(null)}
                    onDownload={() => {
                        onDownload(contextMenu.file.id, contextMenu.file.name);
                        setContextMenu(null);
                    }}
                    onDelete={() => {
                        onDelete(contextMenu.file.id);
                        setContextMenu(null);
                    }}
                    onPreview={() => {
                        if (contextMenu.file.type === 'folder') {
                            onFileClick({ preventDefault: () => { }, stopPropagation: () => { } } as React.MouseEvent, contextMenu.file.id, visibleOrderedIds);
                        } else {
                            handlePreviewRequest(contextMenu.file);
                        }
                        setContextMenu(null);
                    }}
                    onCopyImage={
                        contextMenu.file.type !== 'folder' && isImageFile(contextMenu.file.name)
                            ? () => {
                                const f = contextMenu.file;
                                setContextMenu(null);
                                copyImageToClipboard(f, f.folder_id ?? activeFolderId)
                                    .then(() => toast.success("Image copied"))
                                    .catch((e) => toast.error(`Copy failed: ${e?.message ?? e}`));
                            }
                            : undefined
                    }
                />
            )}
        </div>
    )
}
