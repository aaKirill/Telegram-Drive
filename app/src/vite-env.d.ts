/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TARGET?: "web" | "tauri";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
