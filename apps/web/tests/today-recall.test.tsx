import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// （hint 选择题路径的冻结勾选回放依赖服务端 selectedOptionId，与 API 契约一致）
const recalledAnswer = () => makeCorrectAnswer({ outcomeSource: 'recalled' });
const assistedAnswer = () =>
  makeCorrectAnswer({ result: 'basic_pass', outcomeSource: 'assisted', selectedOptionId: 'o1' });
const forgotAnswer = () =>
  makeWrongAnswer({ outcomeSource: 'forgot', selectedOptionId: 'o2' });

/** 第 2 张卡（用于断言"下一题"确实切换了任务） */
function secondTask() {
  return makeChoiceTask({
    taskId: 'task-2',
    item: {
      id: 'item-2',
      type: 'word',
      target: 'ambitious',
      meaning: '有雄心的',
      ipa: '/æmˈbɪʃəs/',
      notes: null,
    },
  });
}

/** 冻结反馈判定 <p>（与作答按钮文案相同，须按元素区分以避开卸载时序） */
function verdictParagraph(text: string): Promise<HTMLElement> {
  return screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === text);
}

/** 冻结反馈的释义行 <p>（Hint 冻结时与选项按钮/正确答案行文案可能相同，按整段区分） */
function meaningParagraph(): HTMLElement {
  return screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '正确释义：稳定的');
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
      item: {
        id: 'item-1',
        type: 'word',
        target: 'stable',
        meaning: '稳定的',
        ipa: '/ˈsteɪbl/',
        notes: '也作名词：马厩',
      },
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
    // 进度同步推进（已完成数/总数）
    expect(screen.getByText('1 / 2')).toBeVisible();
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

  it('没想起来：POST {recall:"forgot"} → 留在当前卡看揭示，手动下一题（§7.6 不会/答错不自动切）', async () => {
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

    // 留在当前卡：判语 + 释义/原句揭示；不自动切下一题
    expect(await verdictParagraph('没想起来')).toBeVisible();
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'ambitious' })).not.toBeInTheDocument();

    // 手动下一题才切换
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
  });

  it('主动回忆入口：可直接点「没想起来」（§7.1）POST {recall:"forgot"} 并留在当前卡', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': forgotAnswer(),
    });
    renderTodayApp();

    // 揭示前即可直接声明没想起来；不剧透 meaning
    expect(await screen.findByRole('button', { name: '没想起来' })).toBeVisible();
    expect(screen.queryByText('稳定的')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '没想起来' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'forgot',
    });

    expect(await verdictParagraph('没想起来')).toBeVisible();
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    // 留在当前卡手动下一题；不出现虚构的选择题纠错
    expect(screen.getByRole('button', { name: '下一题' })).toBeVisible();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'ambitious' })).not.toBeInTheDocument();
  });

  it('Hint 主动不会：点「不会」POST {giveUp:true} → 留在当前卡；只勾正确选项与理由，不虚构错误标记', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': makeWrongAnswer({
        gaveUp: true,
        selectedOptionId: null,
        outcomeSource: 'forgot',
      }),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '给我提示' }));
    fireEvent.click(await screen.findByRole('button', { name: '不会' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({ giveUp: true });

    // 留在当前卡：判语 + 释义/原句 + 选项纠错（只勾正确项）
    expect(await verdictParagraph('没想起来')).toBeVisible();
    expect(meaningParagraph()).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    const group = screen.getByRole('group', { name: '选项' });
    expect(within(group).getByRole('button', { name: '稳定的' }).className).toContain(
      'text-success',
    );
    expect(within(group).getByRole('button', { name: '摇晃的' }).className).not.toContain(
      'text-destructive',
    );
    expect(screen.getByText('stable 在这里指结构上的稳固。')).toBeVisible();

    // 手动下一题；未自动切换
    expect(screen.getByRole('button', { name: '下一题' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'ambitious' })).not.toBeInTheDocument();
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

    // 提交后父级立即冻结：assisted 基础通过判语 + 释义/原句 + 勾选正确选项；
    // Hint 答对无「其实是蒙的」入口（§7.6：蒙的已移除）
    const assistedVerdict = await verdictParagraph('提示后想起（基础通过）');
    expect(assistedVerdict.className).toContain('text-warning');
    expect(screen.queryByText('其实是蒙的')).not.toBeInTheDocument();
    expect(screen.queryByText('其实我蒙的')).not.toBeInTheDocument();
    expect(screen.queryByText('太简单了')).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: '选项' });
    expect(within(group).getByRole('button', { name: '稳定的' }).className).toContain(
      'text-success',
    );
    expect(screen.getByText('释义：')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
  });

  it('Hint 选错 → 冻结"没想起来"+正确释义揭示+统一纠错（勾错选/正确项并展示理由）', async () => {
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
    expect(meaningParagraph()).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    // 统一纠错：错误选项与正确选项都标记，并展示选择理由（result.selectedOptionId 回放也生效）
    const group = screen.getByRole('group', { name: '选项' });
    expect(within(group).getByRole('button', { name: '摇晃的' }).className).toContain(
      'text-destructive',
    );
    expect(within(group).getByRole('button', { name: '稳定的' }).className).toContain(
      'text-success',
    );
    expect(screen.getByText('stable 在这里指结构上的稳固。')).toBeVisible();
  });

  // 回看（readOnly 冻结态）已随顺序导航删除（2026-09-28 决策）：历史记录只在「今日学习」只读列表展示，
  // 冻结反馈的只读断言由 today-navigation / today-active 的弹层用例覆盖。

  // refetch 失败兜底：自评后停留冻结反馈（历史 outcomeSource=NULL 按 result 回退判定文案）
  it('refetch 失败：自评后停留冻结反馈（历史 outcomeSource=NULL 回退"想起来了"），下一题兜底仍在', async () => {
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
    // 刷新失败不自动前进：人工兜底入口仍在（坏题入口在「今日学习」记录上，不在卡面）
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();
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
