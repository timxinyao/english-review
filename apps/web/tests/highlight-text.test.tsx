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

  it('首词不规则表（原"已知边界"已关闭）：wore/worn 形态点亮 wear down', () => {
    expect(highlightedTexts('The long hike wore down my resolve.', 'wear down')).toEqual([
      'wore down',
    ]);
    expect(highlightedTexts('Water had worn down the rock.', 'wear down')).toEqual(['worn down']);
  });

  it('无命中/空 target：整段按普通文本渲染（无 mark）', () => {
    expect(highlightedTexts('plain text', 'zzz')).toEqual([]);
    expect(highlightedTexts('plain text', '')).toEqual([]);
  });
});

describe('HighlightText 占位代词与首词不规则动词表', () => {
  it("用户实例：get one's butt kicked 命中 gets his butt kicked（高亮为原文形态）", () => {
    expect(
      highlightedTexts(
        'I will decide when he trains and when he gets his butt kicked at Pai Sho.',
        "get one's butt kicked",
      ),
    ).toEqual(['gets his butt kicked']);
  });

  it('反身占位：enjoy oneself 命中 enjoyed himself', () => {
    expect(highlightedTexts('He enjoyed himself at the party.', 'enjoy oneself')).toEqual([
      'enjoyed himself',
    ]);
  });

  it('首词不规则表：wear down 命中 wore down；make sense 命中 made sense', () => {
    expect(highlightedTexts('The long hike wore down my resolve.', 'wear down')).toEqual([
      'wore down',
    ]);
    expect(highlightedTexts('It made sense at the time.', 'make sense')).toEqual(['made sense']);
  });

  it('be 动词表：be supposed to 命中 is supposed to', () => {
    expect(highlightedTexts('He is supposed to arrive at noon.', 'be supposed to')).toEqual([
      'is supposed to',
    ]);
  });

  it("弯引号归一：one's cup of tea 命中弯撇原句 one’s cup of tea（双向）", () => {
    // 原句弯撇（’），target 直撇（'）
    expect(highlightedTexts('It may not be one’s cup of tea.', "one's cup of tea")).toEqual([
      'one’s cup of tea',
    ]);
    // target 弯撇，原句直撇——归一化双向成立
    expect(highlightedTexts("It may not be one's cup of tea.", 'one’s cup of tea')).toEqual([
      "one's cup of tea",
    ]);
  });

  it("占位符不越词位：独立 his 不因某 target 含 one's 而乱命中", () => {
    expect(
      highlightedTexts('His brother fixed his bike yesterday.', "get one's butt kicked"),
    ).toEqual([]);
  });
});
