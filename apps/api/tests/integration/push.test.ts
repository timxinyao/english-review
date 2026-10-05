import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { AnswerResponse } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import { pushSubscriptions } from '../../src/db/schema.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { setTodayDepsForTests } from '../../src/modules/today/service.js';
import { sendGradingPush } from '../../src/modules/push/service.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { createFakeDeps } from '../helpers/today-fakes.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';

// web-push 全量 mock：sendNotification 成功/失败由各用例覆写 mockResolvedValue/mockRejectedValue
vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'B-test-public', privateKey: 'test-private' })),
    setVapidDetails: vi.fn(),
  },
}));

// SendResult（statusCode/body/headers）对测试是冗余面：抹掉泛型，按无类型 Mock 使用
const sendNotification = vi.mocked(webpush.sendNotification) as unknown as Mock;

const apps: FastifyInstance[] = [];
const dayAgo = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

/** VAPID 已配置的 app（env 注入；process.env 仅影响 loadConfig，不落盘） */
function createPushApp(): TestApp {
  const prev = {
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  };
  process.env.VAPID_PUBLIC_KEY = 'B-test-public';
  process.env.VAPID_PRIVATE_KEY = 'test-private';
  process.env.VAPID_SUBJECT = 'mailto:notify@english-review.local';
  try {
    const ctx = createTestApp();
    apps.push(ctx.app);
    return ctx;
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function pushConfig(): AppConfig {
  return loadConfig({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    VAPID_PUBLIC_KEY: 'B-test-public',
    VAPID_PRIVATE_KEY: 'test-private',
    VAPID_SUBJECT: 'mailto:notify@english-review.local',
  });
}

const SUB = {
  endpoint: 'https://push.example.dev/sub/1',
  p256dh: 'BKey1',
  auth: 'Auth1',
};

async function subscribe(ctx: TestApp, cookie: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    headers: { cookie },
    payload: SUB,
  });
  expect(res.statusCode).toBe(200);
}

async function seedDueProduction(db: AppDatabase, itemId: string, target: string): Promise<void> {
  await seedItem(db, { id: itemId, type: 'chunk', target, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', {
    difficulty: 5,
    stability: 25,
    reps: 4,
    nextReviewAt: dayAgo(),
    lastReviewAt: '2026-09-20T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'production',
    promptText: `请使用 ${target} 表达这个意思。`,
    payloadJson: JSON.stringify({
      mustUse: target,
      referenceAnswer: `They ${target} naturally.`,
      acceptanceNotes: '允许正常时态变化。',
    }),
    correctOptionId: null,
  });
}

afterAll(async () => {
  setTodayDepsForTests(null);
  for (const app of apps) await app.close();
});

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockImplementation(async () => ({ statusCode: 201, body: '', headers: {} }));
});

