import { Plus, HardDrive, Folder } from 'lucide-react';
import { TelegramFolder } from '../../types';

interface MoveToFolderModalProps {
    folders: TelegramFolder[];
    onClose: () => void;
    onSelect: (id: number | null) => void;
    activeFolderId: number | null;
}

export function MoveToFolderModal({ folders, onClose, onSelect, activeFolderId }: MoveToFolderModalProps) {
    // touchAction: 'manipulation' kills the iOS double-tap zoom delay so
    // option taps feel snappy. Without it, Safari sometimes swallows the
    // first click on a freshly-rendered modal as a tap-zoom candidate.
    const tapStyle = { touchAction: 'manipulation' as const, WebkitTapHighlightColor: 'transparent' };
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose} style={tapStyle}>
            <div
                className="bg-telegram-surface border border-telegram-border rounded-xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
                onClick={e => e.stopPropagation()}
                style={tapStyle}
            >
                <div className="p-4 border-b border-telegram-border flex justify-between items-center">
                    <h3 className="text-telegram-text font-medium">Move to Folder</h3>
                    <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text p-1" aria-label="Close"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {activeFolderId !== null && (
                        <button
                            type="button"
                            onClick={() => onSelect(null)}
                            style={tapStyle}
                            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-telegram-text hover:bg-telegram-hover active:bg-telegram-hover transition-colors"
                        >
                            <div className="w-8 h-8 rounded bg-telegram-primary/20 flex items-center justify-center text-telegram-primary shrink-0">
                                <HardDrive className="w-4 h-4" />
                            </div>
                            <span className="font-medium truncate">Saved Messages</span>
                        </button>
                    )}

                    {folders.map((f: any) => {
                        if (f.id === activeFolderId) return null;
                        return (
                            <button
                                type="button"
                                key={f.id}
                                onClick={() => onSelect(f.id)}
                                style={tapStyle}
                                className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-telegram-text hover:bg-telegram-hover active:bg-telegram-hover transition-colors"
                            >
                                <div className="w-8 h-8 rounded bg-telegram-hover flex items-center justify-center text-telegram-text shrink-0">
                                    <Folder className="w-4 h-4" />
                                </div>
                                <span className="font-medium truncate">{f.name}</span>
                            </button>
                        )
                    })}

                    {folders.length === 0 && activeFolderId === null && (
                        <div className="p-4 text-center text-xs text-telegram-subtext">No other folders available. Create one first!</div>
                    )}
                </div>
            </div>
        </div>
    )
}
