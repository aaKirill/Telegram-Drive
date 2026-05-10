import { useEffect, useRef, useState } from 'react';
import { HardDrive, LayoutGrid, Sun, Moon, ListChecks, ListX, Settings as SettingsIcon, Menu, MoreVertical, Search, X, CircleCheckBig, Columns3 } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

interface TopBarProps {
    currentFolderName: string | null;
    selectedIds: number[];
    onShowMoveModal: () => void;
    onBulkDownload: () => void;
    onBulkDelete: () => void;
    onDownloadFolder: () => void;
    onStartClick: () => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    onOpenSettings: () => void;
    hasFiles: boolean;
    totalFiles: number;
    viewMode: 'grid' | 'list';
    setViewMode: (mode: 'grid' | 'list') => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    /** Mobile-only: hamburger toggles the drawer-mode sidebar. */
    isMobile?: boolean;
    onMobileMenu?: () => void;
    /** Mobile-only Select mode toggle. When true, taps on cards toggle
     *  selection (instead of preview); when false, taps preview. */
    selectMode?: boolean;
    onToggleSelectMode?: () => void;
    /** Desktop-only grid-columns control. Mobile is fixed at 3 cols. */
    gridColumns?: number;
    onGridColumnsChange?: (n: number) => void;
    /** Mobile-only sort + filter controls live inside the kebab. Single
     *  source of truth so the desktop sidebar/header can reuse them.
     *  field+direction match the existing Settings keys (defaultSortField
     *  / defaultSortDir) so both share the same type. */
    sortField?: 'name' | 'size' | 'date';
    sortDirection?: 'asc' | 'desc';
    onSortChange?: (field: 'name' | 'size' | 'date', direction: 'asc' | 'desc') => void;
    /** Single-select filter for mobile (vs. the Set<ConcreteCategory> the
     *  desktop FileExplorer chrome offers). 'all' = no filter. */
    mobileFilter?: 'all' | 'image' | 'video' | 'audio' | 'document' | 'other';
    onMobileFilterChange?: (next: 'all' | 'image' | 'video' | 'audio' | 'document' | 'other') => void;
}

