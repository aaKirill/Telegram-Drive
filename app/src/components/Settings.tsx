import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { ArrowLeft, FolderOpen, KeyRound, Lock, Unlock, ShieldOff, Trash2, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useAppSettings, AppSettings } from '../hooks/useAppSettings';
import { useFolderPrefs } from '../hooks/useFolderPrefs';
import { useFolderLocks, folderKey } from '../hooks/useFolderLocks';
import { useFolderKillswitch } from '../hooks/useFolderKillswitch';
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import { TelegramFolder, BandwidthStats } from '../types';
import { useConfirm } from '../context/ConfirmContext';
import { formatBytes } from '../utils';
import { FolderLockModal, LockModalMode } from './dashboard/FolderLockModal';

interface SettingsProps {
    onClose: () => void;
    folders: TelegramFolder[];
    bandwidth: BandwidthStats | null;
    locks: ReturnType<typeof useFolderLocks>;
}

interface PendingLockAction {
    folderId: number;
    folderName: string;
    mode: LockModalMode;
}

const AUTO_LOCK_OPTIONS: { value: number | null; label: string }[] = [
    { value: null, label: 'Off' },
    { value: 1, label: '1 minute' },
    { value: 5, label: '5 minutes' },
    { value: 15, label: '15 minutes' },
    { value: 20, label: '20 minutes' },
    { value: 30, label: '30 minutes' },
];

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
    return (
        <section className="border-b border-telegram-border pb-6 mb-6">
            <h2 className="text-base font-semibold text-telegram-text mb-1">{title}</h2>
            {description && <p className="text-xs text-telegram-subtext mb-4">{description}</p>}
            <div className="space-y-3">{children}</div>
        </section>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
                <div className="text-sm text-telegram-text">{label}</div>
                {hint && <div className="text-xs text-telegram-subtext mt-0.5">{hint}</div>}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={() => !disabled && onChange(!checked)}
            disabled={disabled}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-telegram-primary' : 'bg-telegram-border'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
        </button>
    );
}

function Select<T extends string | number | null>({ value, options, onChange }: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <select
            value={value === null ? '__null__' : String(value)}
            onChange={(e) => {
                const raw = e.target.value;
                const found = options.find(o => (o.value === null ? '__null__' : String(o.value)) === raw);
                if (found) onChange(found.value);
            }}
            className="bg-telegram-hover border border-telegram-border rounded px-2 py-1 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50"
        >
            {options.map(o => (
                <option key={o.value === null ? '__null__' : String(o.value)} value={o.value === null ? '__null__' : String(o.value)}>{o.label}</option>
            ))}
        </select>
    );
}

type PasscodeStatus = 'disabled' | 'locked' | 'unlocked';

