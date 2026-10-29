import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeCanceledEntry,
  makeChoiceTask,
  makeCorrectAnswer,
  makeLearnTask,
  makeProductionTask,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

it('revealing recall brings the meaning into the scroll region on short screens', async () => {
  const scroll = vi.fn();
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    stubApi({ '/api/today': () => makeActive(makeChoiceTask()) });
    renderTodayApp();
    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'nearest' }));
  } finally {
    HTMLElement.prototype.scrollIntoView = previous;
  }
});

describe('V2 pending 题目准备（2026-10-03 两级契约）', () => {
  beforeEach(() => vi.clearAllMocks());

  /** 理解题不消费绑定题：question=null 也立即渲染 RecallCard，不触发 prepare（反白屏核心） */
  it('understanding question=null 立即渲染 RecallCard：无正在准备、不调 prepare、可直接作答', async () => {
    const task = makeChoiceTask({ question: null });
    stubApi({
      '/api/today': () => makeActive(task),
      '/api/today/tasks/task-1/answer': () => makeCorrectAnswer({ outcomeSource: 'recalled' }),
    });
    renderTodayApp();
    // 词行与原句即时可见（已知内容不白屏），显示答案可点
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '原句The ladder feels stable.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
    expect(screen.queryByText('正在准备…')).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(apiCalls('/api/today/tasks/task-1/prepare')).toHaveLength(0);
    // 可直接作答：显示答案 → 良好 → POST recall（未绑题也能走完整作答流）
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1));
    expect(apiCalls('/api/today/tasks/task-1/answer')[0]!.init).toMatchObject({ method: 'POST' });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0]!)).toEqual({
      recall: 'recalled',
    });
  });

  it('表达题 question=null：词行+原句+加载态 dock，in-flight 无稍后再做', async () => {
    const pending = makeProductionTask({ question: null });
    let resolve!: () => void;
    const held = new Promise<void>((r) => {
      resolve = r;
    });
    stubApi({
      '/api/today': () => makeActive(pending),
      '/api/today/tasks/task-prod/prepare': () => held.then(() => pending),
    });
    renderTodayApp();
    // 已知内容（词行+原句）即时渲染，输入框不可达
    expect(await screen.findByRole('heading', { name: 'give up' })).toBeVisible();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '原句Never give up your dreams.',
      ),
    ).toBeVisible();
    expect(screen.getByText('正在准备…')).toBeVisible();
    expect(screen.queryByLabelText('表达答案')).toBeNull();
    // in-flight 期间不提供稍后再做/重试（只在生成失败后出现）
    expect(screen.queryByRole('button', { name: '稍后再做' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-prod/prepare')).toHaveLength(1));
    resolve();
  });

  it('生成失败保留任务和总数，重试后 Production target、词库与提交可达', async () => {
    const ready = makeProductionTask();
    let tries = 0;
    stubApi({
      '/api/today': () => makeActive(tries > 1 ? ready : { ...ready, question: null }),
      '/api/today/tasks/task-prod/prepare': () =>
        ++tries === 1 ? Promise.reject(new Error('题目暂时无法生成，请稍后重试')) : ready,
    });
    renderTodayApp();
    // 失败态：错误文案 + dock 三键（重试/稍后再做/刷新今日学习）
    expect(await screen.findByText('题目暂时无法生成，请稍后重试')).toBeVisible();
    expect(screen.getByText('今日 0 / 1')).toBeVisible();
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
    expect(screen.getByRole('button', { name: '稍后再做' })).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新今日学习' })).toBeVisible();
    expect(screen.queryByLabelText('表达答案')).toBeNull();
    expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('scramble-chip-bank')).toBeVisible();
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
    expect(screen.getByText('give up')).toBeVisible();
    expect(screen.queryByLabelText('填空答案')).toBeNull();
  });

  it('失败任务可稍后再做（POST /later），进度总数不减少且下一张卡可答', async () => {
    let deferred = false;
    const pending = makeProductionTask({ question: null });
    stubApi({
      '/api/today': () =>
        makeActive(deferred ? makeLearnTask() : pending, { completed: 0, total: 2 }),
      '/api/today/tasks/task-prod/prepare': () =>
        Promise.reject(new Error('题目暂时无法生成，请稍后重试')),
      '/api/today/tasks/task-prod/later': () => {
        deferred = true;
        return { ok: true, progress: { completed: 0, total: 2 } };
      },
    });
    renderTodayApp();
    await screen.findByText('题目暂时无法生成，请稍后重试');
    fireEvent.click(screen.getByRole('button', { name: '稍后再做' }));
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-prod/later')).toHaveLength(1));
    expect(apiCalls('/api/today/tasks/task-prod/later')[0]!.init).toMatchObject({ method: 'POST' });
    expect(await screen.findByRole('heading', { name: 'gravity' })).toBeVisible();
    expect(screen.getByText('今日 0 / 2')).toBeVisible();
  });
});

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

