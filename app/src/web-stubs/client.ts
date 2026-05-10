// gramjs-backed implementation of the cmd_auth_*/cmd_connect/cmd_logout
// surface. Mirrors the Tauri backend's contract so callsites and the
// AuthWizard don't need branches.

import { TelegramClient, Api, password as gramPassword } from "telegram";
import { StringSession } from "telegram/sessions";
import * as passcode from "./passcode";
import { Store } from "./store";
import { clearChannelInputCache } from "./folders";

let client: TelegramClient | null = null;
let creds: { apiId: number; apiHash: string } | null = null;
let pendingPhone = "";
let pendingHash = "";

async function loadCreds(): Promise<{ apiId: number; apiHash: string }> {
  if (creds) return creds;
  const store = await Store.load("config.json");
  const idStr = await store.get<string>("api_id");
  const hash = await store.get<string>("api_hash");
  if (!idStr || !hash) throw new Error("Missing api_id/api_hash");
  const apiId = parseInt(idStr, 10);
  if (Number.isNaN(apiId)) throw new Error("Invalid api_id");
  creds = { apiId, apiHash: hash };
  return creds;
}

async function buildClient(): Promise<TelegramClient> {
  const { apiId, apiHash } = await loadCreds();
  const sessionStr = await passcode.loadSession();
  const session = new StringSession(sessionStr || "");
  const c = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
  });
  return c;
}

// Serialize concurrent first-call ensureClient() invocations. Without this,
// a Dashboard mount that fires useFiles → ensureClient at the same time as
// App.tsx's bootstrap → cmd_check_connection → ensureClient would each
// build a separate TelegramClient, racing the session file and producing
// a hung iter_messages on the loser. The shared connecting Promise means
// every caller awaits the same handshake.
let connecting: Promise<TelegramClient> | null = null;

export async function ensureClient(): Promise<TelegramClient> {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const c = await buildClient();
      await c.connect();
      client = c;
      return c;
    })();
    connecting.finally(() => { connecting = null; });
  }
  return connecting;
}

async function persistSession(): Promise<void> {
  if (!client) return;
  const s = (client.session as StringSession).save();
  await passcode.saveSession(s);
}

export async function connect(apiId: number): Promise<void> {
  // Mirror cmd_connect: only apiId is passed in; pair it with the apiHash
  // already in the Store. AuthWizard's setup step writes both before this
  // call, so the lookup always succeeds.
  const store = await Store.load("config.json");
  const apiHash = await store.get<string>("api_hash");
  if (!apiHash) throw new Error("Missing api_hash");
  // Idempotent on creds match: cmd_connect is called twice on cold start
  // (App.tsx bootstrap + Dashboard's useTelegramConnection mount). The old
  // teardown-and-rebuild path raced any iter_messages the dashboard had
  // already kicked off — they'd be holding a reference to the disconnecting
  // client and hang forever, leaving the file list stuck on "Loading...".
  if (client && creds && creds.apiId === apiId && creds.apiHash === apiHash) return;
  creds = { apiId, apiHash };
  if (client) {
    try { await client.disconnect(); } catch {}
    client = null;
  }
  client = await buildClient();
  await client.connect();
}

export async function checkConnection(): Promise<boolean> {
  try {
    const c = await ensureClient();
    return await c.isUserAuthorized();
  } catch {
    return false;
  }
}

export async function authRequestCode(phone: string): Promise<string> {
  const c = await ensureClient();
  if (await c.isUserAuthorized()) return "already_authorized";
  const { apiId, apiHash } = await loadCreds();
  const r = await c.sendCode({ apiId, apiHash }, phone);
  pendingPhone = phone;
  pendingHash = r.phoneCodeHash;
  return r.phoneCodeHash;
}

export async function authSignIn(code: string): Promise<{ success: boolean; next_step?: string }> {
  const c = await ensureClient();
  try {
    await c.invoke(
      new Api.auth.SignIn({
        phoneNumber: pendingPhone,
        phoneCodeHash: pendingHash,
        phoneCode: code,
      }),
    );
    await persistSession();
    return { success: true };
  } catch (e) {
    const msg = String((e as { errorMessage?: string; message?: string })?.errorMessage ?? (e as Error)?.message ?? e);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      return { success: false, next_step: "password" };
    }
    throw e;
  }
}

export async function authCheckPassword(password: string): Promise<{ success: boolean }> {
  const c = await ensureClient();
  const pwdInfo = await c.invoke(new Api.account.GetPassword());
  const srp = await gramPassword.computeCheck(pwdInfo, password);
  await c.invoke(new Api.auth.CheckPassword({ password: srp }));
  await persistSession();
  return { success: true };
}

// QR-code login. Mirrors the Tauri `cmd_auth_qr_login` / `cmd_auth_qr_poll`
// surface so AuthWizard can use the same code path on both targets.
//
// Two-channel flow, lifted from gramjs's signInUserWithQrCode:
//   1. Telegram pushes UpdateLoginToken to our session the instant the
//      phone calls auth.acceptLoginToken. We listen for it and flip an
//      `acceptedFlag` so the next poll fast-paths.
//   2. Polling falls back on auth.exportLoginToken — same QR stays valid
//      until expiry. If the response is LoginTokenMigrateTo, the user's
//      account lives on a different DC from the one we exported on; we
//      _switchDC and ImportLoginToken to finish the handshake there.
//      Without this, accounts on a different home DC stayed forever on
//      LoginTokenMigrateTo and the poll never advanced.
function bytesToUrlBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

