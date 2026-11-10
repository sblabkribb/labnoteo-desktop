/** Vite `import.meta.env` flags this app reads (tsconfig does not load vite/client). DEV is false in `vite build`. */
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
