import type { ReactNode } from 'react';

/** 正则特殊字符转义（target 作为字面量拼进正则） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单词的词形变体 alternation：一组正则分支（不枚举字符串）覆盖常见屈折——
 * 三单 s/es、过去 ed、进行 ing，加上规则变形：末尾 e 去 e 加 ing/ed（use→using/used）、
 * 辅音+元音+单辅音结尾双写辅音（stop→stopping/stopped）、辅音后 y 结尾 y→ies/ied
 * （carry→carries/carried）。不对应真实拼写的形式（useing 等）永远不命中，无害；
 * 不规则过去式（wore/gave）天然不覆盖。例：use → use(?:s|es|ies|ed|d|ing)?|using|used。
 * 仅对纯字母词（≥2 字母）变形，其余（连字符词、缩写等）按字面量返回。
 */
function inflectedWordPattern(word: string): string {
  const escaped = escapeRegExp(word);
  if (!/^[A-Za-z]{2,}$/.test(word)) return escaped;

  const w = word.toLowerCase();
  const alts = [`${escaped}(?:s|es|ies|ed|d|ing)?`];

  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    alts.push(`${stem}ing`, `${stem}ed`); // ed 与 基础+d 同形，幂等无害
  }
  if (/[^aeiou]y$/.test(w)) {
    const stem = w.slice(0, -1);
    alts.push(`${stem}ies`, `${stem}ied`);
  }
  // 末三位 辅音+元音+单辅音（末位排除 w/x/y）：双写末辅音（visit 等多音节只会多出
  // 永不命中的拼错形式，submit→submitting 这类重读末音节的正确变形则被覆盖）
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
    const doubled = w + w.slice(-1);
    alts.push(`${doubled}ing`, `${doubled}ed`);
  }
  return alts.join('|');
}

/**
 * 占位代词表：词库 target 里的占位符在原句中对应任意人称（chunk 内任意词位替换，
 * 不越词边界——alternation 位于固定词位，独立的 his/my 不会单独触发命中）。
 * 键为归一化形（小写 + 去撇号：one's/one’s/ones → ones）；引号字符类覆盖
 * 直撇 '、弯撇 ‘ ’ 与撇号 ′。
 */
const PRONOUN_PLACEHOLDERS: Record<string, string> = {
  ones: "one['‘’′]s|ones|my|his|her|their|your|its|our",
  oneself: 'oneself|myself|himself|herself|themselves|yourself|itself|ourselves',
};

/** 占位符查表用的归一化：小写 + 去各类撇号 */
function placeholderKey(word: string): string {
  return word.toLowerCase().replace(/['‘’′]/g, '');
}

/**
 * 首词不规则动词表（小写键，匹配大小写不敏感）：叠加在规则屈折之上，
 * 补齐规则变形覆盖不到的不规则形态（wear down → wore down）。命中显示原文形态。
 */
const IRREGULAR_FIRST_VERBS: Record<string, string> = {
  be: 'is|am|are|was|were|being|been',
  have: 'has|had',
  get: 'got|gotten',
  do: 'does|did',
  go: 'went|gone',
  make: 'made',
  take: 'took|taken',
  give: 'gave|given',
  wear: 'wore|worn',
  say: 'said',
  tell: 'told',
  come: 'came',
};

/**
 * 在文本中高亮目标词/词组（大小写不敏感，词边界匹配）。
 * 单词目标按词形变体集命中（makes/making 也点亮 make）；词组目标对首词变形
 * （规则屈折 ∪ 不规则动词表，make sense → makes/making/made sense）、其余词保持
 * 原形，但占位代词（one's/oneself）在任意词位按人称替换命中
 * （get one's butt kicked → gets his butt kicked）。高亮显示原文里的实际形态。
 * 样式（2026-10-03 四候选视觉评审胜选 C）：accent 文字 + 半粗 + 大偏移下划线——
 * 颜色/字重/下划线三重信号，Quiet 且一眼锁定；不用底色（mark 的 bg-transparent
 * 前缀在 Tailwind CSS 顺序上会压掉任何 bg-* 类）。
 */
export function HighlightText({
  text,
  target,
  className = 'font-semibold text-accent underline decoration-accent/60 decoration-2 underline-offset-4',
}: {
  text: string;
  target: string;
  className?: string;
}): ReactNode {
  if (!target) return <>{text}</>;

  // 词边界匹配；空白允许灵活空白（换行/多空格）；首词按 屈折变形 ∪ 不规则表 匹配，
  // 其余词原形（占位代词任意词位替换）。每个词位的 alternation 都包 (?:...)：
  // 防词组后续词被并进分支尾部，也防灾难回溯（分支均为有界字面量序列）。
  const pattern = target
    .trim()
    .split(/\s+/)
    .map((word, index) => {
      const placeholder = PRONOUN_PLACEHOLDERS[placeholderKey(word)];
      if (placeholder) return `(?:${placeholder})`;
      if (index === 0) {
        const irregular = IRREGULAR_FIRST_VERBS[word.toLowerCase()];
        return irregular
          ? `(?:${inflectedWordPattern(word)}|${irregular})`
          : `(?:${inflectedWordPattern(word)})`;
      }
      return escapeRegExp(word);
    })
    .join('\\s+');
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
