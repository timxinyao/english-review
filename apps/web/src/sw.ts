import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { notificationTag, parsePushPayload, shouldShowNotification } from './lib/push-payload';

/**
 * Foxi PWA Service Worker（vite-plugin-pwa injectManifest 手写源码，types 走 tsconfig.sw.json
 * 的 WebWorker lib，主程序 tsconfig 显式 exclude 本文件）：
 * - precache：构建时注入 self.__WB_MANIFEST（precacheAndRoute 挂路由）；不注册导航回退
 *   （沿用旧 generateSW 配置 navigateFallback=undefined 语义）→ 不拦截页面导航与 /api
 * - autoUpdate 语义保留：install 即 skipWaiting + activate 即 clients.claim
 *   （配合 lib/pwa-update.ts 的 controllerchange 自动刷新），cleanupOutdatedCaches 清旧缓存
 * - push：造句批改完成通知。服务端恒发（覆盖 iOS 后台冻结——页面冻结时连接未断、
 *   服务端无从得知客户端已不等结果），前台是否静默由这里兜底：存在可见窗口
 *   （用户正看着结果卡）即跳过 showNotification；payload.test===true 为订阅即自检，
 *   恒弹绕过前台静默（tag=push-selftest，不与批改通知互斥替换）
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

// ---------- Web Push：造句批改完成通知 + 订阅自检 ----------

self.addEventListener('push', (event: PushEvent) => {
  const payload = parsePushPayload(event.data?.text());
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      // 前台静默（批改通知）：任一可见窗口 = 用户正看着结果卡，跳过通知；
      // test 自检恒弹绕过静默（订阅瞬间必在前台，静默会吞掉自检弹窗）
      const hasVisibleWindow = clients.some((client) => client.visibilityState === 'visible');
      if (!shouldShowNotification(payload, hasVisibleWindow)) return;
      const tag = notificationTag(payload); // 自检独立 tag：不与批改通知互斥替换
      await self.registration.showNotification(
        payload.title ?? (tag === 'push-selftest' ? '通知已开启' : '造句批改完成'),
        {
          body: payload.body,
          tag,
          data: { url: payload.url ?? '/today' },
          icon: '/icon-192.png',
        },
      );
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
