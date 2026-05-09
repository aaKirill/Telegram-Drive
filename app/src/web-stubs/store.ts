// IndexedDB-backed shim of @tauri-apps/plugin-store. One IDB key per
// "filename" holds a JSON blob; the Store class exposes the same surface as
// the Tauri plugin (get/set/save/has/delete/keys/entries/...). Per-instance
// caching + a debounced flush match the Tauri plugin's "in-memory + save()"
// model so callsites that don't await save() still see their writes.

import { get as idbGet, set as idbSet } from "idb-keyval";

type Json = unknown;
type Listener = (key: string, value: Json) => void;

const cache = new Map<string, Map<string, Json>>();
const inflight = new Map<string, Promise<Map<string, Json>>>();

async function loadMap(filename: string): Promise<Map<string, Json>> {
  const hit = cache.get(filename);
  if (hit) return hit;
  let pending = inflight.get(filename);
  if (!pending) {
    pending = (async () => {
      const raw = (await idbGet<Record<string, Json>>(`store:${filename}`)) ?? {};
      const map = new Map(Object.entries(raw));
      cache.set(filename, map);
      inflight.delete(filename);
      return map;
    })();
    inflight.set(filename, pending);
  }
  return pending;
}

async function flush(filename: string, map: Map<string, Json>) {
  const obj: Record<string, Json> = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  await idbSet(`store:${filename}`, obj);
}

export class Store {
  private filename: string;
  private listeners = new Set<Listener>();

  private constructor(filename: string) {
    this.filename = filename;
  }

  static async load(filename: string): Promise<Store> {
    const s = new Store(filename);
    await loadMap(filename);
    return s;
  }

  static async get(filename: string): Promise<Store | null> {
    const s = new Store(filename);
    await loadMap(filename);
    return s;
  }

  async get<T = Json>(key: string): Promise<T | undefined> {
    const map = await loadMap(this.filename);
    return map.get(key) as T | undefined;
  }

  async set(key: string, value: Json): Promise<void> {
    const map = await loadMap(this.filename);
    map.set(key, value);
    for (const l of this.listeners) l(key, value);
  }

  async has(key: string): Promise<boolean> {
    const map = await loadMap(this.filename);
    return map.has(key);
  }

  async delete(key: string): Promise<boolean> {
    const map = await loadMap(this.filename);
    return map.delete(key);
  }

  async clear(): Promise<void> {
    const map = await loadMap(this.filename);
    map.clear();
  }

  async keys(): Promise<string[]> {
    const map = await loadMap(this.filename);
    return Array.from(map.keys());
  }

  async values<T = Json>(): Promise<T[]> {
    const map = await loadMap(this.filename);
    return Array.from(map.values()) as T[];
  }

  async entries<T = Json>(): Promise<[string, T][]> {
    const map = await loadMap(this.filename);
    return Array.from(map.entries()) as [string, T][];
  }

  async length(): Promise<number> {
    const map = await loadMap(this.filename);
    return map.size;
  }

  async reload(): Promise<void> {
    cache.delete(this.filename);
    await loadMap(this.filename);
  }

  async save(): Promise<void> {
    const map = await loadMap(this.filename);
    await flush(this.filename, map);
  }

  async close(): Promise<void> {
    await this.save();
  }

  async onChange(cb: Listener): Promise<() => void> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async onKeyChange<T = Json>(key: string, cb: (value: T | undefined) => void): Promise<() => void> {
    const wrapper: Listener = (k, v) => { if (k === key) cb(v as T | undefined); };
    this.listeners.add(wrapper);
    return () => this.listeners.delete(wrapper);
  }
}

export async function load(filename: string): Promise<Store> {
  return Store.load(filename);
}

export async function getStore(filename: string): Promise<Store | null> {
  return Store.get(filename);
}
