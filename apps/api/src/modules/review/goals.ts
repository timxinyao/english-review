import { MASTERED_STABILITY_DAYS } from '@el/shared';
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

/** FSRS 掌握线：stability ≥ 120 天（typeof 防御旧快照缺字段的 undefined） */
function atMasteredStability(s: { stability: number | null }): boolean {
  return typeof s.stability === 'number' && s.stability >= MASTERED_STABILITY_DAYS;
}

/** mastered 只要求当前目标内的维度越过掌握线，不丢弃不要求维度的历史。 */
export function isMastered(
  u: ReviewStateSnapshot,
  p: ReviewStateSnapshot,
  productionEnabled: boolean,
): boolean {
  return atMasteredStability(u) && (!productionEnabled || atMasteredStability(p));
}
