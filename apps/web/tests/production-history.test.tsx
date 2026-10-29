import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProductionHistoryList } from '../src/features/library/ProductionHistoryList';
afterEach(cleanup);
it('does not repeat the submitted sentence as an original when no correction exists', () => {
  render(
    <ProductionHistoryList
      history={[
        {
          id: 'p1',
          createdAt: '2026-10-29T00:00:00Z',
          originalText: 'The pressure stress makes me want to give up',
          correctedSentence: null,
          betterVersion: null,
          betterVersionKind: null,
          result: 'basic_pass',
          mode: 'today',
        },
      ]}
    />,
  );
  expect(screen.getAllByText('The pressure stress makes me want to give up')).toHaveLength(1);
  expect(screen.queryByText(/^原句：/)).toBeNull();
});
