import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA（docs/phases/phase-6-ops.md）：autoUpdate 自动注入 SW 注册，main.tsx 无需手动 register。
    // injectManifest（2026-10-05 Web Push）：SW 源码手写于 src/sw.ts（push 前台静默 +
    // notificationclick 聚焦/开窗），构建时注入 precache manifest（self.__WB_MANIFEST）。
    // 语义沿用旧 generateSW：只 precache 静态资产、无导航回退（不拦截 /api）；
    // sw.ts 自带 skipWaiting + clients.claim 保持 autoUpdate 即时接管。
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Foxi',
        short_name: 'Foxi',
        start_url: '/',
        display: 'standalone',
        background_color: '#f4f3ee',
        theme_color: '#f4f3ee',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      // navigateFallback 语义=无导航回退（sw.ts 不注册 navigation route，/api 不经过 SW）
      injectManifest: {
        globPatterns: ['**/*.{js,css,html}'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.E2E_API_PORT ?? 5174}`,
    },
  },
});
