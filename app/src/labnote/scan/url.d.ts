/** Vite `?url` imports: the emitted asset's same-origin URL (tsconfig does not load vite/client). */
declare module '*?url' {
  const url: string;
  export default url;
}
