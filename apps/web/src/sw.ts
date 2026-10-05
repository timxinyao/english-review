import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

/**
 * Foxi PWA Service Worker（vite-plugin-pwa injectManifest 手写源码，types 走 tsconfig.sw.json
 * 的 WebWorker lib，主程序 tsconfig 显式 exclude 本文件）：
 * - precache：构建时注入 self.__WB_MANIFEST（precacheAndRoute 挂路由）；不注册导航回退
 *   （沿用旧 generateSW 配置 navigateFallback=undefined 语义）→ 不拦截页面导航与 /api
 * - autoUpdate 语义保留：install 即 skipWaiting + activate 即 clients.claim
 *   （配合 lib/pwa-update.ts 的 controllerchange 自动刷新），cleanupOutdatedCaches 清旧缓存
 * - push：造句批改完成通知。服务端恒发（覆盖 iOS 后台冻结——页面冻结时连接未断、
 *   服务端无从得知客户端已不等结果），前台是否静默由这里兜底：存在可见窗口
 *   （用户正看着结果卡）即跳过 showNotification
 * - notificationclick：已有窗口 focus + postMessage，否则 openWindow(data.url ?? '/today')
 */

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0];
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

// ---------- Web Push：造句批改完成通知 ----------

interface GradingPushPayload {
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  let payload: GradingPushPayload = {};
  try {
    payload = event.data ? (JSON.parse(event.data.text()) as GradingPushPayload) : {};
  } catch {
    // 非 JSON 载荷：按空载荷处理（默认标题 + /today）
  }
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      // 前台静默：任一可见窗口 = 用户正看着结果卡，跳过通知
      if (clients.some((client) => client.visibilityState === 'visible')) return;
      await self.registration.showNotification(payload.title ?? '造句批改完成', {
        body: payload.body,
        tag: 'grading', // 同 tag 覆盖：连续批改不堆叠
        data: { url: payload.url ?? '/today' },
        icon: '/icon-192.png',
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/today';
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      const existing = clients[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'grading-notification-click', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
