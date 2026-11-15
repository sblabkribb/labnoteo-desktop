import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Two pages: the app and the desktop pet window (pet.html).
  build: { target: 'es2022', rollupOptions: { input: { main: resolve(__dirname, 'index.html'), pet: resolve(__dirname, 'pet.html') } } },
});
