import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../src/lib/api';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeChoiceTask,
  makeProductionAnswer,
  makeProductionTask,
  makeSessionEntry,
  makeTasksResponse,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('../src/lib/sound', () => ({ playGradingCue: vi.fn() }));

function nextTask() {
  return makeChoiceTask({ taskId: 'task-next' });
}

const REF = ['The', 'constant', 'stress', 'makes', 'me', 'want', 'to', 'give', 'up'] as const;

async function pickTokens(tokens: readonly string[]) {
  const bank = await screen.findByTestId('scramble-chip-bank');
  for (const tok of tokens) {
    const btn = Array.from(bank.querySelectorAll('button')).find((b) => b.textContent === tok);
    expect(btn, `missing chip ${tok}`).toBeTruthy();
    fireEvent.click(btn!);
  }
}

describe('Today 拼词表达题（scramble_v1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer(),
    });
  });

  it('渲染中文题干、目标芯片与词库；初始提交禁用', async () => {
    renderTodayApp();
    expect(await screen.findByText('长期的压力让我想放弃。')).toBeVisible();
    expect(screen.getByText('give up')).toBeVisible();
    expect(screen.getByTestId('scramble-chip-bank')).toBeVisible();
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
    expect(screen.queryByLabelText('表达答案')).not.toBeInTheDocument();
  });

  it('点选芯片后 POST selectedTokens；展示每目标结果与参考句', async () => {
    renderTodayApp();
    await pickTokens(REF);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[0])).toEqual({
      selectedTokens: [...REF],
    });
    const box = await screen.findByTestId('scramble-result');
    expect(box.textContent).toMatch(/通过/);
    expect(box.textContent).toMatch(/give up/);
    expect(box.textContent).toMatch(/参考：The constant stress makes me want to give up/);
  });

  it('不会：POST {giveUp:true}；展示参考与失败目标', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer({
        result: 'fail',
        correct: false,
        gaveUp: true,
        submittedAnswerText: null,
        itemResults: [{ learningItemId: 'item-give-up', surface: 'give up', result: 'fail' }],
        referenceTokens: [...REF],
        referenceAnswer: REF.join(' '),
        answerNote: '允许正常时态变化。',
      }),
    });
    renderTodayApp();
    fireEvent.click(await screen.findByRole('button', { name: '不会' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-prod/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-prod/answer')[0])).toEqual({ giveUp: true });
    const box = await screen.findByTestId('scramble-result');
    expect(box.textContent).toMatch(/未通过|错/);
    expect(box.textContent).toMatch(/参考/);
  });

  it('继续：手动下一题切换任务', async () => {
    stubApi({
      '/api/today': makeActive(makeProductionTask(), { completed: 1, total: 6 }),
      '/api/today/tasks/task-prod/answer': makeProductionAnswer(),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(makeProductionTask(), makeProductionAnswer()),
        makeSessionEntry(nextTask(), null),
      ]),
    });
    renderTodayApp();
    await pickTokens(REF);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    fireEvent.click(await screen.findByRole('button', { name: '继续' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks')).not.toHaveLength(0);
    });
  });
});
