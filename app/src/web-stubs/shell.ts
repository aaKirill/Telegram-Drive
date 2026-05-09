// External link opener. window.open is good enough for the URLs the app
// passes (Telegram help pages, etc.).

export async function open(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}
