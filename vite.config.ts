import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  base: './',
  html: command === 'serve' ? { cspNonce: 'xinban-dev-only' } : undefined,
  plugins: [
    react(),
    {
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) =>
          html.replace("script-src 'self';", "script-src 'self' 'nonce-xinban-dev-only';"),
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist/renderer', emptyOutDir: true },
}));
