import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CorrectionSegment } from '@el/shared';
import { CorrectionDiff } from '../src/components/correction-diff';

afterEach(cleanup);

/** PRODUCT §7.4 示例 diff：wear → wears */
const SEGMENTS: CorrectionSegment[] = [
  { text: 'The constant stress ', type: 'same' },
  { text: 'wear', type: 'delete' },
  { text: 'wears', type: 'insert' },
  { text: ' me down every day.', type: 'same' },
];

describe('CorrectionDiff（表达题批改 diff，PRODUCT §7.4/§12.2）', () => {
  it('same 片段保持正文色，不带删除线或增删颜色', () => {
    render(<CorrectionDiff segments={SEGMENTS} betterVersion={null} />);

    // 尾部带空格的片段用精确 textContent 匹配（避免文本规范化吞掉空格）
    const seg = screen.getByText(
      (_, el) => el?.tagName === 'SPAN' && el.textContent === 'The constant stress ',
    );
    expect(seg.className).toContain('text-foreground');
    expect(seg.className).not.toContain('line-through');
    expect(seg.className).not.toContain('text-diff-delete');
    expect(seg.className).not.toContain('text-diff-insert');
  });

  it('delete 片段：diff-delete 红色 + 删除线', () => {
    render(<CorrectionDiff segments={SEGMENTS} betterVersion={null} />);

    const seg = screen.getByText('wear');
    expect(seg.className).toContain('text-diff-delete');
    expect(seg.className).toContain('line-through');
  });

  it('insert 片段：diff-insert 绿色、无删除线', () => {
    render(<CorrectionDiff segments={SEGMENTS} betterVersion={null} />);

    const seg = screen.getByText('wears');
    expect(seg.className).toContain('text-diff-insert');
    expect(seg.className).not.toContain('line-through');
  });

  it('betterVersion 存在：折叠在“更自然的说法”里，默认不展开', () => {
    render(
      <CorrectionDiff
        segments={SEGMENTS}
        betterVersion="The constant stress is wearing me down."
      />,
    );

    const summary = screen.getByText('更自然的说法');
    expect(summary).toBeVisible();
    const details = screen.getByText('The constant stress is wearing me down.').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
  });

  it('betterVersion 为 null：不渲染折叠区', () => {
    render(<CorrectionDiff segments={SEGMENTS} betterVersion={null} />);

    expect(screen.queryByText('更自然的说法')).not.toBeInTheDocument();
  });

  it('有修改时展示“纠正后”干净行；全 same（通过）时不渲染', () => {
    const { rerender } = render(
      <CorrectionDiff
        segments={SEGMENTS}
        correctedSentence="The constant stress wears me down every day."
        betterVersion={null}
      />,
    );
    expect(screen.getByText('纠正后')).toBeVisible();
    expect(screen.getByText('The constant stress wears me down every day.')).toBeVisible();

    // 通过：diff 全 same，句子本身已在 diff 中，不再渲染“纠正后”行
    rerender(
      <CorrectionDiff
        segments={[{ text: 'The constant stress makes me want to give up.', type: 'same' }]}
        correctedSentence="The constant stress makes me want to give up."
        betterVersion={null}
      />,
    );
    expect(screen.getByText('The constant stress makes me want to give up.')).toBeVisible();
    expect(screen.queryByText('纠正后')).not.toBeInTheDocument();
  });
});
