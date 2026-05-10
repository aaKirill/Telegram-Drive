// Per-day bandwidth tracker for the web build. Mirrors what
// `commands/bandwidth.rs` keeps on Tauri so the BandwidthWidget can show
// a "Used Today" bar on web too. Resets at midnight UTC.
//
// Persistence: localStorage so the counter survives page reloads but
// resets cleanly on a new day. The shape is intentionally tiny —
// { date, up, down } — anything more elaborate would pull weight that
// only the desktop side really needs.

const KEY = "td_bandwidth_v1";

type DayCounters = {
  date: string; // YYYY-MM-DD UTC
  up: number;
  down: number;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): DayCounters {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return { date: todayUtc(), up: 0, down: 0 };
    const parsed = JSON.parse(raw) as Partial<DayCounters>;
    if (!parsed || typeof parsed !== "object") return { date: todayUtc(), up: 0, down: 0 };
    if (parsed.date !== todayUtc()) return { date: todayUtc(), up: 0, down: 0 };
    return {
      date: todayUtc(),
      up: Number(parsed.up) || 0,
      down: Number(parsed.down) || 0,
    };
  } catch {
    return { date: todayUtc(), up: 0, down: 0 };
  }
}

function save(c: DayCounters): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY, JSON.stringify(c));
    }
  } catch { /* quota exhausted or private mode — non-fatal */ }
}

export function recordUpload(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const c = load();
  c.up += Math.floor(bytes);
  save(c);
}

export function recordDownload(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const c = load();
  c.down += Math.floor(bytes);
  save(c);
}

export function getStats(): { up_bytes: number; down_bytes: number } {
  const c = load();
  return { up_bytes: c.up, down_bytes: c.down };
}
