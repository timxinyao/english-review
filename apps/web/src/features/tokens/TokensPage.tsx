import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';

/** 色板条目：cssVar 为 globals.css :root 变量名 */
const TOKENS: { name: string; cssVar: string }[] = [
  { name: '背景 background', cssVar: '--background' },
  { name: '卡片 card', cssVar: '--card' },
  { name: '前景 foreground', cssVar: '--foreground' },
  { name: '柔和底 muted', cssVar: '--muted' },
  { name: '柔和前景 muted-foreground', cssVar: '--muted-foreground' },
  { name: '品牌暖橙 accent', cssVar: '--accent' },
  { name: '浅暖填充 accent-soft', cssVar: '--accent-soft' },
  { name: '描边 border', cssVar: '--border' },
  { name: '输入描边 input', cssVar: '--input' },
  { name: '暖红 destructive', cssVar: '--destructive' },
  { name: '通过绿 success', cssVar: '--success' },
  { name: '基础通过金 warning', cssVar: '--warning' },
  { name: 'Diff 删除 diff-delete', cssVar: '--diff-delete' },
  { name: 'Diff 插入 diff-insert', cssVar: '--diff-insert' },
];

/** /tokens：全局设计基元色卡页（不入导航）；色值运行时读 CSS 变量，零第二份数据 */
export function TokensPage(): ReactNode {
  const [hexOf, setHexOf] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setHexOf(
      Object.fromEntries(TOKENS.map((t) => [t.cssVar, style.getPropertyValue(t.cssVar).trim()])),
    );
  }, []);

  return (
    <div className="space-y-8 p-6">
      <h2 className="text-lg font-semibold">色板</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {TOKENS.map((t) => (
          <div key={t.cssVar} className="space-y-1">
            <div
              className="h-10 rounded-lg border border-border"
              style={{ backgroundColor: `var(${t.cssVar})` }}
              aria-hidden
            />
            <p className="text-xs text-muted-foreground">
              {t.name} · <code>{t.cssVar}</code> {hexOf[t.cssVar] && `· ${hexOf[t.cssVar]}`}
            </p>
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">按钮矩阵</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">primary</Button>
          <Button variant="neutral">neutral</Button>
          <Button variant="negative">negative</Button>
          <Button variant="destructive">destructive</Button>
          <Button variant="ghost">ghost</Button>
          <Button variant="neutral" disabled>
            禁用
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          primary=肯定主操作；neutral=中性次要；negative=学习流否定自评；destructive=不可逆危险确认；ghost=弱操作
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">判语语义色</h2>
        <p className="text-sm text-success">通过 · 想起来了</p>
        <p className="text-sm text-warning">基础通过 · 提示后想起</p>
        <p className="text-sm text-destructive">未通过 · 没想起来 / 想错了</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">字号层级</h2>
        <p className="text-lg text-foreground">text-lg 词行/标题</p>
        <p className="text-base text-foreground">text-base 释义</p>
        <p className="text-sm text-foreground">text-sm 正文</p>
        <p className="text-xs text-muted-foreground">text-xs 辅助说明</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Diff 色</h2>
        <p>
          <span className="text-diff-delete">删除：原句错误片段</span>
          <span className="ml-2 text-diff-insert">插入：修正后片段</span>
        </p>
      </section>
    </div>
  );
}
