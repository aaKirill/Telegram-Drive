import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Plus, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileCard } from './FileCard';
import { EmptyState } from './EmptyState';
import { TelegramFile } from '../../types';
import { ContextMenu } from './ContextMenu';
import { FileListItem } from './FileListItem';
import { categorizeFile, FileTypeCategory } from '../../utils';

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
     *  checkbox handle; subsequent finger movement over other cards adds
     *  them. We only ADD (not toggle) so a swipe never accidentally
     *  unselects what it just touched. */
    onAddToSelection?: (id: number) => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
    disableThumbnailFor?: (file: TelegramFile) => boolean;
    sortField: 'name' | 'size' | 'date';
    sortDirection: 'asc' | 'desc';
    onSortChange: (field: 'name' | 'size' | 'date', direction: 'asc' | 'desc') => void;
}


function useGridColumns(containerRef: React.RefObject<HTMLDivElement | null>) {
    const [columns, setColumns] = useState(4);
    const [containerWidth, setContainerWidth] = useState(800);

    useEffect(() => {
        if (!containerRef.current) return;

        const updateColumns = () => {
            const width = containerRef.current?.clientWidth || 800;
            setContainerWidth(width);
            if (width < 640) setColumns(2);
            else if (width < 768) setColumns(3);
            else if (width < 1024) setColumns(4);
            else if (width < 1280) setColumns(5);
            else setColumns(6);
        };

        updateColumns();
        const observer = new ResizeObserver(updateColumns);
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [containerRef]);

    return { columns, containerWidth };
}

export function FileExplorer({
    files, loading, error, viewMode, selectedIds, activeFolderId,
    onFileClick, onFileDoubleClick, onDelete, onDownload, onPreview, onManualUpload, onSelectionClear, onToggleSelection, onAddToSelection, onDrop, onDragStart, onDragEnd, disableThumbnailFor,
    sortField, sortDirection, onSortChange
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
    const { columns, containerWidth } = useGridColumns(parentRef);

    const GAP = 6;
    const cardWidth = (containerWidth - (GAP * (columns - 1))) / columns;
    const cardHeight = cardWidth * 0.75; // aspect-[4/3]
    const rowHeight = Math.max(cardHeight + GAP, 150);

    const handleContextMenu = useCallback((e: React.MouseEvent, file: TelegramFile) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, file });
    }, []);

    const sortedFiles = useMemo(() => {
        const filtered = typeFilters.size === 0
            ? files
            : files.filter((f) => f.type === 'folder' || typeFilters.has(categorizeFile(f.name)));

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
    }, [files, sortField, sortDirection, typeFilters]);

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
    useEffect(() => {
        if (!onAddToSelection) return;
        const root = parentRef.current;
        if (!root) return;

        const state = {
            active: false,
            dragging: false,
            startId: null as number | null,
            startX: 0,
            startY: 0,
            wasDragging: false, // set on touchend, read by the click suppressor
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
            // Only commandeer the gesture (and block scroll) once the user
            // is in selection mode AND has moved past threshold. Outside
            // selection mode the swipe is just a scroll — don't interfere.
            if (selectedRef.current.length === 0) return;
            e.preventDefault();
            const currentId = idAtPoint(t.clientX, t.clientY);
            if (currentId === null || state.startId === null) return;
            const ordered = orderedRef.current;
            const a = ordered.indexOf(state.startId);
            const b = ordered.indexOf(currentId);
            if (a < 0 || b < 0) return;
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            for (let i = lo; i <= hi; i++) onAddToSelection(ordered[i]);
        };

        const onEnd = (e: TouchEvent) => {
            if (state.dragging && selectedRef.current.length > 0) {
                // Prevent the synthetic click that follows a touchend so a
                // 200px drag-select doesn't also fire onClick on the card
                // where the finger lifted (which would either open preview
                // or toggle, both wrong here).
                e.preventDefault();
                state.wasDragging = true;
                // Belt-and-braces: also intercept the next click in capture
                // phase, since not every iOS version honors touchend's
                // preventDefault for the trailing click.
                const blockClick = (ev: Event) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    document.removeEventListener('click', blockClick, true);
                };
                document.addEventListener('click', blockClick, true);
                window.setTimeout(() => {
                    document.removeEventListener('click', blockClick, true);
                    state.wasDragging = false;
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
    }, [onAddToSelection]);

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

    if (loading) {
        return (
            <div className="flex-1 p-3 sm:p-6 flex justify-center items-center text-telegram-subtext flex-col gap-4">
                <div className="w-8 h-8 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                Loading your files...
            </div>
        )
    }

    if (error) {
        return <div className="flex-1 p-3 sm:p-6 flex justify-center items-center text-red-400">Error loading files</div>
    }

    if (files.length === 0) {
        return (
            <div className="flex-1 p-3 sm:p-6 overflow-auto">
                <EmptyState onUpload={onManualUpload} />
            </div>
        );
    }

    return (
        <div
            ref={parentRef}
            className="flex-1 p-3 sm:p-6 overflow-auto custom-scrollbar"
            onClick={(e) => {
                if (e.target === e.currentTarget) onSelectionClear();
            }}
        >
            {viewMode === 'grid' ? (
                <>

                    <div className="flex items-center gap-2 mb-4 text-xs text-telegram-subtext flex-wrap">
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
                                                <button
                                                    key="upload"
                                                    onClick={(e) => { e.stopPropagation(); onManualUpload(); }}
                                                    className="border-2 border-dashed border-telegram-border rounded-xl flex flex-col items-center justify-center text-telegram-subtext hover:border-telegram-primary hover:text-telegram-primary transition-all group"
                                                    style={{ height: `${cardHeight}px` }}
                                                >
                                                    <Plus className="w-8 h-8 mb-2 group-hover:scale-110 transition-transform" />
                                                    <span className="text-sm font-medium">Upload Files</span>
                                                </button>
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
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {contextMenu && (
                <ContextMenu
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
                />
            )}
        </div>
    )
}
