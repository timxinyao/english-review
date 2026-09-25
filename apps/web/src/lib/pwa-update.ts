/**
 * PWA 更新即生效：新 SW 接管（controllerchange）时自动刷新页面。
 * 配合 vite-plugin-pwa 的 autoUpdate（skipWaiting），用户下次启动时
 * 旧版闪一下即自动换新版，不再需要"杀两次"。
 */
let refreshing = false;

export function setupAutoUpdate(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.getRegistration().then((reg) => {
    void reg?.update(); // 启动即检查更新
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return; // 防刷新循环
    refreshing = true;
    window.location.reload();
  });
}
