import type {
  DuplicateDecision,
  ImportCommitRequest,
  ImportCommitResponse,
  ImportPreviewResponse,
  LearningItemStatus,
  LibraryImport,
  LibraryItemDetail,
  LibraryListQuery,
  LibraryListResponse,
  PracticeAnswerRequest,
  PracticeAnswerResponse,
  PracticeStartResponse,
  SuggestionSource,
  UpdateLearningItemRequest,
  UpdateLearningItemResponse,
} from '@el/shared';
import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ---------- 常量与 query keys ----------

export const LIBRARY_PAGE_SIZE = 20;

export const libraryKeys = {
  all: ['library'] as const,
  list: (params: LibraryListQuery) => ['library', 'list', params] as const,
  detail: (id: string) => ['library', 'detail', id] as const,
};

/** 导入相关 mutation 标识（commit 成功后 invalidate libraryKeys.all） */
export const importKeys = {
  all: ['import'] as const,
  preview: ['import', 'preview'] as const,
  commit: ['import', 'commit'] as const,
};

/** 列表固定筛选（PRODUCT_DESIGN §5.2）；学习中 = status active */
export type LibraryFilterKey =
  | 'all'
  | 'type:word'
  | 'type:chunk'
  | 'status:active'
  | 'status:mastered'
  | 'status:paused'
  | 'status:archived';

export const LIBRARY_FILTERS: { key: LibraryFilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'type:word', label: 'Word' },
  { key: 'type:chunk', label: 'Chunk' },
  { key: 'status:active', label: '学习中' },
  { key: 'status:mastered', label: '已掌握' },
  { key: 'status:paused', label: '已暂停' },
  { key: 'status:archived', label: '已归档' },
];

export function libraryListParams(
  filter: LibraryFilterKey,
  query: string,
  page: number,
  pageSize: number = LIBRARY_PAGE_SIZE,
): LibraryListQuery {
  const params: LibraryListQuery = { page, pageSize };
  const q = query.trim();
  if (q) params.query = q;
  if (filter.startsWith('type:')) params.type = filter.slice(5) as 'word' | 'chunk';
  else if (filter.startsWith('status:')) params.status = filter.slice(7) as LearningItemStatus;
  return params;
}

export const LIBRARY_STATUS_LABELS: Record<LearningItemStatus, string> = {
  active: '学习中',
  mastered: '已掌握',
  paused: '已暂停',
  archived: '已归档',
};

export const IMPORT_DECISION_LABELS: Record<DuplicateDecision, string> = {
  merge: '合并',
  new_item: '新增',
  skip_exact_duplicate: '跳过',
};

export const IMPORT_DECISION_OPTIONS: { value: DuplicateDecision; label: string }[] = [
  { value: 'merge', label: '合并' },
  { value: 'new_item', label: '新增' },
  { value: 'skip_exact_duplicate', label: '跳过' },
];

/** 建议来源标记（PRODUCT_DESIGN §9.2：AI 只建议，用户确认） */
export const SUGGESTION_SOURCE_LABELS: Record<SuggestionSource, string> = {
  ai: 'AI',
  rule_exact: '规则',
  rule_fallback: '规则回退',
};

// ---------- 请求函数 ----------

export async function fetchLibraryList(params: LibraryListQuery): Promise<LibraryListResponse> {
  const sp = new URLSearchParams();
  if (params.query) sp.set('query', params.query);
  if (params.type) sp.set('type', params.type);
  if (params.status) sp.set('status', params.status);
  sp.set('page', String(params.page));
  sp.set('pageSize', String(params.pageSize));
  return api<LibraryListResponse>(`/api/library?${sp.toString()}`);
}

export async function fetchLibraryDetail(id: string): Promise<LibraryItemDetail> {
  return api<LibraryItemDetail>(`/api/library/${id}`);
}

export async function updateLibraryItem(
  id: string,
  body: UpdateLearningItemRequest,
): Promise<UpdateLearningItemResponse> {
  return api<UpdateLearningItemResponse>(`/api/library/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function itemAction(id: string, action: string): Promise<LibraryItemDetail> {
  return api<LibraryItemDetail>(`/api/library/${id}/${action}`, { method: 'POST' });
}

export function pauseLibraryItem(id: string) {
  return itemAction(id, 'pause');
}

export function resumeLibraryItem(id: string) {
  return itemAction(id, 'resume');
}

export function archiveLibraryItem(id: string) {
  return itemAction(id, 'archive');
}

export function restoreLibraryItem(id: string) {
  return itemAction(id, 'restore');
}

export function resetLibraryItemProgress(id: string) {
  return itemAction(id, 'reset');
}

export function masterLibraryItem(id: string) {
  return itemAction(id, 'master');
}

export function previewLibraryImport(payload: LibraryImport): Promise<ImportPreviewResponse> {
  return api<ImportPreviewResponse>('/api/import/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function commitLibraryImport(req: ImportCommitRequest): Promise<ImportCommitResponse> {
  return api<ImportCommitResponse>('/api/import/commit', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// ---------- 练一下（PRODUCT §4.4：不改 Stage/next_review_at、不造补强、不计 Today 进度）----------

export function startPractice(itemId: string): Promise<PracticeStartResponse> {
  return api<PracticeStartResponse>(`/api/library/${itemId}/practice`, { method: 'POST' });
}

export function answerPracticeQuestion(
  itemId: string,
  questionId: string,
  body: PracticeAnswerRequest,
  signal?: AbortSignal,
): Promise<PracticeAnswerResponse> {
  return api<PracticeAnswerResponse>(`/api/library/${itemId}/practice/${questionId}/answer`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

/** 开始练习：临时生成与当前阶段匹配的题（表达题优质句仍可入 Personal Example） */
export function usePractice(itemId: string) {
  return useMutation({ mutationFn: () => startPractice(itemId) });
}

/** usePracticeAnswer 结果：mutation 全量字段 + cancel（批改中取消，2026-10-05） */
export type PracticeAnswerMutation = UseMutationResult<
  PracticeAnswerResponse,
  Error,
  { questionId: string; body: PracticeAnswerRequest }
> & { cancel: () => void };

/**
 * 练习作答 + 批改中取消：练一下无正式状态，cancel 为纯前端掐断
 * （abort + reset 清 pending/error），无取消后 invalidate 诉求。
 */
export function usePracticeAnswer(itemId: string): PracticeAnswerMutation {
  const qc = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: ({ questionId, body }: { questionId: string; body: PracticeAnswerRequest }) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return answerPracticeQuestion(itemId, questionId, body, controller.signal);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
  const { reset } = mutation;
  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    reset();
  }, [reset]);
  return { ...mutation, cancel };
}
