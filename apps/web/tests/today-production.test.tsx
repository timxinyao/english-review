import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../src/lib/api';
import { api, ApiError } from '../src/lib/api';
import { playGradingCue } from '../src/lib/sound';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeChoiceTask,
  makeProductionAnswer,
  makeProductionTask,
  makeSessionEntry,
  makeTasksResponse,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
// 保留 ApiError 真类（失败/超时用例要按 code 构造结构化错误），仅桩 api 函数
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
// 提示音（2026-10-05）：mock 合成音模块，组件级只断言调用
vi.mock('../src/lib/sound', () => ({ playGradingCue: vi.fn() }));

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
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '必须使用：give up[复制]',
      ),
    ).toBeVisible();
    expect(screen.getByText('give up').className).toContain('text-accent');
    const textarea = screen.getByLabelText('表达答案');
    expect(textarea).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
  });

  it('目标词一键复制：点击写入剪贴板，底部 Toast 反馈；pointerdown 阻断焦点转移（键盘不收起）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderTodayApp();

    const btn = await screen.findByRole('button', { name: '复制目标词' });
    // pointerdown 不夺焦点：默认行为被阻断（真实设备上表现为输入框不 blur、键盘不收起）
    const pd = createEvent.pointerDown(btn);
    fireEvent(btn, pd);
    expect(pd.defaultPrevented).toBe(true);
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('give up'));
    expect(await screen.findByText('内容已经复制到剪贴板')).toBeVisible();
    expect(screen.getByRole('button', { name: '复制目标词' })).toBeVisible(); // 按钮保持 [复制]
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
    expect(screen.getByText(/正在批改 0\/120/)).toBeVisible();
    // 批改等待中不提供「不会表达」入口
    expect(screen.queryByRole('button', { name: '不会表达' })).not.toBeInTheDocument();
  });

  it('批改正计时与用时（2026-10-06）：等待中每秒 +1 显示 已流逝/预算，≥30s 转 accent；结果卡显示批改用时', async () => {
    vi.useFakeTimers();
    try {
      let resolveAnswer!: (v: unknown) => void;
      const statusQueue = [makeActive(makeProductionTask(), { completed: 1, total: 6 })];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(makeProductionTask(), { completed: 1, total: 6 }),
        '/api/today/tasks/task-prod/answer': () =>
          new Promise((r) => {
            resolveAnswer = r;
          }),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByLabelText('表达答案'), {
        target: { value: 'I want to give up.' },
      });
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/正在批改 0\/120/)).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      let label = document.querySelector('[data-grading-label]')!;
      expect(label.textContent).toBe('正在批改 5/120');
      expect(label.className).toContain('text-muted-foreground');

      // 长尾区（≥30s）：数字转 accent，提示进入疑难句等待区
      await act(async () => {
        await vi.advanceTimersByTimeAsync(26_000);
      });
      label = document.querySelector('[data-grading-label]')!;
      expect(label.textContent).toBe('正在批改 31/120');
      expect(label.className).toContain('text-accent');

      // 结果到达：正计时消失，结果卡头部右侧显示本轮批改用时（≥10s 取整）
      await act(async () => {
        resolveAnswer(makeProductionAnswer());
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('通过')).toBeVisible();
      expect(document.querySelector('[data-grading-label]')).toBeNull();
      const duration = document.querySelector('[data-grading-duration]')!;
      expect(duration.textContent).toBe('批改用时 31s');
    } finally {
      vi.useRealTimers();
    }
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

  it('未通过：判定 destructive、红删绿增 diff、纠正后行、betterVersion 默认折叠', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer({
        result: 'fail',
        correct: false,
        explanation: '请使用 give up 表达“放弃”。',
        // fail 挫败反馈（2026-10-27）：diff/解释之外同时揭示题目自带参考句与用法
        referenceAnswer: 'The constant stress makes me want to give up.',
        answerNote: '允许正常时态与人称变化。',
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
    // fail 同时揭示参考句（目标词高亮）与用法说明（gave_up 同款版式）
    const reference = screen.getByText(
      (_, el) =>
        el?.tagName === 'P' &&
        el.textContent === '参考句The constant stress makes me want to give up.',
    );
    expect(reference).toBeVisible();
    expect(screen.getByText('允许正常时态与人称变化。')).toBeVisible();
    // rewrite 作为参考表达，默认折叠
    const summary = screen.getByText('参考表达');
    expect(summary).toBeVisible();
    expect(screen.queryByText('更自然的说法')).not.toBeInTheDocument();
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    (details as HTMLDetailsElement).open = true;
    expect(screen.getByText('The constant stress makes me want to give up everything.')).toBeVisible();
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

  it('答对后播放前台提示音 playGradingCue("done")（PRODUCT §5.1）', async () => {
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => {
      expect(vi.mocked(playGradingCue)).toHaveBeenCalledWith('done');
    });
  });

  it('批改失败（AI_PROVIDER_ERROR）：错误提示、输入保留、弹窗内重试成功', async () => {
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

    // 失败：弹窗（错误原文 + 未计入话术）与卡上红字同时出现，textarea 内容保留
    const dialog = await screen.findByRole('dialog', { name: '批改未完成' });
    expect(within(dialog).getByText('AI 批改暂时不可用 本次作答未计入，可重试。')).toBeVisible();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('AI 批改暂时不可用');
    expect(screen.getByLabelText('表达答案')).toHaveValue(
      'The constant stress makes me want to give up.',
    );

    // 弹窗重试：同一输入再次提交并成功，弹窗随之消失
    fireEvent.click(within(dialog).getByRole('button', { name: '重试' }));
    expect(await screen.findByText('通过')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(2);
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[1])).toEqual({
      answerText: 'The constant stress makes me want to give up.',
    });
  });

  it('失败弹窗（超时）：「批改未完成」+ 未计入话术；卡上红字保留（2026-10-05）', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      // 前端 150s 超时 → ApiError REQUEST_TIMEOUT；tasks 无该题 result（未结算）→ 正常置错
      '/api/today/tasks/task-prod/answer': () =>
        Promise.reject(new ApiError('REQUEST_TIMEOUT', '请求超时，请重试', 0)),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    const dialog = await screen.findByRole('dialog', { name: '批改未完成' });
    // 超时走固定话术（不含错误原文）
    expect(within(dialog).getByText('网络或服务超时，本次作答未计入成绩，可重试。')).toBeVisible();
    within(dialog).getByRole('button', { name: '返回修改' });
    within(dialog).getByRole('button', { name: '重试' });
    // 卡上红字保留：弹窗关闭后仍可见失败原因
    expect(screen.getByRole('alert').textContent).toContain('请求超时');
  });

  it('失败弹窗 [返回修改]：关弹窗回编辑态、输入保留、同一错误不重复弹（2026-10-05）', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': () =>
        Promise.reject(new ApiError('REQUEST_TIMEOUT', '请求超时，请重试', 0)),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    const dialog = await screen.findByRole('dialog', { name: '批改未完成' });
    fireEvent.click(within(dialog).getByRole('button', { name: '返回修改' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // 回可编辑态：输入保留、textarea 可用、卡上按钮恢复
    expect(screen.getByLabelText('表达答案')).toHaveValue(
      'The constant stress makes me want to give up.',
    );
    expect(screen.getByLabelText('表达答案')).toBeEnabled();
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    // 同一错误只弹一次：关闭后不再自行弹出
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeVisible();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('失败弹窗 [重试]：以原句直接重交（第 2 次 POST body 相同，2026-10-05）', async () => {
    let answerCalls = 0;
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': () => {
        answerCalls += 1;
        return answerCalls === 1
          ? Promise.reject(new ApiError('REQUEST_TIMEOUT', '请求超时，请重试', 0))
          : Promise.resolve(makeProductionAnswer());
      },
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    const dialog = await screen.findByRole('dialog', { name: '批改未完成' });
    fireEvent.click(within(dialog).getByRole('button', { name: '重试' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(2);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[1])).toEqual({
      answerText: 'The constant stress makes me want to give up.',
    });
    // 重交成功：弹窗关闭、卡面显示已批结果
    expect(await screen.findByText('通过')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('超时竞态保险：REQUEST_TIMEOUT 但 invalidate 后 tasks 已有该任务 result → 不弹窗、卡面显示已批结果（2026-10-05）', async () => {
    // 服务端其实在断连检测前已结算（前端 150s 超时后才落库）：作答请求被掐断后批量视图已有 result
    let settled = false;
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': () => {
        settled = true;
        return Promise.reject(new ApiError('REQUEST_TIMEOUT', '请求超时，请重试', 0));
      },
      '/api/today/tasks': () =>
        settled
          ? makeTasksResponse([makeSessionEntry(makeProductionTask(), makeProductionAnswer())])
          : makeTasksResponse([makeSessionEntry(makeProductionTask(), null)]),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    // 回放结果交给组件：卡面显示已批结果，不弹失败弹窗、无红字
    expect(await screen.findByText('通过')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: '批改未完成' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('切后台批改完成后回前台：先看该题反馈卡（判语/diff/下一题），而非直接跳下一题（2026-10-05）', async () => {
    // 提交后切后台：answer fetch 挂起不归（模拟 iOS 冻结/掐断连接），
    // 服务端在后台完成结算——回前台时批量视图已带 result
    let settled = false;
    stubApi({
      '/api/today': () =>
        makeActive(settled ? nextTask() : makeProductionTask(), {
          completed: settled ? 2 : 1,
          total: 6,
        }),
      '/api/today/tasks/task-prod/answer': () => new Promise(() => {}),
      '/api/today/tasks': () =>
        makeTasksResponse([
          makeSessionEntry(makeProductionTask(), settled ? makeProductionAnswer() : null),
        ]),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'The constant stress makes me want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    // 批改请求在途（提交按钮已变「取消」）时切后台，服务端结算完毕
    expect(await screen.findByRole('button', { name: '取消' })).toBeEnabled();
    settled = true;

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      visibility.mockReturnValue('visible');
      fireEvent(document, new Event('visibilitychange'));
    } finally {
      visibility.mockRestore();
    }

    // 回前台先补看该题批改反馈：判语 + 解释 + 「下一题」，不是下一题的题面
    expect(await screen.findByText('通过')).toBeVisible();
    expect(screen.getByText('目标表达使用正确。')).toBeVisible();
    expect(screen.getByRole('button', { name: '下一题' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'stable' })).not.toBeInTheDocument();

    // 看完点「下一题」才前进到下一条目
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
  });

  it('切后台批改未结算回前台：保持批改等待（现有行为），不误展示反馈卡（2026-10-05）', async () => {
    stubApi({
      '/api/today': () => makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': () => new Promise(() => {}),
      '/api/today/tasks': () => makeTasksResponse([makeSessionEntry(makeProductionTask(), null)]),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('表达答案'), {
      target: { value: 'I want to give up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByRole('button', { name: '取消' })).toBeEnabled();

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      visibility.mockReturnValue('visible');
      fireEvent(document, new Event('visibilitychange'));
    } finally {
      visibility.mockRestore();
    }

    // 任务仍未结算：无反馈卡，维持「正在批改…」等待态
    await waitFor(() => {
      expect(screen.getByText(/正在批改 0\/120/)).toBeVisible();
    });
    expect(screen.queryByText('通过')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();
  });
});
