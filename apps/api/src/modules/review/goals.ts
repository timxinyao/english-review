import type { ReviewStateSnapshot } from './service.js';

/** 显式覆盖优先；NULL 沿用类型默认（Word 关、Chunk 开）。 */
export function effectiveProductionEnabled(item: {
  type: string;
  productionEnabledOverride: number | boolean | null;
}): boolean {
  return item.productionEnabledOverride == null
    ? item.type === 'chunk'
    : item.productionEnabledOverride === 1 || item.productionEnabledOverride === true;
}

/** mastered 只要求当前目标内的维度稳定，不丢弃不要求维度的历史。 */
export function isMastered(
  u: ReviewStateSnapshot,
  p: ReviewStateSnapshot,
  productionEnabled: boolean,
): boolean {
  return u.stable && (!productionEnabled || p.stable);
}
