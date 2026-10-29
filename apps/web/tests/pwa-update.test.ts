import { afterEach, expect, it, vi } from 'vitest';
import { setupAutoUpdate } from '../src/lib/pwa-update';
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
});
it('checks for updates without installing a controller-change page reload handler', async () => {
  const update = vi.fn().mockResolvedValue(undefined);
  const addEventListener = vi.fn();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue({ update }), addEventListener },
  });
  setupAutoUpdate();
  await Promise.resolve();
  expect(update).toHaveBeenCalledOnce();
  expect(addEventListener.mock.calls.some(([name]) => name === 'controllerchange')).toBe(false);
});
it('absorbs offline service-worker registration/update errors', async () => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockRejectedValue(new Error('offline')),
      addEventListener: vi.fn(),
    },
  });
  expect(() => setupAutoUpdate()).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
