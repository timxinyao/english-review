import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeActive,
  makeChoiceTask,
  makeClozeTask,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

/**
 * Today 沉浸式卡布局（PRODUCT §5.1 一题一屏；Phase 8 Task 3）。
 * jsdom 无法断言真实像素，这里锁定结构性约束：
 * 活动容器占可用视口高、题干/反馈在滚动区、输入与主操作停靠底部 dock。
 * 视口内可达性（短屏/键盘）由 e2e today.spec.ts 移动端用例覆盖。
 */
describe('Today 沉浸式卡布局', () => {
  beforeEach(() => vi.clearAllMocks());

  it('活动会话容器占可用视口高（dvh 工具类）；卡面为可伸缩列', async () => {
    stubApi({ '/api/today': makeActive(makeClozeTask(), { completed: 2, total: 5 }) });
    const { container } = renderTodayApp();
    await screen.findByLabelText('填空答案');

    const viewport = container.querySelector('.h-today-viewport');
    expect(viewport).not.toBeNull();
    expect(viewport!.className).toContain('flex-col');
    expect(viewport!.className).toContain('min-h-0');

    const card = container.querySelector('article');
    expect(card).not.toBeNull();
    expect(card!.className).toContain('flex-1');
    expect(card!.className).toContain('min-h-0');
    expect(card!.className).toContain('flex-col');
  });

  it('填空卡：题干在滚动区，输入与主提交停靠底部 dock', async () => {
    stubApi({ '/api/today': makeActive(makeClozeTask(), { completed: 2, total: 5 }) });
    const { container } = renderTodayApp();
    await screen.findByLabelText('填空答案');

    const body = container.querySelector('[data-slot="body"]');
    const dock = container.querySelector('[data-slot="dock"]');
    expect(body).not.toBeNull();
    expect(dock).not.toBeNull();
    expect(body!.className).toContain('overflow-y-auto');
    expect(body!.className).toContain('min-h-0');
    // dock 与滚动区互斥：输入和提交按钮都在 dock 内，题干句面在滚动区
    expect(body!.contains(screen.getByLabelText('填空答案'))).toBe(false);
    expect(dock!.contains(screen.getByLabelText('填空答案'))).toBe(true);
    expect(dock!.contains(screen.getByRole('button', { name: '提交' }))).toBe(true);
    expect(dock!.contains(screen.getByRole('button', { name: '不会填' }))).toBe(true);
    expect(body!.contains(screen.getByText('data has not been processed yet.'))).toBe(true);
  });

  it('Recall 卡：词行/原句在滚动区，揭示前仅 [显示答案] 停靠底部 dock，揭示后三档键仍在 dock', async () => {
    stubApi({ '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }) });
    const { container } = renderTodayApp();
    await screen.findByRole('button', { name: '显示答案' });

    const body = container.querySelector('[data-slot="body"]');
    const dock = container.querySelector('[data-slot="dock"]');
    expect(body).not.toBeNull();
    expect(dock).not.toBeNull();
    expect(
      body!.contains(
        screen.getByText(
          (_, el) => el?.tagName === 'P' && el.textContent === '原句The ladder feels stable.',
        ),
      ),
    ).toBe(true);
    // 揭示前：dock 只有一个全宽主按钮，无任何自评键
    expect(body!.contains(screen.getByRole('button', { name: '显示答案' }))).toBe(false);
    expect(dock!.contains(screen.getByRole('button', { name: '显示答案' }))).toBe(true);
    expect(screen.queryByRole('button', { name: '重来' })).toBeNull();
    expect(screen.queryByRole('button', { name: '良好' })).toBeNull();
    expect(screen.queryByRole('button', { name: '简单' })).toBeNull();

    // 揭示后：三档自评键（重来/良好/简单）都在 dock、不在滚动区（dock 节点被替换，重取）
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    const revealedDock = container.querySelector('[data-slot="dock"]');
    expect(revealedDock).not.toBeNull();
    for (const name of ['重来', '良好', '简单']) {
      expect(body!.contains(screen.getByRole('button', { name }))).toBe(false);
      expect(revealedDock!.contains(screen.getByRole('button', { name }))).toBe(true);
    }
  });

  it('表达卡：中文提示在滚动区，textarea/提交/不会表达停靠底部 dock', async () => {
    stubApi({
      '/api/today': makeActive(
        {
          ...makeClozeTask(),
          taskType: 'production',
          question: {
            questionId: 'q-prod',
            zhPrompt: '长期的压力让我想放弃。',
            mustUse: 'give up',
          },
        },
        { completed: 1, total: 6 },
      ),
    });
    const { container } = renderTodayApp();
    await screen.findByLabelText('表达答案');

    const body = container.querySelector('[data-slot="body"]');
    const dock = container.querySelector('[data-slot="dock"]');
    expect(body!.contains(screen.getByText('长期的压力让我想放弃。'))).toBe(true);
    expect(dock!.contains(screen.getByLabelText('表达答案'))).toBe(true);
    expect(dock!.contains(screen.getByRole('button', { name: '提交' }))).toBe(true);
    expect(dock!.contains(screen.getByRole('button', { name: '不会表达' }))).toBe(true);
  });

  it('表达卡触屏先无滚动聚焦但不移动真实输入，点击后预定位底部区域', async () => {
    stubApi({
      '/api/today': makeActive({
        ...makeClozeTask(),
        taskType: 'production',
        question: { questionId: 'q-prod', zhPrompt: '说一句话。', mustUse: 'raw' },
      }),
    });
    renderTodayApp();
    const input = await screen.findByLabelText('表达答案');
    expect(input).not.toHaveFocus();

    const touch = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    const focusSpy = vi.spyOn(input, 'focus');
    fireEvent(input, touch);
    expect(touch.defaultPrevented).toBe(false);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(input).toHaveFocus();
    expect(document.documentElement).toHaveAttribute('data-today-touch-pending');
    expect(document.documentElement).not.toHaveAttribute('data-today-keyboard-primed');
    fireEvent.click(input);
    expect(document.documentElement).not.toHaveAttribute('data-today-touch-pending');
    expect(input).toHaveFocus();
    expect(document.documentElement).toHaveAttribute('data-today-keyboard-primed');
  });
});
