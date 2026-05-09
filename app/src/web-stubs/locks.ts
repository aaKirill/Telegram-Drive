// Web counterpart to commands/locks.rs. Folder-lock verifiers are stored
// as Argon2id PHC strings — same format as the Tauri side — so a snapshot
// pushed by either client can be verified on the other. Persistent
// attempt counters back the killswitch.
//
// IndexedDB layout:
//   td:folder-lock:<folderKey>   → string (PHC encoded Argon2id hash)
//   td:lock-attempts             → { [folderKey | "_passcode"]: count }

import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from "idb-keyval";
import { argon2id, argon2Verify } from "hash-wasm";

const LOCK_KEY_PREFIX = "td:folder-lock:";
const ATTEMPTS_KEY = "td:lock-attempts";
export const PASSCODE_ATTEMPTS_KEY = "_passcode";

// Match Argon2::default() on the Rust side so PHC strings produced here
// look identical to ones produced by the desktop app.
const ARGON_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
} as const;

const unlockedFolders = new Set<string>();

function folderKeyStr(folderId: number | null): string {
  return folderId === null ? "home" : folderId.toString();
}

async function readPhc(folderId: number | null): Promise<string | null> {
  const stored = await idbGet<unknown>(LOCK_KEY_PREFIX + folderKeyStr(folderId));
  // PHC string format. Anything else (legacy {salt, verifier} blob from the
  // pre-unification web build) is treated as no lock — the user has to
  // reset the password to sync-compatible format.
  return typeof stored === "string" ? stored : null;
}

export async function setLock(folderId: number | null, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const phc = await argon2id({
    password,
    salt,
    ...ARGON_PARAMS,
    outputType: "encoded",
  });
  await idbSet(LOCK_KEY_PREFIX + folderKeyStr(folderId), phc);
  unlockedFolders.add(folderKeyStr(folderId));
}

export async function unlock(folderId: number | null, password: string): Promise<boolean> {
  const phc = await readPhc(folderId);
  if (!phc) return false;
  let ok = false;
  try {
    ok = await argon2Verify({ password, hash: phc });
  } catch {
    ok = false;
  }
  if (!ok) {
    await incrementAttempts(folderKeyStr(folderId));
    return false;
  }
  await resetAttempts(folderKeyStr(folderId));
  unlockedFolders.add(folderKeyStr(folderId));
  return true;
}

export async function removeLock(folderId: number | null, password: string): Promise<boolean> {
  const ok = await unlock(folderId, password);
  if (!ok) return false;
  await idbDel(LOCK_KEY_PREFIX + folderKeyStr(folderId));
  unlockedFolders.delete(folderKeyStr(folderId));
  return true;
}

export function relock(folderId: number | null): void {
  unlockedFolders.delete(folderKeyStr(folderId));
}

export function forgetFolderLock(folderId: number | null): void {
  void idbDel(LOCK_KEY_PREFIX + folderKeyStr(folderId));
  unlockedFolders.delete(folderKeyStr(folderId));
}

export async function listAllLockedKeys(): Promise<string[]> {
  const all = await idbKeys();
  return all
    .filter((k): k is string => typeof k === "string" && k.startsWith(LOCK_KEY_PREFIX))
    .map((k) => k.slice(LOCK_KEY_PREFIX.length));
}

export async function listLockedKeys(): Promise<string[]> {
  const all = await listAllLockedKeys();
  return all.filter((k) => !unlockedFolders.has(k));
}

export async function pruneOrphanLocks(validFolderIds: number[]): Promise<number> {
  const valid = new Set(validFolderIds.map((n) => n.toString()));
  valid.add("home");
  let removed = 0;
  const all = await listAllLockedKeys();
  for (const key of all) {
    if (!valid.has(key)) {
      await idbDel(LOCK_KEY_PREFIX + key);
      unlockedFolders.delete(key);
      removed++;
    }
  }
  return removed;
}

// --- Attempt counters ---------------------------------------------------

export async function getAttempts(key: string): Promise<number> {
  const map = (await idbGet<Record<string, number>>(ATTEMPTS_KEY)) ?? {};
  return map[key] ?? 0;
}

export async function incrementAttempts(key: string): Promise<number> {
  const map = (await idbGet<Record<string, number>>(ATTEMPTS_KEY)) ?? {};
  map[key] = (map[key] ?? 0) + 1;
  await idbSet(ATTEMPTS_KEY, map);
  return map[key];
}

export async function resetAttempts(key: string): Promise<void> {
  const map = (await idbGet<Record<string, number>>(ATTEMPTS_KEY)) ?? {};
  if (key in map) {
    delete map[key];
    await idbSet(ATTEMPTS_KEY, map);
  }
}

// --- Sync export / import -----------------------------------------------

export async function exportLocks(): Promise<Record<string, string>> {
  const all = await listAllLockedKeys();
  const out: Record<string, string> = {};
  for (const key of all) {
    const phc = await idbGet<unknown>(LOCK_KEY_PREFIX + key);
    if (typeof phc === "string") out[key] = phc;
  }
  return out;
}

export async function importLocks(remote: Record<string, string>): Promise<void> {
  // Replace the local set with the remote set wholesale (LWW).
  const existing = await listAllLockedKeys();
  for (const key of existing) await idbDel(LOCK_KEY_PREFIX + key);
  for (const [key, phc] of Object.entries(remote)) {
    if (typeof phc === "string" && phc.startsWith("$argon2")) {
      await idbSet(LOCK_KEY_PREFIX + key, phc);
    }
  }
  unlockedFolders.clear();
}

export async function exportAttempts(): Promise<Record<string, number>> {
  return (await idbGet<Record<string, number>>(ATTEMPTS_KEY)) ?? {};
}

export async function importAttempts(remote: Record<string, number>): Promise<void> {
  await idbSet(ATTEMPTS_KEY, { ...remote });
}

export async function clearEverythingForReset(): Promise<void> {
  const all = await idbKeys();
  for (const k of all) {
    if (typeof k === "string" && (k.startsWith(LOCK_KEY_PREFIX) || k === ATTEMPTS_KEY)) {
      await idbDel(k);
    }
  }
  unlockedFolders.clear();
}
