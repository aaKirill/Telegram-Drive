// gramjs-backed implementation of the cmd_auth_*/cmd_connect/cmd_logout
// surface. Mirrors the Tauri backend's contract so callsites and the
// AuthWizard don't need branches.

import { TelegramClient, Api, password as gramPassword } from "telegram";
import { StringSession } from "telegram/sessions";
import * as passcode from "./passcode";
import { Store } from "./store";

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

export async function ensureClient(): Promise<TelegramClient> {
  if (client) return client;
  client = await buildClient();
  await client.connect();
  return client;
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

export async function logout(): Promise<void> {
  if (client) {
    try { await client.invoke(new Api.auth.LogOut()); } catch {}
    try { await client.disconnect(); } catch {}
    client = null;
  }
  await passcode.clearSession();
}

export function dropClient(): void {
  if (client) {
    client.disconnect().catch(() => {});
    client = null;
  }
}
