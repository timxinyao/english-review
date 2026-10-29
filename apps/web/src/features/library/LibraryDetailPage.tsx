import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  stabilityStageLabel,
  type LibraryItemDetail,
  type UpdateLearningItemRequest,
} from '@el/shared';
import { Star } from 'lucide-react';
import { Textarea } from '../../components/ui/textarea';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select } from '../../components/ui/select';
import { todayKeys } from '../today/api';
import { cn } from '../../lib/utils';
import {
  LIBRARY_STATUS_LABELS,
  archiveLibraryItem,
  fetchLibraryDetail,
  libraryKeys,
  masterLibraryItem,
  pauseLibraryItem,
  resetLibraryItemProgress,
  restoreLibraryItem,
  resumeLibraryItem,
  updateLibraryItem,
} from './api';
import { PracticeView } from './PracticeView';
import { ProductionHistoryList } from './ProductionHistoryList';

const DIMENSION_LABELS = { understanding: '理解', production: '输出' } as const;

interface ConfirmState {
  title: string;
  description?: string;
  onConfirm: () => void;
}

function ConfirmDialog({
  confirm,
  onCancel,
  pending,
  error,
}: {
  confirm: ConfirmState;
  onCancel: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const submitting = useRef(false);
  useEffect(() => {
    if (!pending) submitting.current = false;
  }, [pending]);
  return (
    <Dialog label={confirm.title} onClose={onCancel} dismissible={!pending} className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm text-foreground">{confirm.title}</p>
        {confirm.description && (
          <p className="text-xs text-muted-foreground">{confirm.description}</p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            if (submitting.current || pending) return;
            submitting.current = true;
            confirm.onConfirm();
          }}
        >
          {pending ? '正在重置…' : '确定'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message || '重置失败，请重试。'}
        </p>
      )}
    </Dialog>
  );
}

interface EditFormState {
  productionEnabledOverride: 'default' | 'enabled' | 'disabled';
  target: string;
  meaning: string;
  ipa: string;
  source: string;
  sourceUrl: string;
  tagsText: string;
  notes: string;
  sourceExample: string;
  extraExamples: string[];
  personal: { id: string; text: string; pinned: boolean }[];
}

