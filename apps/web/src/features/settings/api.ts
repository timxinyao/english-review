import type {
  RestoreCommitRequest,
  RestoreCommitResponse,
  RestorePreviewResponse,
} from '@el/shared';
import { api } from '../../lib/api';

// ---------- 备份与恢复（PRODUCT §9.3：PC 提供；契约 packages/shared backup.ts 已冻结）----------

/** commit 成功后延迟整页刷新（等待提示可读） */
export const RESTORE_RELOAD_DELAY_MS = 1500;

/** 导出完整备份：blob 下载（文件名 english-review-backup-<date>.json） */
export async function exportBackup(): Promise<void> {
  const res = await fetch('/api/export/backup', { credentials: 'include' });
  if (!res.ok) throw new Error(`导出失败（${res.status}），请稍后重试。`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `english-review-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 恢复预览：请求体 = 备份 JSON 本身 */
export function previewRestore(payload: unknown): Promise<RestorePreviewResponse> {
  return api<RestorePreviewResponse>('/api/restore/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 二次确认后提交覆盖恢复 */
export function commitRestore(req: RestoreCommitRequest): Promise<RestoreCommitResponse> {
  return api<RestoreCommitResponse>('/api/restore/commit', {
    method: 'POST',
    body: JSON.stringify(req satisfies RestoreCommitRequest),
  });
}
