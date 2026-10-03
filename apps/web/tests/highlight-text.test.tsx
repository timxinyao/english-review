import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HighlightText } from '../src/components/highlight-text';

afterEach(cleanup);

/** 渲染后收集所有 mark 的文本（即被高亮的原文片段） */
function highlightedTexts(text: string, target: string): string[] {
  const { container } = render(
    <p>
      <HighlightText text={text} target={target} />
    </p>,
  );
  return Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent ?? '');
}

describe('HighlightText 词形变体高亮', () => {
  it('原形命中：stable 命中原句里的 stable', () => {
    expect(highlightedTexts('The ladder feels stable.', 'stable')).toEqual(['stable']);
  });

  it('词组首词变形：make sense 命中 makes sense（显示原文形态）', () => {
    expect(highlightedTexts('His explanation makes sense to me.', 'make sense')).toEqual([
      'makes sense',
    ]);
    expect(highlightedTexts('Does that make sense?', 'make sense')).toEqual(['make sense']);
    expect(highlightedTexts('I was making sense of the data.', 'make sense')).toEqual([
      'making sense',
    ]);
  });

  it('词组首词进行式：wear down 命中 wearing down', () => {
    expect(highlightedTexts('The stress is wearing down my patience.', 'wear down')).toEqual([
      'wearing down',
    ]);
  });

  it('单词屈折族：use/uses/using 各命中且高亮为原文形态', () => {
    expect(highlightedTexts('I use it.', 'use')).toEqual(['use']);
    expect(highlightedTexts('She uses it.', 'use')).toEqual(['uses']);
    expect(highlightedTexts('He is using it.', 'use')).toEqual(['using']);
    expect(highlightedTexts('They used it.', 'use')).toEqual(['used']);
  });

  it('规则变形：双写辅音（stop→stopping/stopped）与辅音后 y（carry→carries/carried）', () => {
    expect(highlightedTexts('He stopped the car and went in.', 'stop')).toEqual(['stopped']);
    expect(highlightedTexts('The rain is stopping now.', 'stop')).toEqual(['stopping']);
    expect(highlightedTexts('She carried the box.', 'carry')).toEqual(['carried']);
    expect(highlightedTexts('It carries well.', 'carry')).toEqual(['carries']);
  });

  it('词边界保护：hat 不误伤 that，只命中独立的 hat', () => {
    expect(highlightedTexts('I bought that hat for my hat collection.', 'hat')).toEqual([
      'hat',
      'hat',
    ]);
    const marks = highlightedTexts('That hat is nice.', 'hat');
    expect(marks).toEqual(['hat']);
  });

  it('大小写不敏感：Makes 大写开头仍命中', () => {
    expect(highlightedTexts('Makes sense to me.', 'make sense')).toEqual(['Makes sense']);
  });

  it('不规则过去式不覆盖（已知边界）：wore 不点亮 wear down', () => {
    expect(highlightedTexts('The long hike wore me down.', 'wear down')).toEqual([]);
  });

  it('无命中/空 target：整段按普通文本渲染（无 mark）', () => {
    expect(highlightedTexts('plain text', 'zzz')).toEqual([]);
    expect(highlightedTexts('plain text', '')).toEqual([]);
  });
});