export function TopBar({
    currentFolderName, selectedIds, onShowMoveModal, onBulkDownload, onBulkDelete,
    onDownloadFolder, onStartClick, onSelectAll, onDeselectAll, onOpenSettings, hasFiles, totalFiles,
    viewMode, setViewMode, searchTerm, onSearchChange,
    isMobile = false, onMobileMenu,
    selectMode = false, onToggleSelectMode,
    gridColumns, onGridColumnsChange,
    sortField, sortDirection, onSortChange,
    mobileFilter = 'all', onMobileFilterChange,
}: TopBarProps) {
    const allSelected = hasFiles && selectedIds.length >= totalFiles && totalFiles > 0;
    const { theme, toggleTheme } = useTheme();
    const [overflowOpen, setOverflowOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [colsOpen, setColsOpen] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);
    const colsRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Click-outside dismissal for the kebab menu. touchstart covers iOS
    // taps on areas that don't synthesize a click event.
    useEffect(() => {
        if (!overflowOpen) return;
        const onOutside = (e: Event) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
                setOverflowOpen(false);
            }
        };
        document.addEventListener('mousedown', onOutside);
        document.addEventListener('touchstart', onOutside, { passive: true });
        return () => {
            document.removeEventListener('mousedown', onOutside);
            document.removeEventListener('touchstart', onOutside);
        };
    }, [overflowOpen]);

    // Same dismiss logic for the columns dropdown (desktop-only).
    useEffect(() => {
        if (!colsOpen) return;
        const onOutside = (e: Event) => {
            if (colsRef.current && !colsRef.current.contains(e.target as Node)) {
                setColsOpen(false);
            }
        };
        document.addEventListener('mousedown', onOutside);
        return () => document.removeEventListener('mousedown', onOutside);
    }, [colsOpen]);

    // Auto-focus the search input when the user opens it on mobile,
    // and clear the term on close so the next open starts fresh.
    useEffect(() => {
        if (searchOpen) {
            setTimeout(() => searchInputRef.current?.focus(), 50);
        }
    }, [searchOpen]);

    // Mobile search-expanded mode replaces the whole topbar with a single
    // input + close button so the user gets an unambiguous "search" surface
    // when there's no room for an inline input next to everything else.
    if (isMobile && searchOpen) {
        // Padding-top via inline style is on the OUTER header so the
        // status-bar reserve sits above the h-14 content row instead of
        // squeezing it (Tailwind's `h-14` is border-box, so adding
        // `safe-top` padding to the same element collapsed the row to a
        // few pixels and clipped icons under iOS's clock/battery overlay).
        return (
            <header
                className="border-b border-telegram-border bg-telegram-surface/95 backdrop-blur-md sticky top-0 z-10"
                style={{ paddingTop: 'env(safe-area-inset-top)' }}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center px-2 gap-2 h-14">
                <Search className="w-5 h-5 text-telegram-subtext shrink-0" />
                <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Search..."
                    className="flex-1 bg-transparent text-sm text-telegram-text placeholder:text-telegram-subtext focus:outline-none"
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                />
                <button
                    type="button"
                    onClick={() => { setSearchOpen(false); onSearchChange(''); }}
                    style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                    className="p-2 -mr-1 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition shrink-0"
                    aria-label="Close search"
                >
                    <X className="w-5 h-5" />
                </button>
                </div>
            </header>
        );
    }

    return (
        <header
            className="border-b border-telegram-border bg-telegram-surface/80 backdrop-blur-md sticky top-0 z-10"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
            onClick={e => e.stopPropagation()}
        >
            <div className="flex items-center px-2 sm:px-4 justify-between h-14">
            <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                {isMobile && (
                    <button
                        onClick={onMobileMenu}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition shrink-0"
                        title="Open menu"
                        aria-label="Open menu"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                )}
                <div className="flex items-center text-sm breadcrumbs text-telegram-subtext select-none min-w-0">
                    <button
                        onClick={onStartClick}
                        disabled={!currentFolderName}
                        className="hover:text-telegram-text disabled:hover:text-telegram-subtext disabled:cursor-default cursor-pointer transition-colors shrink-0"
                        title={currentFolderName ? "Close folder" : undefined}
                    >
                        Root
                    </button>
                    {currentFolderName && (
                        <>
                            <span className="mx-2 shrink-0">/</span>
                            <span className="text-telegram-text font-medium truncate">{currentFolderName}</span>
                        </>
                    )}
                </div>
            </div>

            {/* Inline search — desktop only. Mobile uses the search-icon
                expand-to-fullbar pattern (rendered above and via the button
                in the right-hand cluster). */}
            {!isMobile && (
                <div className="flex-1 max-w-md mx-2 sm:mx-4 min-w-0">
                    <input
                        type="text"
                        placeholder="Search..."
                        className="w-full bg-telegram-hover border border-telegram-border rounded-lg px-3 py-1.5 text-sm text-telegram-text placeholder:text-telegram-subtext focus:outline-none focus:border-telegram-primary/50 transition-colors"
                        value={searchTerm}
                        onChange={(e) => onSearchChange(e.target.value)}
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                    />
                </div>
            )}

            <div className="flex items-center gap-1 sm:gap-2">
                {/* Bulk-action cluster — desktop only. On mobile it lives in
                    a fixed bottom bar (rendered by Dashboard). */}
                {!isMobile && selectedIds.length > 0 && (
                    <div className="flex items-center gap-2 mr-4 animate-in fade-in slide-in-from-top-2">
                        <span className="text-xs text-telegram-subtext mr-2">{selectedIds.length} Selected</span>
                        {selectedIds.length >= 2 && (
                            <button onClick={onDeselectAll} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border rounded-md text-xs text-telegram-text transition" title="Clear selection">Deselect</button>
                        )}
                        <button onClick={onShowMoveModal} className="px-3 py-1.5 bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary rounded-md text-xs transition font-medium">Move to...</button>
                        <button onClick={onBulkDownload} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border rounded-md text-xs text-telegram-text transition">Download Selected</button>
                        <button onClick={onBulkDelete} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-md text-xs transition">Delete</button>
                    </div>
                )}

                {/* Mobile-only: search icon (expands to fullbar input) and
                    Select-mode toggle. Hidden on desktop where the inline
                    search input + click-to-select cover the same actions. */}
                {isMobile && (
                    <button
                        type="button"
                        onClick={() => setSearchOpen(true)}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition shrink-0"
                        title="Search"
                        aria-label="Search"
                    >
                        <Search className="w-5 h-5" />
                    </button>
                )}

                {/* Select-mode toggle is mobile-only. Single icon — the
                    background tint indicates active state (no glyph swap). */}
                {isMobile && hasFiles && onToggleSelectMode && (
                    <button
                        type="button"
                        onClick={onToggleSelectMode}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className={`p-2 rounded-md transition shrink-0 ${selectMode ? 'bg-telegram-primary/15 text-telegram-primary' : 'hover:bg-telegram-hover text-telegram-subtext hover:text-telegram-text'}`}
                        title={selectMode ? 'Done' : 'Select'}
                        aria-label={selectMode ? 'Done selecting' : 'Enter select mode'}
                    >
                        <CircleCheckBig className="w-5 h-5" />
                    </button>
                )}

                {hasFiles && (!isMobile || selectMode) && (
                    <button
                        onClick={allSelected ? onDeselectAll : onSelectAll}
                        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                        className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group shrink-0"
                        title={allSelected ? "Deselect All" : "Select All"}
                    >
                        {allSelected ? <ListX className="w-5 h-5" /> : <ListChecks className="w-5 h-5" />}
                        {!isMobile && (
                            <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                {allSelected ? 'Deselect All' : 'Select All'}
                            </span>
                        )}
                    </button>
                )}

                {/* Desktop: full icon row. Mobile: collapse into kebab. */}
                {!isMobile ? (
                    <>
                        <button onClick={onDownloadFolder} className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition group relative" title="Download Folder">
                            <HardDrive className="w-5 h-5" />
                            <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                Download All Files
                            </span>
                        </button>

                        <button
                            onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                            className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                            title="Toggle Layout"
                        >
                            <LayoutGrid className="w-5 h-5" />
                            <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                {viewMode === 'grid' ? 'Switch to List' : 'Switch to Grid'}
                            </span>
                        </button>

                        {viewMode === 'grid' && gridColumns !== undefined && onGridColumnsChange && (
                            <div className="relative" ref={colsRef}>
                                <button
                                    onClick={() => setColsOpen(o => !o)}
                                    className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                                    title="Grid columns"
                                    aria-label="Grid columns"
                                >
                                    <Columns3 className="w-5 h-5" />
                                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                        {gridColumns} columns
                                    </span>
                                </button>
                                {colsOpen && (
                                    <div className="absolute right-0 top-full mt-1 w-32 bg-telegram-surface border border-telegram-border rounded-md shadow-xl z-50 py-1 text-sm">
                                        {[2, 4, 6, 8, 10, 12].map(n => (
                                            <button
                                                key={n}
                                                type="button"
                                                onClick={() => { onGridColumnsChange(n); setColsOpen(false); }}
                                                className={`w-full text-left px-3 py-1.5 hover:bg-telegram-hover ${gridColumns === n ? 'text-telegram-primary' : 'text-telegram-text'}`}
                                            >
                                                {n} columns
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="w-px h-6 bg-telegram-border mx-1"></div>

                        <button
                            onClick={onOpenSettings}
                            className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                            title="Settings"
                        >
                            <SettingsIcon className="w-5 h-5" />
                            <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                Settings
                            </span>
                        </button>

                        <button
                            onClick={toggleTheme}
                            className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                        >
                            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                            <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                            </span>
                        </button>
                    </>
                ) : (
                    <div className="relative" ref={overflowRef}>
                        <button
                            onClick={() => setOverflowOpen(o => !o)}
                            className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition"
                            title="More"
                            aria-label="More actions"
                        >
                            <MoreVertical className="w-5 h-5" />
                        </button>
                        {overflowOpen && (
                            <div className="absolute right-0 top-full mt-1 w-52 bg-telegram-surface border border-telegram-border rounded-md shadow-xl z-50 py-1 text-xs max-h-[80vh] overflow-y-auto">
                                {/* Sort — picker stays open while user
                                    toggles fields (closing instantly on
                                    every tap would force a re-open per
                                    change, which is annoying). */}
                                {sortField && sortDirection && onSortChange && (
                                    <SubSection label="Sort by">
                                        {(['name', 'size', 'date'] as const).map((f) => {
                                            const active = sortField === f;
                                            return (
                                                <button
                                                    key={f}
                                                    type="button"
                                                    onClick={() => {
                                                        onSortChange(f, active ? (sortDirection === 'asc' ? 'desc' : 'asc') : sortDirection);
                                                    }}
                                                    className={`w-full px-3 py-1 text-left flex items-center justify-between hover:bg-telegram-hover ${active ? 'text-telegram-primary' : 'text-telegram-text'}`}
                                                >
                                                    <span className="capitalize">{f}</span>
                                                    {active && <span className="text-[10px]">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
                                                </button>
                                            );
                                        })}
                                    </SubSection>
                                )}

                                {/* Filter — single-select for mobile. */}
                                {onMobileFilterChange && (
                                    <SubSection label="Filter">
                                        {([
                                            ['all', 'All'],
                                            ['image', 'Images'],
                                            ['video', 'Videos'],
                                            ['audio', 'Audio'],
                                            ['document', 'Documents'],
                                            ['other', 'Other'],
                                        ] as const).map(([v, lbl]) => {
                                            const active = mobileFilter === v;
                                            return (
                                                <button
                                                    key={v}
                                                    type="button"
                                                    onClick={() => onMobileFilterChange(v)}
                                                    className={`w-full px-3 py-1 text-left hover:bg-telegram-hover ${active ? 'text-telegram-primary' : 'text-telegram-text'}`}
                                                >
                                                    {lbl}
                                                </button>
                                            );
                                        })}
                                    </SubSection>
                                )}

                                <MenuRow
                                    icon={<HardDrive className="w-4 h-4" />}
                                    label="Download Folder"
                                    onClick={() => { setOverflowOpen(false); onDownloadFolder(); }}
                                />
                                <MenuRow
                                    icon={<LayoutGrid className="w-4 h-4" />}
                                    label={viewMode === 'grid' ? 'Switch to List' : 'Switch to Grid'}
                                    onClick={() => { setOverflowOpen(false); setViewMode(viewMode === 'grid' ? 'list' : 'grid'); }}
                                />
                                <div className="my-1 border-t border-telegram-border" />
                                <MenuRow
                                    icon={<SettingsIcon className="w-4 h-4" />}
                                    label="Settings"
                                    onClick={() => { setOverflowOpen(false); onOpenSettings(); }}
                                />
                                <MenuRow
                                    icon={theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                                    label={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                                    onClick={() => { setOverflowOpen(false); toggleTheme(); }}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
            </div>
        </header>
    )
}

function MenuRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-telegram-hover text-telegram-text text-left"
        >
            <span className="text-telegram-subtext shrink-0">{icon}</span>
            <span className="truncate">{label}</span>
        </button>
    );
}

function SubSection({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="border-b border-telegram-border last:border-b-0">
            <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wide text-telegram-subtext/80">
                {label}
            </div>
            {children}
        </div>
    );
}