describe('Web Push 订阅路由', () => {
  it('GET vapid-public-key：配置了 VAPID 返回公钥；未配置返回 null', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: 'B-test-public' });

    // 未配置（env 缺省 → vapid null）：功能休眠信号
    const bare = createTestApp();
    apps.push(bare.app);
    const bareCookie = await loginCookie(bare.app);
    const bareRes = await bare.app.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
      headers: { cookie: bareCookie },
    });
    expect(bareRes.json()).toEqual({ publicKey: null });
  });

  it('POST subscribe：upsert（同 endpoint 重复订阅只刷新密钥）；GET status 反映订阅存在', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);

    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/push/status', headers: { cookie } })
      ).json(),
    ).toEqual({ subscribed: false });

    await subscribe(ctx, cookie);
    await subscribe(ctx, cookie); // 重复 subscribe（浏览器续订）→ upsert 不报错
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { ...SUB, p256dh: 'BKey2' }, // 密钥轮换
    });
    expect(res.statusCode).toBe(200);

    const rows = ctx.db.select().from(pushSubscriptions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe(SUB.endpoint);
    expect(rows[0]!.p256dh).toBe('BKey2');
    expect(rows[0]!.auth).toBe(SUB.auth);

    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/push/status', headers: { cookie } })
      ).json(),
    ).toEqual({ subscribed: true });
  });

  it('POST subscribe：VAPID 未配置（休眠）→ 旧语义只 upsert 不自检，仍 {ok:true}', async () => {
    const bare = createTestApp();
    apps.push(bare.app);
    const cookie = await loginCookie(bare.app);

    const res = await bare.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: SUB,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(bare.db.select().from(pushSubscriptions).all()).toHaveLength(1);
  });

  it('POST subscribe：自检成功 → 立即发 test 推送（test:true + 固定文案），订阅保留，响应 {ok:true}', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: SUB,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subArg, payloadArg, optionsArg] = sendNotification.mock.calls[0]!;
    expect(subArg).toMatchObject({
      endpoint: SUB.endpoint,
      keys: { p256dh: SUB.p256dh, auth: SUB.auth },
    });
    expect(JSON.parse(payloadArg as string)).toEqual({
      title: '通知已开启',
      body: '批改完成时会在这里提醒你',
      url: '/today',
      test: true, // SW 端恒弹标记：绕过前台静默
    });
    expect(optionsArg).toMatchObject({
      vapidDetails: { publicKey: 'B-test-public', subject: 'mailto:notify@english-review.local' },
    });
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(1);
  });

  it('POST subscribe：自检失败（403 BadJwtToken）→ 回滚删除订阅，{ok:false, reason 含 statusCode+body reason}，warn 日志含上游 reason', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('failed'), {
        statusCode: 403,
        body: '{"reason":"BadJwtToken"}',
      }),
    );
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: { cookie },
        payload: SUB,
      });
      // HTTP 仍 200：让前端展示 reason 并回弹开关，而非笼统报错
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toContain('403');
      expect(body.reason).toContain('BadJwtToken');

      // 回滚：刚 upsert 的死订阅不残留（否则后续批改推送恒 403/410）
      expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(0);

      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('self-test');
      expect(logged).toContain('BadJwtToken');
    } finally {
      warn.mockRestore();
    }
  });

  it('POST unsubscribe：删除订阅；status 回到 false；未订阅 endpoint 也成功（幂等）', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);
    await subscribe(ctx, cookie);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: { cookie },
      payload: { endpoint: SUB.endpoint },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(0);
    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/push/status', headers: { cookie } })
      ).json(),
    ).toEqual({ subscribed: false });

    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: { cookie },
      payload: { endpoint: 'https://push.example.dev/sub/unknown' },
    });
    expect(again.statusCode).toBe(200);
  });

  it('参数校验：缺字段 400', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { endpoint: SUB.endpoint },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('sendGradingPush（best-effort 恒发）', () => {
  it('成功：payload=造句批改完成 · target · 判定；TTL 300 + VAPID 身份', async () => {
    const ctx = createPushApp();
    await ctx.db
      .insert(pushSubscriptions)
      .values({
        id: 'sub-1',
        ...SUB,
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-05T00:00:00.000Z',
      })
      .run();

    await sendGradingPush(ctx.db, pushConfig(), { target: 'give up', verdictLabel: '通过' });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, payload, options] = sendNotification.mock.calls[0]!;
    expect(subscription.endpoint).toBe(SUB.endpoint);
    expect(JSON.parse(payload as string)).toEqual({
      title: '造句批改完成',
      body: 'give up · 通过',
      url: '/today',
    });
    expect(options).toMatchObject({
      TTL: 300,
      vapidDetails: { publicKey: 'B-test-public', subject: 'mailto:notify@english-review.local' },
    });
  });

  it('410：推送服务注销订阅 → 删除该行，其余订阅照发', async () => {
    const ctx = createPushApp();
    await ctx.db
      .insert(pushSubscriptions)
      .values([
        { id: 'sub-1', ...SUB, createdAt: 't', updatedAt: 't' },
        {
          id: 'sub-2',
          endpoint: 'https://push.example.dev/sub/2',
          p256dh: 'B2',
          auth: 'A2',
          createdAt: 't',
          updatedAt: 't',
        },
      ])
      .run();
    sendNotification.mockImplementation(async (sub: { endpoint?: string } | undefined) => {
      if (sub?.endpoint === SUB.endpoint) {
        throw Object.assign(new Error('Subscription no longer exists'), { statusCode: 410 });
      }
      return { statusCode: 201 };
    });

    await expect(
      sendGradingPush(ctx.db, pushConfig(), { target: 'raw', verdictLabel: '未通过' }),
    ).resolves.toBeUndefined();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const left = ctx.db.select().from(pushSubscriptions).all();
    expect(left.map((r) => r.id)).toEqual(['sub-2']);
  });

  it('其他错误：仅告警不抛出、订阅保留（可观测走 journal console.warn）', async () => {
    const ctx = createPushApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await ctx.db
        .insert(pushSubscriptions)
        .values({ id: 'sub-1', ...SUB, createdAt: 't', updatedAt: 't' })
        .run();
      sendNotification.mockRejectedValueOnce(
        Object.assign(new Error('upstream 502'), {
          statusCode: 502,
          body: '{"reason":"BadJwtToken"}',
        }),
      );

      await expect(
        sendGradingPush(ctx.db, pushConfig(), { target: 'raw', verdictLabel: '通过' }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      // 日志带 statusCode 与上游 body（Apple reason）：密钥/订阅问题可观测、不静默
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('status=502');
      expect(logged).toContain('BadJwtToken');
      expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('VAPID 未配置 → 直接 return 不发送；无订阅 → 不发送', async () => {
    const ctx = createPushApp();
    const bareConfig = loadConfig({
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      AUTH_PASSWORD: 'test-password',
    });
    await ctx.db
      .insert(pushSubscriptions)
      .values({ id: 'sub-1', ...SUB, createdAt: 't', updatedAt: 't' })
      .run();

    await sendGradingPush(ctx.db, bareConfig, { target: 'raw', verdictLabel: '通过' });
    expect(sendNotification).not.toHaveBeenCalled();

    // 有 VAPID 但订阅表空
    await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, 'sub-1')).run();
    await sendGradingPush(ctx.db, pushConfig(), { target: 'raw', verdictLabel: '通过' });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe('today answer 路由发送钩子（结算成功后 setImmediate 恒发）', () => {
  it('production 作答落库后 sendNotification 被调（body=target · 判定）；幂等回放不重复通知', async () => {
    const ctx = createPushApp();
    const cookie = await loginCookie(ctx.app);
    setTodayDepsForTests(createFakeDeps());
    await seedDueProduction(ctx.db, 'it-push', 'giveup-chunk');
    await subscribe(ctx, cookie);

    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/today/start',
      headers: { cookie },
    });
    expect(start.statusCode).toBe(200);

    // 造句题：prepare 绑定 → 作答（答案含目标词 → pass）
    let taskId: string | null = null;
    for (;;) {
      const cur = (
        await ctx.app.inject({ method: 'GET', url: '/api/today', headers: { cookie } })
      ).json() as { status: string; currentTask: { taskId: string; taskType: string } | null };
      if (cur.status !== 'active' || cur.currentTask === null) break;
      if (cur.currentTask.taskType === 'production') {
        taskId = cur.currentTask.taskId;
        break;
      }
      // 先答掉非造句任务
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/today/tasks/${cur.currentTask.taskId}/answer`,
        headers: { cookie },
        payload: { recall: 'recalled' },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(taskId).not.toBeNull();

    const prepare = await ctx.app.inject({
      method: 'POST',
      url: `/api/today/tasks/${taskId}/prepare`,
      headers: { cookie },
    });
    expect(prepare.statusCode).toBe(200);

    sendNotification.mockClear();
    const answer = await ctx.app.inject({
      method: 'POST',
      url: `/api/today/tasks/${taskId}/answer`,
      headers: { cookie },
      payload: { answerText: 'They giveup-chunk naturally.' },
    });
    expect(answer.statusCode).toBe(200);
    const parsed = AnswerResponse.parse(answer.json());
    expect(parsed.result).toBe('pass');

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(sendNotification.mock.calls[0]![1] as string) as {
      title: string;
      body: string;
    };
    expect(payload.title).toBe('造句批改完成');
    expect(payload.body).toBe('giveup-chunk · 通过');

    // 幂等回放（alreadyCompleted）：不重复通知
    sendNotification.mockClear();
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/today/tasks/${taskId}/answer`,
      headers: { cookie },
      payload: { answerText: 'They giveup-chunk naturally.' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().alreadyCompleted).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('VAPID 未配置（默认 env）：作答照常成功，钩子零发送', async () => {
    const bare = createTestApp();
    apps.push(bare.app);
    const cookie = await loginCookie(bare.app);
    setTodayDepsForTests(createFakeDeps());
    await seedDueProduction(bare.db, 'it-push-bare', 'giveup-chunk');

    await bare.app.inject({ method: 'POST', url: '/api/today/start', headers: { cookie } });
    let taskId: string | null = null;
    for (;;) {
      const cur = (
        await bare.app.inject({ method: 'GET', url: '/api/today', headers: { cookie } })
      ).json() as { status: string; currentTask: { taskId: string; taskType: string } | null };
      if (cur.status !== 'active' || cur.currentTask === null) break;
      if (cur.currentTask.taskType === 'production') {
        taskId = cur.currentTask.taskId;
        break;
      }
      await bare.app.inject({
        method: 'POST',
        url: `/api/today/tasks/${cur.currentTask.taskId}/answer`,
        headers: { cookie },
        payload: { recall: 'recalled' },
      });
    }
    expect(taskId).not.toBeNull();
    await bare.app.inject({
      method: 'POST',
      url: `/api/today/tasks/${taskId}/prepare`,
      headers: { cookie },
    });
    sendNotification.mockClear();
    const res = await bare.app.inject({
      method: 'POST',
      url: `/api/today/tasks/${taskId}/answer`,
      headers: { cookie },
      payload: { answerText: 'They giveup-chunk naturally.' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
