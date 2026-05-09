// Pulled at build time from package.json by Vite's define() so the web
// build's Settings page shows the correct version.
declare const __APP_VERSION__: string;

export async function getVersion(): Promise<string> {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "web";
}

export async function getName(): Promise<string> {
  return "Telegram Drive";
}

export async function getTauriVersion(): Promise<string> {
  return "0";
}
