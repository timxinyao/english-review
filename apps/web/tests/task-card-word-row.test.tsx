import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskCard } from '../src/features/today/components/TaskCard';
import {
  makeChoiceTask,
  makeCorrectAnswer,
  makeLearnTask,
} from './today-helpers';

afterEach(cleanup);

// TaskCard 内部 useBadQuestion 依赖 QueryClient（首次直渲 TaskCard，需自带 Provider）
function renderCard(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe('TaskCard 词行（已答/回看显示单词）', () => {
  it('已答的非 learn 卡显示 target + IPA', () => {
    renderCard(
      <TaskCard task={makeChoiceTask()} result={makeCorrectAnswer()} onAnswered={() => {}} onAdvance={() => {}} />,
    );
    expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
    expect(screen.getByText('/ˈsteɪbl/')).toBeVisible();
  });

  it('未作答的非 learn 卡不显示词行（避免剧透）', () => {
    renderCard(
      <TaskCard task={makeChoiceTask()} result={null} onAnswered={() => {}} onAdvance={() => {}} />,
    );
    expect(screen.queryByRole('heading', { name: 'stable' })).not.toBeInTheDocument();
  });

  it('chunk 无 IPA：只显示 target', () => {
    const task = makeChoiceTask({
      item: { id: 'i', type: 'chunk', target: 'give up', meaning: '放弃', ipa: null },
    });
    renderCard(<TaskCard task={task} result={makeCorrectAnswer()} onAnswered={() => {}} onAdvance={() => {}} />);
    expect(screen.getByRole('heading', { name: 'give up' })).toBeVisible();
  });

  it('learn 卡不重复渲染词行（LearnContent 已有）', () => {
    renderCard(
      <TaskCard task={makeLearnTask()} result={null} onAnswered={() => {}} onAdvance={() => {}} />,
    );
    expect(screen.getAllByRole('heading', { name: 'gravity' })).toHaveLength(1);
  });
});
