import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
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

const apiMock = vi.mocked(api);

// Task 1 判定映射：recalled→pass / assisted→basic_pass / forgot→fail
const recalledAnswer = () => makeCorrectAnswer({ outcomeSource: 'recalled' });
const assistedAnswer = () => makeCorrectAnswer({ result: 'basic_pass', outcomeSource: 'assisted' });
const forgotAnswer = () => makeWrongAnswer({ outcomeSource: 'forgot' });

/** 第 2 张卡（用于断言"下一题"确实切换了任务） */
function secondTask() {
  return makeChoiceTask({
    taskId: 'task-2',
    item: { id: 'item-2', type: 'word', target: 'ambitious', meaning: '有雄心的', ipa: '/æmˈbɪʃəs/' },
  });
}

/** 冻结反馈判定 <p>（与作答按钮文案相同，须按元素区分以避开卸载时序） */
function verdictParagraph(text: string): Promise<HTMLElement> {
  return screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === text);
}

describe('Recall Card（understanding）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('初始：显示 target/IPA/source_example 与 [给我提示][显示答案]，不显示 meaning 与选项', async () => {
    stubApi({ '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }) });
    renderTodayApp();

    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(screen.getByText('/ˈsteɪbl/')).toBeVisible();
    // 原句默认展示（Recall Card 不再有"查看原句"）
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    expect(screen.getByRole('button', { name: '发音' })).toBeVisible();
    expect(screen.getByRole('button', { name: '给我提示' })).toBeVisible();
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
    // 不剧透：meaning、题面与选项都不出现
    expect(screen.queryByText('稳定的')).not.toBeInTheDocument();
    expect(screen.queryByText('"stable" 的意思是？')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
  });

  it('显示答案：meaning 展示、[没想起来][想起来了]；点想起来了 → POST {recall:"recalled"} → 冻结"想起来了"', async () => {
    const statusQueue = [makeActive(makeChoiceTask())];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-1/answer': recalledAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    expect(await screen.findByText('稳定的')).toBeVisible();
    expect(screen.getByRole('button', { name: '没想起来' })).toBeVisible();
    expect(screen.getByRole('button', { name: '想起来了' })).toBeVisible();
    // 揭示态不再提供提示入口
    expect(screen.queryByRole('button', { name: '给我提示' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '想起来了' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'recalled',
    });

    // 冻结反馈：recalled 文案（success 色）
    const verdict = await verdictParagraph('想起来了');
    expect(verdict.className).toContain('text-success');
    // understanding 由 RecallCard 自带词行：TaskCard 顶部词行不重复
    expect(screen.getAllByRole('heading', { name: 'stable' })).toHaveLength(1);

    // 手动"下一题"推进（与其他题型一致）
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });

  it('没想起来：POST {recall:"forgot"} → 冻结显示正确 meaning + source_example 突出', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': forgotAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'forgot',
    });

    const verdict = await verdictParagraph('没想起来');
    expect(verdict.className).toContain('text-destructive');
    // 正确释义揭示 + source_example 突出块（原句样式）
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
  });

  it('Hint：点给我提示出现选择题；选对 → POST {selectedOptionId, hintUsed:true} → 冻结"提示后想起（基础通过）"', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': assistedAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '给我提示' }));

    // Hint 复用选择题：题面 + 选项；仅答题形态（无查看原句、无反馈 chips）
    expect(await screen.findByText('"stable" 的意思是？')).toBeVisible();
    expect(screen.getByRole('group', { name: '选项' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看原句' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '给我提示' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '显示答案' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      selectedOptionId: 'o1',
      hintUsed: true,
    });

    // 提交后父级立即冻结：选择题不再渲染
    expect(await verdictParagraph('提示后想起（基础通过）')).toBeVisible();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
  });

  it('Hint 选错 → 冻结"没想起来"+正确释义揭示', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': forgotAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '给我提示' }));
    fireEvent.click(await screen.findByRole('button', { name: '摇晃的' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      selectedOptionId: 'o2',
      hintUsed: true,
    });

    expect(await verdictParagraph('没想起来')).toBeVisible();
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
  });

  it('readOnly 回看：直接呈现冻结态，无作答按钮', async () => {
    const done = makeChoiceTask({
      taskId: 'task-1',
      item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null },
    });
    const current = makeChoiceTask({
      taskId: 'task-2',
      item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: null },
    });
    stubApi({
      '/api/today': makeActive(current, { completed: 1, total: 2 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(done, recalledAnswer()),
        makeSessionEntry(current, null),
      ]),
    });
    renderTodayApp();
    await screen.findByText('第 2 / 2');

    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /alpha/ }),
    );
    await screen.findByText('第 1 / 2');

    // 冻结回看：recalled 反馈 + 词行；不出现任何作答入口
    expect(await verdictParagraph('想起来了')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '给我提示' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '显示答案' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '没想起来' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '想起来了' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
  });
});
