import type { ReactNode } from 'react';

/**
 * 在文本中高亮目标词/词组（大小写不敏感，词边界匹配）。
 * 样式与 Read 高亮一致：accent-soft 背景 + accent 文字。
 */
export function HighlightText({
  text,
  target,
  className = 'rounded bg-accent-soft px-0.5 font-medium text-accent',
}: {
  text: string;
  target: string;
  className?: string;
}): ReactNode {
  if (!target) return <>{text}</>;

  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 词边界匹配；chunk 的空格允许灵活空白（换行/多空格）
  const pattern = escaped.replace(/\s+/g, '\\s+');
  const regex = new RegExp(`\\b(${pattern})\\b`, 'gi');

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <mark key={match.index} className={`bg-transparent ${className}`}>
        {match[0]}
      </mark>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
}
