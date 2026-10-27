import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type {
  AnswerResponse,
  SessionTaskEntry,
  TodayActiveResponse,
  TodayCompletedResponse,
  TodayIdleResponse,
  TodaySessionTasksResponse,
  TodayTaskView,
} from '@el/shared';
import { api } from '../src/lib/api';
import { TodayPage } from '../src/features/today/TodayPage';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 在 MemoryRouter + QueryClient 中渲染 /today */
export function renderTodayApp() {
  const queryClient = makeQueryClient();
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/today']}>
        <Routes>
          <Route path="/today" element={<TodayPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...renderResult };
}

// ---------- lib/api mock 工具（mock fetch 封装，保留真实 hooks/invalidate 行为）----------

/** 按 path 桩掉 api()；值可为对象或 () => 对象（用于队列/动态返回） */
export function stubApi(handlers: Record<string, unknown | (() => unknown)>) {
  vi.mocked(api).mockImplementation(((path: string) => {
    if (handlers[path] === undefined && path === '/api/today/tasks') {
      // 默认空批量：ActiveSession 挂载即请求；显式桩见 today-navigation.test
      return Promise.resolve({ tasks: [] });
    }
    const handler = handlers[path];
    if (handler === undefined) {
      return Promise.reject(new Error(`stubApi: unexpected api call ${path}`));
    }
    return Promise.resolve(typeof handler === 'function' ? (handler as () => unknown)() : handler);
  }) as typeof api);
}

/** 取出某 path 前缀的全部调用（path + init） */
export function apiCalls(pathPrefix: string): { path: string; init?: RequestInit }[] {
  return vi
    .mocked(api)
    .mock.calls.filter(([p]) => typeof p === 'string' && (p as string).startsWith(pathPrefix))
    .map(([p, init]) => ({ path: p as string, init }));
}

export function jsonBodyOf(call: { init?: RequestInit }): unknown {
  return JSON.parse(call.init?.body as string);
}

// ---------- fixtures ----------

const CHOICE_OPTIONS = [
  { id: 'o1', text: '稳定的' },
  { id: 'o2', text: '摇晃的' },
  { id: 'o3', text: '昂贵的' },
];

export function makeChoiceTask(overrides: Partial<TodayTaskView> = {}): TodayTaskView {
  return {
    taskId: 'task-1',
    taskType: 'understanding',
    dimension: 'understanding',
    origin: 'base',
    deferCount: 0,
    item: {
      id: 'item-1',
      type: 'word',
      target: 'stable',
      meaning: '稳定的',
      ipa: '/ˈsteɪbl/',
      notes: null,
    },
    sourceExample: 'The ladder feels stable.',
    supplementaryExamples: [],
    question: {
      questionId: 'q-1',
      kind: 'direct_meaning',
      context: null,
      question: '"stable" 的意思是？',
      options: CHOICE_OPTIONS,
    },
    ...overrides,
  };
}

export function makeClozeTask(overrides: Partial<TodayTaskView> = {}): TodayTaskView {
  return {
    taskId: 'task-cloze',
    taskType: 'cloze',
    dimension: 'production',
    origin: 'base',
    deferCount: 0,
    item: {
      id: 'item-2',
      type: 'word',
      target: 'raw',
      meaning: '未加工的',
      ipa: null,
      notes: null,
    },
    sourceExample: 'Raw sugar is less sweet.',
    supplementaryExamples: [],
    question: {
      questionId: 'q-cloze',
      textWithBlank: 'The ____ data has not been processed yet.',
    },
    ...overrides,
  };
}

export function makeProductionTask(overrides: Partial<TodayTaskView> = {}): TodayTaskView {
  return {
    taskId: 'task-prod',
    taskType: 'production',
    dimension: 'production',
    origin: 'base',
    deferCount: 0,
    item: {
      id: 'item-give-up',
      type: 'chunk',
      target: 'give up',
      meaning: '放弃',
      ipa: null,
      notes: null,
    },
    sourceExample: 'Never give up your dreams.',
    supplementaryExamples: [],
    question: {
      questionId: 'q-prod',
      zhPrompt: '长期的压力让我想放弃。',
      mustUse: 'give up',
    },
    ...overrides,
  };
}