describe('Today 任务卡：learn Recall 卡 / 稍后再做 / 坏题', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('稍后再做按钮已移除（右滑替代）', async () => {
    stubApi({
      '/api/today': makeActive(makeLearnTask(), { completed: 1, total: 4 }),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'gravity' });
    expect(screen.queryByRole('button', { name: '稍后再做' })).not.toBeInTheDocument();
  });

  it('坏题：答错留在当前卡，下一题后从「今日学习」记录标记，confirm 流程 POST bad-question', async () => {
    let answered = false;
    const nextTask = makeChoiceTask({
      taskId: 'task-2',
      item: {
        id: 'item-2',
        type: 'word',
        target: 'make sense',
        meaning: '讲得通',
        ipa: null,
        notes: null,
      },
      question: {
        questionId: 'q-2',
        kind: 'direct_meaning',
        context: null,
        question: '"make sense" 的意思是？',
        options: [
          { id: 'm1', text: '讲得通' },
          { id: 'm2', text: '毫无意义' },
        ],
      },
    });
    const first = makeChoiceTask();
    stubApi({
      '/api/today': () =>
        answered
          ? makeActive(nextTask, { completed: 1, total: 4 })
          : makeActive(first, { completed: 1, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(first, makeWrongAnswer()),
              makeSessionEntry(nextTask, null),
            ])
          : makeTasksResponse([makeSessionEntry(first, null), makeSessionEntry(nextTask, null)]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeWrongAnswer();
      },
      '/api/today/tasks/task-1/bad-question': { ok: true, progress: { completed: 1, total: 4 } },
    });
    renderTodayApp();

    // 答题前卡片上没有坏题入口（坏题只在「今日学习」的具体记录上，PRODUCT §4.2/§6.5）
    await screen.findByRole('heading', { name: 'stable' });
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();

    // 显示答案 → 重来 → 评分即前进（2026-10-03 三档：答错也自动切卡，无留卡分支）
    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '重来' }));
    expect(await screen.findByRole('heading', { name: 'make sense' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();

    // 打开今日学习 → 展开 stable 分组 → 记录上标记坏题 → confirm POST task-1
    fireEvent.click(screen.getByRole('button', { name: '查看今日学习' }));
    const sheet = screen.getByRole('dialog', { name: '今日学习' });
    await waitFor(() => expect(sheet).toBeVisible());
    fireEvent.click(within(sheet).getByRole('button', { name: /stable/ }));
    expect(await within(sheet).findByRole('button', { name: '坏题' })).toBeVisible();
    fireEvent.click(within(sheet).getByRole('button', { name: '坏题' }));
    const dialog = screen.getByRole('dialog', { name: '标记坏题' });
    expect(screen.getByText('标记坏题将撤销本次作答影响')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/bad-question')).toHaveLength(1);
    });
    expect(apiCalls('/api/today/tasks/task-1/bad-question')[0].init).toMatchObject({
      method: 'POST',
    });
    // 标记坏题不改变当前题：关闭弹层仍在 make sense
    fireEvent.click(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '今日学习' })).toBeNull());
    expect(await screen.findByRole('heading', { name: 'make sense' })).toBeVisible();
  });
});

