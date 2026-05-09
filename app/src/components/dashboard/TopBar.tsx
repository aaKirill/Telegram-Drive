import { useEffect, useRef, useState } from 'react';
import { HardDrive, LayoutGrid, Sun, Moon, ListChecks, ListX, Settings as SettingsIcon, Menu, MoreVertical } from 'lucide-react';
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
}

export function TopBar({
    currentFolderName, selectedIds, onShowMoveModal, onBulkDownload, onBulkDelete,
    onDownloadFolder, onStartClick, onSelectAll, onDeselectAll, onOpenSettings, hasFiles, totalFiles,
    viewMode, setViewMode, searchTerm, onSearchChange,
    isMobile = false, onMobileMenu,
}: TopBarProps) {
    const allSelected = hasFiles && selectedIds.length >= totalFiles && totalFiles > 0;
    const { theme, toggleTheme } = useTheme();
    const [overflowOpen, setOverflowOpen] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);

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

    return (
        <header className="h-14 border-b border-telegram-border flex items-center px-2 sm:px-4 justify-between bg-telegram-surface/80 backdrop-blur-md sticky top-0 z-10" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 min-w-0">
                {isMobile && (
                    <button
                        onClick={onMobileMenu}
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

                {hasFiles && (
                    <button
                        onClick={allSelected ? onDeselectAll : onSelectAll}
                        className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
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
                            <div className="absolute right-0 top-full mt-1 w-52 bg-telegram-surface border border-telegram-border rounded-md shadow-xl z-50 py-1 text-sm">
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
        </header>
    )
}

function MenuRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-telegram-hover text-telegram-text text-left"
        >
            <span className="text-telegram-subtext">{icon}</span>
            <span>{label}</span>
        </button>
    );
}
