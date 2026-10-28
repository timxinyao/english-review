/** Greedy due-order packing for multi-item scramble Production (spec §5; plan Task 4). */

export function groupProductionItems<T extends { id: string }>(
  dueAsc: T[],
  opts?: { min?: number; max?: number },
): T[][] {
  const max = opts?.max ?? 3;
  const min = opts?.min ?? 1;
  if (max < 1) return [];
  if (min < 1 || min > max) {
    throw new Error(`groupProductionItems: invalid min/max (${min}/${max})`);
  }
  if (dueAsc.length === 0) return [];

  const groups: T[][] = [];
  let i = 0;
  while (i < dueAsc.length) {
    const remaining = dueAsc.length - i;
    const take = Math.min(max, remaining);
    groups.push(dueAsc.slice(i, i + take));
    i += take;
  }
  return groups;
}
