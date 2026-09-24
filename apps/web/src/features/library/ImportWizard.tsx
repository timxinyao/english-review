import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LibraryImport,
  type DuplicateDecision,
  type ImportCommitResponse,
  type ImportPreviewResponse,
} from '@el/shared';
import type { ZodError } from 'zod';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { ApiError } from '../../lib/api';
import {
  IMPORT_DECISION_LABELS,
  IMPORT_DECISION_OPTIONS,
  SUGGESTION_SOURCE_LABELS,
  commitLibraryImport,
  libraryKeys,
  previewLibraryImport,
} from './api';

const textareaClass =
  'flex min-h-[220px] w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** 把 Zod 校验错误整理成「第 N 项：字段 错误」逐条列表 */
function formatImportErrors(error: ZodError): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    if (issue.path[0] === 'items' && typeof issue.path[1] === 'number') {
      const itemNo = issue.path[1] + 1;
      const field = issue.path.slice(2).join('.') || '整体';
      lines.push(`第 ${itemNo} 项：${field} ${issue.message}`);
    } else {
      lines.push(`文件格式：${issue.path.join('.') || '(根)'} ${issue.message}`);
    }
  }
  return lines;
}

export function ImportWizard({ onExit }: { onExit: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'input' | 'preview' | 'done'>('input');
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<number, DuplicateDecision>>({});
  const [summary, setSummary] = useState<ImportCommitResponse | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: previewLibraryImport,
    onSuccess: (resp) => {
      setPreview(resp);
      setDecisions(Object.fromEntries(resp.items.map((i) => [i.index, i.suggestion.action])));
      setErrors([]);
      setStep('preview');
    },
  });

  const commitMutation = useMutation({
    mutationFn: commitLibraryImport,
    onSuccess: (resp) => {
      setSummary(resp);
      setCommitError(null);
      setStep('done');
      void qc.invalidateQueries({ queryKey: libraryKeys.all });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        setCommitError('预览已过期或已提交，请返回上一步重新预览。');
      } else {
        setCommitError(`提交失败：${err.message}`);
      }
    },
  });

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsText(file);
  }

  function startPreview() {
    setErrors([]);
    setCommitError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setErrors([`JSON 解析失败：${err instanceof Error ? err.message : '格式错误'}`]);
      return;
    }
    const result = LibraryImport.safeParse(parsed);
    if (!result.success) {
      setErrors(formatImportErrors(result.error));
      return;
    }
    previewMutation.mutate(result.data);
  }

  function applyAllSuggestions() {
    if (!preview) return;
    setDecisions(Object.fromEntries(preview.items.map((i) => [i.index, i.suggestion.action])));
  }

  function commit() {
    if (!preview) return;
    setCommitError(null);
    commitMutation.mutate({
      previewToken: preview.previewToken,
      decisions: preview.items.map((i) => ({
        index: i.index,
        action: decisions[i.index] ?? i.suggestion.action,
      })),
    });
  }

  return (
    <section className="space-y-4">
      {step === 'input' && (
        <>
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">导入学习库</h1>
            <Button variant="ghost" size="sm" onClick={onExit}>
              返回 Library
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-json">粘贴学习库 JSON</Label>
            <textarea
              id="import-json"
              rows={12}
              className={textareaClass}
              placeholder='{"version":"1.2","items":[…]}'
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Label htmlFor="import-file" className="text-xs font-normal">
                或选择 .json 文件
              </Label>
              <input
                id="import-file"
                type="file"
                accept=".json,application/json"
                onChange={onFile}
              />
            </div>
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
              onClick={startPreview}
              disabled={text.trim().length === 0 || previewMutation.isPending}
            >
              {previewMutation.isPending ? '校验中…' : '预览'}
            </Button>
          </div>
        </>
      )}

      {step === 'preview' && preview && (
        <>
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">导入预览</h1>
            <Button variant="ghost" size="sm" onClick={() => setStep('input')}>
              返回编辑
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            共 {preview.items.length} 项候选；系统建议仅供参考，可逐条调整最终决定。
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={applyAllSuggestions}>
              全部采用系统建议
            </Button>
          </div>

          <ul className="border-t border-border">
            {preview.items.map(({ index, candidate, suggestion, match }) => {
              const decision = decisions[index] ?? suggestion.action;
              return (
                <li key={index} className="space-y-1.5 border-b border-border py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {index + 1}. {candidate.target}
                    </p>
                    <span
                      title={suggestion.reason}
                      className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
                    >
                      {IMPORT_DECISION_LABELS[suggestion.action]}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{candidate.meaning}</p>
                  <p className="text-xs text-muted-foreground">{candidate.source_example}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      建议：{IMPORT_DECISION_LABELS[suggestion.action]} ·{' '}
                      {SUGGESTION_SOURCE_LABELS[suggestion.source]}
                      {match ? ` · 与已有「${match.existingTarget}」比对` : ''}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      决定
                      <select
                        aria-label={`决定：第 ${index + 1} 项`}
                        value={decision}
                        onChange={(e) =>
                          setDecisions((prev) => ({
                            ...prev,
                            [index]: e.target.value as DuplicateDecision,
                          }))
                        }
                        className="h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        {IMPORT_DECISION_OPTIONS.map(({ value, label }) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          {commitError && (
            <p role="alert" className="text-sm text-destructive">
              {commitError}
            </p>
          )}
          <div>
            <Button onClick={commit} disabled={commitMutation.isPending}>
              {commitMutation.isPending ? '提交中…' : `确认导入（${preview.items.length} 项）`}
            </Button>
          </div>
        </>
      )}

      {step === 'done' && summary && (
        <>
          <h1 className="text-lg font-semibold">导入完成</h1>
          <p className="text-sm">
            新增 {summary.created} 项 · 合并 {summary.merged} 项 · 跳过 {summary.skipped} 项（共{' '}
            {summary.total} 项）
          </p>
          <p className="text-xs text-muted-foreground">
            新学习项已进入 New Queue，将按每日新学习额度逐步引入 Today。
          </p>
          <div>
            <Button onClick={onExit}>返回 Library 列表</Button>
          </div>
        </>
      )}
    </section>
  );
}