export function makeLearnTask(overrides: Partial<TodayTaskView> = {}): TodayTaskView {
  return {
    taskId: 'task-learn',
    taskType: 'learn',
    dimension: 'understanding',
    origin: 'base',
    deferCount: 0,
    item: {
      id: 'item-3',
      type: 'word',
      target: 'gravity',
      meaning: '重力',
      ipa: '/ˈɡrævəti/',
      notes: null,
    },
    sourceExample: 'I laugh at gravity all the time.',
    supplementaryExamples: ['Gravity is a fundamental force.'],
    question: {
      questionId: 'q-learn',
      kind: 'direct_meaning',
      context: null,
      question: '"gravity" 的意思是？',
      options: [
        { id: 'o1', text: '重力' },
        { id: 'o2', text: '引力波' },
        { id: 'o3', text: '严重性' },
      ],
    },
    ...overrides,
  };
}

export function makeIdle(overrides: Partial<TodayIdleResponse> = {}): TodayIdleResponse {
  return {
    status: 'idle',
    dueItems: 4,
    plannedReviews: 4,
    backlogLeft: 0,
    newTodayAvailable: 1,
    totalItems: 57,
    newQueueCount: 27,
    recentlyLearned: [
      { id: 'r1', target: 'wear down', meaning: '消耗；使疲惫', type: 'chunk' },
      { id: 'r2', target: 'raw', meaning: '未加工的', type: 'word' },
    ],
    ...overrides,
  };
}

export function makeActive(
  currentTask: TodayTaskView | null,
  progress: { completed: number; total: number } = { completed: 0, total: 1 },
): TodayActiveResponse {
  return {
    status: 'active',
    session: { id: 'session-1', sessionDate: '2026-09-24' },
    progress,
    currentTask,
  };
}

export function makeCompleted(
  overrides: Partial<TodayCompletedResponse['summary']> = {},
  /** extend 契约字段（Task 2 完成页消费）；null=不限制 */
  remainingNewQuota: number | null = null,
): TodayCompletedResponse {
  return {
    status: 'completed',
    totalItems: 57,
    newQueueCount: 27,
    summary: {
      totalTasks: 6,
      pass: 3,
      basicPass: 1,
      fail: 1,
      newItemsStarted: 1,
      recommendRead: true,
      ...overrides,
    },
    remainingNewQuota,
  };
}

export function makeCorrectAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    result: 'pass',
    correct: true,
    gaveUp: false,
    selectedOptionId: null,
    submittedAnswerText: null,
    referenceAnswer: null,
    answerNote: null,
    explanation: null,
    correctOptionId: null,
    completeSentence: null,
    acceptedAnswer: null,
    correction: null,
    personalExampleSaved: false,
    reinforcementAdded: false,
    progress: { completed: 1, total: 3 },
    completed: null,
    ...overrides,
  };
}

export function makeWrongAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    result: 'fail',
    correct: false,
    gaveUp: false,
    selectedOptionId: null,
    submittedAnswerText: null,
    referenceAnswer: null,
    answerNote: null,
    explanation: 'stable 在这里指结构上的稳固。',
    correctOptionId: 'o1',
    completeSentence: null,
    acceptedAnswer: null,
    correction: null,
    personalExampleSaved: false,
    reinforcementAdded: true,
    progress: { completed: 1, total: 4 },
    completed: null,
    ...overrides,
  };
}

/** 表达题批改结果（pass：corrected = 原句，diff 全 same） */
export function makeProductionAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    result: 'pass',
    correct: true,
    gaveUp: false,
    selectedOptionId: null,
    submittedAnswerText: 'The constant stress makes me want to give up.',
    referenceAnswer: null,
    answerNote: null,
    explanation: '目标表达使用正确。',
    correctOptionId: null,
    completeSentence: null,
    acceptedAnswer: null,
    correction: {
      segments: [{ text: 'The constant stress makes me want to give up.', type: 'same' }],
      correctedSentence: 'The constant stress makes me want to give up.',
      betterVersion: null,
      betterVersionKind: null,
    },
    personalExampleSaved: true,
    reinforcementAdded: false,
    progress: { completed: 1, total: 3 },
    completed: null,
    ...overrides,
  };
}

export function makeSessionEntry(
  task: TodayTaskView,
  result: AnswerResponse | null,
  canceled = false,
): SessionTaskEntry {
  return { task, result, canceled };
}

export function makeTasksResponse(
  tasks: SessionTaskEntry[],
  /** 服务端给出的最近一次可撤销作答（PRODUCT §5.1 撤销图标数据源） */
  undoableTaskId: string | null = null,
): TodaySessionTasksResponse {
  return { tasks, undoableTaskId };
}

/** 已撤销条目（result 不回放） */
export function makeCanceledEntry(task: TodayTaskView): SessionTaskEntry {
  return makeSessionEntry(task, null, true);
}
