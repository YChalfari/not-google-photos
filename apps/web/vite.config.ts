import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const apiTarget = process.env.NGP_API_ORIGIN ?? 'http://127.0.0.1:4810';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 4811,
    strictPort: true,
    proxy: {
      // Same origin as the page, so the session cookie is first-party.
      '/api': { target: apiTarget },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4811,
    strictPort: true,
    proxy: { '/api': { target: apiTarget } },
  },
});
