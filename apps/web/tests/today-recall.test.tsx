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
import { speak } from '../src/lib/tts';
const speakMock = vi.mocked(speak);
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

// Task 1 判定映射：recalled→pass（良好）/ easy→pass（简单）/ forgot→fail（重来）
// （assisted=basic_pass 仅历史数据，RecallFeedback 保留其回放判语）
const recalledAnswer = () => makeCorrectAnswer({ outcomeSource: 'recalled' });
const easyAnswer = () => makeCorrectAnswer({ outcomeSource: 'easy' });
const forgotAnswer = () => makeWrongAnswer({ outcomeSource: 'forgot', selectedOptionId: 'o2' });

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

/** 原句块 <p>（label span + 句子；目标词被 HighlightText 拆成 mark 后按整块 textContent 定位） */
function exampleBlock(sentence: string): HTMLElement {
  return screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === `原句${sentence}`);
}

/** 原句块内目标词高亮（HighlightText：词边界命中处 mark 带 text-accent，恰好一次）。
 *  HighlightText 另具备占位代词（one's/oneself → 任意人称，get one's butt kicked 命中
 *  gets his butt kicked）与首词不规则动词表（wear down → wore down）能力；本文件仅
 *  断言稳定单词 target，占位符/不规则形态由 highlight-text.test.tsx 直测覆盖。 */
function expectTargetHighlighted(block: HTMLElement, target: string) {
  const marks = within(block).getAllByText(
    (_, el) => el?.classList.contains('text-accent') === true,
  );
  expect(marks).toHaveLength(1);
  expect(marks[0]).toHaveTextContent(target);
}

