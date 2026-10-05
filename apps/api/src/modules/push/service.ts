import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import type { AnswerResponse } from '@el/shared';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { learningItems, pushSubscriptions, reviewTasks } from '../../db/schema.js';

/** 推送载荷（SW push 事件解析后 showNotification；url 供 notificationclick 聚焦/开窗） */
export interface GradingPushPayload {
  title: string;
  body: string;
  url: string;
}

/** 表达题判定文案（与前端 PRODUCTION_VERDICTS 对齐） */
const VERDICT_LABELS: Record<AnswerResponse['result'], string> = {
  pass: '通过',
  basic_pass: '基本通过',
  fail: '未通过',
};

// TTL 300s：批改结果只在几分钟内有意义，离线超时即弃（不补发陈旧通知）
const PUSH_TTL_SECONDS = 300;

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 订阅 CRUD ----------

/** upsert：同一 endpoint 重复 subscribe 只刷新密钥与时间戳（浏览器续订场景） */
export function upsertPushSubscription(
  db: AppDatabase,
  sub: { endpoint: string; p256dh: string; auth: string },
): void {
  const ts = nowIso();
  const existing = db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, sub.endpoint))
    .get();
  if (existing) {
    db.update(pushSubscriptions)
      .set({ p256dh: sub.p256dh, auth: sub.auth, updatedAt: ts })
      .where(eq(pushSubscriptions.id, existing.id))
      .run();
    return;
  }
  db.insert(pushSubscriptions)
    .values({ id: randomUUID(), ...sub, createdAt: ts, updatedAt: ts })
    .run();
}

export function deletePushSubscription(db: AppDatabase, endpoint: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}

/** 开关初始状态 = 服务器是否存在订阅（单用户应用，不区分设备） */
export function hasPushSubscription(db: AppDatabase): boolean {
  return db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).limit(1).all().length > 0;
}

// ---------- 发送 ----------

/**
 * 遍历全部订阅发送「造句批改完成」通知（best-effort，永不抛出阻断调用方）：
 * - 404/410 = 订阅已被推送服务注销（浏览器清数据/卸载）→ 删除该行；
 * - 其余错误仅 console.warn（journal 可观测，不重试）。
 * 恒发：由 SW 端判断前台可见性静默（覆盖 iOS 后台冻结——页面冻结连接未断、
 * 客户端无法告知服务端"其实没在等"，服务端无从判断，故一律发）。
 */
export async function sendGradingPush(
  db: AppDatabase,
  config: AppConfig,
  note: { target: string; verdictLabel: string },
): Promise<void> {
  if (!config.vapid) return; // VAPID 未配置：功能休眠
  const subs = db.select().from(pushSubscriptions).all();
  if (subs.length === 0) return;
  const payload: GradingPushPayload = {
    title: '造句批改完成',
    body: `${note.target} · ${note.verdictLabel}`,
    url: '/today',
  };
  for (const row of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { TTL: PUSH_TTL_SECONDS, vapidDetails: config.vapid },
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id)).run();
        continue;
      }
      console.warn(
        `[push] sendNotification failed: endpoint=${row.endpoint} status=${status ?? 'n/a'} message=${(err as Error | undefined)?.message ?? String(err)}`,
      );
    }
  }
}

/**
 * today answer 路由的发送钩子：production 作答**结算成功后** setImmediate best-effort。
 * - 恒发（不依赖断连检测）；幂等回放（alreadyCompleted）不重复通知；
 * - 事务内查 task/item 取 target 与判定文案，任何异常仅 warn 不影响作答响应。
 */
export function queueGradingPush(
  db: AppDatabase,
  config: AppConfig,
  taskId: string,
  response: AnswerResponse,
): void {
  if (!config.vapid) return; // 休眠：零开销直接返回
  if (response.alreadyCompleted === true) return; // 幂等回放（重复提交/断连竞态）不重复通知
  setImmediate(() => {
    try {
      const task = db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
      if (!task || task.taskType !== 'production') return; // 仅造句批改发通知
      const item = db
        .select()
        .from(learningItems)
        .where(eq(learningItems.id, task.learningItemId))
        .get();
      if (!item) return;
      const verdictLabel = response.gaveUp
        ? '主动不会'
        : (VERDICT_LABELS[response.result] ?? response.result);
      void sendGradingPush(db, config, { target: item.target, verdictLabel }).catch((err) => {
        console.warn(`[push] sendGradingPush rejected: ${(err as Error)?.message ?? String(err)}`);
      });
    } catch (err) {
      console.warn(`[push] grading hook failed: ${(err as Error)?.message ?? String(err)}`);
    }
  });
}
