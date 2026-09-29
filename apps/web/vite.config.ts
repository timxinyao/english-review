import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // 【临时调试】键盘避让诊断浮层的 build 标识，问题定位后随浮层一并删除
  define: {
    __BUILD_TAG__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    // PWA（docs/phases/phase-6-ops.md）：autoUpdate 自动注入 SW 注册，main.tsx 无需手动 register。
    // workbox 只 precache 静态资产：显式关闭 navigateFallback，避免 SW 拦截 /api 请求。
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Foxi',
        short_name: 'Foxi',
        start_url: '/',
        display: 'standalone',
        background_color: '#faf9f6',
        theme_color: '#faf9f6',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        navigateFallback: undefined,
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
