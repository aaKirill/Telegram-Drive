import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Lock, AlertTriangle, X } from 'lucide-react';
import { useAppSettings } from '../../hooks/useAppSettings';

export type LockModalMode = 'set' | 'unlock' | 'remove';

const KILLSWITCH_THRESHOLD = 10;
const WARN_AT_REMAINING = 3;

interface FolderLockModalProps {
    mode: LockModalMode;
    folderName: string;
    onClose: () => void;
    /** Returns true on success (correct password / set complete), false on bad password. Throws on backend error. */
    onSubmit: (password: string) => Promise<boolean>;
    /** Folder id this modal is acting on. Required to surface the killswitch
     *  warning ("X attempts left before this folder is deleted"). */
    folderId?: number | null;
}

const TITLES: Record<LockModalMode, string> = {
    set: 'Set folder password',
    unlock: 'Unlock folder',
    remove: 'Remove folder password',
};

const SUBMITS: Record<LockModalMode, string> = {
    set: 'Lock folder',
    unlock: 'Unlock',
    remove: 'Remove lock',
};

export function FolderLockModal({ mode, folderName, onClose, onSubmit, folderId }: FolderLockModalProps) {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const { settings } = useAppSettings();

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // On open, if killswitch is armed and this folder is already mid-streak,
    // surface the warning before the user even tries again.
    useEffect(() => {
        if (mode === 'set') return;
        if (!settings.killswitchEnabled) return;
        if (folderId === undefined) return;
        (async () => {
            try {
                const attempts = await invoke<number>('cmd_get_lock_attempts', { folderId });
                const remaining = KILLSWITCH_THRESHOLD - attempts;
                if (remaining > 0 && remaining <= WARN_AT_REMAINING) {
                    setWarning(`Killswitch armed: ${remaining} attempt${remaining === 1 ? '' : 's'} left before this folder is deleted.`);
                }
            } catch {}
        })();
    }, [mode, settings.killswitchEnabled, folderId]);

    const submit = async () => {
        setError(null);
        if (!password) {
            setError('Password is required');
            return;
        }
        if (mode === 'set' && password !== confirm) {
            setError('Passwords do not match');
            return;
        }
        setBusy(true);
        try {
            const ok = await onSubmit(password);
            if (ok) {
                onClose();
            } else {
                setError('Incorrect password');
                setPassword('');
                // Refresh the killswitch warning post-attempt.
                if (mode !== 'set' && settings.killswitchEnabled && folderId !== undefined) {
                    try {
                        const attempts = await invoke<number>('cmd_get_lock_attempts', { folderId });
                        const remaining = KILLSWITCH_THRESHOLD - attempts;
                        if (remaining > 0 && remaining <= WARN_AT_REMAINING) {
                            setWarning(`Killswitch armed: ${remaining} attempt${remaining === 1 ? '' : 's'} left before this folder is deleted.`);
                        }
                    } catch {}
                }
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[300] bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-telegram-surface rounded-xl border border-telegram-border w-full max-w-sm p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
                <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Lock className="w-5 h-5 text-telegram-primary" />
                        <h2 className="text-base font-semibold text-telegram-text">{TITLES[mode]}</h2>
                    </div>
                    <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <p className="text-xs text-telegram-subtext mb-4 truncate">Folder: {folderName}</p>

                <input
                    ref={inputRef}
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !busy && submit()}
                    placeholder={mode === 'set' ? 'New password' : 'Password'}
                    className="w-full bg-white/10 rounded px-3 py-2 text-sm text-telegram-text focus:outline-none focus:ring-1 focus:ring-telegram-primary mb-2"
                />
                {mode === 'set' && (
                    <input
                        type="password"
                        value={confirm}
                        onChange={e => setConfirm(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !busy && submit()}
                        placeholder="Confirm password"
                        className="w-full bg-white/10 rounded px-3 py-2 text-sm text-telegram-text focus:outline-none focus:ring-1 focus:ring-telegram-primary mb-2"
                    />
                )}

                {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
                {warning && (
                    <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mb-2">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{warning}</span>
                    </div>
                )}

                {mode === 'set' && (
                    <p className="text-[11px] text-telegram-subtext mb-3 leading-snug">
                        Local UX lock only. Your data still lives on Telegram and is not encrypted by this app.
                    </p>
                )}

                <div className="flex gap-2 justify-end">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs rounded bg-white/5 hover:bg-white/10 text-telegram-text disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs rounded bg-telegram-primary hover:bg-telegram-primary/80 text-white disabled:opacity-50"
                    >
                        {busy ? '...' : SUBMITS[mode]}
                    </button>
                </div>
            </div>
        </div>
    );
}
