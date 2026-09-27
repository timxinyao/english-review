/**
 * PWA 更新即生效：新 SW 接管（controllerchange）时自动刷新页面。
 * 配合 vite-plugin-pwa 的 autoUpdate（skipWaiting），用户下次启动时
 * 旧版闪一下即自动换新版，不再需要"杀两次"。
 */
let refreshing = false;

export function setupAutoUpdate(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  function checkUpdate() {
    navigator.serviceWorker.getRegistration().then((reg) => {
      void reg?.update(); // 有新版本→安装→controllerchange→上方监听自动刷新
    });
  }

  checkUpdate(); // 启动即检查

  // 后台恢复时检查：PWA 常驻后台几乎不会冷启动，不在此检查会永远停在旧版本
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkUpdate();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return; // 防刷新循环
    refreshing = true;
    window.location.reload();
  });
}
