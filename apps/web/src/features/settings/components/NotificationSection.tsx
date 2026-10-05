import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { Button } from '../../../components/ui/button';

interface PushStatusResponse {
  subscribed: boolean;
}

interface PushPublicKeyResponse {
  publicKey: string | null;
}

/** VAPID applicationServerKey：URL-safe base64 → Uint8Array（pushManager.subscribe 入参格式） */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * 批改完成通知开关（Web Push，PRODUCT §5.1）：
 * - 开：取 VAPID 公钥（null = 服务器未配置，保持关）→ 请求通知权限 → pushManager.subscribe
 *   → POST /api/push/subscribe（开关状态持久化于服务器订阅表）
 * - 关：POST /api/push/unsubscribe + 浏览器侧 subscription.unsubscribe()
 * - 初始状态 GET /api/push/status（刷新后开关不回弹）
 * - iOS 注意：requestPermission/pushManager 仅在「添加到主屏的 PWA + HTTPS」下可用，
 *   Safari 标签页内直接失败——失败信息按此给出可读提示。
 */
export function NotificationSection() {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['push-status'],
    queryFn: () => api<PushStatusResponse>('/api/push/status'),
  });

  const toggle = useMutation({
    mutationFn: async (next: 'on' | 'off') => {
      setMessage(null);
      if (next === 'off') return disablePush();
      return enablePush();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['push-status'] });
    },
    onError: (err: Error) => {
      setMessage(err.message);
    },
  });

  const subscribed = status.data?.subscribed === true;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <span className="text-muted-foreground">批改完成通知</span>
        <Button
          variant={subscribed ? 'neutral' : 'default'}
          disabled={status.isLoading || toggle.isPending}
          onClick={() => toggle.mutate(subscribed ? 'off' : 'on')}
        >
          {subscribed ? '已开启' : '开启'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        造句提交后切后台，批改完成时推送提醒（前台时改为提示音，不打扰）。
      </p>
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

async function enablePush(): Promise<void> {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('此浏览器不支持推送通知（iOS 请从主屏 App 内开启）');
  }
  const { publicKey } = await api<PushPublicKeyResponse>('/api/push/vapid-public-key');
  if (!publicKey) {
    throw new Error('服务器未配置推送通知，暂不可开启');
  }
  // 权限请求必须在用户手势内同步发起（iOS PWA 手势链）
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('通知权限未开启（iOS：设置 → 通知 → 允许 Foxi）');
  }
  const registration = await navigator.serviceWorker.ready;
  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch {
    // iOS 常见：非主屏 PWA / 非 HTTPS / 用户拒绝——浏览器直接 reject，无权限弹窗
    throw new Error('订阅失败：请确认已将 Foxi 添加到主屏（PWA）后再开启');
  }
  const json = subscription.toJSON();
  const keys = (json.keys ?? {}) as { p256dh?: string; auth?: string };
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('订阅信息不完整，请重试');
  }
  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, p256dh: keys.p256dh, auth: keys.auth }),
  });
}

async function disablePush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    // 先服务器后浏览器：服务器删除失败也不阻塞本地退订（下次开关重订阅即 upsert 自愈）
    await api('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
    await subscription.unsubscribe();
  }
}
