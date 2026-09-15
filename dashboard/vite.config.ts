import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The backend's CORS allowlist names this origin explicitly, so the port
    // is not a free choice -- changing it means changing BLUEBERRY_CORS_ORIGINS.
    strictPort: true,
    // Without an explicit host, Vite's default DNS lookup for "localhost" can
    // resolve to the IPv6 loopback only on some machines, which leaves plain
    // 127.0.0.1 (IPv4) refusing connections -- including from the VS Code
    // extension's "Open Dashboard" command, which targets 127.0.0.1 by
    // default. Binding all interfaces makes both localhost and 127.0.0.1 work.
    host: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
