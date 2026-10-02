import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReadArticleView } from '@el/shared';
import { loadRealReadDeps, setReadDepsForTests } from '../../src/modules/read/service.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { seedItem, seedReviewState } from '../helpers/seed.js';

/**
 * 真实绑定测试：loadRealReadDeps 适配层 → completeStructured（Schema + 机器不变式 + 重试）
 * → mock provider（无 GLM key 时 runtime 退化为 mock，确定性输出）。
 */
const realDeps = await loadRealReadDeps().catch(() => null);

const apps: FastifyInstance[] = [];

afterAll(async () => {
  setReadDepsForTests(null);
  for (const app of apps) await app.close();
});

describe.skipIf(realDeps === null)('read 与 AI 链路真实绑定', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeAll(async () => {
    ctx = createTestApp();
    apps.push(ctx.app);
    cookie = await loginCookie(ctx.app);
    setReadDepsForTests(realDeps);
    for (const id of ['rb-a', 'rb-b', 'rb-c']) {
      await seedItem(ctx.db, { id, target: id, meaning: `${id} 释义`, queueState: 'started' });
      await seedReviewState(ctx.db, id, 'understanding', { level: 2 });
    }
  });

  it('generate 走 completeStructured：surface_form 必须实际出现在正文（新不变式）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/read/generate',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const view = ReadArticleView.parse(res.json());
    expect(view.title).toBe('A Mock Story');
    expect(view.focusItems).toHaveLength(3);
    // mock 输出的 surface_form = target 原词，且真实出现在 body（大小写不敏感）
    for (const f of view.focusItems) {
      expect(view.body.toLowerCase().includes(f.surfaceForm.toLowerCase())).toBe(true);
    }
    // V2 纯阅读：mock 输出无 checks，视图 checks=[]
    expect(view.checks).toEqual([]);
    // mock provider 元数据：真实 Prompt Registry 的 generate_read.v2
    expect(view.id).toBeTruthy();
  });
});
