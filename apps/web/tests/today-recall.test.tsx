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
  makeLearnTask,
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

  it('显示答案：meaning 展示、[没想起来][想起来了]；点想起来了 → POST {recall:"recalled"} → 自动进入下一题', async () => {
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
    const notesDetails = screen.getByText('笔记').closest('details');
    expect(notesDetails).toHaveAttribute('open');
    expect(notesDetails).toHaveTextContent('也作名词：马厩');
    expect(screen.queryByRole('button', { name: '给我提示' })).not.toBeInTheDocument();

    // 评分即前进：不出现"下一题"，refetch 落地即切下一张卡
    fireEvent.click(screen.getByRole('button', { name: '想起来了' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'recalled',
    });
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });

  it('评分即前进：刷新落地前用预取队列直接渲染下一题（无占位、无反馈闪现）', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        return new Promise(() => {}); // 状态刷新挂起：钉住乐观窗口
      },
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(makeChoiceTask(), recalledAnswer()),
              makeSessionEntry(secondTask(), null),
            ])
          : makeTasksResponse([
              makeSessionEntry(makeChoiceTask(), null),
              makeSessionEntry(secondTask(), null),
            ]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return recalledAnswer();
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '想起来了' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    // 无占位：直接渲染预取队列的下一题（ambitious），不带旧题反馈与兜底按钮
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByText('正在加载下一题…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();
    // 进度同步推进
    expect(screen.getByText('第 2 / 2')).toBeVisible();
  });

  it('评分即前进（末题）：队列无下一题时占位等待刷新（完成页统计只能来自刷新）', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 0, total: 1 });
        return new Promise(() => {});
      },
      '/api/today/tasks': makeTasksResponse([makeSessionEntry(makeChoiceTask(), null)]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return recalledAnswer();
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '想起来了' }));

    expect(await screen.findByText('正在加载下一题…')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'ambitious' })).not.toBeInTheDocument();
  });

  it('没想起来：POST {recall:"forgot"} → 自动进入下一题（释义在揭示态已看过）', async () => {
    const statusQueue = [makeActive(makeChoiceTask(), { completed: 1, total: 4 })];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
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
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
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

    // 提交后父级立即冻结：选择题不再渲染；释义与原句保留（不能只有一行判语）
    expect(await verdictParagraph('提示后想起（基础通过）')).toBeVisible();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
    expect(screen.getByText('释义：')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
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

  // refetch 失败兜底：自评后停留冻结反馈（历史 outcomeSource=NULL 按 result 回退判定文案）
  it('refetch 失败：自评后停留冻结反馈（历史 outcomeSource=NULL 回退"想起来了"），下一题/坏题兜底仍在', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        throw new Error('network down');
      },
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeCorrectAnswer(); // 无 outcomeSource → 历史回退
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));

    const verdict = await verdictParagraph('想起来了');
    expect(verdict.className).toContain('text-success');
    expect(screen.queryByText('没想起来')).not.toBeInTheDocument();
    // 刷新失败不自动前进：人工兜底入口仍在
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
    expect(screen.getByRole('button', { name: '坏题' })).toBeVisible();
  });

  it('refetch 失败：历史 outcomeSource=NULL 回退"没想起来"+释义揭示', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        throw new Error('network down');
      },
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeWrongAnswer(); // 无 outcomeSource → 历史回退
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));

    const verdict = await verdictParagraph('没想起来');
    expect(verdict.className).toContain('text-destructive');
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
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

describe('learn 分派 RecallCard（新词首触即回忆）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('learn 任务渲染 RecallCard：初始不剧透 meaning/选项；显示答案→想起来了→POST {recall:"recalled"}', async () => {
    const statusQueue = [makeActive(makeLearnTask(), { completed: 1, total: 4 })];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-learn/answer': recalledAnswer(),
    });
    renderTodayApp();

    // 词行 + 原句（RecallCard 自带）；不剧透：meaning、选择题均不出现
    expect(await screen.findByRole('heading', { name: 'gravity' })).toBeVisible();
    expect(screen.getByText('/ˈɡrævəti/')).toBeVisible();
    expect(screen.getByText('I laugh at gravity all the time.')).toBeVisible();
    expect(screen.queryByText('重力')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
    expect(screen.getByRole('button', { name: '给我提示' })).toBeVisible();

    // 显示答案 → 想起来了（recall 直判）
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    expect(await screen.findByText('重力')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '想起来了' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-learn/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-learn/answer')[0])).toEqual({
      recall: 'recalled',
    });

    // 评分即前进：refetch 落地自动到下一张卡（learn 与 understanding 同路径）
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'gravity' })).not.toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });
});
