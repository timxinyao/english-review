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
    explanation: null,
    correctOptionId: null,
    completeSentence: null,
    acceptedAnswer: null,
    correction: null,
    personalExampleSaved: false,
    ...overrides,
  };
}

/** 3 题练习：选择 → 表达 → 填空 */
function makePracticeQuestions(): PracticeQuestion[] {
  return [
    {
      qtype: 'choice',
      questionId: 'pq-1',
      kind: 'direct_meaning',
      context: null,
      question: '"give up" 的意思是？',
      options: [
        { id: 'po1', text: '放弃' },
        { id: 'po2', text: '坚持' },
      ],
    },
    {
      qtype: 'production',
      questionId: 'pq-2',
      zhPrompt: '他决定戒烟。',
      mustUse: 'give up',
    },
    {
      qtype: 'cloze',
      questionId: 'pq-3',
      textWithBlank: 'He decided to ____ smoking.',
    },
  ];
}

function makePracticeStart(): PracticeStartResponse {
  return { questions: makePracticeQuestions() };
}

/** 桩好详情 + 练一下接口后渲染详情页 */
function renderDetailWithPractice(answerHandler: () => unknown = () => makePracticeAnswer()) {
  detailApi.mockResolvedValue(makeDetail());
  stubApi({
    '/api/library/item-1/practice': makePracticeStart(),
    '/api/library/item-1/practice/pq-1/answer': answerHandler,
    '/api/library/item-1/practice/pq-2/answer': answerHandler,
    '/api/library/item-1/practice/pq-3/answer': answerHandler,
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

describe('Library 练一下（PRODUCT §4.4：不改正式进度）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('入口按钮 → 练习视图：进度 1 / 3 与首题渲染', async () => {
    renderDetailWithPractice();

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));

    expect(await screen.findByText('1 / 3')).toBeVisible();
    expect(screen.getByText('"give up" 的意思是？')).toBeVisible();
    expect(screen.getByRole('button', { name: '放弃' })).toBeVisible();
    const startCalls = apiCalls('/api/library/item-1/practice');
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].init).toMatchObject({ method: 'POST' });
    // 详情内容暂时不可见（视图切换）
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('答选择题：提交 option id；答对点击任意处继续到表达题', async () => {
    renderDetailWithPractice();

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '放弃' }));

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      selectedOptionId: 'po1',
    });
    expect(await screen.findByText('回答正确')).toBeVisible();

    fireEvent.click(screen.getByText('回答正确'));
    expect(await screen.findByText('他决定戒烟。')).toBeVisible();
    expect(screen.getByText('2 / 3')).toBeVisible();
  });

  it('表达题批改与完成：提交 answerText → diff → 下一题 → 填空 → 练习完成 → 返回详情', async () => {
    stubApi({
      '/api/library/item-1/practice': makePracticeStart(),
      '/api/library/item-1/practice/pq-1/answer': makePracticeAnswer(),
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
      '/api/library/item-1/practice/pq-3/answer': makePracticeAnswer({
        completeSentence: 'He decided to give up smoking.',
      }),
    });
    detailApi.mockResolvedValue(makeDetail());
    renderLibraryApp('/library/item-1');
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));

    // 第 1 题：选择
    fireEvent.click(await screen.findByRole('button', { name: '放弃' }));
    await screen.findByText('回答正确');
    fireEvent.click(screen.getByText('回答正确'));

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

    // 第 3 题：填空 → 回答正确 → 手动下一题
    const blank = await screen.findByLabelText('填空答案');
    fireEvent.change(blank, { target: { value: 'give up' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('回答正确');
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    // 完成
    expect(await screen.findByText('练习完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回详情' }));
    expect(await screen.findByRole('button', { name: '编辑' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'resilient' })).toBeVisible();
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
