import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScrambleQuestionCard } from '../src/components/scramble-question-card';

const question = {
  questionId: 'q1',
  kind: 'scramble' as const,
  zhPrompt: '长期开会让我很累。',
  targets: [
    { learningItemId: 'a', surface: 'wear down' },
    { learningItemId: 'b', surface: 'meetings' },
  ],
  chips: ['me', 'Long', 'tire', 'wear', 'meetings', 'down', 'really', 'out'],
};

describe('ScrambleQuestionCard', () => {
  it('assembles chips and submits selectedTokens in order', () => {
    const onSubmitTokens = vi.fn();
    render(
      <ScrambleQuestionCard
        question={question}
        result={null}
        pending={false}
        error={null}
        onSubmitTokens={onSubmitTokens}
        onAdvance={() => {}}
      />,
    );

    expect(screen.getByText('长期开会让我很累。')).toBeTruthy();
    expect(screen.getByText('wear down')).toBeTruthy();

    // Pick Long → meetings → really → wear → me → down
    for (const tok of ['Long', 'meetings', 'really', 'wear', 'me', 'down']) {
      const bank = screen.getByTestId('scramble-chip-bank');
      const btn = Array.from(bank.querySelectorAll('button')).find((b) => b.textContent === tok);
      expect(btn, `missing chip ${tok}`).toBeTruthy();
      fireEvent.click(btn!);
    }

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmitTokens).toHaveBeenCalledWith(['Long', 'meetings', 'really', 'wear', 'me', 'down']);
  });

  it('shows per-item results after submit', () => {
    render(
      <ScrambleQuestionCard
        question={question}
        result={{
          result: 'fail',
          correct: false,
          explanation: '有一个目标没用对',
          correctOptionId: null,
          completeSentence: null,
          acceptedAnswer: null,
          correction: null,
          personalExampleSaved: false,
          itemResults: [
            { learningItemId: 'a', surface: 'wear down', result: 'fail' },
            { learningItemId: 'b', surface: 'meetings', result: 'pass' },
          ],
          referenceTokens: ['Long', 'meetings', 'really', 'wear', 'me', 'down'],
        }}
        pending={false}
        error={null}
        onSubmitTokens={() => {}}
        onAdvance={() => {}}
      />,
    );

    const box = screen.getByTestId('scramble-result');
    expect(box.textContent).toMatch(/未通过/);
    expect(box.textContent).toMatch(/wear down/);
    expect(box.textContent).toMatch(/错/);
    expect(box.textContent).toMatch(/meetings/);
    expect(box.textContent).toMatch(/参考：Long meetings really wear me down/);
  });
});
