// Copy an image file to the system clipboard. Works on Tauri (webview's
// `navigator.clipboard.write` is the same Chromium API) and the web build.
//
// The Clipboard API only reliably accepts `image/png`. JPEG and friends
// have to go through a canvas re-encode pass first; we always normalise to
// PNG so the path is predictable everywhere.
//
// User-activation gotcha: navigator.clipboard.write requires the call to
// happen during the same transient user-activation window as the click
// that triggered it. Awaiting a fetch+decode chain BEFORE write() blows
// past that window on most browsers. The fix is to construct the
// ClipboardItem with a *Promise* resolving to the blob — Chromium keeps
// the activation valid until that promise settles. So we build a
// ClipboardItem synchronously and let it resolve internally.
//
// On Tauri the streaming URL is the localhost server with a token query
// param; fetch() works because the same URL feeds the <img> tag in
// PreviewModal. On web, the URL is a Service-Worker-intercepted path.

import { resolveMediaUrl } from "./transport";
import type { TelegramFile } from "../types";

async function fetchAsPng(file: TelegramFile, folderId: number | null): Promise<Blob> {
    const url = await resolveMediaUrl(folderId, file.id);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching image`);
    const blob = await res.blob();
    if (blob.type === "image/png") return blob;
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
            "image/png",
        );
    });
}

export async function copyImageToClipboard(
    file: TelegramFile,
    folderId: number | null,
): Promise<void> {
    if (!navigator.clipboard || typeof (navigator.clipboard as { write?: unknown }).write !== "function") {
        throw new Error("Clipboard API unavailable in this browser");
    }
    if (typeof ClipboardItem === "undefined") {
        throw new Error("ClipboardItem unsupported in this browser");
    }

    // Construct ClipboardItem synchronously with a Promise<Blob> — keeps
    // the user-activation window alive across the fetch + decode.
    const item = new ClipboardItem({
        "image/png": fetchAsPng(file, folderId),
    });
    await navigator.clipboard.write([item]);
}