export function Settings({ onClose, folders, bandwidth, locks }: SettingsProps) {
    const { settings, loaded, update } = useAppSettings();
    const { get: getFolderPref, update: updateFolderPref } = useFolderPrefs();
    const { confirm } = useConfirm();
    const [passStatus, setPassStatus] = useState<PasscodeStatus>('unlocked');
    const [changing, setChanging] = useState(false);
    const [oldPass, setOldPass] = useState('');
    const [newPass, setNewPass] = useState('');
    const [removing, setRemoving] = useState(false);
    const [removePass, setRemovePass] = useState('');
    const [pendingLock, setPendingLock] = useState<PendingLockAction | null>(null);
    const killswitch = useFolderKillswitch();
    const updater = useUpdateCheck();
    const [appVersion, setAppVersion] = useState<string>('');

    const folderHasPassword = (folderId: number) => locks.allLockedKeys.has(folderKey(folderId));

    const onModalSubmit = async (password: string): Promise<boolean> => {
        if (!pendingLock) return false;
        switch (pendingLock.mode) {
            case 'set':
                await locks.setPassword(pendingLock.folderId, password);
                toast.success(`Password set on "${pendingLock.folderName}".`);
                return true;
            case 'remove': {
                const ok = await locks.removeLock(pendingLock.folderId, password);
                if (ok) toast.success(`Password removed from "${pendingLock.folderName}".`);
                else await killswitch.check(pendingLock.folderId);
                return ok;
            }
            case 'unlock': {
                const ok = await locks.unlock(pendingLock.folderId, password);
                if (!ok) await killswitch.check(pendingLock.folderId);
                return ok;
            }
        }
    };

    useEffect(() => {
        invoke<PasscodeStatus>('cmd_passcode_status').then(setPassStatus).catch(() => {});
        getVersion().then(setAppVersion).catch(() => {});
    }, []);

    const set = <K extends keyof AppSettings>(key: K) => (v: AppSettings[K]) => update(key, v);

    const pickDownloadPath = async () => {
        const result = await open({ directory: true, multiple: false });
        if (typeof result === 'string') {
            await update('downloadPath', result);
            toast.success('Default download folder set.');
        }
    };

    const clearDownloadPath = async () => {
        await update('downloadPath', null);
    };

    const clearCache = async () => {
        if (!await confirm({
            title: 'Clear cache',
            message: 'Delete all cached thumbnails and previews? They will be re-downloaded on demand.',
            confirmText: 'Clear',
            variant: 'info',
        })) return;
        try {
            await invoke('cmd_clean_cache');
            toast.success('Cache cleared.');
        } catch (e) {
            toast.error('Failed to clear cache: ' + e);
        }
    };

    const lockNow = async () => {
        try {
            await invoke('cmd_passcode_lock');
            // The App's bootstrap state machine will route to LockScreen on next render
            // because cmd_passcode_status will return 'locked'. We close this view too.
            onClose();
            window.location.reload();
        } catch (e) {
            toast.error('Failed to lock: ' + e);
        }
    };

    const submitPasscodeChange = async () => {
        if (!oldPass || newPass.length < 4) {
            toast.error('New passcode must be at least 4 characters.');
            return;
        }
        try {
            await invoke('cmd_passcode_change', { oldPasscode: oldPass, newPasscode: newPass });
            toast.success('Passcode changed.');
            setOldPass(''); setNewPass(''); setChanging(false);
        } catch (e) {
            toast.error(String(e));
        }
    };

    const submitPasscodeRemove = async () => {
        if (!removePass) return;
        try {
            await invoke('cmd_passcode_remove', { passcode: removePass });
            toast.success('Passcode removed.');
            setRemovePass(''); setRemoving(false);
            setPassStatus('disabled');
        } catch (e) {
            toast.error(String(e));
        }
    };

    if (!loaded) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <div className="w-8 h-8 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    const visibleFolders = folders;
    const lifetimeDown = bandwidth?.down_bytes ?? 0;
    const lifetimeUp = bandwidth?.up_bytes ?? 0;

    return (
        <div className="h-full w-full overflow-y-auto bg-telegram-bg">
            <header className="sticky top-0 z-10 bg-telegram-surface/95 backdrop-blur-md border-b border-telegram-border px-6 py-3 flex items-center gap-3">
                <button onClick={onClose} className="p-1.5 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition" title="Back">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-lg font-semibold text-telegram-text">Settings</h1>
            </header>

            <div className="max-w-2xl mx-auto px-6 py-6">

                <Section title="Security" description="Local passcode protects your encrypted Telegram session.">
                    <Row label="Status" hint={passStatus === 'disabled' ? 'No passcode set on this device.' : passStatus === 'locked' ? 'Locked.' : 'Unlocked this session.'}>
                        <span className={`text-xs px-2 py-1 rounded ${passStatus === 'disabled' ? 'bg-telegram-hover text-telegram-subtext' : 'bg-telegram-primary/15 text-telegram-primary'}`}>
                            {passStatus.toUpperCase()}
                        </span>
                    </Row>
                    {passStatus !== 'disabled' && (
                        <>
                            <Row label="Auto-lock when idle" hint="Re-lock the app after a period of inactivity.">
                                <Select
                                    value={settings.autoLockMinutes}
                                    options={AUTO_LOCK_OPTIONS}
                                    onChange={set('autoLockMinutes')}
                                />
                            </Row>
                            <Row label="Lock now" hint="Reload the app and require passcode to continue.">
                                <button onClick={lockNow} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border text-xs rounded-md transition flex items-center gap-1.5">
                                    <Lock className="w-3.5 h-3.5" /> Lock now
                                </button>
                            </Row>
                            {!changing ? (
                                <Row label="Change passcode">
                                    <button onClick={() => setChanging(true)} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border text-xs rounded-md transition flex items-center gap-1.5">
                                        <KeyRound className="w-3.5 h-3.5" /> Change…
                                    </button>
                                </Row>
                            ) : (
                                <div className="space-y-2 p-3 bg-telegram-hover rounded-md">
                                    <input type="password" autoFocus value={oldPass} onChange={e => setOldPass(e.target.value)} placeholder="Current passcode" className="w-full bg-telegram-surface rounded px-2 py-1 text-sm" />
                                    <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="New passcode (min 4 chars)" className="w-full bg-telegram-surface rounded px-2 py-1 text-sm" />
                                    <div className="flex gap-2 justify-end">
                                        <button onClick={() => { setChanging(false); setOldPass(''); setNewPass(''); }} className="px-3 py-1 text-xs text-telegram-subtext hover:text-telegram-text">Cancel</button>
                                        <button onClick={submitPasscodeChange} className="px-3 py-1 text-xs bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary rounded">Apply</button>
                                    </div>
                                </div>
                            )}
                            {!removing ? (
                                <Row label="Disable passcode" hint="Removes the passcode and decrypts the session at rest.">
                                    <button onClick={() => setRemoving(true)} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs rounded-md transition flex items-center gap-1.5">
                                        <ShieldOff className="w-3.5 h-3.5" /> Disable…
                                    </button>
                                </Row>
                            ) : (
                                <div className="space-y-2 p-3 bg-red-500/5 border border-red-500/20 rounded-md">
                                    <div className="text-xs text-red-400">This decrypts your session on disk.</div>
                                    <input type="password" autoFocus value={removePass} onChange={e => setRemovePass(e.target.value)} placeholder="Confirm with current passcode" className="w-full bg-telegram-surface rounded px-2 py-1 text-sm" />
                                    <div className="flex gap-2 justify-end">
                                        <button onClick={() => { setRemoving(false); setRemovePass(''); }} className="px-3 py-1 text-xs text-telegram-subtext hover:text-telegram-text">Cancel</button>
                                        <button onClick={submitPasscodeRemove} className="px-3 py-1 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded">Disable</button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </Section>

                <Section title="Appearance">
                    <Row label="Default view">
                        <Select
                            value={settings.defaultView}
                            options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
                            onChange={set('defaultView')}
                        />
                    </Row>
                    <Row label="Default sort field">
                        <Select
                            value={settings.defaultSortField}
                            options={[{ value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }, { value: 'date', label: 'Date' }]}
                            onChange={set('defaultSortField')}
                        />
                    </Row>
                    <Row label="Default sort direction">
                        <Select
                            value={settings.defaultSortDir}
                            options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]}
                            onChange={set('defaultSortDir')}
                        />
                    </Row>
                </Section>

                <Section title="Thumbnails" description="Hide previews/thumbnails on file cards. Filenames remain visible.">
                    <Row label="Hide thumbnails everywhere" hint="Overrides per-folder settings.">
                        <Toggle checked={settings.hideThumbnailsGlobal} onChange={set('hideThumbnailsGlobal')} />
                    </Row>
                    <Row label="Hide for newly created folders" hint="Default for any folder you create from now on.">
                        <Toggle checked={settings.hideThumbnailsForNewFolders} onChange={set('hideThumbnailsForNewFolders')} />
                    </Row>
                    <div className="pt-2">
                        <div className="text-xs text-telegram-subtext mb-1">Per-folder overrides</div>
                        <div className="rounded-md border border-telegram-border divide-y divide-telegram-border max-h-56 overflow-y-auto">
                            {visibleFolders.length === 0 && (
                                <div className="px-3 py-3 text-xs text-telegram-subtext">No folders yet.</div>
                            )}
                            {visibleFolders.map(f => {
                                const pref = getFolderPref(f.id);
                                return (
                                    <div key={f.id} className="flex items-center justify-between px-3 py-2">
                                        <span className="text-sm text-telegram-text truncate">{f.name}</span>
                                        <Toggle
                                            checked={!!pref.hideThumbnails}
                                            onChange={(v) => updateFolderPref(f.id, { hideThumbnails: v })}
                                            disabled={settings.hideThumbnailsGlobal}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </Section>

                <Section
                    title="Hidden folders"
                    description="Hidden folders disappear from the sidebar entirely. To open one, type its EXACT name into the search bar — partial or fuzzy matches will not surface it. Use the key icon to set or remove a folder password without un-hiding."
                >
                    <div className="rounded-md border border-telegram-border divide-y divide-telegram-border max-h-56 overflow-y-auto">
                        {visibleFolders.length === 0 && (
                            <div className="px-3 py-3 text-xs text-telegram-subtext">No folders yet.</div>
                        )}
                        {visibleFolders.map(f => {
                            const pref = getFolderPref(f.id);
                            const locked = folderHasPassword(f.id);
                            return (
                                <div key={f.id} className="flex items-center justify-between px-3 py-2 gap-3">
                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                        {pref.hidden ? <EyeOff className="w-3.5 h-3.5 text-telegram-subtext shrink-0" /> : <Eye className="w-3.5 h-3.5 text-telegram-subtext shrink-0" />}
                                        <span className="text-sm text-telegram-text truncate">{f.name}</span>
                                    </div>
                                    <button
                                        onClick={() => setPendingLock({ folderId: f.id, folderName: f.name, mode: locked ? 'remove' : 'set' })}
                                        className={`p-1.5 rounded-md transition ${locked ? 'text-telegram-primary hover:bg-telegram-primary/10' : 'text-telegram-subtext hover:bg-telegram-hover hover:text-telegram-text'}`}
                                        title={locked ? 'Remove password' : 'Set password'}
                                    >
                                        {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                                    </button>
                                    <Toggle
                                        checked={!!pref.hidden}
                                        onChange={(v) => updateFolderPref(f.id, { hidden: v })}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </Section>

                <Section title="Downloads">
                    <Row label="Default download folder" hint={settings.downloadPath || 'Asks you each time.'}>
                        <div className="flex gap-2">
                            <button onClick={pickDownloadPath} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border text-xs rounded-md transition flex items-center gap-1.5">
                                <FolderOpen className="w-3.5 h-3.5" /> Pick…
                            </button>
                            {settings.downloadPath && (
                                <button onClick={clearDownloadPath} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border text-xs rounded-md transition">
                                    Clear
                                </button>
                            )}
                        </div>
                    </Row>
                </Section>

                <Section title="Updates">
                    <Row label="Check for updates on startup" hint="Polls the GitHub releases endpoint 5 seconds after launch.">
                        <Toggle checked={settings.updateCheckEnabled} onChange={set('updateCheckEnabled')} />
                    </Row>
                    <Row
                        label="Check now"
                        hint={
                            updater.error
                                ? `Last check failed: ${updater.error}`
                                : updater.available
                                    ? `Update available: v${updater.version}`
                                    : updater.notFound
                                        ? `You're up to date${appVersion ? ` (v${appVersion})` : ''}.`
                                        : 'Manually query GitHub for a newer release.'
                        }
                    >
                        <button
                            type="button"
                            onClick={() => updater.checkForUpdates()}
                            disabled={updater.checking || updater.downloading}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-telegram-hover hover:bg-telegram-border border border-telegram-border text-telegram-text disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${updater.checking ? 'animate-spin' : ''}`} />
                            {updater.checking ? 'Checking…' : 'Check for updates'}
                        </button>
                    </Row>
                </Section>

                <Section
                    title="Killswitch"
                    description="When enabled, repeated wrong passwords trigger destructive cleanup. Use with caution — deletions hit Telegram itself, not just this device."
                >
                    <Row
                        label="Enable killswitch"
                        hint="Folder password: 10 wrong attempts deletes that folder (channel + all messages). App passcode: 10 wrong attempts deletes EVERY [TD] folder and resets the local session."
                    >
                        <Toggle checked={settings.killswitchEnabled} onChange={set('killswitchEnabled')} />
                    </Row>
                </Section>

                <Section title="Storage">
                    <Row label="Lifetime downloaded">
                        <span className="text-sm text-telegram-subtext">{formatBytes(lifetimeDown)}</span>
                    </Row>
                    <Row label="Lifetime uploaded">
                        <span className="text-sm text-telegram-subtext">{formatBytes(lifetimeUp)}</span>
                    </Row>
                    <Row label="Clear thumbnail / preview cache">
                        <button onClick={clearCache} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs rounded-md transition flex items-center gap-1.5">
                            <Trash2 className="w-3.5 h-3.5" /> Clear cache
                        </button>
                    </Row>
                </Section>

                <div className="text-center text-xs text-telegram-subtext py-4">
                    Telegram Drive{appVersion ? ` v${appVersion}` : ''}
                </div>
            </div>

            {pendingLock && (
                <FolderLockModal
                    mode={pendingLock.mode}
                    folderName={pendingLock.folderName}
                    folderId={pendingLock.folderId}
                    onClose={() => setPendingLock(null)}
                    onSubmit={onModalSubmit}
                />
            )}
        </div>
    );
}
