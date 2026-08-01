/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** First name used in the idle-state greeting. Defaults to "there". */
  readonly VITE_USER_NAME?: string;
  /** App version, injected from package.json at build time (see vite.config.ts). */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
