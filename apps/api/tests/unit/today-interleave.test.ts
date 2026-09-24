import { describe, expect, it } from 'vitest';
import { interleaveTasks, type InterleavableTask } from '../../src/modules/today/service.js';

function t(
  itemId: string,
  taskType: InterleavableTask['taskType'],
  tag = '',
): InterleavableTask & { tag: string } {
  return { itemId, taskType, tag: tag || `${itemId}:${taskType}` };
}

/** 断言相邻位置不同 item（多组时轮转保证） */
function expectNoAdjacentSameItem(ordered: InterleavableTask[]): void {
  for (let i = 1; i < ordered.length; i += 1) {
    expect(ordered[i]!.itemId, `位置 ${i - 1}/${i}`).not.toBe(ordered[i - 1]!.itemId);
  }
}

function maxTypeRun(ordered: InterleavableTask[]): number {
  let max = 0;
  let run = 0;
  let prev: string | null = null;
  for (const x of ordered) {
    run = x.taskType === prev ? run + 1 : 1;
    prev = x.taskType;
    max = Math.max(max, run);
  }
  return max;
}

describe('interleaveTasks 混排', () => {
  it('保持全部任务且不改变任务集合', () => {
    const tasks = [t('a', 'understanding'), t('b', 'cloze'), t('c', 'learn'), t('a', 'cloze')];
    const ordered = interleaveTasks(tasks);
    expect(ordered).toHaveLength(tasks.length);
    expect(new Set(ordered.map((x) => x.tag))).toEqual(new Set(tasks.map((x) => x.tag)));
  });

  it('同一 item 的多个任务不相邻（多 item 场景）', () => {
    const tasks = [
      t('a', 'understanding'),
      t('a', 'cloze'),
      t('b', 'understanding'),
      t('b', 'cloze'),
      t('c', 'understanding'),
      t('c', 'cloze'),
    ];
    const ordered = interleaveTasks(tasks);
    expectNoAdjacentSameItem(ordered);
  });

  it('同 item 的 learn 卡先于该 item 的复习题出现', () => {
    // learn 与 U/P 复习共存于同一 item 不可能（learn 项 queue_state=new），
    // 但算法仍应保证组内 learn → understanding → cloze 的稳定顺序
    const ordered = interleaveTasks([
      t('a', 'cloze'),
      t('a', 'understanding'),
      t('b', 'understanding'),
    ]);
    const aTypes = ordered.filter((x) => x.itemId === 'a').map((x) => x.taskType);
    expect(aTypes).toEqual(['understanding', 'cloze']);
  });

  it('同一题型连续不超过 3（混合题量充足时）', () => {
    const tasks = [
      t('a', 'understanding'),
      t('b', 'understanding'),
      t('c', 'understanding'),
      t('d', 'understanding'),
      t('e', 'cloze'),
      t('f', 'understanding'),
    ];
    const ordered = interleaveTasks(tasks);
    expectNoAdjacentSameItem(ordered);
    expect(maxTypeRun(ordered)).toBeLessThanOrEqual(3);
  });

  it('纯单一题型无法打散时保持原序（不抛错）', () => {
    const tasks = [
      t('a', 'understanding'),
      t('b', 'understanding'),
      t('c', 'understanding'),
      t('d', 'understanding'),
      t('e', 'understanding'),
    ];
    const ordered = interleaveTasks(tasks);
    expect(ordered.map((x) => x.itemId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(maxTypeRun(ordered)).toBe(5);
  });

  it('大量混合任务：同 item 不相邻且题型 run ≤ 3', () => {
    const tasks: InterleavableTask[] = [];
    const items = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'];
    // i1..i3 各有 U+P 两维到期；i4..i6 只有 U
    for (const item of items) {
      tasks.push(t(item, 'understanding'));
      if (item <= 'i3') tasks.push(t(item, 'cloze'));
    }
    const ordered = interleaveTasks(tasks);
    expectNoAdjacentSameItem(ordered);
    expect(maxTypeRun(ordered)).toBeLessThanOrEqual(3);
  });

  it('打散交换不制造相邻同 item', () => {
    // 构造需要类型打散的场景：5 个 understanding + 1 个 cloze
    const tasks = [
      t('a', 'understanding'),
      t('b', 'understanding'),
      t('c', 'understanding'),
      t('d', 'understanding'),
      t('e', 'understanding'),
      t('a', 'cloze'),
    ];
    const ordered = interleaveTasks(tasks);
    expectNoAdjacentSameItem(ordered);
    expect(maxTypeRun(ordered)).toBeLessThanOrEqual(3);
  });

  it('空列表与单任务', () => {
    expect(interleaveTasks([])).toEqual([]);
    expect(interleaveTasks([t('a', 'learn')])).toHaveLength(1);
  });
});
