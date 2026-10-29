import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScrambleQuestionCard } from '../src/components/scramble-question-card';
import { StartSessionDialog } from '../src/features/today/components/StartSessionDialog';
afterEach(cleanup);
const question = {
  questionId: 'q1',
  kind: 'scramble' as const,
  zhPrompt: '我觉得这有道理。',
  targets: [{ learningItemId: 'i1', surface: 'make sense' }],
  chips: ['I', 'think', 'it', 'makes', 'sense', 'I', '.'],
};
const props = {
  question,
  result: null,
  pending: false,
  error: null,
  onSubmitTokens: vi.fn(),
  onAdvance: vi.fn(),
};
const bankButtons = () => within(screen.getByTestId('scramble-chip-bank')).getAllByRole('button');
describe('native scramble interactions', () => {
  it('keeps stable bank positions and separate duplicate occurrences', () => {
    render(<ScrambleQuestionCard {...props} />);
    fireEvent.click(bankButtons()[0]!);
    expect(bankButtons()).toHaveLength(7);
    expect(bankButtons()[0]).toBeDisabled();
    expect(bankButtons()[5]).toBeEnabled();
    fireEvent.click(bankButtons()[5]!);
    expect(within(screen.getByTestId('scramble-answer-row')).getAllByRole('button')).toHaveLength(
      2,
    );
  });
  it('undoes and clears without submitting', () => {
    render(<ScrambleQuestionCard {...props} />);
    fireEvent.click(bankButtons()[0]!);
    fireEvent.click(bankButtons()[1]!);
    fireEvent.click(screen.getByRole('button', { name: '撤回最后一个词' }));
    expect(within(screen.getByTestId('scramble-answer-row')).getAllByRole('button')).toHaveLength(
      1,
    );
    fireEvent.click(screen.getByRole('button', { name: '清空句子' }));
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
  });
  it('preserves failed draft but resets on question identity change', () => {
    const { rerender } = render(<ScrambleQuestionCard {...props} />);
    fireEvent.click(bankButtons()[0]!);
    rerender(<ScrambleQuestionCard {...props} error="网络错误，请重试" />);
    expect(within(screen.getByTestId('scramble-answer-row')).getAllByRole('button')).toHaveLength(
      1,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('网络错误');
    expect(screen.getByRole('alert').closest('[data-slot="dock"]')).not.toBeNull();
    rerender(<ScrambleQuestionCard {...props} question={{ ...question, questionId: 'q2' }} />);
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
  });
  it('keeps the submitted sentence visible beside per-target feedback', () => {
    render(
      <ScrambleQuestionCard
        {...props}
        result={{
          result: 'pass',
          correct: true,
          explanation: null,
          correctOptionId: null,
          completeSentence: null,
          acceptedAnswer: null,
          correction: null,
          personalExampleSaved: false,
          submittedAnswerText: 'I think it makes sense.',
          itemResults: [{ learningItemId: 'i1', surface: 'make sense', result: 'pass' }],
        }}
      />,
    );
    expect(screen.getByText('I think it makes sense.')).toBeVisible();
  });
  it('explains deterministic assembly without repeating unverified morphology promises', () => {
    render(
      <ScrambleQuestionCard
        {...props}
        result={{
          result: 'fail',
          correct: false,
          explanation: '允许正常时态和人称变化。',
          correctOptionId: null,
          completeSentence: null,
          acceptedAnswer: null,
          correction: null,
          personalExampleSaved: false,
        }}
      />,
    );
    expect(screen.queryByText('允许正常时态和人称变化。')).toBeNull();
    expect(screen.getByText(/不是自由造句批改/)).toBeVisible();
  });
  it('guards rapid repeated submit before pending props arrive', () => {
    const submit = vi.fn();
    render(<ScrambleQuestionCard {...props} onSubmitTokens={submit} />);
    fireEvent.click(bankButtons()[0]!);
    const button = screen.getByRole('button', { name: '提交' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
describe('native dialog accessibility', () => {
  it('focuses dialog and supports Escape except during pending work', async () => {
    const close = vi.fn();
    const { rerender } = render(
      <StartSessionDialog
        pending={false}
        errorMessage="失败"
        onRetry={vi.fn()}
        onDismiss={close}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
    rerender(
      <StartSessionDialog pending errorMessage={null} onRetry={vi.fn()} onDismiss={close} />,
    );
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
  });
  it('traps Tab and restores scroll after unmount', async () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(
      <StartSessionDialog
        pending={false}
        errorMessage="失败"
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(document.body.style.overflow).toBe('hidden');
    screen.getByRole('button', { name: '重试' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });
});