describe('Today 撤销最近一次作答（卡片右上单图标，PRODUCT §5.1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const taskA = makeChoiceTask(); // stable / understanding
  const taskB = makeChoiceTask({
    taskId: 'task-2',
    item: { id: 'item-2', type: 'word', target: 'beta', meaning: '乙', ipa: null, notes: null },
    question: {
      questionId: 'q-2',
      kind: 'direct_meaning',
      context: null,
      question: '"beta" 的意思是？',
      options: [
        { id: 'b1', text: '乙' },
        { id: 'b2', text: '甲' },
      ],
    },
  });
  const taskC = makeChoiceTask({
    taskId: 'task-3',
    item: { id: 'item-3', type: 'word', target: 'gamma', meaning: '丙', ipa: null, notes: null },
    question: {
      questionId: 'q-3',
      kind: 'direct_meaning',
      context: null,
      question: '"gamma" 的意思是？',
      options: [
        { id: 'g1', text: '丙' },
        { id: 'g2', text: '丁' },
      ],
    },
  });
  /** Recall 撤销后的重答：同 item/原题，新任务实例立即呈现。 */
  const taskAReplacement = makeChoiceTask({
    taskId: 'task-repl',
    question: taskA.question,
  });

  it('反馈态指向本题：取消不发请求；确认恰好一次；成功立即回原词并清除揭示', async () => {
    let answered = false;
    let undone = false;
    stubApi({
      '/api/today': () =>
        undone
          ? makeActive(taskAReplacement, { completed: 0, total: 2 })
          : answered
            ? makeActive(taskB, { completed: 1, total: 2 })
            : makeActive(taskA, { completed: 0, total: 2 }),
      '/api/today/tasks': () =>
        undone
          ? makeTasksResponse([
              makeCanceledEntry(taskA),
              makeSessionEntry(taskB, null),
              makeSessionEntry(taskAReplacement, null),
            ])
          : answered
            ? makeTasksResponse(
                [makeSessionEntry(taskA, makeWrongAnswer()), makeSessionEntry(taskB, null)],
                'task-1',
              )
            : makeTasksResponse([makeSessionEntry(taskA, null), makeSessionEntry(taskB, null)]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeWrongAnswer();
      },
      '/api/today/tasks/task-1/undo': () => {
        undone = true;
        return { ok: true, progress: { completed: 0, total: 2 } };
      },
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'stable' });

    // 答错评分即前进：自动切到 beta，撤销图标随批量视图出现在当前卡（指向最近一次作答 task-1）
    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '重来' }));
    expect(await screen.findByRole('heading', { name: 'beta' })).toBeVisible();
    const undoIcon = await screen.findByRole('button', { name: '撤销最近一次作答' });
    expect(undoIcon).toBeVisible();

    // 确认层写明将撤销的词/题型/结果（PRODUCT §5.1）
    fireEvent.click(undoIcon);
    const dialog = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    expect(within(dialog).getByText('stable')).toBeVisible();
    expect(within(dialog).getByText(/理解题/)).toBeVisible();
    expect(within(dialog).getByText(/未通过/)).toBeVisible();
    expect(within(dialog).getByText('撤销后立即回到这个词重新作答。')).toBeVisible();

    // 取消：不发任何请求
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '撤销最近一次作答' })).toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(0);

    // 确认：恰好一次 POST
    fireEvent.click(screen.getByRole('button', { name: '撤销最近一次作答' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '撤销最近一次作答' })).getByRole('button', {
        name: '撤销',
      }),
    );
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(1));
    expect(apiCalls('/api/today/tasks/task-1/undo')[0].init).toMatchObject({ method: 'POST' });

    // 成功：同词新的任务实例，不带旧揭示或评分。
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'beta' })).toBeNull();
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '重来' })).toBeNull();
    expect(screen.queryByText('"stable" 的意思是？')).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(1); // 仍只有一次
  });

  it('已进入下一题后：确认层指向最近一次正式作答（前一题），而非当前题', async () => {
    stubApi({
      '/api/today': makeActive(taskB, { completed: 1, total: 2 }),
      '/api/today/tasks': makeTasksResponse(
        [makeSessionEntry(taskA, makeWrongAnswer()), makeSessionEntry(taskB, null)],
        'task-1',
      ),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'beta' });

    fireEvent.click(await screen.findByRole('button', { name: '撤销最近一次作答' }));
    const dialog = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    // 指向前一题 stable（最近一次作答），不是当前 beta
    expect(within(dialog).getByText('stable')).toBeVisible();
    expect(within(dialog).queryByText('beta')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '撤销最近一次作答' })).toBeNull(),
    );
    expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(0);
  });

  it('另一设备已有更新作答：图标始终指向服务端最近作答，请求发到服务端给的 id', async () => {
    stubApi({
      '/api/today': makeActive(taskC, { completed: 2, total: 3 }),
      '/api/today/tasks': makeTasksResponse(
        [
          makeSessionEntry(taskA, makeWrongAnswer()),
          makeSessionEntry(taskB, makeWrongAnswer()),
          makeSessionEntry(taskC, null),
        ],
        'task-2', // 服务端：最近一次作答是另一设备提交的 task-2
      ),
      '/api/today/tasks/task-2/undo': { ok: true, progress: { completed: 1, total: 3 } },
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'gamma' });

    fireEvent.click(await screen.findByRole('button', { name: '撤销最近一次作答' }));
    const dialog = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    // 确认层指向服务端给的 task-2（beta），不是本地更早的 task-1（stable）也不是当前题
    expect(within(dialog).getByText('beta')).toBeVisible();
    expect(within(dialog).queryByText('stable')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-2/undo')).toHaveLength(1));
    expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(0);
  });

  it('无可撤销作答时（undoableTaskId=null）不渲染撤销图标', async () => {
    stubApi({
      '/api/today': makeActive(taskB, { completed: 0, total: 2 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(taskA, null),
        makeSessionEntry(taskB, null),
      ]),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'beta' });
    await screen.findByText('今日 0 / 2');
    expect(screen.queryByRole('button', { name: '撤销最近一次作答' })).toBeNull();
  });

  it('过期撤销 409（另一设备已作答）：刷新并解释，不清掉其他设备的作答', async () => {
    let undoAttempted = false;
    stubApi({
      '/api/today': makeActive(taskC, { completed: 1, total: 3 }),
      '/api/today/tasks': () =>
        undoAttempted
          ? makeTasksResponse(
              [
                makeSessionEntry(taskA, makeWrongAnswer()),
                makeSessionEntry(taskB, makeWrongAnswer()),
                makeSessionEntry(taskC, null),
              ],
              'task-2',
            )
          : makeTasksResponse(
              [
                makeSessionEntry(taskA, makeWrongAnswer()),
                makeSessionEntry(taskB, null),
                makeSessionEntry(taskC, null),
              ],
              'task-1',
            ),
      '/api/today/tasks/task-1/undo': () => {
        undoAttempted = true;
        return Promise.reject(new Error('已有更新的作答，无法撤销该任务'));
      },
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'gamma' });

    fireEvent.click(await screen.findByRole('button', { name: '撤销最近一次作答' }));
    const dialog = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }));

    // 409 解释：说明已有更新的作答（服务端中文信息透传），确认层保留可取消
    expect(await within(dialog).findByText('已有更新的作答，无法撤销该任务')).toBeVisible();
    // 失败后刷新：另一设备在 task-2 上的作答保留在分布里（未被清掉）
    expect(await screen.findByText('通过 0 · 基础通过 0 · 未通过 2')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '撤销最近一次作答' })).toBeNull(),
    );

    // 图标重新指向刷新后的服务端最近作答（task-2/beta）
    fireEvent.click(screen.getByRole('button', { name: '撤销最近一次作答' }));
    const dialog2 = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    expect(within(dialog2).getByText('beta')).toBeVisible();
  });

  it('没有可用新题（可重试错误）：原作答保持，可再次重试', async () => {
    stubApi({
      '/api/today': makeActive(taskB, { completed: 1, total: 2 }),
      '/api/today/tasks': makeTasksResponse(
        [makeSessionEntry(taskA, makeWrongAnswer()), makeSessionEntry(taskB, null)],
        'task-1',
      ),
      '/api/today/tasks/task-1/undo': () =>
        Promise.reject(new Error('暂时没有可用的新题，请稍后重试')),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'beta' });

    fireEvent.click(await screen.findByRole('button', { name: '撤销最近一次作答' }));
    const dialog = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }));
    expect(await within(dialog).findByText('暂时没有可用的新题，请稍后重试')).toBeVisible();

    // 原作答保持：结果分布未变
    expect(screen.getByText('通过 0 · 基础通过 0 · 未通过 1')).toBeVisible();
    // 确认按钮仍可用：允许重试（诚实提示，不吞请求）
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(2));
  });
});