let qrCreds: { apiId: number; apiHash: string } | null = null;
let qrAcceptedFlag = false;
let qrUpdateUnsub: (() => void) | null = null;

function tokenBytesToUrl(t: unknown): string {
    const u8 = t instanceof Uint8Array ? t : new Uint8Array(t as ArrayBuffer);
    return `tg://login?token=${bytesToUrlBase64(u8)}`;
}

function attachQrUpdateListener(c: TelegramClient): void {
    if (qrUpdateUnsub) return;
    // gramjs's catch-all addEventHandler signature accepts a single
    // callback (event arg is optional at runtime) but its TS overloads
    // require both — cast to any to use the catch-all behaviour.
    const handler = (update: unknown): void => {
        if (update instanceof Api.UpdateLoginToken) {
            qrAcceptedFlag = true;
        }
    };
    (c as unknown as { addEventHandler: (cb: (e: unknown) => void) => void })
        .addEventHandler(handler);
    qrUpdateUnsub = () => {
        try {
            (c as unknown as { removeEventHandler: (cb: (e: unknown) => void) => void })
                .removeEventHandler(handler);
        } catch { /* noop */ }
    };
}

function detachQrUpdateListener(): void {
    if (qrUpdateUnsub) { qrUpdateUnsub(); qrUpdateUnsub = null; }
    qrAcceptedFlag = false;
}

export async function qrLogin(apiId: number, apiHash: string): Promise<string> {
    if (!apiHash.trim()) throw new Error("API Hash cannot be empty.");
    qrCreds = { apiId, apiHash };
    qrAcceptedFlag = false;
    const c = await ensureClient();
    attachQrUpdateListener(c);
    if (await c.isUserAuthorized()) {
        detachQrUpdateListener();
        return "__authorized__";
    }
    const result = await c.invoke(
        new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }),
    );
    if (result instanceof Api.auth.LoginTokenSuccess) {
        await persistSession();
        detachQrUpdateListener();
        return "__authorized__";
    }
    if (result instanceof Api.auth.LoginToken) return tokenBytesToUrl(result.token);
    if (result instanceof Api.auth.LoginTokenMigrateTo) return tokenBytesToUrl(result.token);
    throw new Error("Unexpected ExportLoginToken response");
}

export async function qrPoll(): Promise<{ success: boolean; next_step?: string; error?: string }> {
    if (!qrCreds) return { success: false, next_step: "waiting" };
    let c: TelegramClient;
    try {
        c = await ensureClient();
    } catch {
        return { success: false, next_step: "waiting" };
    }
    attachQrUpdateListener(c);
    try {
        const result = await c.invoke(
            new Api.auth.ExportLoginToken({
                apiId: qrCreds.apiId,
                apiHash: qrCreds.apiHash,
                exceptIds: [],
            }),
        );
        if (result instanceof Api.auth.LoginTokenSuccess) {
            await persistSession();
            detachQrUpdateListener();
            qrCreds = null;
            return { success: true, next_step: "dashboard" };
        }
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
            // Account is on a different DC. Switch our connection there
            // and import the migration token; mirrors gramjs's
            // signInUserWithQrCode internals.
            try {
                // _switchDC is internal but stable; gramjs's own QR helper
                // calls it the same way.
                await (c as unknown as { _switchDC: (n: number) => Promise<void> })._switchDC(result.dcId);
                const imported = await c.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
                if (imported instanceof Api.auth.LoginTokenSuccess) {
                    await persistSession();
                    detachQrUpdateListener();
                    qrCreds = null;
                    return { success: true, next_step: "dashboard" };
                }
                // ImportLoginToken returned LoginToken — still waiting. We
                // remain on the new DC; subsequent polls will see Success.
                return { success: false, next_step: "waiting" };
            } catch (e) {
                const msg = String((e as { errorMessage?: string; message?: string })?.errorMessage
                    ?? (e as Error)?.message ?? e);
                if (msg.includes("SESSION_PASSWORD_NEEDED")) {
                    return { success: false, next_step: "password" };
                }
                console.warn("[td] QR migrate import failed:", e);
                return { success: false, next_step: "waiting" };
            }
        }
        // LoginToken — still waiting for scan. The UpdateLoginToken event
        // (if it fired between polls) is logged but irrelevant — the next
        // ExportLoginToken call will surface LoginTokenSuccess.
        if (qrAcceptedFlag) qrAcceptedFlag = false;
        return { success: false, next_step: "waiting" };
    } catch (e) {
        const msg = String((e as { errorMessage?: string; message?: string })?.errorMessage
            ?? (e as Error)?.message ?? e);
        // 2FA accounts: the phone's auth.acceptLoginToken returns
        // SESSION_PASSWORD_NEEDED on our side. Route to the password step
        // and let AuthWizard reuse the SRP flow.
        if (msg.includes("SESSION_PASSWORD_NEEDED")) {
            return { success: false, next_step: "password" };
        }
        console.warn("[td] QR poll error:", msg);
        return { success: false, next_step: "waiting" };
    }
}

export async function logout(): Promise<void> {
  if (client) {
    try { await client.invoke(new Api.auth.LogOut()); } catch {}
    try { await client.disconnect(); } catch {}
    client = null;
  }
  clearChannelInputCache();
  await passcode.clearSession();
}

export function dropClient(): void {
  if (client) {
    client.disconnect().catch(() => {});
    client = null;
  }
  clearChannelInputCache();
}
