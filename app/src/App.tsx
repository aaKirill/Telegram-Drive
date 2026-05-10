import { useEffect, useState } from "react";
import { invoke } from "./lib/transport";
import { Store } from "@tauri-apps/plugin-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthWizard } from "./components/AuthWizard";
import { Dashboard } from "./components/Dashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateBanner } from "./components/UpdateBanner";
import { LockScreen } from "./components/LockScreen";
import { PasscodeSetup } from "./components/PasscodeSetup";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useAppSettings } from "./hooks/useAppSettings";
import "./App.css";

import { Toaster } from "sonner";
import { ConfirmProvider } from "./context/ConfirmContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { DropZoneProvider } from "./contexts/DropZoneContext";

const queryClient = new QueryClient();

type PasscodeStatus = "disabled" | "locked" | "unlocked";
type AuthState =
    | "checking"
    | "locked"               // passcode set, app needs unlock before anything else
    | "passcode_setup"        // logged into Telegram, must create local passcode before Dashboard
    | "authenticated"
    | "unauthenticated";

// Module-scoped promise: dedupes the bootstrap across React.StrictMode's
// dev-only mount/unmount/remount cycle. A boolean flag isn't enough — the
// first mount's cleanup cancels its own setState, but the second mount
// would see a "started" flag and never receive the result. Sharing one
// promise lets both mounts await the same work; whichever is still mounted
// when it resolves does the state update.
let bootstrapPromise: Promise<AuthState> | null = null;

function startBootstrap(): Promise<AuthState> {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async (): Promise<AuthState> => {
        try {
            const passStatus = await invoke<PasscodeStatus>("cmd_passcode_status");
            if (passStatus === "locked") return "locked";
            const ok = await pingTelegramSession();
            if (!ok) return "unauthenticated";
            return passStatus === "disabled" ? "passcode_setup" : "authenticated";
        } catch {
            return "unauthenticated";
        }
    })();
    return bootstrapPromise;
}

/**
 * Resolve the saved api_id from disk (preferring config.json, falling back
 * to the legacy settings.json), then ping Telegram via cmd_check_connection
 * and report whether the session is alive.
 *
 * Used at two points in the app's lifecycle:
 *   1. Cold start, after passcode unlock (or when no passcode is set), to
 *      decide between Dashboard and AuthWizard.
 *   2. Right after passcode setup completes (the session was alive when we
 *      initialised it pre-setup, so we just need to flip authState).
 */
async function pingTelegramSession(): Promise<boolean> {
    let store = await Store.load("config.json");
    let apiIdStr = await store.get<string>("api_id");
    if (!apiIdStr) {
        store = await Store.load("settings.json");
        apiIdStr = await store.get<string>("api_id");
    }
    if (!apiIdStr) return false;
    const apiId = parseInt(apiIdStr as string, 10);
    if (Number.isNaN(apiId)) return false;
    await invoke("cmd_connect", { apiId });
    return await invoke<boolean>("cmd_check_connection");
}