describe('进度区交互：整个进度区为弹层入口', () => {
  beforeEach(() => vi.clearAllMocks());

  it('分段条嵌在入口按钮内：点分段打开弹层；自动发音开关是兄弟节点而非内嵌', async () => {
    const answered = makeChoiceTask();
    const pending = makeChoiceTask({
      taskId: 'task-2',
      item: {
        id: 'item-2',
        type: 'word',
        target: 'beta',
        meaning: '乙',
        ipa: null,
        notes: null,
      },
      question: {
        questionId: 'q-2',
        kind: 'direct_meaning',
        context: null,
        question: '"beta" 的意思是？',
        options: [
          { id: 'b1', text: '乙' },
          { id: 'b2', text: '甲' },
        ],
      },
    });
    stubApi({
      '/api/today': () => makeActive(pending, { completed: 1, total: 2 }),
      '/api/today/tasks': () =>
        makeTasksResponse([
          makeSessionEntry(answered, makeWrongAnswer()),
          makeSessionEntry(pending, null),
        ]),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'beta' });

    // 分段条渲染在入口按钮内部（数字/统计/分段条任意处皆可点）
    const entry = await screen.findByRole('button', { name: '查看今日学习' });
    const segs = await waitFor(() => {
      const found = entry.querySelectorAll('[data-seg]');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(segs[0]).toHaveAttribute('data-seg', 'fail');
    expect(segs[1]).toHaveAttribute('data-seg', 'pending');

    // 点分段条（而非按钮文字区）同样打开只读弹层，不改变当前题
    fireEvent.click(segs[1]!);
    expect(screen.getByRole('dialog', { name: '今日学习' })).toBeVisible();

    // 自动发音开关不在入口按钮内（button 嵌 button 非法嵌套），是按钮外兄弟节点
    expect(within(entry).queryByRole('button', { name: '自动发音' })).toBeNull();
    expect(screen.getByRole('button', { name: '自动发音' })).toBeVisible();
  });
});

describe('大队列进度区：不渲染每题色条', () => {
  beforeEach(() => vi.clearAllMocks());

  it('任务数 > 20 时仅显示完成/总数与文字统计，无 data-seg', async () => {
    const tasks = Array.from({ length: 21 }, (_, i) =>
      makeChoiceTask({
        taskId: `task-${i}`,
        item: {
          id: `item-${i}`,
          type: 'word',
          target: i === 20 ? 'omega' : `w${i}`,
          meaning: `义${i}`,
          ipa: null,
          notes: null,
        },
        question: {
          questionId: `q-${i}`,
          kind: 'direct_meaning',
          context: null,
          question: `"w${i}" 的意思是？`,
          options: [
            { id: `o${i}a`, text: `义${i}` },
            { id: `o${i}b`, text: '其他' },
          ],
        },
      }),
    );
    const current = tasks[20]!;
    stubApi({
      '/api/today': () => makeActive(current, { completed: 0, total: 21 }),
      '/api/today/tasks': () =>
        makeTasksResponse(tasks.map((task) => makeSessionEntry(task, null))),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'omega' });
    expect(await screen.findByText('今日 0 / 21')).toBeVisible();
    expect(screen.getByText('通过 0 · 基础通过 0 · 未通过 0')).toBeVisible();
    const entry = screen.getByRole('button', { name: '查看今日学习' });
    expect(entry.querySelectorAll('[data-seg]')).toHaveLength(0);
  });
});

describe('回前台自动刷新今日状态（2026-10-04）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('visibilitychange 变 visible 时 invalidate today（/api/today 重新请求）；hidden 不触发', async () => {
    stubApi({
      '/api/today': () => makeActive(makeChoiceTask()),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'stable' });
    // 精确匹配 /api/today（排除 /api/today/tasks 等前缀同源调用）
    const todayCallCount = () =>
      apiCalls('/api/today').filter((c) => c.path === '/api/today').length;
    const baseline = todayCallCount();
    expect(baseline).toBeGreaterThanOrEqual(1);

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      // 不可见（如切回 PWA 前台前）：不触发刷新
      visibility.mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 50));
      expect(todayCallCount()).toBe(baseline);

      // 回到可见：invalidate todayKeys.all，/api/today 重新请求（服务端批改已结算的结果立即可见）
      visibility.mockReturnValue('visible');
      fireEvent(document, new Event('visibilitychange'));
      await waitFor(() => expect(todayCallCount()).toBeGreaterThan(baseline));
    } finally {
      visibility.mockRestore();
    }
  });
});
