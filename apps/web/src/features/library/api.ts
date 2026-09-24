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
  SuggestionSource,
  UpdateLearningItemRequest,
  UpdateLearningItemResponse,
} from '@el/shared';
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
