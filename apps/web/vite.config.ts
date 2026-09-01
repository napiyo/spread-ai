import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'spreadAI',
        short_name: 'spreadAI',
        description: 'Run LLMs in your browser, spread across every device you own.',
        theme_color: '#08080b',
        background_color: '#08080b',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // App shell only. Model weights are many GB and are cached by the
        // runtimes themselves (WebLLM -> Cache API/OPFS, ORT -> our own store).
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/huggingface\.co\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'hf-api', expiration: { maxEntries: 200, maxAgeSeconds: 86400 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: {
    // These ship their own wasm/worker assets; let Vite pre-bundle them once.
    exclude: ['onnxruntime-web', '@huggingface/transformers'],
  },
  worker: { format: 'es' },
  server: {
    host: true, // needed so phones on the LAN can reach the dev server
    headers: {
      // Not strictly required by WebGPU, but enables SharedArrayBuffer for the
      // wasm fallback paths in onnxruntime-web / transformers.js.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: { target: 'esnext' },
})
