import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // 모든 테스트를 한국어 화면으로 시작한다: src/__tests__/setupLang.ts
    setupFiles: ['src/__tests__/setupLang.ts'],
    // CSS stays out of tests (empty modules), except print.css read as text (`?raw`) for the standalone print file.
    css: { include: [/print\.css\?raw$/] },
  },
});
