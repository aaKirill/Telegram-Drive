import { useCallback, useEffect, useReducer } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import { useAppSettings } from './useAppSettings';

interface UpdateState {
    checking: boolean;
    available: boolean;
    downloading: boolean;
    progress: number;
    error: string | null;
    version: string | null;
    lastCheckedAt: number | null;
    notFound: boolean;
}

// Module-level shared state. Same pattern as useAppSettings/useFolderPrefs:
// the manual "Check for updates" button in Settings has to drive the same
// banner that App renders, but each useState() callsite owns its own copy
// of state — so a per-instance hook would split the two consumers.
let _state: UpdateState = {
    checking: false,
    available: false,
    downloading: false,
    progress: 0,
    error: null,
    version: null,
    lastCheckedAt: null,
    notFound: false,
};
let _update: Update | null = null;
const subscribers = new Set<() => void>();
const setState = (patch: Partial<UpdateState>) => {
    _state = { ..._state, ...patch };
    subscribers.forEach(fn => fn());
};

async function checkForUpdates(): Promise<void> {
    setState({ checking: true, error: null, notFound: false });
    try {
        const updateInfo = await check();
        if (updateInfo) {
            _update = updateInfo;
            setState({ checking: false, available: true, version: updateInfo.version, lastCheckedAt: Date.now() });
        } else {
            _update = null;
            setState({ checking: false, available: false, version: null, notFound: true, lastCheckedAt: Date.now() });
        }
    } catch (err: unknown) {
        setState({ checking: false, error: stringifyErr(err), lastCheckedAt: Date.now() });
    }
}

function stringifyErr(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const anyErr = err as { message?: unknown };
        if (typeof anyErr.message === 'string') return anyErr.message;
        try { return JSON.stringify(err); } catch { /* fall through */ }
    }
    return 'Failed to check for updates';
}

async function downloadAndInstall(): Promise<void> {
    if (!_update) return;
    setState({ downloading: true, progress: 0 });
    let downloaded = 0;
    let contentLength = 0;
    try {
        await _update.downloadAndInstall((event) => {
            if (event.event === 'Started') {
                const data = event.data as { contentLength?: number };
                contentLength = data.contentLength || 0;
            } else if (event.event === 'Progress') {
                const data = event.data as { chunkLength?: number };
                downloaded += data.chunkLength || 0;
                if (contentLength > 0) {
                    const pct = Math.round((downloaded / contentLength) * 100);
                    setState({ progress: Math.min(pct, 100) });
                }
            }
        });
    } catch (err: unknown) {
        const msg = stringifyErr(err);
        setState({ downloading: false, error: msg });
        toast.error(`Update failed: ${msg}`, { duration: 10000 });
        console.error("[updater] downloadAndInstall failed:", err);
        return;
    }

    // Install succeeded. Try to auto-relaunch into the new bundle. If
    // relaunch fails (e.g. capability misconfigured, OS rejected the
    // spawn) the user is otherwise stranded on the old version with no
    // clue the install worked — the toast is the fallback.
    try {
        await relaunch();
    } catch (err: unknown) {
        const msg = stringifyErr(err);
        console.error("[updater] relaunch failed:", err);
        setState({ downloading: false });
        toast.success(
            `Update installed. Please quit and reopen the app to apply.\n(Auto-restart failed: ${msg})`,
            { duration: 30000 },
        );
    }
}

function dismissUpdate(): void {
    _update = null;
    setState({ available: false });
}

export function useUpdateCheck() {
    const [, force] = useReducer((n: number) => n + 1, 0);
    const { settings, loaded: settingsLoaded } = useAppSettings();

    useEffect(() => {
        subscribers.add(force);
        return () => { subscribers.delete(force); };
    }, []);

    useEffect(() => {
        if (!settingsLoaded || !settings.updateCheckEnabled) return;
        if (_state.lastCheckedAt !== null) return;
        const timer = setTimeout(() => { checkForUpdates(); }, 5000);
        return () => clearTimeout(timer);
    }, [settingsLoaded, settings.updateCheckEnabled]);

    const stable = useCallback(checkForUpdates, []);
    const stableInstall = useCallback(downloadAndInstall, []);
    const stableDismiss = useCallback(dismissUpdate, []);

    return {
        ..._state,
        checkForUpdates: stable,
        downloadAndInstall: stableInstall,
        dismissUpdate: stableDismiss,
    };
}
