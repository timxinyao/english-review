import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { parseBody } from '../../lib/http.js';
import { deletePushSubscription, hasPushSubscription, subscribeWithSelfTest } from './service.js';

// 订阅体 = PushSubscription.toJSON() 的最小面（endpoint + 两把密钥）
const SubscribeRequest = z.object({
  endpoint: z.string().min(1),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

const UnsubscribeRequest = z.object({
  endpoint: z.string().min(1),
});

/** Web Push（批改完成通知，TECHNICAL §push）：均需登录会话（app.ts preHandler 统一校验） */
export function pushRoutes(app: FastifyInstance, db: AppDatabase, config: AppConfig): void {
  // 前端开启通知前先取公钥；未配置返回 null（客户端提示"服务器未配置"并保持关）
  app.get('/api/push/vapid-public-key', async () => ({
    publicKey: config.vapid?.publicKey ?? null,
  }));

  // 开关初始状态：服务器是否存在订阅（刷新后不回弹到"关"）
  app.get('/api/push/status', async () => ({ subscribed: hasPushSubscription(db) }));

  // 订阅即自检：upsert 后立即发一条 test 推送验证端到端链路（VAPID/JWT/上游拒绝当场暴露）；
  // 失败回滚删除订阅并返回 {ok:false, reason}（HTTP 仍 200，让前端开关回弹并展示 reason）
  app.post('/api/push/subscribe', async (req) => {
    const sub = parseBody(SubscribeRequest, req.body);
    return subscribeWithSelfTest(db, config, sub);
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = parseBody(UnsubscribeRequest, req.body);
    deletePushSubscription(db, endpoint);
    return { ok: true };
  });
}
