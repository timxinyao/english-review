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

/** subscribe 响应：订阅即自检结果（失败时 reason 形如「403 BadJwtToken」= statusCode+上游 reason） */
interface PushSubscribeResponse {
  ok: boolean;
  reason?: string;
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
 * - 开：取 VAPID 公钥（null = 服务器未配置，保持关）→ 请求通知权限 → 清残留旧订阅
 *   （设备可能存绑旧 VAPID 钥的订阅，不清会让 subscribe 直接 reject = 点了没反应）
 *   → pushManager.subscribe → POST /api/push/subscribe（服务器订阅即自检：立即发一条
 *   test 推送，失败回滚订阅并返回 ok:false+reason → 开关回弹为关、展示
 *   「推送服务拒绝（403 BadJwtToken）」式提示）
 * - 关：POST /api/push/unsubscribe + 浏览器侧 subscription.unsubscribe()
 * - 每个失败分支都在卡面留可见红字（保留到下次操作）：系统权限被拒给 iOS 设置路径、
 *   标签页/非 HTTPS 环境给「主屏打开」指引、subscribe 异常透出 error.message。
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
    // Safari 标签页内两者直接缺失：只有主屏 PWA + HTTPS 才支持 Web Push
    throw new Error('需要从主屏打开的 Foxi 应用里开启通知');
  }
  const { publicKey } = await api<PushPublicKeyResponse>('/api/push/vapid-public-key');
  if (!publicKey) {
    throw new Error('服务器未配置推送通知，暂不可开启');
  }
  // 权限请求必须在用户手势内同步发起（iOS PWA 手势链）
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    if (permission === 'denied') {
      // 曾在系统层拒绝后 iOS 不再弹框：只能去系统设置打开，给出可照做的路径
      throw new Error('系统通知权限被拒绝：请到 iOS 设置 → 通知 → Foxi 打开“允许通知”，再回来开启');
    }
    throw new Error('通知权限未开启（未选择允许），请再试一次');
  }
  const registration = await navigator.serviceWorker.ready;
  const manager: PushManager | undefined = registration.pushManager;
  if (!manager) {
    throw new Error('需要从主屏打开的 Foxi 应用里开启通知');
  }
  // 残留订阅自愈（2026-10-05 点开无反应修复）：设备可能残留绑旧 VAPID 公钥的订阅
  // （服务端已换钥+清库），直接 subscribe 会被浏览器按钥不匹配 reject——先退浏览器侧
  // 旧订阅，并 best-effort 让服务器删旧 endpoint（新库无此记录也无妨），再走新钥订阅。
  const stale = await manager.getSubscription();
  if (stale) {
    await api('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: stale.endpoint }),
    }).catch(() => undefined);
    await stale.unsubscribe();
  }
  let subscription: PushSubscription;
  try {
    subscription = await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch (err) {
    // 其余 reject 原样透出浏览器信息（iOS 常见：非主屏 PWA / 非 HTTPS）
    throw err instanceof Error
      ? new Error(`订阅失败：${err.message}`)
      : new Error('订阅失败：请确认已将 Foxi 添加到主屏（PWA）后再开启');
  }
  const json = subscription.toJSON();
  const keys = (json.keys ?? {}) as { p256dh?: string; auth?: string };
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('订阅信息不完整，请重试');
  }
  const res = await api<PushSubscribeResponse>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, p256dh: keys.p256dh, auth: keys.auth }),
  });
  // 订阅即自检失败：服务器已回滚删除订阅，开关回弹为关并展示上游 reason（推送链路不通）
  if (!res.ok) {
    throw new Error(`推送服务拒绝（${res.reason ?? '未知原因'}）`);
  }
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
