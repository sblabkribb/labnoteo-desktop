/** Vite `?raw` imports of Markdown: the file's text as a string (tsconfig does not load vite/client). */
declare module '*.md?raw' {
  const text: string;
  export default text;
}