function EditItemForm({
  detail,
  saving,
  onSave,
  onCancel,
}: {
  detail: LibraryItemDetail;
  saving: boolean;
  onSave: (body: UpdateLearningItemRequest) => void;
  onCancel: () => void;
}) {
  const { item } = detail;
  const [form, setForm] = useState<EditFormState>({
    productionEnabledOverride:
      item.productionEnabledOverride === null
        ? 'default'
        : item.productionEnabledOverride
          ? 'enabled'
          : 'disabled',
    target: item.target,
    meaning: item.meaning,
    ipa: item.ipa ?? '',
    source: item.source ?? '',
    sourceUrl: item.sourceUrl ?? '',
    tagsText: item.tags.join(', '),
    notes: item.notes ?? '',
    sourceExample: detail.sourceExample,
    extraExamples: [...detail.extraExamples],
    personal: detail.personalExamples.map((p) => ({ id: p.id, text: p.text, pinned: p.pinned })),
  });

  const canSubmit =
    form.target.trim().length > 0 &&
    form.meaning.trim().length > 0 &&
    form.sourceExample.trim().length > 0;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSave({
      productionEnabledOverride:
        form.productionEnabledOverride === 'default'
          ? null
          : form.productionEnabledOverride === 'enabled',
      target: form.target.trim(),
      meaning: form.meaning.trim(),
      ipa: item.type === 'word' && form.ipa.trim() ? form.ipa.trim() : null,
      source: form.source.trim() || null,
      sourceUrl: form.sourceUrl.trim() || null,
      tags: form.tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      notes: form.notes.trim() || null,
      sourceExample: form.sourceExample.trim(),
      extraExamples: form.extraExamples.map((s) => s.trim()).filter((s) => s.length > 0),
      personalExamples: form.personal.map((p) => ({
        id: p.id,
        text: p.text.trim(),
        pinned: p.pinned,
      })),
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">编辑学习项</h2>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit || saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-target">Target</Label>
        <Input
          id="edit-target"
          value={form.target}
          onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-meaning">释义</Label>
        <Input
          id="edit-meaning"
          value={form.meaning}
          onChange={(e) => setForm((f) => ({ ...f, meaning: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-production-goal">造句目标</Label>
        <Select
          id="edit-production-goal"
          value={form.productionEnabledOverride}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              productionEnabledOverride: e.target
                .value as EditFormState['productionEnabledOverride'],
            }))
          }
        >
          <option value="default">按类型默认（Word 不需要，Chunk 需要）</option>
          <option value="enabled">需要造句</option>
          <option value="disabled">不需要造句</option>
        </Select>
      </div>

      {item.type === 'word' && (
        <div className="space-y-2">
          <Label htmlFor="edit-ipa">IPA</Label>
          <Input
            id="edit-ipa"
            value={form.ipa}
            placeholder="/rɪˈzɪliənt/"
            onChange={(e) => setForm((f) => ({ ...f, ipa: e.target.value }))}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="edit-source">来源</Label>
        <Input
          id="edit-source"
          value={form.source}
          onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-source-url">来源链接</Label>
        <Input
          id="edit-source-url"
          type="url"
          value={form.sourceUrl}
          onChange={(e) => setForm((f) => ({ ...f, sourceUrl: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-tags">标签（逗号分隔）</Label>
        <Input
          id="edit-tags"
          value={form.tagsText}
          onChange={(e) => setForm((f) => ({ ...f, tagsText: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-notes">备注</Label>
        <Textarea
          id="edit-notes"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-source-example">原句（source example）</Label>
        <Textarea
          id="edit-source-example"
          rows={2}
          value={form.sourceExample}
          onChange={(e) => setForm((f) => ({ ...f, sourceExample: e.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label>补充例句（extra）</Label>
        <div className="space-y-2">
          {form.extraExamples.map((example, i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label={`补充例句 ${i + 1}`}
                value={example}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    extraExamples: f.extraExamples.map((v, j) => (j === i ? e.target.value : v)),
                  }))
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    extraExamples: f.extraExamples.filter((_, j) => j !== i),
                  }))
                }
              >
                删除
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="neutral"
          size="sm"
          onClick={() => setForm((f) => ({ ...f, extraExamples: [...f.extraExamples, ''] }))}
        >
          添加例句
        </Button>
      </div>

      <div className="space-y-2">
        <Label>个人例句（personal）</Label>
        <div className="space-y-2">
          {form.personal.map((p, i) => (
            <div key={p.id} className="flex items-center gap-2">
              <Input
                aria-label={`个人例句 ${i + 1}`}
                value={p.text}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    personal: f.personal.map((v, j) =>
                      j === i ? { ...v, text: e.target.value } : v,
                    ),
                  }))
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={p.pinned}
                aria-label={p.pinned ? `取消收藏个人例句 ${i + 1}` : `收藏个人例句 ${i + 1}`}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    personal: f.personal.map((v, j) => (j === i ? { ...v, pinned: !v.pinned } : v)),
                  }))
                }
              >
                <Star
                  aria-hidden
                  className={cn(
                    'h-4 w-4',
                    p.pinned ? 'fill-accent text-accent' : 'text-muted-foreground',
                  )}
                />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </form>
  );
}

export function LibraryDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [practicing, setPracticing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: libraryKeys.detail(id),
    queryFn: () => fetchLibraryDetail(id),
    enabled: id.length > 0,
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: libraryKeys.all });
  }

  const reset = useMutation({
    mutationFn: () => resetLibraryItemProgress(id),
    onSuccess: () => {
      setConfirm(null);
      invalidate();
      void qc.invalidateQueries({ queryKey: todayKeys.all });
    },
  });

  const update = useMutation({
    mutationFn: (body: UpdateLearningItemRequest) => updateLibraryItem(id, body),
    onSuccess: (resp) => {
      qc.setQueryData(libraryKeys.detail(id), resp);
      invalidate();
      void qc.invalidateQueries({ queryKey: todayKeys.all });
      setEditing(false);
      if (resp.progressResetSuggested) {
        setConfirm({
          title: '释义已变化，是否重置学习进度？',
          description: '重置后理解与输出进度将重新开始。',
          onConfirm: () => reset.mutate(),
        });
      }
    },
  });

  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: invalidate,
  });

  if (isLoading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">加载中…</p>;
  }
  if (isError || !data) {
    return <p className="py-16 text-center text-sm text-destructive">读取失败，请刷新重试。</p>;
  }

  // “练一下”是详情内的临时练习视图（PRODUCT §4.4），退出后回到详情
  if (practicing) {
    return <PracticeView itemId={id} onExit={() => setPracticing(false)} />;
  }

  const { item } = data;

  function runAction(run: () => Promise<unknown>) {
    action.mutate(run);
  }

  return (
    <div className="space-y-6">
      <Link
        to="/library"
        className="inline-flex min-h-11 items-center text-sm text-muted-foreground transition-colors hover:text-accent"
      >
        ← 返回 Library
      </Link>

      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-xl font-semibold text-foreground">{item.target}</h1>
          {item.type === 'word' && item.ipa && (
            <span className="text-sm text-muted-foreground">{item.ipa}</span>
          )}
          <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {item.type === 'word' ? 'Word' : 'Chunk'}
          </span>
          <span className="text-xs text-muted-foreground">
            {LIBRARY_STATUS_LABELS[item.status]}
          </span>
          {item.queueState === 'new' && (
            <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              New Queue
            </span>
          )}
        </div>
        <p className="text-sm text-foreground">{item.meaning}</p>
      </header>

      {editing ? (
        <EditItemForm
          detail={data}
          saving={update.isPending}
          onCancel={() => setEditing(false)}
          onSave={(body) => update.mutate(body)}
        />
      ) : (
        <>
          <dl className="space-y-2 text-sm">
            {item.source && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">来源</dt>
                <dd>{item.source}</dd>
              </div>
            )}
            {item.sourceUrl && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">链接</dt>
                <dd className="min-w-0 flex-1 truncate">
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                  >
                    {item.sourceUrl}
                  </a>
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">标签</dt>
              <dd className="flex flex-wrap gap-1">
                {item.tags.length > 0
                  ? item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))
                  : '—'}
              </dd>
            </div>
          </dl>

          {item.notes && <p className="text-sm text-muted-foreground">{item.notes}</p>}

          <section className="space-y-3">
            <h2 className="text-sm font-medium">例句</h2>
            <div className="space-y-1">
              <h3 className="text-xs text-muted-foreground">原句（source）</h3>
              <p className="text-sm">{data.sourceExample}</p>
            </div>
            <div className="space-y-1">
              <h3 className="text-xs text-muted-foreground">补充例句（extra）</h3>
              {data.extraExamples.length > 0 ? (
                <ul className="space-y-1">
                  {data.extraExamples.map((example, i) => (
                    <li key={i} className="text-sm">
                      {example}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">—</p>
              )}
            </div>
            <div className="space-y-1">
              <h3 className="text-xs text-muted-foreground">个人例句（personal）</h3>
              {data.personalExamples.length > 0 ? (
                <ul className="space-y-2">
                  {data.personalExamples.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-2">
                      <p className="flex min-w-0 items-center gap-1.5 text-sm">
                        <Star
                          aria-hidden
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            p.pinned ? 'fill-accent text-accent' : 'text-muted-foreground',
                          )}
                        />
                        <span className="truncate">{p.text}</span>
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          update.mutate({
                            personalExamples: data.personalExamples.map((v) =>
                              v.id === p.id
                                ? { id: v.id, pinned: !v.pinned }
                                : { id: v.id, pinned: v.pinned },
                            ),
                          })
                        }
                      >
                        {p.pinned ? '取消收藏' : '收藏'}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">—</p>
              )}
            </div>
          </section>

          <ProductionHistoryList history={data.productionHistory} />

          <section className="space-y-2">
            <h2 className="text-sm font-medium">学习状态</h2>
            {data.reviewStates.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {data.reviewStates.map((rs) => (
                  <li key={rs.dimension} className="flex flex-wrap items-center gap-x-3">
                    <span className="w-10 text-muted-foreground">
                      {DIMENSION_LABELS[rs.dimension]}
                    </span>
                    <span>{rs.stability === null ? '—' : `S${Math.round(rs.stability)}天`}</span>
                    <span className="text-muted-foreground">
                      {stabilityStageLabel(rs.stability)}
                    </span>
                    <span className="text-muted-foreground">下次复习</span>
                    <span>{rs.nextReviewAt ? rs.nextReviewAt.slice(0, 10) : '未安排'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">尚未开始学习（New Queue）。</p>
            )}
          </section>

          <div className="space-y-2 border-t border-border pt-4">
            {/* 主操作突出：练一下 / 编辑；暂停归档等收进「更多」 */}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setPracticing(true)}>
                练一下
              </Button>
              <Button variant="neutral" size="sm" onClick={() => setEditing(true)}>
                编辑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              >
                更多
              </Button>
            </div>
            {moreOpen && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2"
                data-more-actions
              >
                {item.status === 'active' && (
                  <Button
                    variant="neutral"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => runAction(() => pauseLibraryItem(id))}
                  >
                    暂停
                  </Button>
                )}
                {item.status === 'paused' && (
                  <Button
                    variant="neutral"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => runAction(() => resumeLibraryItem(id))}
                  >
                    恢复
                  </Button>
                )}
                {item.status === 'archived' ? (
                  <Button
                    variant="neutral"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => runAction(() => restoreLibraryItem(id))}
                  >
                    恢复
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => runAction(() => archiveLibraryItem(id))}
                  >
                    归档
                  </Button>
                )}
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() =>
                    setConfirm({
                      title: '重置学习进度？',
                      description: '将清空该学习项的理解与输出进度，重新回到未开始状态。',
                      onConfirm: () => reset.mutate(),
                    })
                  }
                >
                  重置进度
                </Button>
                {item.status !== 'mastered' && (
                  <Button
                    variant="neutral"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => runAction(() => masterLibraryItem(id))}
                  >
                    标记已掌握
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          confirm={confirm}
          pending={reset.isPending}
          error={reset.error}
          onCancel={() => {
            reset.reset();
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
