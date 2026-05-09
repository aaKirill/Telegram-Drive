// In-process event bus for the web build. The Tauri version of listen()
// streams progress updates from Rust over IPC; here we wire upload/download
// progress through this bus so the React hooks see the same shape.

export type UnlistenFn = () => void;
export type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void;

const subs = new Map<string, Set<EventCallback<unknown>>>();
let nextId = 1;

export async function listen<T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  let set = subs.get(event);
  if (!set) { set = new Set(); subs.set(event, set); }
  const wrapper = cb as EventCallback<unknown>;
  set.add(wrapper);
  return () => { set!.delete(wrapper); };
}

export async function once<T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (e) => {
    unlisten();
    cb(e);
  });
  return unlisten;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  emitWebEvent(event, payload);
}

export function emitWebEvent(event: string, payload?: unknown): void {
  const set = subs.get(event);
  if (!set) return;
  const id = nextId++;
  for (const cb of set) {
    try { cb({ event, id, payload }); } catch { /* listener errors don't break the bus */ }
  }
}
