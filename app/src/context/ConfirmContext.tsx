import { createContext, useContext, useState, ReactNode } from 'react';

interface ConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'info';
}

interface ConfirmContextType {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType | undefined>(undefined);

export function ConfirmProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [options, setOptions] = useState<ConfirmOptions>({ title: '', message: '' });
    const [resolveRef, setResolveRef] = useState<((value: boolean) => void) | null>(null);

    const confirm = (opts: ConfirmOptions) => {
        setOptions(opts);
        setIsOpen(true);
        return new Promise<boolean>((resolve) => {
            setResolveRef(() => resolve);
        });
    };

    const handleConfirm = () => {
        setIsOpen(false);
        if (resolveRef) resolveRef(true);
    };

    const handleCancel = () => {
        setIsOpen(false);
        if (resolveRef) resolveRef(false);
    };

    // iOS Safari needs `touch-action: manipulation` + an explicit tap
    // highlight reset on dialog buttons; without these, the first tap
    // sometimes registers as a double-tap-to-zoom and the click never
    // makes it to the handler — that was the failure mode making
    // folder-delete unusable on mobile.
    const tapStyle = { touchAction: 'manipulation' as const, WebkitTapHighlightColor: 'transparent' };

    return (
        <ConfirmContext.Provider value={{ confirm }}>
            {children}
            {isOpen && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
                    onClick={handleCancel}
                >
                    <div
                        className="bg-telegram-surface border border-telegram-border rounded-xl p-5 sm:p-6 w-full max-w-sm shadow-2xl animate-in zoom-in-95"
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 className="text-lg font-medium text-telegram-text mb-2">{options.title}</h3>
                        <p className="text-telegram-subtext text-sm mb-6 whitespace-pre-line">{options.message}</p>
                        <div className="flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={handleCancel}
                                style={tapStyle}
                                className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/5 active:bg-white/10 text-telegram-subtext transition"
                            >
                                {options.cancelText || 'Cancel'}
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirm}
                                style={tapStyle}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${options.variant === 'danger' ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 active:bg-red-500/30' : 'bg-telegram-primary text-white hover:bg-telegram-primary/90 active:bg-telegram-primary/80'}`}
                            >
                                {options.confirmText || 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </ConfirmContext.Provider>
    );
}

export const useConfirm = () => {
    const context = useContext(ConfirmContext);
    if (!context) throw new Error('useConfirm must be used within a ConfirmProvider');
    return context;
};
