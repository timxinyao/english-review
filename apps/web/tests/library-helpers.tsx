import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  ImportPreviewResponse,
  LibraryItemDetail,
  LibraryListItemDto,
  LibraryListResponse,
  UpdateLearningItemResponse,
} from '@el/shared';
import { LibraryDetailPage } from '../src/features/library/LibraryDetailPage';
import { LibraryPage } from '../src/features/library/LibraryPage';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 在 MemoryRouter + QueryClient 中渲染 /library 与 /library/:id 两条路由 */
export function renderLibraryApp(route = '/library') {
  const queryClient = makeQueryClient();
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/:id" element={<LibraryDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...renderResult };
}

// ---------- fixtures ----------

export function makeListItem(overrides: Partial<LibraryListItemDto> = {}): LibraryListItemDto {
  return {
    id: 'item-1',
    type: 'word',
    target: 'resilient',
    meaning: '有韧性的；能快速恢复的',
    status: 'active',
    queueState: 'started',
    tags: ['Avatar'],
    source: 'Avatar S01E12',
    understandingStage: '练习中',
    productionStage: '初学',
    nextReviewAt: '2026-09-25T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeListResponse(
  items: LibraryListItemDto[],
  total = items.length,
  page = 1,
  pageSize = 20,
): LibraryListResponse {
  return { items, total, page, pageSize };
}

export function makeDetail(overrides: Partial<LibraryItemDetail['item']> = {}): LibraryItemDetail {
  return {
    item: {
      id: 'item-1',
      type: 'word',
      target: 'resilient',
      meaning: '有韧性的',
      ipa: '/rɪˈzɪliənt/',
      source: 'Avatar S01E12',
      sourceUrl: 'https://example.com/s01e12',
      tags: ['Avatar', 'adj'],
      notes: '常用于描述系统或人的韧性。',
      status: 'active',
      queueState: 'started',
      needsReinforcement: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      archivedAt: null,
      ...overrides,
    },
    sourceExample: 'The city proved resilient after the storm.',
    extraExamples: ['She is resilient under pressure.'],
    personalExamples: [
      {
        id: 'pe-1',
        text: 'I stayed resilient during the exam week.',
        originalText: 'I stay resilient during the exam week.',
        betterText: null,
        pinned: true,
      },
      {
        id: 'pe-2',
        text: 'A resilient mindset helps.',
        originalText: null,
        betterText: null,
        pinned: false,
      },
    ],
    reviewStates: [
      {
        dimension: 'understanding',
        level: 4,
        stable: false,
        nextReviewAt: '2026-09-25T10:00:00.000Z',
        lastReviewAt: '2026-09-24T10:00:00.000Z',
      },
      { dimension: 'production', level: 2, stable: false, nextReviewAt: null, lastReviewAt: null },
    ],
    productionHistory: [],
  };
}

/** 造句历史条目（LibraryItemDetail.productionHistory 元素） */
export function makeHistoryEntry(
  overrides: Partial<LibraryItemDetail['productionHistory'][number]> = {},
): LibraryItemDetail['productionHistory'][number] {
  return {
    id: 'ph-1',
    createdAt: '2026-09-24T10:00:00.000Z',
    originalText: 'The constant stress make me want to give up.',
    correctedSentence: 'The constant stress makes me want to give up.',
    betterVersion: null,
    result: 'pass',
    mode: 'today',
    ...overrides,
  };
}

export function makeUpdateResponse(
  detail: LibraryItemDetail,
  progressResetSuggested: boolean,
): UpdateLearningItemResponse {
  return { ...detail, progressResetSuggested };
}

export function makePreview(): ImportPreviewResponse {
  return {
    previewToken: 'tok-1',
    items: [
      {
        index: 0,
        candidate: {
          type: 'chunk',
          target: 'wear down',
          meaning: '逐渐使……疲惫；消耗',
          source_example: 'It wears you down.',
          extra_examples: [],
          source: 'Avatar S01E12',
          source_url: null,
          tags: ['Avatar'],
          notes: null,
        },
        suggestion: {
          action: 'merge',
          reason: '与已有项释义高度相近',
          confidence: 0.9,
          source: 'ai',
        },
        match: {
          existingId: 'item-9',
          existingTarget: 'wear down',
          existingMeaning: '逐渐使疲惫',
        },
        warnings: [],
      },
      {
        index: 1,
        candidate: {
          type: 'word',
          target: 'resilient',
          meaning: '有韧性的',
          source_example: 'A resilient city recovers quickly.',
          extra_examples: [],
          tags: [],
        },
        suggestion: {
          action: 'new_item',
          reason: '无相同 target',
          confidence: 1,
          source: 'rule_fallback',
        },
        match: null,
        warnings: [],
      },
      {
        index: 2,
        candidate: {
          type: 'word',
          target: 'raw',
          meaning: '未加工的',
          source_example: 'Raw sugar is less sweet.',
          extra_examples: [],
          tags: [],
        },
        suggestion: {
          action: 'skip_exact_duplicate',
          reason: '内容完全重复',
          confidence: 1,
          source: 'rule_exact',
        },
        match: {
          existingId: 'item-10',
          existingTarget: 'raw',
          existingMeaning: '未加工的',
        },
        warnings: [],
      },
    ],
  };
}
