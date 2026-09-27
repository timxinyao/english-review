import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCard } from '../src/features/today/components/TaskCard';
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
    item: { id: 'item-2', type: 'word', target: 'ambitious', meaning: '有雄心的', ipa: '/æmˈbɪʃəs/', notes: null },
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
    // notes 折叠链路：fixture 带笔记，揭示态默认收起（summary 可见）
    const withNotes = makeChoiceTask({
      item: { id: 'item-1', type: 'word', target: 'stable', meaning: '稳定的', ipa: '/ˈsteɪbl/', notes: '也作名词：马厩' },
    });
    const statusQueue = [makeActive(withNotes)];
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
    // notes 折叠渲染：summary「笔记」可见，details 默认收起（内容随展开才显示）
    expect(screen.getByText('笔记')).toBeVisible();
    const notesDetails = screen.getByText('笔记').closest('details');
    expect(notesDetails).not.toBeNull();
    expect(notesDetails).not.toHaveAttribute('open');
    expect(notesDetails).toHaveTextContent('也作名词：马厩');
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
    // hint 态原句块隐藏：不与题面重复展示源句
    expect(screen.queryByText('The ladder feels stable.')).not.toBeInTheDocument();
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
      item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null, notes: null },
    });
    const current = makeChoiceTask({
      taskId: 'task-2',
      item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: null, notes: null },
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

  // 历史数据（outcomeSource=NULL）冻结回退：按 result 渲染
  it('历史 outcomeSource=NULL：result.correct=true 冻结回退"想起来了"', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': makeCorrectAnswer(), // 无 outcomeSource
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));

    const verdict = await verdictParagraph('想起来了');
    expect(verdict.className).toContain('text-success');
    expect(screen.queryByText('没想起来')).not.toBeInTheDocument();
  });

  it('历史 outcomeSource=NULL：result.correct=false 冻结回退"没想起来"+释义揭示', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': makeWrongAnswer(), // 无 outcomeSource
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));

    const verdict = await verdictParagraph('没想起来');
    expect(verdict.className).toContain('text-destructive');
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
  });

  it('历史 outcomeSource=NULL 且 readOnly（result=null）：中性回看——仅 meaning，无判定文案', () => {
    // 会话内（列表回看）到不了 result=null 的冻结态，直接以 readOnly 渲染 TaskCard
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TaskCard
          task={makeChoiceTask()}
          result={null}
          readOnly
          onAnswered={() => {}}
          onAdvance={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.queryByText('想起来了')).not.toBeInTheDocument();
    expect(screen.queryByText('没想起来')).not.toBeInTheDocument();
    expect(screen.queryByText('提示后想起（基础通过）')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '显示答案' })).not.toBeInTheDocument();
  });
});
