// File-picker shim. In Tauri the dialog plugin returns OS paths (strings);
// in the browser there are no paths, so we trigger a hidden <input type=file>,
// stash the selected File objects in a registry, and return synthetic
// "web-file:<id>" tokens. cmd_upload_file pulls the File back out of the
// registry by token.

import { registerFile } from "./files";

type OpenOpts = {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
};

export async function open(opts: OpenOpts = {}): Promise<string | string[] | null> {
  // Bulk-download "select destination directory" — there is no directory
  // concept in browsers; return a synthetic non-null marker so the hook
  // knows the user accepted, then per-file blob downloads handle output.
  if (opts.directory) {
    return "web:downloads";
  }

  const tokens = await pickFiles(opts.multiple === true);
  if (!tokens) return null;
  return opts.multiple ? tokens : tokens[0] ?? null;
}

export async function save(opts: { defaultPath?: string } = {}): Promise<string | null> {
  // Browsers never expose a "save here" picker that returns a path. Echo back
  // the suggested filename as a non-null marker so the queue continues; the
  // actual save happens via <a download> in cmd_download_file.
  return opts.defaultPath ?? "download";
}

export async function ask(_message: string): Promise<boolean> {
  return false;
}

export async function confirm(message: string): Promise<boolean> {
  return window.confirm(message);
}

export async function message(text: string): Promise<void> {
  window.alert(text);
}

function pickFiles(multiple: boolean): Promise<string[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (multiple) input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    let settled = false;
    const cleanup = () => { input.parentNode?.removeChild(input); };

    input.addEventListener("change", () => {
      if (settled) return;
      settled = true;
      const files = Array.from(input.files ?? []);
      cleanup();
      if (!files.length) { resolve(null); return; }
      resolve(files.map((f) => registerFile(f)));
    });

    // Modern browsers fire `cancel` when the user dismisses the picker;
    // older Safari doesn't, so we also fall back to a focus-based detection.
    input.addEventListener("cancel", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    });
    const onFocus = () => {
      setTimeout(() => {
        if (settled) return;
        if (!input.files || input.files.length === 0) {
          settled = true;
          cleanup();
          window.removeEventListener("focus", onFocus);
          resolve(null);
        }
      }, 300);
    };
    window.addEventListener("focus", onFocus, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}
