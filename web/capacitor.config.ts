import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.loqui.app",
  appName: "Loqui",
  webDir: "dist",
  android: {
    minWebViewVersion: 89,
  },
};

export default config;
