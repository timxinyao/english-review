import { useEffect, useState, type ReactNode } from 'react';
import { Volume2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { CorrectionDiff } from '../../components/correction-diff';
import { cn } from '../../lib/utils';

/** 只登记 token 名与工具类；色值从 globals.css 读取，不复制色值或内联样式。 */
const TOKENS = [
  { name: '纸张背景', cssVar: '--background', className: 'bg-background' },
  { name: '暖白卡片', cssVar: '--card', className: 'bg-card' },
  { name: '暖黑正文', cssVar: '--foreground', className: 'bg-foreground' },
  { name: '暖灰填充', cssVar: '--muted', className: 'bg-muted' },
  { name: '暖灰悬停', cssVar: '--muted-hover', className: 'bg-muted-hover' },
  { name: '辅助文字', cssVar: '--muted-foreground', className: 'bg-muted-foreground' },
  { name: '陶土强调', cssVar: '--accent', className: 'bg-accent' },
  { name: '强调悬停', cssVar: '--accent-hover', className: 'bg-accent-hover' },
  { name: '浅陶土', cssVar: '--accent-soft', className: 'bg-accent-soft' },
  { name: '细边界', cssVar: '--border', className: 'bg-border' },
  { name: '输入边界', cssVar: '--input', className: 'bg-input' },
  { name: '暖红', cssVar: '--destructive', className: 'bg-destructive' },
  { name: '浅暖红', cssVar: '--destructive-soft', className: 'bg-destructive-soft' },
  { name: '通过绿', cssVar: '--success', className: 'bg-success' },
  { name: '基础通过金', cssVar: '--warning', className: 'bg-warning' },
  { name: 'Diff 删除', cssVar: '--diff-delete', className: 'bg-diff-delete' },
  { name: 'Diff 插入', cssVar: '--diff-insert', className: 'bg-diff-insert' },
];

const BUTTONS = [
  { variant: 'primary', label: '主操作 · 提交、良好、下一题' },
  { variant: 'neutral', label: '次操作 · 简单、取消、关闭' },
  { variant: 'negative', label: '否定自评 · 重来' },
  { variant: 'destructive', label: '危险确认 · 归档、覆盖恢复' },
  { variant: 'ghost', label: '工具操作 · 发音、撤销、刷新' },
] as const;

/** /tokens：真实色卡与组件；不接业务 API，输入示例仅用于体验控件。 */
export function TokensPage(): ReactNode {
  const [hexOf, setHexOf] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setHexOf(
      Object.fromEntries(TOKENS.map((t) => [t.cssVar, style.getPropertyValue(t.cssVar).trim()])),
    );
  }, []);

  return (
    <div className="mx-auto max-w-[680px] space-y-10 pb-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">色卡与组件</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          暖纸、陶土与清晰的阅读层次。这里展示应用实际使用的颜色和控件。
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">色板</h2>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
          {TOKENS.map((t) => (
            <div key={t.cssVar} className="min-w-0 space-y-2">
              <div
                className={cn('h-16 rounded-lg border border-border', t.className)}
                aria-hidden
              />
              <p className="text-sm">{t.name}</p>
              <p className="break-all text-xs leading-5 text-muted-foreground">
                <code>{t.cssVar}</code>
                <span className="block font-mono">{hexOf[t.cssVar]}</span>
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-7">
        <h2 className="text-lg font-medium">按钮矩阵</h2>
        <div className="space-y-3">
          {BUTTONS.map(({ variant, label }) => (
            <div key={variant} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button variant={variant} className="w-32">
                {variant}
              </Button>
              <span className="text-sm text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="neutral" disabled>
            禁用
          </Button>
          <Button variant="ghost" size="icon" aria-label="图标按钮示例">
            <Volume2 className="h-4 w-4" aria-hidden />
          </Button>
          <Button variant="neutral" size="sm">
            小按钮
          </Button>
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-7">
        <h2 className="text-lg font-medium">输入控件</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="token-input">文本输入</Label>
            <Input id="token-input" placeholder="输入一个词或表达" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="token-select">选择</Label>
            <Select id="token-select" className="w-full" defaultValue="B1">
              <option value="A2">A2</option>
              <option value="B1">B1</option>
              <option value="B2">B2</option>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="token-textarea">表达输入</Label>
          <Textarea id="token-textarea" rows={3} placeholder="Write your sentence in English…" />
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-7">
        <h2 className="text-lg font-medium">字号层级</h2>
        <div className="space-y-6 rounded-xl border border-border bg-card p-6">
          <p className="study-title">make sense</p>
          <p className="study-example">
            <span className="mb-1 block text-xs text-muted-foreground">原句</span>
            His explanation makes sense to me.
          </p>
          <p className="text-lg leading-relaxed">讲得通；有道理</p>
          <p className="text-sm leading-7 text-muted-foreground">
            笔记与辅助正文，保持舒适的行距。
          </p>
          <p className="text-xs text-muted-foreground">辅助标签 · 进度与来源</p>
        </div>
      </section>

      <section className="space-y-3 border-t border-border pt-7">
        <h2 className="text-lg font-medium">判语语义色</h2>
        <p className="text-sm text-success">通过 · 良好 / 简单</p>
        <p className="text-sm text-warning">基础通过 · 提示后想起</p>
        <p className="text-sm text-destructive">未通过 · 重来</p>
      </section>

      <section className="space-y-3 border-t border-border pt-7">
        <h2 className="text-lg font-medium">Diff 色</h2>
        <CorrectionDiff
          segments={[
            { text: 'His explanation ', type: 'same' },
            { text: 'make', type: 'delete' },
            { text: 'makes', type: 'insert' },
            { text: ' sense to me.', type: 'same' },
          ]}
          betterVersion={null}
        />
      </section>
    </div>
  );
}
