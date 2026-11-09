/** Vite `?raw` imports: the file's text as a string (tsconfig does not load vite/client). */
declare module '*.css?raw' {
  const text: string;
  export default text;
}