function AppContent() {
    // null-equivalent "checking" state ensures we never show AuthWizard before
    // we've had a chance to validate a saved session — without this the wizard
    // re-asks for the phone number on every cold start, and submitting it
    // burns an auth.sendCode RPC that hits a stiff per-phone FLOOD_WAIT
    // (Telegram caches it for 16h+).
    const [authState, setAuthState] = useState<AuthState>("checking");
    const { theme } = useTheme();
    const { available, version, downloading, progress, downloadAndInstall, dismissUpdate } = useUpdateCheck();
    const { settings: appSettings, loaded: appSettingsLoaded } = useAppSettings();

    // Idle auto-lock. Only armed when a passcode is configured AND the user
    // is currently past the lock gate (i.e. authenticated or in passcode-setup
    // — but in passcode-setup the timer is moot because the session is fresh).
    useEffect(() => {
        if (!appSettingsLoaded) return;
        if (authState !== "authenticated") return;
        const minutes = appSettings.autoLockMinutes;
        if (!minutes || minutes <= 0) return;
        const timeoutMs = minutes * 60 * 1000;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    await invoke("cmd_passcode_lock");
                } catch {
                    // best-effort
                }
                // Bounce back to LockScreen via a clean reload so all in-memory
                // state (open queries, drag handles, etc.) is reset.
                window.location.reload();
            }, timeoutMs);
        };
        const events = ["mousemove", "keydown", "mousedown", "touchstart", "wheel"];
        events.forEach(ev => window.addEventListener(ev, arm, { passive: true }));
        arm();
        return () => {
            events.forEach(ev => window.removeEventListener(ev, arm));
            if (timer) clearTimeout(timer);
        };
    }, [appSettingsLoaded, appSettings.autoLockMinutes, authState]);

    useEffect(() => {
        let cancelled = false;
        startBootstrap().then((s) => {
            if (!cancelled) setAuthState(s);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Pull cross-device snapshot once we know the user is authenticated.
    // Failure is silent — sync is best-effort and shouldn't block the UI.
    // Pulls on focus / visibilitychange and again every 5 minutes as a
    // backstop, since the Tauri webview occasionally swallows focus
    // events and a user who never tabs away would otherwise never see
    // remote changes.
    useEffect(() => {
        if (authState !== "authenticated") return;
        let cancelled = false;
        const pull = () => {
            if (cancelled) return;
            import("./lib/sync").then((m) => m.runSync()).catch(() => { });
        };
        pull();
        const onFocus = () => pull();
        const onVisible = () => { if (!document.hidden) pull(); };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);
        const poll = setInterval(pull, 5 * 60 * 1000);
        return () => {
            cancelled = true;
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisible);
            clearInterval(poll);
        };
    }, [authState]);

    /** Called by LockScreen on successful passcode entry. The session bytes
     *  are already on disk; we just need to ping Telegram to confirm and
     *  then route to Dashboard or AuthWizard. */
    const handleUnlocked = async () => {
        setAuthState("checking");
        try {
            const ok = await pingTelegramSession();
            setAuthState(ok ? "authenticated" : "unauthenticated");
        } catch {
            setAuthState("unauthenticated");
        }
    };

    /** Called by AuthWizard on successful login. Telegram session is now
     *  fresh on disk. If a passcode was already configured (e.g. the
     *  user came through LockScreen → unlock-succeeded → ping-failed
     *  → AuthWizard), we MUST NOT route to PasscodeSetup — it would
     *  call cmd_passcode_set and the backend correctly rejects
     *  overwriting an existing passcode.json with "Passcode already
     *  set". The existing passcode just continues to apply to the
     *  fresh session; it'll be sealed on app exit by the same exit
     *  handler that always runs. */
    const handleLoggedIn = async () => {
        try {
            const status = await invoke<PasscodeStatus>("cmd_passcode_status");
            if (status === "disabled") {
                setAuthState("passcode_setup");
            } else {
                setAuthState("authenticated");
            }
        } catch {
            setAuthState("passcode_setup");
        }
    };

    /** Called by PasscodeSetup once cmd_passcode_set has succeeded. */
    const handlePasscodeSet = () => {
        setAuthState("authenticated");
    };

    return (
        <main className="h-screen w-screen text-telegram-text overflow-hidden selection:bg-telegram-primary/30 relative">
            <UpdateBanner
                available={available}
                version={version}
                downloading={downloading}
                progress={progress}
                onUpdate={downloadAndInstall}
                onDismiss={dismissUpdate}
            />
            {/* Top-center keeps toasts away from the bottom-right
                TransferQueue panel and the mobile bulk-action bar. */}
            <Toaster theme={theme} position="top-center" offset={16} />
            {authState === "checking" ? (
                <div className="h-full w-full flex items-center justify-center">
                    <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin" />
                </div>
            ) : authState === "locked" ? (
                <LockScreen
                    onUnlocked={handleUnlocked}
                    onReset={() => setAuthState("unauthenticated")}
                />
            ) : authState === "passcode_setup" ? (
                <PasscodeSetup onSet={handlePasscodeSet} />
            ) : authState === "authenticated" ? (
                <Dashboard onLogout={() => setAuthState("unauthenticated")} />
            ) : (
                <AuthWizard onLogin={handleLoggedIn} />
            )}
        </main>
    );
}


function App() {
    return (
        <ErrorBoundary>
            <ThemeProvider>
                <QueryClientProvider client={queryClient}>
                    <ConfirmProvider>
                        <DropZoneProvider>
                            <AppContent />
                        </DropZoneProvider>
                    </ConfirmProvider>
                </QueryClientProvider>
            </ThemeProvider>
        </ErrorBoundary>
    );
}

export default App;
