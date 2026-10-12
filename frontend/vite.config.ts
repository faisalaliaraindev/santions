import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
// vitest/config re-exports Vite's defineConfig with the `test` key typed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // The panel authenticates through the API's backend-for-frontend session, so it must be
    // same-origin with the API in development too. Provider tokens never reach the browser.
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/auth': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
