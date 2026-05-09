import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")) as { version: string };

const stub = (name: string) => path.resolve(here, "src/web-stubs", name);

// Repo name on GitHub determines the Pages subpath.
const BASE = process.env.WEB_BASE ?? "/Telegram-Drive/";

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    // gramjs (the `telegram` package) imports Node's Buffer/process/crypto
    // throughout. The plugin shims them so the bundle runs in browsers.
    nodePolyfills({
      include: ["buffer", "process", "util", "events", "stream", "crypto", "path"],
      globals: { Buffer: true, process: true, global: true },
    }),
    {
      // Inject a strict CSP only into the web build's index.html. The Tauri
      // build's webview uses non-https schemes (tauri://, https://tauri.localhost)
      // that would conflict with these directives, so we keep the policy
      // out of the shared template.
      name: "td-csp-injector",
      transformIndexHtml(html) {
        const csp = [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self' blob: wss://*.web.telegram.org wss://venus.web.telegram.org wss://*.telegram.org https://*.web.telegram.org",
          "object-src 'none'",
          "base-uri 'self'",
          // frame-ancestors is ignored in <meta> CSPs (must be an HTTP
          // header). GitHub Pages sets X-Frame-Options: deny on its own.
        ].join("; ");
        return html.replace(
          "<head>",
          `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
        );
      },
    },
  ],
  define: {
    "import.meta.env.VITE_TARGET": JSON.stringify("web"),
    __APP_VERSION__: JSON.stringify(`${pkg.version}-web`),
  },
  resolve: {
    alias: {
      "@tauri-apps/api/core": stub("core.ts"),
      "@tauri-apps/api/event": stub("event.ts"),
      "@tauri-apps/api/app": stub("app.ts"),
      "@tauri-apps/plugin-store": stub("store.ts"),
      "@tauri-apps/plugin-dialog": stub("dialog.ts"),
      "@tauri-apps/plugin-shell": stub("shell.ts"),
      "@tauri-apps/plugin-updater": stub("updater.ts"),
      "@tauri-apps/plugin-process": stub("process.ts"),
      // gramjs ships StoreSession that imports node-localstorage; we use
      // StringSession exclusively, so swap in a no-op to drop the dead
      // weight (pulls in fs/path otherwise).
      "node-localstorage": stub("node-localstorage.ts"),
    },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2020",
  },
});
