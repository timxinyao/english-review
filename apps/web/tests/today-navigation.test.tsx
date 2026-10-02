import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
  makeProductionTask,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

/** 会话 fixture（2026-09-28 改版）：t1 对、t2 基础通过、t3 错、t4 当前未做 */
const alphaItem = {
  id: 'i1',
  type: 'word' as const,
  target: 'alpha',
  meaning: '甲',
  ipa: '/ælfa/',
  notes: null,
};
const t1 = makeChoiceTask({ taskId: 'task-1', item: alphaItem });
const t2 = makeChoiceTask({
  taskId: 'task-2',
  item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: null, notes: null },
});
const t3 = makeChoiceTask({
  taskId: 'task-3',
  item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null, notes: null },
});
const t4 = makeChoiceTask({
  taskId: 'task-4',
  item: { id: 'i4', type: 'word', target: 'delta', meaning: '丁', ipa: null, notes: null },
});

const recalledPass = () => makeCorrectAnswer({ outcomeSource: 'recalled', correctOptionId: 'o1' });
const assistedBasic = () =>
  makeCorrectAnswer({
    result: 'basic_pass',
    outcomeSource: 'assisted',
    selectedOptionId: 'o2',
    correctOptionId: 'o1',
    explanation: '结合上下文选择释义。',
  });
const wrong = () => makeWrongAnswer();

/** 进度分布 fixture：对 1 · 基础 1 · 错 1 · 未做 1（当前=delta） */
function stubDistributionSession() {
  stubApi({
    '/api/today': makeActive(t4, { completed: 3, total: 4 }),
    '/api/today/tasks': makeTasksResponse([
      makeSessionEntry(t1, recalledPass()),
      makeSessionEntry(t2, assistedBasic()),
      makeSessionEntry(t3, wrong()),
      makeSessionEntry(t4, null),
    ]),
  });
}

describe('Today 进度：结果分布（PRODUCT §5.1）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('四色分段 + 文字计数：绿对/黄基础/红错/灰未做，当前段高亮；已完成数/总数', async () => {
    stubDistributionSession();
    renderTodayApp();

    // 文字计数（不以颜色为唯一载体）与 完成数/总数
    expect(await screen.findByText('通过 1 · 基础通过 1 · 未通过 1')).toBeVisible();
    expect(screen.getByText('3 / 4')).toBeVisible();

    // 分布分段按结果着色：pass / basic_pass / fail / pending 各一段
    await waitFor(() => expect(document.querySelectorAll('[data-seg]')).toHaveLength(4));
    expect(document.querySelectorAll('[data-seg="pass"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-seg="basic_pass"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-seg="fail"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-seg="pending"]')).toHaveLength(1);
    // 当前题分段高亮
    const current = document.querySelector('[data-current="true"]');
    expect(current).not.toBeNull();
    expect(current!.getAttribute('data-seg')).toBe('pending');
  });

  it('已撤销任务不计入分母与分布：计数只看未撤销条目', async () => {
    const t5 = makeChoiceTask({
      taskId: 'task-5',
      item: { id: 'i5', type: 'word', target: 'zeta', meaning: '戊', ipa: null, notes: null },
    });
    stubApi({
      // 服务端 progressOf 已排除撤销（Task 2）；前端同样从批量视图排除
      '/api/today': makeActive(t4, { completed: 3, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, recalledPass()),
        makeSessionEntry(t2, assistedBasic()),
        makeSessionEntry(t3, wrong()),
        makeSessionEntry(t5, null, true), // 已撤销（曾作答后被坏题/撤销）
        makeSessionEntry(t4, null),
      ]),
    });
    renderTodayApp();

    expect(await screen.findByText('通过 1 · 基础通过 1 · 未通过 1')).toBeVisible();
    expect(screen.getByText('3 / 4')).toBeVisible(); // 分母 4 = 5 条 - 1 撤销
    await waitFor(() => expect(document.querySelectorAll('[data-seg]')).toHaveLength(4)); // 撤销条目无分段
  });

  it('补强动态增加总题数：作答（错题插补强）后总数 4 → 5', async () => {
    let answered = false;
    const t5 = makeChoiceTask({
      taskId: 'task-5',
      item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null, notes: null },
    });
    stubApi({
      '/api/today': () =>
        answered
          ? makeActive(t4, { completed: 3, total: 5 })
          : makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(t1, recalledPass()),
              makeSessionEntry(t2, assistedBasic()),
              makeSessionEntry(t3, wrong()),
              makeSessionEntry(t4, null),
              makeSessionEntry(t5, null), // 补强题排在队尾
            ])
          : makeTasksResponse([
              makeSessionEntry(t1, recalledPass()),
              makeSessionEntry(t2, assistedBasic()),
              makeSessionEntry(t3, null),
              makeSessionEntry(t4, null),
            ]),
      '/api/today/tasks/task-3/answer': () => {
        answered = true;
        return makeWrongAnswer({ reinforcementAdded: true });
      },
    });
    renderTodayApp();
    expect(await screen.findByText('2 / 4')).toBeVisible();

    // 答错 → 留在当前卡看揭示 → 手动下一题；补强使总数变 5
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));
    fireEvent.click(await screen.findByRole('button', { name: '下一题' }));
    expect(await screen.findByText('3 / 5')).toBeVisible();
    expect(screen.getByText('通过 1 · 基础通过 1 · 未通过 1')).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('[data-seg]')).toHaveLength(5));
  });

  it('键盘 ←/→ 不再导航：不产生 later 调用', async () => {
    stubDistributionSession();
    renderTodayApp();
    await screen.findByText('通过 1 · 基础通过 1 · 未通过 1');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await new Promise((r) => setTimeout(r, 200));
    expect(apiCalls('/api/today/tasks/task-4/later')).toHaveLength(0);
    // 当前题未变
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });

  it('答对：refetch 成功后自动推进到下一题（评分即前进）', async () => {
    let answered = false;
    stubApi({
      '/api/today': () =>
        answered
          ? makeActive(t4, { completed: 3, total: 4 })
          : makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(t1, recalledPass()),
              makeSessionEntry(t2, assistedBasic()),
              makeSessionEntry(t3, makeCorrectAnswer({ outcomeSource: 'recalled' })),
              makeSessionEntry(t4, null),
            ])
          : makeTasksResponse([
              makeSessionEntry(t1, recalledPass()),
              makeSessionEntry(t2, assistedBasic()),
              makeSessionEntry(t3, null),
              makeSessionEntry(t4, null),
            ]),
      '/api/today/tasks/task-3/answer': () => {
        answered = true;
        return makeCorrectAnswer({ outcomeSource: 'recalled' });
      },
    });
    renderTodayApp();
    await screen.findByText('2 / 4');
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));
    // 无需点"下一题"：refetch 落地即到下一题
    expect(await screen.findByRole('heading', { name: 'delta' })).toBeVisible();
    expect(await screen.findByText('3 / 4')).toBeVisible();
  });
});

