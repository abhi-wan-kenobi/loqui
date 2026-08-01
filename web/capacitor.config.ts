import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.loqui.app",
  appName: "Loqui",
  webDir: "dist",
  android: {
    minWebViewVersion: 89,
    // The app is served from https://localhost (a secure context, needed for
    // getUserMedia). Talking to a plain ws:// LAN server from that origin is
    // "mixed content", which the WebView blocks by default — this allows it so
    // the zero-certificate ws://<host>:8480 path works.
    allowMixedContent: true,
  },
};

export default config;
