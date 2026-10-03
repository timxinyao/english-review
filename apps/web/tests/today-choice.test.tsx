import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChoiceQuestionCard } from '../src/components/choice-question-card';
import { api } from '../src/lib/api';
import {
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
  makeLearnTask,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

/** 第 2 张卡：understanding 复习（用于断言"下一题"确实切换了任务） */
function secondTask() {
  return makeChoiceTask({
    taskId: 'task-2',
    item: {
      id: 'item-2',
      type: 'word',
      target: 'stable',
      meaning: '稳定的',
      ipa: '/ˈsteɪbl/',
      notes: null,
    },
  });
}

/**
 * learn 首题走 Recall Card（2026-10-03 起三档自评：揭示前仅「显示答案」，揭示后
 * 重来/良好/简单三键；无「给我提示」入口）。注意：fake timers 下 RTL findBy* 永不 settle，
 * fake-timers 用例必须用同步 query（与既有 fake-timers 用例手法一致）。
 */
describe('Today learn 首题（Recall Card：三档自评）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeLearnTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-learn/answer': makeWrongAnswer(),
    });
  });

  it('active 态渲染进度 x / y；learn 分派 RecallCard——不剧透 meaning/选项，无提示入口', async () => {
    renderTodayApp();

    expect(await screen.findByText('1 / 4')).toBeVisible();
    // learn 渲染 RecallCard：不剧透 meaning，也无选项与提示入口（揭示前仅「显示答案」）
    expect(screen.queryByText('重力')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
    // 揭示前无任何三档自评键（2026-10-03 起唯一入口是「显示答案」）
    expect(screen.queryByRole('button', { name: '重来' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '良好' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '简单' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '给我提示' })).not.toBeInTheDocument();
  });

  it('答对：refetch 成功后自动推进（评分即前进，无需点下一题）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeLearnTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
        '/api/today/tasks/task-learn/answer': makeCorrectAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
      fireEvent.click(screen.getByRole('button', { name: '良好' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChoiceQuestionCard 统一纠错（§7.6：答错/主动不会同版式；蒙的入口移除）', () => {
  const question = {
    questionId: 'q-1',
    context: null,
    question: '"stable" 的意思是？',
    options: [
      { id: 'o1', text: '稳定的' },
      { id: 'o2', text: '摇晃的' },
      { id: 'o3', text: '昂贵的' },
    ],
  };

  it('答对：只剩「太简单了」反馈，不出现任何蒙的入口', () => {
    render(
      <ChoiceQuestionCard
        question={question}
        result={makeCorrectAnswer({ correctOptionId: 'o1' })}
        pending={false}
        onSubmitOption={() => {}}
        onAdvance={() => {}}
        onFeedback={() => {}}
      />,
    );

    expect(screen.getByText('回答正确')).toBeVisible();
    expect(screen.getByRole('button', { name: '太简单了' })).toBeVisible();
    expect(screen.queryByText('其实是蒙的')).not.toBeInTheDocument();
    expect(screen.queryByText('其实我蒙的')).not.toBeInTheDocument();
  });

  it('答错：勾选错误选项与正确选项、展示正确答案与理由（result.selectedOptionId 驱动，回放同样生效）', () => {
    render(
      <ChoiceQuestionCard
        question={question}
        result={makeWrongAnswer({ selectedOptionId: 'o2', correctOptionId: 'o1' })}
        pending={false}
        onSubmitOption={() => {}}
        onAdvance={() => {}}
      />,
    );

    const group = screen.getByRole('group', { name: '选项' });
    expect(within(group).getByRole('button', { name: '摇晃的' }).className).toContain(
      'text-destructive',
    );
    expect(within(group).getByRole('button', { name: '稳定的' }).className).toContain(
      'text-success',
    );
    expect(within(group).getByRole('button', { name: '昂贵的' }).className).not.toContain(
      'text-destructive',
    );
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '正确答案：稳定的'),
    ).toBeVisible();
    expect(screen.getByText('stable 在这里指结构上的稳固。')).toBeVisible();
    expect(screen.queryByText('其实我蒙的')).not.toBeInTheDocument();
  });

  it('主动不会：只勾正确选项与理由，不虚构错误选项标记；判语「主动不会」；onGiveUp 触发', () => {
    const onGiveUp = vi.fn();
    render(
      <ChoiceQuestionCard
        question={question}
        result={makeWrongAnswer({
          gaveUp: true,
          selectedOptionId: null,
          correctOptionId: 'o1',
          explanation: 'stable 在这里指结构上的稳固。',
        })}
        pending={false}
        onSubmitOption={() => {}}
        onAdvance={() => {}}
        onGiveUp={onGiveUp}
      />,
    );

    expect(screen.getByText('主动不会')).toBeVisible();
    const group = screen.getByRole('group', { name: '选项' });
    expect(within(group).getByRole('button', { name: '稳定的' }).className).toContain(
      'text-success',
    );
    expect(within(group).getByRole('button', { name: '摇晃的' }).className).not.toContain(
      'text-destructive',
    );
    expect(screen.getByText('stable 在这里指结构上的稳固。')).toBeVisible();

    // 答题态才有「不会」入口；冻结态提供手动下一题
    expect(screen.queryByRole('button', { name: '不会' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一题' })).toBeVisible();
  });

  it('答题态：提供「不会」直接放弃入口，点击回调 onGiveUp', () => {
    const onGiveUp = vi.fn();
    render(
      <ChoiceQuestionCard
        question={question}
        result={null}
        pending={false}
        onSubmitOption={() => {}}
        onAdvance={() => {}}
        onGiveUp={onGiveUp}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '不会' }));
    expect(onGiveUp).toHaveBeenCalledOnce();
  });
});

describe('ChoiceQuestionCard 默认版式（Library 练一下）回归：选项在前、下一题不右移', () => {
  const question = {
    questionId: 'q-practice',
    context: null,
    question: '"stable" 的意思是？',
    options: [
      { id: 'o1', text: '稳定的' },
      { id: 'o2', text: '摇晃的' },
      { id: 'o3', text: '昂贵的' },
    ],
  };

  function renderFrozenWrong() {
    return render(
      <ChoiceQuestionCard
        question={question}
        result={makeWrongAnswer({ selectedOptionId: 'o2', correctOptionId: 'o1' })}
        pending={false}
        onSubmitOption={() => {}}
        onAdvance={() => {}}
      />,
    );
  }

  it('冻结态：选项组在判语/正确答案/理由之前（练一下原版式，反馈不得插到选项上方）', () => {
    renderFrozenWrong();

    const group = screen.getByRole('group', { name: '选项' });
    const verdict = screen.getByText('回答错误');
    const answer = screen.getByText(
      (_, el) => el?.tagName === 'P' && el.textContent === '正确答案：稳定的',
    );
    const explanation = screen.getByText('stable 在这里指结构上的稳固。');

    // 判语/正确答案/理由都必须位于选项组之后（DOM 后序）
    expect(group.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      group.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('冻结态：下一题不被填充 span 右移——它是操作行的首个元素子节点（左对齐）', () => {
    renderFrozenWrong();

    const advance = screen.getByRole('button', { name: '下一题' });
    const row = advance.parentElement as HTMLElement;
    expect(row.firstElementChild).toBe(advance);
  });
});
