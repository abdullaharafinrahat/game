import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages, a CDN subfolder,
  // or opened from a static file host.
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The workspace preview proxies through a per-port host; allow it.
    allowedHosts: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          babylon: ['@babylonjs/core'],
          havok: ['@babylonjs/havok'],
        },
      },
    },
  },
  // Havok ships a .wasm next to its ESM entry; let Vite treat it as an asset.
  assetsInclude: ['**/*.wasm'],
});
