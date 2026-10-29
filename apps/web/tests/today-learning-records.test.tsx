import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TodayLearningList,
  groupByItem,
} from '../src/features/today/components/TodayLearningSheet';
import { makeProductionTask, makeCorrectAnswer, makeSessionEntry } from './today-helpers';
afterEach(cleanup);
const task = makeProductionTask({
  question: {
    questionId: 'mixed-q',
    kind: 'scramble',
    zhPrompt: '别放弃，然后出发。',
    targets: [
      { learningItemId: 'item-give-up', surface: 'give up' },
      { learningItemId: 'item-set-off', surface: 'set off' },
    ],
    chips: ['Do', 'not', 'give', 'up', 'then', 'set', 'off'],
  },
});
const entry = makeSessionEntry(
  { ...task, item: { ...task.item, id: 'item-give-up' } },
  makeCorrectAnswer({
    result: 'fail',
    correct: false,
    itemResults: [
      { learningItemId: 'item-give-up', surface: 'give up', result: 'basic_pass' },
      { learningItemId: 'item-set-off', surface: 'set off', result: 'fail' },
    ],
  }),
);
it('groups every scramble participant without inventing missing metadata', () => {
  const groups = groupByItem([entry]);
  expect(groups.map((g) => g.item.id)).toEqual(['item-give-up', 'item-set-off']);
  expect(groups[1]?.item.target).toBe('set off');
  expect(groups[1]?.item.meaning).toBeUndefined();
});
it('history reports per-target Hard/Again evidence, not aggregate failure', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TodayLearningList entries={[entry]} />
    </QueryClientProvider>,
  );
  const primary = screen.getByRole('button', { name: /give up/ });
  const secondary = screen.getByRole('button', { name: /set off/ });
  expect(primary).toHaveTextContent('基本正确');
  expect(secondary).toHaveTextContent('错');
  fireEvent.click(primary);
  expect(
    within(primary.closest('li')!).getByText('基本正确', { selector: 'span.text-xs' }),
  ).toBeVisible();
  fireEvent.click(secondary);
  expect(within(secondary.closest('li')!).getByText('未通过')).toBeVisible();
});
