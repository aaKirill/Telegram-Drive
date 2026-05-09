import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "./lib/transport";

// Signal Rust that a fresh JS context has loaded (cold start OR webview
// reload). The Rust side bumps a generation counter that long-walking
// commands from prior contexts check between iterations, so they bail
// instead of competing with the fresh tree for grammers' sender.
// Fire-and-forget — failure here is non-fatal; cmd_app_mount may not
// exist on the web build, where the dispatcher returns "Not implemented"
// and we can ignore it.
invoke("cmd_app_mount").catch(() => { });

// Service Worker stream proxy lives only in the web build. The condition is
// statically resolved at build time (Vite define), so the bridge module
// doesn't enter the Tauri bundle.
if (import.meta.env.VITE_TARGET === "web") {
  import("./web-stubs/sw-bridge").then((m) => m.registerServiceWorkerBridge());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
