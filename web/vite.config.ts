import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

// Dev-only: Vite proxies /ws to the loqui server so the browser client can
// always speak to same-origin `wss://${location.host}/ws` in every
// environment (dev and production). Target is configurable via VITE_WS_TARGET
// (falls back to the production default port).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const wsTarget = env.VITE_WS_TARGET || "wss://localhost:8443";

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
    },
    server: {
      proxy: {
        "/ws": {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
