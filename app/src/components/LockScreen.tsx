import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { Lock } from "lucide-react";
import { useConfirm } from "../context/ConfirmContext";
import { useAppSettings } from "../hooks/useAppSettings";

const KILLSWITCH_THRESHOLD = 10;

/** Wipes every [TD] folder/channel the app knows about, then resets the local
 *  passcode + session and clears every client-side store. Triggered by the
 *  killswitch when a user exceeds 10 wrong app-passcode attempts. There is
 *  no Telegram-side recovery — channels are deleted server-side too. */
async function killswitchWipeEverything() {
    try {
        const folders = await invoke<{ id: number }[]>("cmd_scan_folders").catch(() => [] as { id: number }[]);
        for (const f of folders) {
            try {
                await invoke("cmd_delete_folder", { folderId: f.id });
            } catch {
                // best-effort — we still want to reset local state even if a
                // single channel delete fails (e.g. network glitch).
            }
        }
    } catch {
        // best-effort
    }
    try {
        await invoke("cmd_passcode_reset");
    } catch {}
    // Drop every client-side persisted store so the reload starts from zero
    // and no tombstoned folder shows up in the sidebar / Settings.
    for (const file of [
        'config.json',
        'settings.json',
        'folder-prefs.json',
        'folder-locks.json',
        'lock-attempts.json',
    ]) {
        try {
            const s = await load(file);
            for (const k of await s.keys()) {
                if (file === 'config.json' || file === 'settings.json') {
                    // Preserve api credentials so the user doesn't have to re-enter them.
                    if (k === 'api_id' || k === 'api_hash') continue;
                }
                await s.delete(k);
            }
            await s.save();
        } catch {}
    }
}

interface LockScreenProps {
    onUnlocked: () => void;
    /** Called after the user confirms the "forgot passcode" reset. The
     *  parent should treat this as a full local wipe — there is no session
     *  on disk anymore — and re-route to the AuthWizard. */
    onReset: () => void;
}

/**
 * Cold-start passcode entry screen. Shown when the on-disk session is
 * encrypted (`passcode.json` exists) and we haven't unlocked it yet this
 * session. On successful unlock, the backend has already decrypted the
 * session bytes back to disk, so the parent can proceed with its normal
 * `cmd_check_connection` bootstrap.
 */
export function LockScreen({ onUnlocked, onReset }: LockScreenProps) {
    const [passcode, setPasscode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const { confirm } = useConfirm();
    const { settings: appSettings } = useAppSettings();

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Surface a warning if the killswitch is armed and we're already mid-streak.
    useEffect(() => {
        if (!appSettings.killswitchEnabled) return;
        invoke<number>("cmd_get_passcode_attempts").then((attempts) => {
            const remaining = KILLSWITCH_THRESHOLD - attempts;
            if (remaining > 0 && remaining <= 3) {
                setWarning(`Killswitch armed: ${remaining} attempt${remaining === 1 ? '' : 's'} left before all folders are deleted.`);
            }
        }).catch(() => {});
    }, [appSettings.killswitchEnabled]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!passcode || busy) return;
        setBusy(true);
        setError(null);
        try {
            await invoke("cmd_passcode_unlock", { passcode });
            setPasscode("");
            onUnlocked();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setPasscode("");
            inputRef.current?.focus();
            // Killswitch: 10+ wrong app-passcode attempts → wipe everything.
            if (appSettings.killswitchEnabled) {
                try {
                    const attempts = await invoke<number>("cmd_get_passcode_attempts");
                    if (attempts >= KILLSWITCH_THRESHOLD) {
                        await killswitchWipeEverything();
                        window.location.reload();
                        return;
                    }
                    const remaining = KILLSWITCH_THRESHOLD - attempts;
                    if (remaining > 0 && remaining <= 3) {
                        setWarning(`Killswitch armed: ${remaining} attempt${remaining === 1 ? '' : 's'} left before all folders are deleted.`);
                    }
                } catch {
                    // ignore — killswitch is best-effort
                }
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="h-full w-full flex items-center justify-center bg-gradient-to-br from-blue-700 to-blue-900">
            <div className="bg-[#1c1c1c] border border-white/10 rounded-2xl shadow-2xl p-10 w-full max-w-md">
                <div className="flex flex-col items-center text-center mb-8">
                    <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center mb-4">
                        <Lock className="w-7 h-7 text-blue-400" />
                    </div>
                    <h1 className="text-xl font-bold text-white">Telegram Drive is Locked</h1>
                    <p className="text-sm text-gray-400 mt-1">Enter your passcode to continue</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <input
                        ref={inputRef}
                        type="password"
                        value={passcode}
                        onChange={(e) => setPasscode(e.target.value)}
                        placeholder="Passcode"
                        disabled={busy}
                        className="w-full px-4 py-3 bg-black/40 border border-white/10 rounded-lg text-white text-base font-mono tracking-widest focus:outline-none focus:border-blue-400 placeholder:text-gray-500 disabled:opacity-50"
                        autoComplete="current-password"
                    />
                    {error && (
                        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                            {error}
                        </div>
                    )}
                    {warning && (
                        <div className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                            {warning}
                        </div>
                    )}
                    <button
                        type="submit"
                        disabled={busy || !passcode}
                        className="w-full py-3 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold transition-colors"
                    >
                        {busy ? "Unlocking..." : "Unlock"}
                    </button>
                </form>

                <div className="mt-6 text-center">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                            const ok = await confirm({
                                title: "Forgot passcode?",
                                message:
                                    "Resetting deletes your encrypted session on this device. " +
                                    "You will need to log in to Telegram again with a verification code, " +
                                    "and Telegram may rate-limit the new login if it has happened recently. Continue?",
                                confirmText: "Reset and re-login",
                                variant: "danger",
                            });
                            if (!ok) return;
                            try {
                                await invoke("cmd_passcode_reset");
                                onReset();
                            } catch (e) {
                                setError(e instanceof Error ? e.message : String(e));
                            }
                        }}
                        className="text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                        Forgot passcode?
                    </button>
                </div>
            </div>
        </div>
    );
}
