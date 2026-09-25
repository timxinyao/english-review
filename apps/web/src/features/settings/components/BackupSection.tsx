import { useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { BackupExport, type RestoreCommitResponse, type RestorePreviewResponse } from '@el/shared';
import type { ZodError } from 'zod';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { ApiError } from '../../../lib/api';
import { RESTORE_RELOAD_DELAY_MS, commitRestore, exportBackup, previewRestore } from '../api';

const MAX_ERRORS_SHOWN = 5;

/** 备份时间展示：ISO → 「YYYY-MM-DD HH:mm」 */
function formatBackupTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

/** Zod 校验错误整理为「第 N 项：字段 错误 / 文件格式：字段 错误」，只显示前几条 */
function formatBackupErrors(error: ZodError): string[] {
  const lines = error.issues.map((issue) => {
    if (issue.path[0] === 'items' && typeof issue.path[1] === 'number') {
      const itemNo = issue.path[1] + 1;
      const field = issue.path.slice(2).join('.') || '整体';
      return `第 ${itemNo} 项：${field} ${issue.message}`;
    }
    return `文件格式：${issue.path.join('.') || '(根)'} ${issue.message}`;
  });
  return lines.length > MAX_ERRORS_SHOWN
    ? [...lines.slice(0, MAX_ERRORS_SHOWN), `……等 ${lines.length} 个问题`]
    : lines;
}

interface BackupSectionProps {
  /** 恢复成功后的整页刷新（可注入以便测试） */
  reload?: () => void;
}

/**
 * 备份与恢复区（PRODUCT §9.3：导入导出只在 PC 提供 → hidden md:block）。
 * 恢复向导：选择文件 → 前端初校验 → 预览（含当前库覆盖警示）→ 二次确认 → 提交。
 */
export function BackupSection({ reload = () => window.location.reload() }: BackupSectionProps) {
  // 导出
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // 恢复
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<RestorePreviewResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restored, setRestored] = useState<RestoreCommitResponse | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: previewRestore,
    onSuccess: (resp) => {
      setPreview(resp);
      setErrors([]);
      setConfirming(false);
      setCommitError(null);
    },
  });

  const commitMutation = useMutation({
    mutationFn: commitRestore,
    onSuccess: (resp) => {
      setRestored(resp);
      setCommitError(null);
      window.setTimeout(reload, RESTORE_RELOAD_DELAY_MS);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        setCommitError('预览已过期，请重新选择文件');
      } else {
        setCommitError(`恢复失败：${err.message}`);
      }
    },
  });

  async function onExport() {
    setExportError(null);
    setExporting(true);
    try {
      await exportBackup();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出失败，请稍后重试。');
    } finally {
      setExporting(false);
    }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
      setFileName(file.name);
      setErrors([]);
      setPreview(null);
      setConfirming(false);
      setRestored(null);
      setCommitError(null);
    };
    reader.readAsText(file);
  }

  function startPreview() {
    setErrors([]);
    setCommitError(null);
    setConfirming(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setErrors([`JSON 解析失败：${err instanceof Error ? err.message : '格式错误'}`]);
      return;
    }
    const result = BackupExport.safeParse(parsed);
    if (!result.success) {
      setErrors(formatBackupErrors(result.error));
      return;
    }
    previewMutation.mutate(result.data);
  }

  function resetRestore() {
    setText('');
    setFileName('');
    setErrors([]);
    setPreview(null);
    setConfirming(false);
    setRestored(null);
    setCommitError(null);
  }

  function onConfirm() {
    if (!preview) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    commitMutation.mutate({ previewToken: preview.previewToken });
  }

  return (
    <>
      <section aria-label="备份与恢复" className="hidden space-y-4 md:block">
        <h2 className="text-sm font-semibold">备份与恢复</h2>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={onExport} disabled={exporting}>
            {exporting ? '导出中…' : '导出完整备份'}
          </Button>
          <span className="text-xs text-muted-foreground">完整备份含学习项、复习进度与统计。</span>
        </div>
        {exportError && (
          <p role="alert" className="text-sm text-destructive">
            {exportError}
          </p>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">恢复备份</h3>

          {!preview && !restored && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Label htmlFor="backup-file" className="text-xs font-normal">
                  选择完整备份 .json 文件
                </Label>
                <input
                  id="backup-file"
                  type="file"
                  accept=".json,application/json"
                  aria-label="备份 JSON 文件"
                  onChange={onFile}
                />
                {fileName && <span className="font-mono">{fileName}</span>}
              </div>

              {errors.length > 0 && (
                <div role="alert" className="space-y-1 rounded-lg border border-destructive/40 p-3">
                  {errors.map((line, i) => (
                    <p key={i} className="text-xs text-destructive">
                      {line}
                    </p>
                  ))}
                </div>
              )}
              {previewMutation.isError && (
                <p role="alert" className="text-sm text-destructive">
                  预览失败：{previewMutation.error.message}
                </p>
              )}
              <div>
                <Button
                  size="sm"
                  onClick={startPreview}
                  disabled={text.trim().length === 0 || previewMutation.isPending}
                >
                  {previewMutation.isPending ? '校验中…' : '校验并预览'}
                </Button>
              </div>
            </>
          )}

          {preview && !restored && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">恢复预览</h4>
              <dl className="space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
                  <dt className="text-muted-foreground">备份时间</dt>
                  <dd>{formatBackupTime(preview.exportedAt)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
                  <dt className="text-muted-foreground">备份学习项</dt>
                  <dd>{preview.itemCount} 项</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
                  <dt className="text-muted-foreground">统计天数</dt>
                  <dd>{preview.dailyStatsDays} 天</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
                  <dt className="text-muted-foreground">当前库学习项</dt>
                  <dd>
                    {preview.currentItemTotal} 项
                    <span className="ml-1 text-destructive">（将被覆盖）</span>
                  </dd>
                </div>
              </dl>
              {preview.warnings.length > 0 && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}

              {confirming && (
                <p className="text-sm text-destructive">
                  将覆盖当前全部数据，且已自动创建恢复前快照
                </p>
              )}
              {commitError && (
                <p role="alert" className="text-sm text-destructive">
                  {commitError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onConfirm}
                  disabled={commitMutation.isPending}
                >
                  {commitMutation.isPending
                    ? '恢复中…'
                    : confirming
                      ? '再次确认覆盖恢复'
                      : '确认覆盖恢复'}
                </Button>
                <Button variant="ghost" size="sm" onClick={resetRestore}>
                  重新选择文件
                </Button>
              </div>
            </div>
          )}

          {restored && (
            <div className="space-y-1">
              <p className="text-sm">恢复完成，正在刷新…</p>
              <p className="text-xs text-muted-foreground">
                已恢复 {restored.restoredItems} 项学习数据 · 统计 {restored.restoredDailyStats}{' '}
                天（恢复前快照：
                {restored.snapshotFile}）
              </p>
            </div>
          )}
        </div>
      </section>

      {/* PRODUCT §4.1/§9.3：导入导出只在 PC；移动端安静提示 */}
      <p className="text-xs text-muted-foreground md:hidden">备份与恢复请在电脑上操作。</p>
    </>
  );
}
