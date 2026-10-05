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

/** 单条订阅的推送目标面（push_subscriptions 行 / subscribe 请求体共形） */
export interface PushSubscriptionTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 底层单发：失败原样抛出（web-push 错误带 statusCode/body），处置策略由调用方决定 */
export async function sendToSubscription(
  sub: PushSubscriptionTarget,
  payload: unknown,
  opts: { vapidDetails: NonNullable<AppConfig['vapid']>; ttl: number },
): Promise<void> {
  await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { TTL: opts.ttl, vapidDetails: opts.vapidDetails },
  );
}

/** 订阅即自检载荷：test:true → SW 恒弹（绕过前台静默），用户点开可见即证链路通 */
const SELF_TEST_PAYLOAD = {
  title: '通知已开启',
  body: '批改完成时会在这里提醒你',
  url: '/today',
  test: true,
} as const;

/** 从 web-push 抛错提炼「statusCode + 上游 reason」：推送服务 4xx body 形如 {"reason":"BadJwtToken"} */
function upstreamFailureReason(err: unknown): string {
  const e = err as { statusCode?: number; body?: string };
  let detail = e.body?.trim() ?? '';
  if (detail) {
    try {
      detail = String((JSON.parse(detail) as { reason?: unknown }).reason ?? detail);
    } catch {
      // 非 JSON body：原样保留
    }
  }
  if (!detail) detail = (err as Error | undefined)?.message ?? String(err);
  return e.statusCode !== undefined ? `${e.statusCode} ${detail}` : detail;
}

/**
 * 订阅即自检：upsert 后立即用新订阅发一条 test 推送——
 * - 成功 → {ok:true}（弹窗由 SW 的 test 分支绕过前台静默展示，订阅瞬间用户必在前台）；
 * - 失败 → 回滚删除刚 upsert 的订阅（死订阅会让后续批改推送恒 403/410），HTTP 仍 200
 *   返回 {ok:false, reason}（statusCode+body reason，如「403 BadJwtToken」）让前端回弹展示；
 * - VAPID 未配置（功能休眠，前端在公钥 null 时不会走到这里）：保持旧语义只 upsert。
 */
export async function subscribeWithSelfTest(
  db: AppDatabase,
  config: AppConfig,
  sub: PushSubscriptionTarget,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  upsertPushSubscription(db, sub);
  if (!config.vapid) return { ok: true };
  try {
    await sendToSubscription(sub, SELF_TEST_PAYLOAD, { vapidDetails: config.vapid, ttl: 0 });
    return { ok: true };
  } catch (err) {
    deletePushSubscription(db, sub.endpoint);
    const reason = upstreamFailureReason(err);
    console.warn(
      `[push] subscribe self-test failed, rolled back: endpoint=${sub.endpoint} reason=${reason}`,
    );
    return { ok: false, reason };
  }
}

/**
 * 遍历全部订阅发送「造句批改完成」通知（best-effort，永不抛出阻断调用方）：
 * - 404/410 = 订阅已被推送服务注销（浏览器清数据/卸载）→ 删除该行；
 * - 其余错误仅 console.warn（journal 可观测，不重试）；日志带 statusCode 与上游 body
 *   （Apple 会给 reason 如 BadJwtToken——密钥/订阅问题可秒定位，不再静默失败）。
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
      await sendToSubscription(row, payload, { vapidDetails: config.vapid, ttl: PUSH_TTL_SECONDS });
    } catch (err) {
      const e = err as { statusCode?: number; body?: string };
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id)).run();
        continue;
      }
      console.warn(
        `[push] sendNotification failed: endpoint=${row.endpoint} status=${e.statusCode ?? 'n/a'} body=${e.body ?? 'n/a'} message=${(err as Error | undefined)?.message ?? String(err)}`,
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
