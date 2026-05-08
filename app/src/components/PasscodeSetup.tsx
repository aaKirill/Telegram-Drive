import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck } from "lucide-react";

interface PasscodeSetupProps {
    /** Called after the passcode has been set and the session re-sealed. */
    onSet: () => void;
}

/**
 * One-time mandatory screen shown after the user has a valid logged-in
 * session but no passcode is configured yet. Captures the passcode +
 * confirmation, calls cmd_passcode_set on the backend (which seals the
 * session under the new key) and then hands control back to the parent.
 *
 * No "skip" button — this is required per the user's spec.
 */
export function PasscodeSetup({ onSet }: PasscodeSetupProps) {
    const [passcode, setPasscode] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        if (passcode.length < 4) {
            setError("Passcode must be at least 4 characters");
            return;
        }
        if (passcode !== confirm) {
            setError("Passcodes do not match");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await invoke("cmd_passcode_set", { passcode });
            onSet();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="h-full w-full flex items-center justify-center bg-gradient-to-br from-blue-700 to-blue-900 p-6">
            <div className="bg-[#1c1c1c] border border-white/10 rounded-2xl shadow-2xl p-10 w-full max-w-md">
                <div className="flex flex-col items-center text-center mb-8">
                    <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center mb-4">
                        <ShieldCheck className="w-7 h-7 text-blue-400" />
                    </div>
                    <h1 className="text-xl font-bold text-white">Create a Local Passcode</h1>
                    <p className="text-sm text-gray-400 mt-2 leading-relaxed">
                        This protects your Telegram session at rest on this device.
                        It is separate from your Telegram cloud password.
                        <br />
                        <span className="text-amber-300/90 text-xs">
                            If you forget it, you'll have to log in again from scratch.
                        </span>
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3">
                    <input
                        ref={inputRef}
                        type="password"
                        value={passcode}
                        onChange={(e) => setPasscode(e.target.value)}
                        placeholder="Passcode (min 4 characters)"
                        disabled={busy}
                        autoComplete="new-password"
                        className="w-full px-4 py-3 bg-black/40 border border-white/10 rounded-lg text-white text-base font-mono tracking-widest focus:outline-none focus:border-blue-400 placeholder:text-gray-500 disabled:opacity-50"
                    />
                    <input
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="Confirm passcode"
                        disabled={busy}
                        autoComplete="new-password"
                        className="w-full px-4 py-3 bg-black/40 border border-white/10 rounded-lg text-white text-base font-mono tracking-widest focus:outline-none focus:border-blue-400 placeholder:text-gray-500 disabled:opacity-50"
                    />
                    {error && (
                        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                            {error}
                        </div>
                    )}
                    <button
                        type="submit"
                        disabled={busy || !passcode || !confirm}
                        className="w-full py-3 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold transition-colors"
                    >
                        {busy ? "Saving..." : "Set passcode"}
                    </button>
                </form>
            </div>
        </div>
    );
}
