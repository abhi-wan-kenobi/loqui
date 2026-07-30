/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** First name used in the idle-state greeting. Defaults to "there". */
  readonly VITE_USER_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
