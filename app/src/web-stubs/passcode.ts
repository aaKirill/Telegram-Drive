// Web counterpart to commands/passcode.rs. Argon2id derives a 32-byte key
// from the user's passcode + a 16-byte salt; that key drives AES-GCM over
// (a) a tiny verifier blob written to IndexedDB so unlock can fail-fast,
// and (b) the gramjs StringSession bytes themselves.
//
// IndexedDB layout (idb-keyval database, default store):
//   td:passcode     → { v:1, salt: u8[16], verifier: u8[12+ct] }
//   td:session.enc  → u8[12+ct]   (encrypted gramjs StringSession)
//   td:session.raw  → string       (only when no passcode is set)

import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { argon2id } from "hash-wasm";
import * as locks from "./locks";

const PASSCODE_KEY = "td:passcode";
const SESSION_ENC_KEY = "td:session.enc";
const SESSION_RAW_KEY = "td:session.raw";
const VERIFIER_PLAINTEXT = "td-passcode-v1";

type PasscodeMeta = { v: 1; salt: number[]; verifier: number[] };

let cachedKey: CryptoKey | null = null;
let unlocked = false;

async function deriveKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id({
    password: passcode,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "binary",
  });
  return crypto.subtle.importKey("raw", raw as Uint8Array, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function aesEncrypt(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out;
}

async function aesDecrypt(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
}

async function readMeta(): Promise<PasscodeMeta | undefined> {
  return idbGet<PasscodeMeta>(PASSCODE_KEY);
}

export type PasscodeStatus = "disabled" | "locked" | "unlocked";

export async function status(): Promise<PasscodeStatus> {
  if (unlocked) return "unlocked";
  const meta = await readMeta();
  return meta ? "locked" : "disabled";
}

// On a fresh "set", any plaintext session bytes already in IDB get re-sealed
// under the new key so we never leave them dangling.
export async function set(passcode: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passcode, salt);
  const verifier = await aesEncrypt(key, new TextEncoder().encode(VERIFIER_PLAINTEXT));
  await idbSet(PASSCODE_KEY, {
    v: 1,
    salt: Array.from(salt),
    verifier: Array.from(verifier),
  } satisfies PasscodeMeta);
  cachedKey = key;
  unlocked = true;

  const raw = await idbGet<string>(SESSION_RAW_KEY);
  if (raw) {
    const enc = await aesEncrypt(key, new TextEncoder().encode(raw));
    await idbSet(SESSION_ENC_KEY, Array.from(enc));
    await idbDel(SESSION_RAW_KEY);
  }
}

export async function unlock(passcode: string): Promise<void> {
  const meta = await readMeta();
  if (!meta) throw new Error("No passcode set");
  const key = await deriveKey(passcode, new Uint8Array(meta.salt));
  try {
    await aesDecrypt(key, new Uint8Array(meta.verifier));
  } catch {
    await locks.incrementAttempts(locks.PASSCODE_ATTEMPTS_KEY);
    throw new Error("Incorrect passcode");
  }
  await locks.resetAttempts(locks.PASSCODE_ATTEMPTS_KEY);
  cachedKey = key;
  unlocked = true;
}

export function lock(): void {
  cachedKey = null;
  unlocked = false;
}

export async function change(oldPasscode: string, newPasscode: string): Promise<void> {
  await unlock(oldPasscode);
  const sess = await loadSession();
  await set(newPasscode);
  if (sess) await saveSession(sess);
}

export async function remove(passcode: string): Promise<void> {
  await unlock(passcode);
  const sess = await loadSession();
  await idbDel(PASSCODE_KEY);
  cachedKey = null;
  unlocked = false;
  if (sess) await saveSession(sess);
  await idbDel(SESSION_ENC_KEY);
}

// "Forgot passcode" — wipes the passcode meta, the encrypted session, all
// folder lock metadata, and attempt counters. The Telegram channels stay
// (this device just forgets who the user was); next launch lands at
// AuthWizard.
export async function reset(): Promise<void> {
  await idbDel(PASSCODE_KEY);
  await idbDel(SESSION_ENC_KEY);
  await idbDel(SESSION_RAW_KEY);
  await locks.clearEverythingForReset();
  cachedKey = null;
  unlocked = false;
}

export async function loadSession(): Promise<string> {
  const meta = await readMeta();
  if (meta) {
    if (!cachedKey) return "";
    const blob = await idbGet<number[]>(SESSION_ENC_KEY);
    if (!blob) return "";
    try {
      const plain = await aesDecrypt(cachedKey, new Uint8Array(blob));
      return new TextDecoder().decode(plain);
    } catch {
      return "";
    }
  }
  return (await idbGet<string>(SESSION_RAW_KEY)) ?? "";
}

export async function saveSession(s: string): Promise<void> {
  const meta = await readMeta();
  if (meta && cachedKey) {
    const blob = await aesEncrypt(cachedKey, new TextEncoder().encode(s));
    await idbSet(SESSION_ENC_KEY, Array.from(blob));
    await idbDel(SESSION_RAW_KEY);
  } else {
    await idbSet(SESSION_RAW_KEY, s);
    await idbDel(SESSION_ENC_KEY);
  }
}

export async function clearSession(): Promise<void> {
  await idbDel(SESSION_ENC_KEY);
  await idbDel(SESSION_RAW_KEY);
}

export function isUnlocked(): boolean {
  return unlocked;
}