describe('Recall Card（understanding）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('el:auto-pronounce');
  });

  it('过期作答显示刷新提示，不揭示答案或虚构成功', async () => {
    stubApi({
      '/api/today': makeActive(makeChoiceTask()),
      '/api/today/tasks/task-1/answer': () =>
        Promise.reject(new Error('会话已过期，请刷新今日学习')),
    });
    renderTodayApp();
    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '重来' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('会话已过期，请刷新今日学习');
    expect(screen.queryByText('正确释义：')).toBeNull();
    const before = apiCalls('/api/today').length;
    fireEvent.click(screen.getByRole('button', { name: '刷新今日学习' }));
    await waitFor(() => expect(apiCalls('/api/today').length).toBeGreaterThan(before));
  });

  it('初始：显示 target/IPA/source_example，揭示前仅全宽 [显示答案]，无任何自评键', async () => {
    stubApi({ '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }) });
    renderTodayApp();

    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(screen.getByText('/ˈsteɪbl/')).toBeVisible();
    // 原句默认展示（Recall Card 不再有"查看原句"）；目标词以 accent 高亮（HighlightText）
    const source = exampleBlock('The ladder feels stable.');
    expect(source).toBeVisible();
    expectTargetHighlighted(source, 'stable');
    expect(screen.getByRole('button', { name: '发音' })).toBeVisible();
    const revealBtn = screen.getByRole('button', { name: '显示答案' });
    expect(revealBtn).toBeVisible();
    expect(revealBtn.className).toContain('bg-accent'); // 全宽主按钮（primary/default）
    // 不剧透：meaning、题面与选项都不出现；揭示前没有任何三档自评键（2026-10-03 起无直判）
    expect(screen.queryByText('稳定的')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重来' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '良好' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '简单' })).not.toBeInTheDocument();
    expect(screen.queryByText('"stable" 的意思是？')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
  });

  it('点显示答案触发发音（默认开；沿用切卡自动读词偏好）', async () => {
    stubApi({ '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }) });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'stable' });
    speakMock.mockClear(); // 排除挂载切卡的自动读词

    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledWith('stable', { userGesture: true });
  });

  it('自动读词偏好关闭（el:auto-pronounce=0）：显示答案不发音', async () => {
    localStorage.setItem('el:auto-pronounce', '0');
    stubApi({ '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }) });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'stable' });
    speakMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    expect(speakMock).not.toHaveBeenCalled();
    expect(await screen.findByText('稳定的')).toBeVisible();
  });

  it('显示答案：meaning 展示、[重来][良好][简单] 三键等宽；点良好 → POST {recall:"recalled"} → 自动进入下一题', async () => {
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
    const againBtn = screen.getByRole('button', { name: '重来' });
    expect(againBtn).toBeVisible();
    expect(againBtn.className).toContain('text-destructive'); // 否定键暖红语义色
    expect(screen.getByRole('button', { name: '良好' }).className).toContain('bg-accent'); // primary
    const easyBtn = screen.getByRole('button', { name: '简单' });
    expect(easyBtn).toBeVisible();
    expect(easyBtn.className).toContain('border-border bg-muted'); // neutral 暖灰中性档
    const notesDetails = screen.getByText('笔记').closest('details');
    expect(notesDetails).toHaveAttribute('open');
    expect(notesDetails).toHaveTextContent('也作名词：马厩');

    // 评分即前进：不出现"下一题"，refetch 落地即切下一张卡
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
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

  it('显示答案后「简单」：POST {recall:"easy"} → 评分即前进', async () => {
    const statusQueue = [makeActive(makeChoiceTask(), { completed: 1, total: 4 })];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-1/answer': easyAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '简单' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'easy',
    });
    // 三键均评分即前进：直接切下一张卡，不冻结重放
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();
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
              makeSessionEntry(makeChoiceTask(), easyAnswer()),
              makeSessionEntry(secondTask(), null),
            ])
          : makeTasksResponse([
              makeSessionEntry(makeChoiceTask(), null),
              makeSessionEntry(secondTask(), null),
            ]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return easyAnswer();
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '简单' }));

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

  it('评分即前进：快照里造句题未绑定时走中性占位，不闪 pending 单词卡', async () => {
    const prodUnbound = { ...makeProductionTask({ taskId: 'task-prod' }), question: null };
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        return new Promise(() => {}); // 钉住乐观窗口：/api/today 挂起（真实世界几毫秒后携绑定题落地）
      },
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(makeChoiceTask(), easyAnswer()),
              makeSessionEntry(prodUnbound, null), // 上次快照：造句题尚未绑定（后台可能已绑好）
            ])
          : makeTasksResponse([
              makeSessionEntry(makeChoiceTask(), null),
              makeSessionEntry(prodUnbound, null),
            ]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return easyAnswer();
      },
    });
    renderTodayApp();
    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '简单' }));
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1));

    // 中性占位：不按旧快照渲染 pending 单词卡（原句/正在准备），输入框也未到
    expect(await screen.findByText('正在加载下一题…')).toBeVisible();
    expect(screen.queryByText('正在准备…')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('表达答案')).not.toBeInTheDocument();
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
        return easyAnswer();
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '简单' }));

    expect(await screen.findByText('正在加载下一题…')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'ambitious' })).not.toBeInTheDocument();
  });

  it('重来（显示答案后）：POST {recall:"forgot"} → 评分即前进，不冻结重放答案（§7.1 揭示后三键均直接切）', async () => {
    const statusQueue = [makeActive(makeChoiceTask(), { completed: 1, total: 4 })];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-1/answer': forgotAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '重来' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'forgot',
    });

    // 答案揭示时已在屏，评分即前进：不冻结重放、不出现下一题按钮，直接切下一张卡
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();
  });

  // 揭示前直判分支已删除（2026-10-03 三档改版：唯一入口是「显示答案」，见上方"初始"用例）；
  // 回看（readOnly 冻结态）已随顺序导航删除（2026-09-28 决策）：历史记录只在「今日学习」只读列表展示，
  // 冻结反馈的只读断言由 today-navigation / today-active 的弹层用例覆盖。

  // refetch 失败兜底：自评后停留冻结反馈（历史 outcomeSource=NULL 按 result 回退判定文案）
  it('refetch 失败：自评后停留冻结反馈（历史 outcomeSource=NULL 回退"良好"），下一题兜底仍在', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));

    const verdict = await verdictParagraph('良好');
    expect(verdict.className).toContain('text-success');
    expect(screen.queryByText('重来')).not.toBeInTheDocument();
    // 刷新失败不自动前进：人工兜底入口仍在（坏题入口在「今日学习」记录上，不在卡面）
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();
  });

  it('refetch 失败：历史 outcomeSource=NULL 回退"重来"+释义揭示', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: '重来' }));

    const verdict = await verdictParagraph('重来');
    expect(verdict.className).toContain('text-destructive');
    expect(screen.getByText('稳定的')).toBeVisible();
    // 冻结反馈的原句块同样高亮目标词
    const frozenExample = exampleBlock('The ladder feels stable.');
    expect(frozenExample).toBeVisible();
    expectTargetHighlighted(frozenExample, 'stable');
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
  });

  it('refetch 失败：easy 冻结判语显示「简单」（text-success，与 良好 同为通过色）', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        throw new Error('network down');
      },
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return easyAnswer();
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '简单' }));

    const verdict = await verdictParagraph('简单');
    expect(verdict.className).toContain('text-success');
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
  });
});

describe('learn 分派 RecallCard（新词首触即回忆）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('learn 任务渲染 RecallCard：初始不剧透 meaning/选项；显示答案→良好→POST {recall:"recalled"}', async () => {
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
    expect(exampleBlock('I laugh at gravity all the time.')).toBeVisible();
    expect(screen.queryByText('重力')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
    // 揭示前仅全宽「显示答案」：三档自评键都不出现（与 understanding 卡一致）
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '重来' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '良好' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '简单' })).not.toBeInTheDocument();

    // 显示答案 → 良好（recall 直判）
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    expect(await screen.findByText('重力')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '良好' }));

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

  it('learn 显示答案后「简单」：POST {recall:"easy"}（首学 easy 等同 pass）', async () => {
    const statusQueue = [makeActive(makeLearnTask(), { completed: 1, total: 4 })];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-learn/answer': easyAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '简单' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-learn/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-learn/answer')[0])).toEqual({
      recall: 'easy',
    });
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
  });
});