describe('Today「今日学习」只读列表（PRODUCT §5.1/§6.5）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('点击进度打开弹层：不影响当前题；portal 到 body；遮罩点击关闭', async () => {
    stubDistributionSession();
    renderTodayApp();
    await screen.findByText('通过 1 · 基础通过 1 · 未通过 1');

    fireEvent.click(screen.getByRole('button', { name: '查看今日学习' }));
    const dialog = screen.getByRole('dialog', { name: '今日学习' });
    await waitFor(() => expect(dialog).toBeVisible());
    // portal：弹层直接挂在 body 下
    expect(dialog.parentElement).toBe(document.body);
    // 当前题不被改变：弹层之下仍是当前卡
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();

    // 面板内部点击不关闭
    fireEvent.click(within(dialog).getByText('今日学习'));
    expect(dialog).toBeVisible();
    // 遮罩关闭后回到原当前题
    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '今日学习' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });

  it('按学习项去重：同 item 多题只一组；记录含题面/作答/正确答案/解释，含「不会」', async () => {
    const t1b = makeChoiceTask({ taskId: 'task-1b', item: alphaItem });
    const prod = makeProductionTask({
      taskId: 'task-p',
      item: { id: 'i9', type: 'chunk', target: 'epsilon', meaning: '放弃', ipa: null, notes: null },
    });
    const gaveUp = makeWrongAnswer({
      gaveUp: true,
      explanation: '考察日常表达。',
      correctOptionId: null,
      outcomeSource: 'forgot',
      reinforcementAdded: false,
      referenceAnswer: 'Never give up your dreams.',
    });
    stubApi({
      '/api/today': makeActive(t4, { completed: 4, total: 5 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, recalledPass()),
        makeSessionEntry(t1b, assistedBasic()),
        makeSessionEntry(t2, wrong()),
        makeSessionEntry(prod, gaveUp),
        makeSessionEntry(t4, null),
      ]),
    });
    renderTodayApp();
    await screen.findByText('通过 1 · 基础通过 1 · 未通过 2');

    fireEvent.click(screen.getByRole('button', { name: '查看今日学习' }));
    const dialog = screen.getByRole('dialog', { name: '今日学习' });
    await waitFor(() => expect(dialog).toBeVisible());

    // alpha 两次作答只出现一组（组头 target 不重复）；组头含 IPA（仅 Word）与释义
    expect(within(dialog).getAllByText('alpha')).toHaveLength(1);
    const alphaGroup = within(dialog).getByRole('button', { name: /alpha/ });
    expect(within(alphaGroup).getByText('/ælfa/')).toBeVisible();
    expect(within(alphaGroup).getByText('甲')).toBeVisible();

    // 展开 alpha：两条记录（题面重复两次），各自作答 + 正确答案 + 解释
    fireEvent.click(alphaGroup);
    expect(within(dialog).getAllByText('"stable" 的意思是？')).toHaveLength(2);
    expect(within(dialog).getByText('想起来了')).toBeVisible(); // recall 直判作答
    expect(within(dialog).getByText('摇晃的')).toBeVisible(); // 提示后选择的选项文本
    expect(within(dialog).getAllByText('稳定的').length).toBeGreaterThanOrEqual(1); // 正确答案（正确选项文本）
    expect(within(dialog).getByText('结合上下文选择释义。')).toBeVisible(); // 解释

    // epsilon 表达题主动不会：作答「不会」+ 参考句
    fireEvent.click(within(dialog).getByRole('button', { name: /epsilon/ }));
    expect(within(dialog).getByText('不会')).toBeVisible();
    expect(within(dialog).getByText('Never give up your dreams.')).toBeVisible();
    expect(within(dialog).getByText('考察日常表达。')).toBeVisible();
  });

  it('未作答与已撤销记录只展示、不可跳转：无链接/无坏题入口，点击不改变当前题', async () => {
    const t5 = makeChoiceTask({
      taskId: 'task-5',
      item: { id: 'i5', type: 'word', target: 'zeta', meaning: '戊', ipa: null, notes: null },
    });
    stubApi({
      '/api/today': makeActive(t4, { completed: 3, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, recalledPass()),
        makeSessionEntry(t2, assistedBasic()),
        makeSessionEntry(t3, wrong()),
        makeSessionEntry(t5, null, true), // 已撤销
        makeSessionEntry(t4, null), // 未作答（当前）
      ]),
    });
    renderTodayApp();
    await screen.findByText('通过 1 · 基础通过 1 · 未通过 1');

    fireEvent.click(screen.getByRole('button', { name: '查看今日学习' }));
    const dialog = screen.getByRole('dialog', { name: '今日学习' });
    await waitFor(() => expect(dialog).toBeVisible());

    // 展开未作答（delta，当前题）与已撤销（zeta）分组
    // 分组头是 li 内的 button，展开的记录行在同级 ul：断言范围取分组 li
    const deltaSection = within(
      within(dialog).getByRole('button', { name: /delta/ }).closest('li')!,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /delta/ }));
    expect(deltaSection.getByText('未作答')).toBeVisible();
    // 未作答记录无坏题入口（尚未作答，无记录可失效）
    expect(deltaSection.queryByRole('button', { name: '坏题' })).toBeNull();

    const zetaButton = within(dialog).getByRole('button', { name: /zeta/ });
    const zetaSection = within(zetaButton.closest('li')!);
    fireEvent.click(zetaButton);
    expect(zetaSection.getByText('已撤销')).toBeVisible();
    expect(zetaSection.queryByRole('button', { name: '坏题' })).toBeNull();

    // 只读：整个弹层没有任何链接（不用于跳题/回看/重答）
    expect(within(dialog).queryByRole('link')).toBeNull();
    // 点击已撤销记录行：不导航、不关弹层、当前题不变
    fireEvent.click(zetaSection.getByText('已撤销'));
    expect(screen.queryByRole('dialog', { name: '今日学习' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });

  it('坏题：从具体记录标记（confirm），旧记录 409 时展示无法失效的原因', async () => {
    const t1b = makeChoiceTask({
      taskId: 'task-1b',
      item: alphaItem,
      question: {
        questionId: 'q-1b',
        kind: 'direct_meaning',
        context: null,
        question: '"alpha" 接近的意思是？',
        options: [
          { id: 'o1', text: '稳定的' },
          { id: 'o2', text: '摇晃的' },
          { id: 'o3', text: '昂贵的' },
        ],
      },
    });
    stubApi({
      '/api/today': makeActive(t4, { completed: 3, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, wrong()), // 旧记录
        makeSessionEntry(t1b, wrong()), // 同 item 更近一次作答
        makeSessionEntry(t2, assistedBasic()),
        makeSessionEntry(t4, null),
      ]),
      // 服务端 409：已有后续作答，该记录无法再失效（ApiError.message 透传）
      '/api/today/tasks/task-1/bad-question': () =>
        Promise.reject(new Error('已有后续作答，无法撤销')),
    });
    renderTodayApp();
    await screen.findByText('通过 0 · 基础通过 1 · 未通过 2');

    fireEvent.click(screen.getByRole('button', { name: '查看今日学习' }));
    const dialog = screen.getByRole('dialog', { name: '今日学习' });
    await waitFor(() => expect(dialog).toBeVisible());
    fireEvent.click(within(dialog).getByRole('button', { name: /alpha/ }));

    // 旧记录（task-1）标记坏题：confirm 后提交到该记录
    const oldRow = within(dialog).getByText('"stable" 的意思是？').closest('li')!;
    fireEvent.click(within(oldRow).getByRole('button', { name: '坏题' }));
    const confirmDialog = screen.getByRole('dialog', { name: '标记坏题' });
    expect(screen.getByText('标记坏题将撤销本次作答影响')).toBeVisible();
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/bad-question')).toHaveLength(1);
      expect(apiCalls('/api/today/tasks/task-1b/bad-question')).toHaveLength(0);
    });
    // 409 解释：说明该记录已无法失效
    await waitFor(() => expect(within(oldRow).getByText('已有后续作答，无法撤销')).toBeVisible());
  });
});
