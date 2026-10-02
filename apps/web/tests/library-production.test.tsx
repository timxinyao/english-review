import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PracticeAnswerResponse, PracticeQuestion, PracticeStartResponse } from '@el/shared';
import type * as LibraryApi from '../src/features/library/api';
import { fetchLibraryDetail } from '../src/features/library/api';
import { apiCalls, jsonBodyOf, stubApi } from './today-helpers';
import { makeDetail, makeHistoryEntry, renderLibraryApp } from './library-helpers';

// 详情查询走模块 mock；练一下 hooks 内部调用 lib/api，用 stubApi 桩（与 Today 测试同模式）
vi.mock('../src/features/library/api', async (importOriginal) => {
  const actual = await importOriginal<typeof LibraryApi>();
  return {
    ...actual,
    fetchLibraryList: vi.fn(),
    fetchLibraryDetail: vi.fn(),
    updateLibraryItem: vi.fn(),
    pauseLibraryItem: vi.fn(),
    resumeLibraryItem: vi.fn(),
    archiveLibraryItem: vi.fn(),
    restoreLibraryItem: vi.fn(),
    resetLibraryItemProgress: vi.fn(),
    masterLibraryItem: vi.fn(),
    previewLibraryImport: vi.fn(),
    commitLibraryImport: vi.fn(),
  };
});

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

afterEach(cleanup);

const detailApi = vi.mocked(fetchLibraryDetail);

function makePracticeAnswer(
  overrides: Partial<PracticeAnswerResponse> = {},
): PracticeAnswerResponse {
  return {
    result: 'pass',
    correct: true,
    meaning: null,
    explanation: null,
    correctOptionId: null,
    completeSentence: null,
    acceptedAnswer: null,
    correction: null,
    personalExampleSaved: false,
    ...overrides,
  };
}

/** Recall 揭示（V2：释义只在作答响应出现） */
function makeRecallAnswer(overrides: Partial<PracticeAnswerResponse> = {}): PracticeAnswerResponse {
  return makePracticeAnswer({ meaning: '放弃', ...overrides });
}

/** 2 题练习（word + production 开）：recall → production；无 cloze */
function makePracticeQuestions(): PracticeQuestion[] {
  return [
    {
      qtype: 'recall',
      questionId: 'pq-1',
      target: 'give up',
      context: 'After months of failure, he refused to give up.',
      hint: {
        questionId: 'pq-1',
        kind: 'direct_meaning',
        context: null,
        question: '"give up" 的意思是？',
        options: [
          { id: 'po1', text: '放弃（动词）' },
          { id: 'po2', text: '坚持（动词）' },
        ],
      },
    },
    {
      qtype: 'production',
      questionId: 'pq-2',
      zhPrompt: '他决定戒烟。',
      mustUse: 'give up',
    },
  ];
}

function makePracticeStart(): PracticeStartResponse {
  return { questions: makePracticeQuestions() };
}

/** 桩好详情 + 练一下接口后渲染详情页（V2：recall(pq-1) → production(pq-2)） */
function renderDetailWithPractice(
  answerHandlers: Record<string, unknown | (() => unknown)> = {},
  start: PracticeStartResponse = makePracticeStart(),
) {
  detailApi.mockResolvedValue(makeDetail());
  stubApi({
    '/api/library/item-1/practice': start,
    '/api/library/item-1/practice/pq-1/answer': makeRecallAnswer(),
    '/api/library/item-1/practice/pq-2/answer': makePracticeAnswer(),
    ...answerHandlers,
  });
  renderLibraryApp('/library/item-1');
}

describe('Library 详情：造句历史（PRODUCT §7.5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染造句历史：corrected 主体、原句小字、result 标签与 betterVersion', async () => {
    const detail = makeDetail();
    detail.productionHistory = [
      makeHistoryEntry({
        id: 'ph-1',
        result: 'pass',
        betterVersion: 'The constant stress makes me want to give up everything.',
      }),
      makeHistoryEntry({
        id: 'ph-2',
        originalText: 'I want to gave up.',
        correctedSentence: 'I want to give up.',
        betterVersion: null,
        result: 'fail',
        mode: 'library_practice',
      }),
    ];
    detailApi.mockResolvedValue(detail);
    renderLibraryApp(`/library/${detail.item.id}`);

    expect(await screen.findByRole('heading', { name: '造句历史' })).toBeVisible();
    // 第 1 条（倒序由服务端保证，按传入顺序渲染）
    expect(screen.getByText('The constant stress makes me want to give up.')).toBeVisible();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === '原句：The constant stress make me want to give up.',
      ),
    ).toBeVisible();
    expect(screen.getByText('通过')).toBeVisible();
    expect(
      screen.getByText('更自然：The constant stress makes me want to give up everything.'),
    ).toBeVisible();
    // 第 2 条：fail 标签
    expect(screen.getByText('未通过')).toBeVisible();
  });

  it('造句历史为空：不渲染整个区块', async () => {
    const detail = makeDetail(); // productionHistory: []
    detailApi.mockResolvedValue(detail);
    renderLibraryApp(`/library/${detail.item.id}`);

    expect(await screen.findByRole('heading', { name: 'resilient' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '造句历史' })).not.toBeInTheDocument();
  });
});

