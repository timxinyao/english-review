import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeChoiceTask,
  makeProductionAnswer,
  makeProductionTask,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

/** 表达题答完后的下一张卡（用于断言手动下一题确实切换了任务） */
function nextTask() {
  return makeChoiceTask({ taskId: 'task-next' });
}

describe('Today 表达题任务卡（PRODUCT §7.3/§7.4/§7.6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer(),
    });
  });

  it('渲染中文提示与必须使用（accent 高亮）表达框；初始提交禁用', async () => {
    renderTodayApp();

    expect(await screen.findByText('长期的压力让我想放弃。')).toBeVisible();
    expect(screen.getByText('用英语表达')).toBeVisible();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '必须使用：give up'),
    ).toBeVisible();
    expect(screen.getByText('give up').className).toContain('text-accent');
    const textarea = screen.getByLabelText('表达答案');
    expect(textarea).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
  });

  it('目标词一键复制：点击写入剪贴板并短暂反馈已复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '复制目标词' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('give up'));
    expect(await screen.findByRole('button', { name: '已复制' })).toBeVisible();
  });

  it('提交答案：POST answerText；不显示“查看原句/蒙的/太简单”，保留稍后再做', async () => {
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    // 表达题不提供选择题专属入口（PRODUCT §7.3）
    expect(screen.queryByRole('button', { name: '查看原句' })).not.toBeInTheDocument();
    expect(screen.queryByText('其实是蒙的')).not.toBeInTheDocument();
    expect(screen.queryByText('太简单了')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '稍后再做' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[0])).toEqual({
      answerText: 'The constant stress makes me want to give up.',
    });
  });

  it('批改中（2026-10-05 可取消）：提交按钮原地变「取消」，进度线存在且无「批改中…」旧文案', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      // 永不 resolve：保持 pending
      '/api/today/tasks/task-prod/answer': () => new Promise(() => {}),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'I want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    // 提交按钮原地替换为「取消」（可点击，不再禁用等待）
    const cancelBtn = await screen.findByRole('button', { name: '取消' });
    expect(cancelBtn).toBeEnabled();
    expect(screen.queryByText('批改中…')).not.toBeInTheDocument();
    // 按钮上方 2px 动态进度线（quiet：animate-pulse 渐变 accent）+「正在批改…」文案
    const progressLine = document.querySelector('[data-grading-progress]');
    expect(progressLine).not.toBeNull();
    expect(progressLine!.className).toContain('animate-pulse');
    expect(screen.getByText('正在批改…')).toBeVisible();
    // 批改等待中不提供「不会表达」入口
    expect(screen.queryByRole('button', { name: '不会表达' })).not.toBeInTheDocument();
  });

  it('点取消：请求被 abort、输入保留、按钮恢复「提交」，无错误提示；invalidate 刷新今日状态', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      // 永不 resolve：保持 pending，signal 由 useAnswer 的 AbortController 传入
      '/api/today/tasks/task-prod/answer': () => new Promise(() => {}),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'I want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByRole('button', { name: '取消' });

    const answerCall = apiCalls('/api/today/tasks/task-prod/answer')[0]!;
    const signal = answerCall.init?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    const todayCallsBefore = apiCalls('/api/today').length;

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    // 请求被掐断；textarea 内容保留可改写重交；按钮恢复「提交」
    expect(signal.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '提交' })).toBeEnabled();
    });
    expect(screen.getByLabelText('表达答案')).toHaveValue('I want to give up.');
    expect(screen.getByLabelText('表达答案')).toBeEnabled();
    // 取消不是失败：不得残留「批改失败」红字，进度线随之消失
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('[data-grading-progress]')).toBeNull();
    // 取消后主动 invalidate today：覆盖「其实已落库」竞态（刷新后显示已批结果卡）
    await waitFor(() => {
      expect(apiCalls('/api/today').length).toBeGreaterThan(todayCallsBefore);
    });
  });

  it('通过：判定、diff 文本、解释、已存入个人例句；手动下一题（2 秒不自动）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeProductionTask(), { completed: 1, total: 6 })];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(nextTask(), { completed: 2, total: 6 }),
        '/api/today/tasks/task-prod/answer': makeProductionAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByLabelText('表达答案'), {
        target: { value: 'The constant stress makes me want to give up.' },
      });
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('通过')).toBeVisible();
      // pass：diff 全 same，句子原文展示
      expect(screen.getByText('The constant stress makes me want to give up.')).toBeVisible();
      expect(screen.getByText('目标表达使用正确。')).toBeVisible();
      expect(screen.getByText('已存入个人例句')).toBeVisible();
      // 坏题入口不在卡面（2026-09-28 起：坏题只在「今日学习」的具体记录上标记，PRODUCT §4.2/§6.5）
      expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();

      // 不自动下一题（自动跳题已全删）：时间流逝仍停留当前卡，直到点"下一题"
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('通过')).toBeVisible();
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: '下一题' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // 下一张卡：understanding → Recall Card 提示态
      expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不会表达：POST {giveUp:true} 不调批改；展示参考句与用法说明、无纠错 diff，手动下一题', async () => {
    const statusQueue = [makeActive(makeProductionTask(), { completed: 1, total: 6 })];
    stubApi({
      '/api/today': () => statusQueue.shift() ?? makeActive(nextTask(), { completed: 2, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer({
        result: 'fail',
        correct: false,
        gaveUp: true,
        submittedAnswerText: null,
        explanation: null,
        referenceAnswer: 'The constant stress makes me want to give up.',
        answerNote: '允许正常时态与人称变化。',
        correction: null,
        personalExampleSaved: false,
      }),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '不会表达' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[0])).toEqual({ giveUp: true });

    // 留在当前卡：判定 + 参考句/用法说明（表达题给-up 揭示来自绑定题目 payload）
    expect(await screen.findByText('主动不会')).toBeVisible();
    // 参考句整块（label + 高亮拆分后按 textContent 定位）；目标词块 give up 以 accent 高亮
    const reference = screen.getByText(
      (_, el) =>
        el?.tagName === 'P' &&
        el.textContent === '参考句The constant stress makes me want to give up.',
    );
    expect(reference).toBeVisible();
    expect(
      within(reference).getByText((_, el) => el?.classList.contains('text-accent') === true),
    ).toHaveTextContent('give up');
    expect(screen.getByText('允许正常时态与人称变化。')).toBeVisible();
    // 无批改即无最小纠错 diff，也不入个人例句
    expect(screen.queryByText('纠正后')).not.toBeInTheDocument();
    expect(screen.queryByText('未通过')).not.toBeInTheDocument();
    expect(screen.queryByText('已存入个人例句')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '不会表达' })).not.toBeInTheDocument();

    // 手动下一题
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
  });

  it('未通过：判定 destructive、红删绿增 diff、纠正后行、betterVersion 默认展开', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer({
        result: 'fail',
        correct: false,
        explanation: '请使用 give up 表达“放弃”。',
        personalExampleSaved: false,
        correction: {
          segments: [
            { text: 'I want to quit it.', type: 'delete' },
            { text: 'The constant stress makes me want to give up.', type: 'insert' },
          ],
          correctedSentence: 'The constant stress makes me want to give up.',
          betterVersion: 'The constant stress makes me want to give up everything.',
          betterVersionKind: 'rewrite',
        },
      }),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'I want to quit it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    const verdict = await screen.findByText('未通过');
    expect(verdict.className).toContain('text-destructive');
    expect(screen.getByText('I want to quit it.').className).toContain('text-diff-delete');
    // 插入片段（绿色）与“纠正后”行都含该句：只断言插入 span 的 class
    const inserted = screen
      .getAllByText('The constant stress makes me want to give up.')
      .find((el) => el.className.includes('text-diff-insert'));
    expect(inserted).toBeDefined();
    expect(screen.getByText('纠正后')).toBeVisible();
    expect(screen.getByText('请使用 give up 表达“放弃”。')).toBeVisible();
    // rewrite 作为参考表达直接显示
    expect(screen.getByText('参考表达')).toBeVisible();
    const details = screen
      .getByText('The constant stress makes me want to give up everything.')
      .closest('details');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('open');
    // fail 不入个人例句
    expect(screen.queryByText('已存入个人例句')).not.toBeInTheDocument();
  });

  it('基本通过：中性判定；未存个人例句时不显示提示', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer({
        result: 'basic_pass',
        personalExampleSaved: false,
      }),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    const verdict = await screen.findByText('基本通过');
    expect(verdict.className).toContain('text-warning');
    expect(screen.queryByText('已存入个人例句')).not.toBeInTheDocument();
  });

  it('批改失败（AI_PROVIDER_ERROR）：错误提示、输入保留、重试成功', async () => {
    let answerCalls = 0;
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': () => {
        answerCalls += 1;
        return answerCalls === 1
          ? Promise.reject(new Error('AI 批改暂时不可用'))
          : Promise.resolve(makeProductionAnswer());
      },
    });
    renderTodayApp();

    const textarea = await screen.findByLabelText('表达答案');
    fireEvent.change(textarea, {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    // 失败：错误提示出现，textarea 内容保留
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('AI 批改暂时不可用');
    expect(screen.getByLabelText('表达答案')).toHaveValue(
      'The constant stress makes me want to give up.',
    );

    // 重试：同一输入再次提交并成功
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('通过')).toBeVisible();
    expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(2);
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[1])).toEqual({
      answerText: 'The constant stress makes me want to give up.',
    });
  });
});
