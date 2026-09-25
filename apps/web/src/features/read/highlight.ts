/** Read 正文 focus 高亮纯工具（PRODUCT §8.1：focus 词“轻微高亮”，old 词不高亮） */

export interface HighlightPart {
  text: string;
  highlighted: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 对段落做 focus surfaceForm 的大小写不敏感标记。
 * - 同一 surfaceForm 重复出现全部标记；
 * - 长词优先匹配，避免短语先被其中单词截断；
 * - 首尾为单词字符的 surfaceForm 加词边界，避免误标子串（如 drawing 中的 raw）。
 */
export function highlightParts(text: string, surfaceForms: readonly string[]): HighlightPart[] {
  const forms = [...new Set(surfaceForms.map((f) => f.trim()).filter((f) => f.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (forms.length === 0 || text.length === 0) return [{ text, highlighted: false }];

  const pattern = new RegExp(
    `(${forms
      .map((form) => {
        const prefix = /^\w/.test(form) ? '\\b' : '';
        const suffix = /\w$/.test(form) ? '\\b' : '';
        return `${prefix}${escapeRegExp(form)}${suffix}`;
      })
      .join('|')})`,
    'gi',
  );

  const parts: HighlightPart[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ text: text.slice(lastIndex, index), highlighted: false });
    parts.push({ text: match[0], highlighted: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), highlighted: false });
  return parts.length > 0 ? parts : [{ text, highlighted: false }];
}
