/** 题目渲染纯工具（Today 与 Library 练一下共用，无 UI、无请求） */

function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 以字符串为种子的确定性洗牌（PRODUCT §7.1：每次展示重新 shuffle 选项，
 * 同一 questionId 在会话内顺序稳定，提交的仍是原 option id）。
 */
export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const arr = [...items];
  let state = seedFrom(seed) || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 0x100000000) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 填空题空位标记（与 AI Schema `text_with_blank` 约定一致：恰好一个 ____） */
export const CLOZE_BLANK = '____';

/** 按空位把 textWithBlank 切成 [前文, 后文]；无标记时退化为整体展示 */
export function splitClozeBlank(textWithBlank: string): [string, string] {
  const index = textWithBlank.indexOf(CLOZE_BLANK);
  if (index === -1) return ['', textWithBlank];
  return [textWithBlank.slice(0, index), textWithBlank.slice(index + CLOZE_BLANK.length)];
}
