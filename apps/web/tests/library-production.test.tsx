import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PracticeAnswerResponse, PracticeQuestion, PracticeStartResponse } from '@el/shared';
import type * as LibraryApi from '../src/features/library/api';
import { fetchLibraryDetail } from '../src/features/library/api';
import type * as ApiModule from '../src/lib/api';
import { ApiError } from '../src/lib/api';
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

// 保留 ApiError 真类（失败弹窗用例要按 code 构造结构化错误），仅桩 api 函数
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

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
      kind: 'scramble',
      zhPrompt: '他决定戒烟。',
      targets: [{ learningItemId: 'item-1', surface: 'give up' }],
      chips: ['He', 'decided', 'to', 'give', 'up', 'smoking', 'quit'],
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
        betterVersionKind: 'rewrite',
      }),
      makeHistoryEntry({
        id: 'ph-2',
        originalText: 'I want to gave up.',
        correctedSentence: 'I want to give up.',
        betterVersion: null,
        result: 'fail',
        mode: 'library_practice',
      }),
      makeHistoryEntry({
        id: 'ph-3',
        originalText: 'A natural legacy sentence.',
        correctedSentence: 'A natural legacy sentence.',
        betterVersion: 'Legacy suggestion without a stored kind.',
        result: 'basic_pass',
      }),
    ];
    detailApi.mockResolvedValue(detail);
    renderLibraryApp(`/library/${detail.item.id}`);

    expect(await screen.findByRole('heading', { name: '造句历史' })).toBeVisible();
    const history = screen.getByRole('region', { name: '造句历史' });
    // 第 1 条（倒序由服务端保证，按传入顺序渲染）
    expect(
      within(history).getByText('The constant stress makes me want to give up.'),
    ).toBeVisible();
    expect(
      within(history).getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === '原句：The constant stress make me want to give up.',
      ),
    ).toBeVisible();
    expect(within(history).getByText('通过')).toBeVisible();
    expect(
      within(history).getByText(
        '参考表达：The constant stress makes me want to give up everything.',
      ),
    ).toBeVisible();
    expect(
      within(history).getByText('更自然：Legacy suggestion without a stored kind.'),
    ).toBeVisible();
    // 第 2 条：fail 标签
    expect(within(history).getByText('未通过')).toBeVisible();
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
    // 原句整块（label + 高亮拆分后按 textContent 定位）；目标词块 give up 以 accent 高亮
    const context = screen.getByText(
      (_, el) =>
        el?.tagName === 'P' &&
        el.textContent === '原句After months of failure, he refused to give up.',
    );
    expect(context).toBeVisible();
    expect(
      within(context).getByText((_, el) => el?.classList.contains('text-accent') === true),
    ).toHaveTextContent('give up');
    // 释义（reveal 内容）与选项在作答前都不渲染
    expect(screen.queryByText('放弃', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '放弃（动词）' })).not.toBeInTheDocument();
    const startCalls = apiCalls('/api/library/item-1/practice');
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].init).toMatchObject({ method: 'POST' });
    // 详情内容暂时不可见（视图切换）
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('Recall 直判：良好 → 提交 recall → 释义揭示 → 下一题到表达题（2 / 2）', async () => {
    renderDetailWithPractice();

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      recall: 'recalled',
    });
    expect(await screen.findByText('良好')).toBeVisible();
    expect(screen.getByText('放弃', { exact: true })).toBeVisible(); // 释义揭示

    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('他决定戒烟。')).toBeVisible();
    expect(screen.getByText('2 / 2')).toBeVisible();
  });

  it('Recall 直判：重来 → fail 揭示释义后仍可继续', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-1/answer': makeRecallAnswer({
        result: 'fail',
        correct: false,
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    const failBtn = await screen.findByRole('button', { name: '重来' });
    expect(failBtn.className).toContain('text-destructive'); // 否定键暖红语义色（与 Today 一致）
    fireEvent.click(failBtn);

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      recall: 'forgot',
    });
    expect(await screen.findByText('重来')).toBeVisible();
    expect(screen.getByText('放弃', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('2 / 2')).toBeVisible();
  });

  it('Recall 直判：简单（2026-10-03 三档自评）→ 提交 {recall:"easy"} → 判语 简单、可继续', async () => {
    renderDetailWithPractice();

    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    // 三键一排：重来 / 良好 / 简单（Library 无「显示答案」前置）
    const easyBtn = await screen.findByRole('button', { name: '简单' });
    expect(easyBtn.className).toContain('border-border bg-muted'); // neutral 暖灰中性档
    fireEvent.click(easyBtn);

    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-1/answer')[0])).toEqual({
      recall: 'easy',
    });
    expect(await screen.findByText('简单')).toBeVisible(); // pass 判语 = 简单
    expect(screen.getByText('放弃', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('2 / 2')).toBeVisible();
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
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));
    expect(await screen.findByText('放弃', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    expect(await screen.findByText('练习完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回详情' }));
    expect(await screen.findByRole('button', { name: '编辑' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'resilient' })).toBeVisible();
  });

  it('表达题拼词：提交 selectedTokens → 结果 → 完成 → 返回详情', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-2/answer': makePracticeAnswer({
        itemResults: [{ learningItemId: 'item-1', surface: 'give up', result: 'pass' }],
        referenceTokens: ['He', 'decided', 'to', 'give', 'up', 'smoking'],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));
    fireEvent.click(await screen.findByRole('button', { name: '下一题' }));
    expect(await screen.findByText('他决定戒烟。')).toBeVisible();
    const bank = screen.getByTestId('scramble-chip-bank');
    for (const tok of ['He', 'decided', 'to', 'give', 'up', 'smoking']) {
      const btn = Array.from(bank.querySelectorAll('button')).find((b) => b.textContent === tok);
      expect(btn).toBeTruthy();
      fireEvent.click(btn!);
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => {
      expect(apiCalls('/api/library/item-1/practice/pq-2/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/library/item-1/practice/pq-2/answer')[0])).toEqual({
      selectedTokens: ['He', 'decided', 'to', 'give', 'up', 'smoking'],
    });
    expect(await screen.findByTestId('scramble-result')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('练习完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回详情' }));
  });

  it('表达题展示目标 surface 芯片（无复制按钮）', async () => {
    renderDetailWithPractice();
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));
    fireEvent.click(await screen.findByRole('button', { name: '下一题' }));
    expect(await screen.findByText('give up')).toBeVisible();
    expect(screen.queryByRole('button', { name: '复制目标词' })).not.toBeInTheDocument();
  });

  it('拼词提交 pending 时禁用芯片与提交', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-2/answer': () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));
    fireEvent.click(await screen.findByRole('button', { name: '下一题' }));
    const bank = await screen.findByTestId('scramble-chip-bank');
    fireEvent.click(Array.from(bank.querySelectorAll('button'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByRole('button', { name: '提交中…' })).toBeDisabled();
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

  it('拼词批改失败：展示错误文案', async () => {
    renderDetailWithPractice({
      '/api/library/item-1/practice/pq-2/answer': () => {
        throw new ApiError('AI_PROVIDER_ERROR', '批改失败', 502);
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: '练一下' }));
    fireEvent.click(await screen.findByRole('button', { name: '良好' }));
    fireEvent.click(await screen.findByRole('button', { name: '下一题' }));
    const bank = await screen.findByTestId('scramble-chip-bank');
    for (const tok of ['He', 'decided', 'to', 'give', 'up', 'smoking']) {
      const btn = Array.from(bank.querySelectorAll('button')).find((b) => b.textContent === tok);
      fireEvent.click(btn!);
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByText(/批改失败/)).toBeVisible();
  });

});
