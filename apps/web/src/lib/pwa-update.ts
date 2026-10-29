/**
 * Install updates in the background; the next normal reload/launch uses the new worker.
 * Never reload on controllerchange: a worker may activate during an unsent answer,
 * an import preview or an edit form. Updating must not discard that work.
 */
export function setupAutoUpdate(): void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  async function checkUpdate() {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    } catch {
      // Offline/update failures do not interrupt learning; retry on the next foreground entry.
    }
  }
  void checkUpdate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkUpdate();
  });
}
