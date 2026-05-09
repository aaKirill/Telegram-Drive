// PWA updates ship via the service worker on next reload, not the Tauri
// updater. check() returns null so useUpdateCheck thinks the app is current.

export type Update = {
  available: boolean;
  version?: string;
  body?: string;
  date?: string;
  downloadAndInstall?: (cb?: (event: unknown) => void) => Promise<void>;
};

export async function check(): Promise<Update | null> {
  return null;
}