describe('Library 练一下（V2：Recall + 可选 Production；PRODUCT §4.4 不改正式进度）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('入口按钮 → 练习视图：进度 1 / 2、Recall 卡词面与原句；释义与 Hint 选项作答前不可见', async () => {
    renderDetailWithPractice();

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));

    expect(await screen.findByText('1 / 2')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'give up' })).toBeVisible();
    expect(screen.getByText('After months of failure, he refused to give up.')).toBeVisible();
    // 释义（reveal 内容）与 Hint 选项在作答前都不渲染
    expect(screen.queryByText('放弃', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '放弃（动词）' })).not.toBeInTheDocument();
    const startCalls = apiCalls('/api/library/item-1/practice');
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].init).toMatchObject({ method: 'POST' });
    // 详情内容暂时不可见（视图切换）
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('Recall 直判：想起来了 → 提交 recall → 释义揭示 → 下一题到表达题（2 / 2）', async () => {
    renderDetailWithPractice();

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      recall: 'recalled',
    });
    expect(await screen.findByText('想起来了')).toBeVisible();
    expect(screen.getByText('放弃', { exact: true })).toBeVisible(); // 释义揭示

    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('他决定戒烟。')).toBeVisible();
    expect(screen.getByText('2 / 2')).toBeVisible();
  });

  it('Recall 直判：没想起来 → fail 揭示释义后仍可继续', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-1/answer': makeRecallAnswer({
        result: 'fail',
        correct: false,
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    const failBtn = await screen.findByRole('button', { name: '没想起来' });
    expect(failBtn.className).toContain('text-destructive'); // 否定键暖红语义色（与 Today 一致）
    fireEvent.click(failBtn);

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      recall: 'forgot',
    });
    expect(await screen.findByText('没想起来')).toBeVisible();
    expect(screen.getByText('放弃', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('2 / 2')).toBeVisible();
  });

  it('Recall Hint：给我提示 → 选项作答（对=提示后想起）→ 释义揭示', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-1/answer': makeRecallAnswer({
        result: 'basic_pass',
        correct: true,
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '给我提示' }));

    const option = await screen.findByRole('button', { name: '放弃（动词）' });
    fireEvent.click(option);

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      selectedOptionId: 'po1',
      hintUsed: true,
    });
    expect(await screen.findByText('提示后想起（基本通过）')).toBeVisible();
    expect(screen.getByText('放弃', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('2 / 2')).toBeVisible();
  });

  it('Recall Hint 答错：fail 判语 + 正确答案揭示 + 释义揭示', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-1/answer': makeRecallAnswer({
        result: 'fail',
        correct: false,
        explanation: 'give up 是放弃。',
        correctOptionId: 'po1',
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '给我提示' }));
    fireEvent.click(await screen.findByRole('button', { name: '坚持（动词）' }));

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      selectedOptionId: 'po2',
      hintUsed: true,
    });
    expect(await screen.findByText('没想起来')).toBeVisible();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '正确答案：放弃（动词）',
      ),
    ).toBeVisible();
    expect(screen.getByText('放弃', { exact: true })).toBeVisible();
  });

  it('单题（word，production 关）：Recall 完成即练习完成 → 返回详情', async () => {
    renderDetailWithPractice(
      {},
      {
        questions: [makePracticeQuestions()[0]!], // 仅 recall
      },
    );

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    expect(await screen.findByText('1 / 1')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));
    expect(await screen.findByText('放弃', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    expect(await screen.findByText('练习完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回详情' }));
    expect(await screen.findByRole('button', { name: '编辑' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'resilient' })).toBeVisible();
  });

  it('表达题批改与完成：提交 answerText → diff → 已存个人例句 → 完成 → 返回详情', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-2/answer': makePracticeAnswer({
        result: 'basic_pass',
        correct: false,
        explanation: '时态可以更自然。',
        personalExampleSaved: true,
        correction: {
          segments: [
            { text: 'He decided to give up smoke.', type: 'delete' },
            { text: 'He decided to give up smoking.', type: 'insert' },
          ],
          correctedSentence: 'He decided to give up smoking.',
          betterVersion: null,
        },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));

    // 第 1 题：recall 直判通过
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));
    await screen.findByText('想起来了');
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    // 第 2 题：表达
    await screen.findByLabelText('表达答案');
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '必须使用：give up'),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText('表达答案'), {
      target: { value: 'He decided to give up smoke.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-2/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-2/answer')[0])).toEqual({
      answerText: 'He decided to give up smoke.',
    });
    expect(await screen.findByText('基本通过')).toBeVisible();
    expect(screen.getByText('He decided to give up smoke.').className).toContain(
      'text-diff-delete',
    );
    expect(screen.getByText('已存入个人例句')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    // 完成
    expect(await screen.findByText('练习完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回详情' }));
    expect(await screen.findByRole('button', { name: '编辑' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'resilient' })).toBeVisible();
  });

  it('表达题目标词一键复制（与 Today 共用卡）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDetailWithPractice();
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));

    // recall 直判通过 → 表达题
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));
    await screen.findByText('放弃');
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    fireEvent.click(await screen.findByRole('button', { name: '复制目标词' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('give up'));
    expect(await screen.findByRole('button', { name: '已复制' })).toBeVisible();
  });

  it('生成练习失败：显示错误并可返回详情', async () => {
    detailApi.mockResolvedValue(makeDetail());
    stubApi({
      '/api/library/item-1/practice': () => Promise.reject(new Error('生成练习失败')),
    });
    renderLibraryApp('/library/item-1');
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));

    expect(await screen.findByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回详情' }));
    expect(await screen.findByRole('button', { name: '编辑' })).toBeVisible();
  });
});
