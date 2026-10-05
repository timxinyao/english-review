import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@el/shared';
import { urlBase64ToUint8Array } from '../src/features/settings/components/NotificationSection';

// ---------- api mock：按 path 桩（push 状态可变，供 invalidate 后回读） ----------

let pushSubscribed = false;
const calls: string[] = [];
const record = (path: string): void => {
  calls.push(path);
};

vi.mock('../src/lib/api', () => ({
  api: vi.fn(async (path: string) => {
    record(path);
    if (path === '/api/settings') {
      return {
        maxNewItemsPerDay: 10,
        contentLevel: 'B1',
        preferredTtsVoice: null,
        updatedAt: '2026-10-05T00:00:00.000Z',
      } satisfies Settings;
    }
    if (path === '/api/ai/models') {
      return {
        provider: 'glm',
        models: { flash: { model: 'glm-flash', source: 'auto', inList: true, thinking: 'off' } },
        thinkingOverride: null,
        taskMapping: [],
        availableModels: [],
        checkedAt: '2026-10-05T00:00:00.000Z',
      };
    }
    if (path === '/api/push/status') return { subscribed: pushSubscribed };
    if (path === '/api/push/vapid-public-key') return { publicKey: VAPID_KEY };
    if (path === '/api/push/subscribe') {
      pushSubscribed = true;
      return { ok: true };
    }
    if (path === '/api/push/unsubscribe') {
      pushSubscribed = false;
      return { ok: true };
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

// VAPID 公钥桩（URL-safe base64）；vi.mock 工厂惰性执行，此常量在被引用前已初始化
const VAPID_KEY = 'BEl62iUYgUrsx1YuyDNrymS2cGf9kbjr5_Y1Lx7OmI7DD2BL5xDnb9nk9W2jiFIk6fXc';

const { SettingsPage } = await import('../src/features/settings/SettingsPage');

// ---------- ServiceWorker / PushManager / Notification 桩 ----------

const unsubscribeBrowser = vi.fn(async () => true);
const fakeSubscription = {
  endpoint: 'https://push.example.dev/sub/1',
  unsubscribe: unsubscribeBrowser,
  toJSON: () => ({
    endpoint: 'https://push.example.dev/sub/1',
    keys: { p256dh: 'BP256DH', auth: 'AUTHKEY' },
  }),
};
const pushManagerSubscribe = vi.fn(async () => fakeSubscription);
const pushManagerGetSubscription = vi.fn(async () => fakeSubscription);
const requestPermission = vi.fn(async () => 'granted');

let serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
let notificationDescriptor = Object.getOwnPropertyDescriptor(window, 'Notification');

function installPushStubs(): void {
  const registration = {
    pushManager: { subscribe: pushManagerSubscribe, getSubscription: pushManagerGetSubscription },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { requestPermission },
  });
}

function restorePushStubs(): void {
  if (serviceWorkerDescriptor)
    Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  if (notificationDescriptor) Object.defineProperty(window, 'Notification', notificationDescriptor);
  else delete (window as { Notification?: unknown }).Notification;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<SettingsPage />, { wrapper });
}

beforeEach(() => {
  pushSubscribed = false;
  calls.length = 0;
  pushManagerSubscribe.mockClear();
  pushManagerGetSubscription.mockClear();
  requestPermission.mockClear();
  unsubscribeBrowser.mockClear();
  serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  notificationDescriptor = Object.getOwnPropertyDescriptor(window, 'Notification');
  installPushStubs();
});

afterEach(() => {
  restorePushStubs();
  cleanup();
});

describe('设置页「批改完成通知」开关（Web Push）', () => {
  it('status 初始化：未订阅显示「开启」；已订阅显示「已开启」', async () => {
    const { unmount } = renderPage();
    expect(await screen.findByRole('button', { name: '开启' })).toBeInTheDocument();
    unmount();

    pushSubscribed = true;
    renderPage();
    expect(await screen.findByRole('button', { name: '已开启' })).toBeInTheDocument();
  });

  it('开启流程：公钥 → 请求权限 → pushManager.subscribe（applicationServerKey 转换）→ POST subscribe → 状态刷新', async () => {
    renderPage();
    const enableBtn = await screen.findByRole('button', { name: '开启' });
    await waitFor(() => expect(enableBtn).toBeEnabled()); // status 加载完才可点
    fireEvent.click(enableBtn);

    await waitFor(() => {
      expect(calls).toContain('/api/push/subscribe');
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManagerSubscribe).toHaveBeenCalledTimes(1);
    expect(pushManagerSubscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
    });
    expect(urlBase64ToUint8Array(VAPID_KEY)).toBeInstanceOf(Uint8Array);
    // 状态回读（invalidate → status）后开关翻转为已开启
    expect(await screen.findByRole('button', { name: '已开启' })).toBeInTheDocument();
  });

  it('服务器未配置（publicKey null）：提示且不调 subscribe、保持关', async () => {
    const { api } = await import('../src/lib/api');
    const original = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/api/push/vapid-public-key') return { publicKey: null };
      if (path === '/api/push/status') return { subscribed: false };
      if (path === '/api/settings') {
        return {
          maxNewItemsPerDay: 10,
          contentLevel: 'B1',
          preferredTtsVoice: null,
          updatedAt: '2026-10-05T00:00:00.000Z',
        };
      }
      if (path === '/api/ai/models') {
        return {
          provider: 'glm',
          models: { flash: { model: 'glm-flash', source: 'auto', inList: true, thinking: 'off' } },
          thinkingOverride: null,
          taskMapping: [],
          availableModels: [],
          checkedAt: '2026-10-05T00:00:00.000Z',
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    try {
      renderPage();
      const enableBtn = await screen.findByRole('button', { name: '开启' });
      await waitFor(() => expect(enableBtn).toBeEnabled());
      fireEvent.click(enableBtn);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('服务器未配置');
      expect(pushManagerSubscribe).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '开启' })).toBeInTheDocument();
    } finally {
      vi.mocked(api).mockImplementation(original!);
    }
  });

  it('订阅自检失败（ok:false）：开关回弹为「开启」并显示上游 reason（403 BadJwtToken）', async () => {
    const { api } = await import('../src/lib/api');
    const original = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/api/push/subscribe') return { ok: false, reason: '403 BadJwtToken' };
      if (path === '/api/push/status') return { subscribed: false };
      if (path === '/api/push/vapid-public-key') return { publicKey: VAPID_KEY };
      if (path === '/api/settings') {
        return {
          maxNewItemsPerDay: 10,
          contentLevel: 'B1',
          preferredTtsVoice: null,
          updatedAt: '2026-10-05T00:00:00.000Z',
        };
      }
      if (path === '/api/ai/models') {
        return {
          provider: 'glm',
          models: { flash: { model: 'glm-flash', source: 'auto', inList: true, thinking: 'off' } },
          thinkingOverride: null,
          taskMapping: [],
          availableModels: [],
          checkedAt: '2026-10-05T00:00:00.000Z',
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    try {
      renderPage();
      const enableBtn = await screen.findByRole('button', { name: '开启' });
      await waitFor(() => expect(enableBtn).toBeEnabled());
      fireEvent.click(enableBtn);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('推送服务拒绝');
      expect(alert.textContent).toContain('403 BadJwtToken');
      // 服务器已回滚订阅：开关不翻转为已开启
      expect(screen.getByRole('button', { name: '开启' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '已开启' })).not.toBeInTheDocument();
    } finally {
      vi.mocked(api).mockImplementation(original!);
    }
  });

  it('关闭流程：POST unsubscribe + 浏览器 subscription.unsubscribe，开关回到「开启」', async () => {
    pushSubscribed = true;
    renderPage();
    const offBtn = await screen.findByRole('button', { name: '已开启' });
    await waitFor(() => expect(offBtn).toBeEnabled());
    fireEvent.click(offBtn);

    await waitFor(() => {
      expect(calls).toContain('/api/push/unsubscribe');
    });
    await waitFor(() => {
      expect(unsubscribeBrowser).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole('button', { name: '开启' })).toBeInTheDocument();
  });
});
