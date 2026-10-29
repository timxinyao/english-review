/** Rule-only evidence for chip assembly; not a general English grammar checker. */
import { normalizeScrambleToken as normalizeToken, scrambleTargetPositions } from '@el/shared';
export { normalizeScrambleToken as normalizeToken } from '@el/shared';

/** Chip identity is the displayed string; repeated words consume distinct available chips. */
export function validChipSelection(selected: string[], available: string[]): boolean {
  const remaining = new Map<string, number>();
  for (const token of available) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  for (const token of selected) {
    const count = remaining.get(token) ?? 0;
    if (count === 0) return false;
    remaining.set(token, count - 1);
  }
  return true;
}

export function judgeScramble(input: {
  selectedTokens: string[];
  referenceTokens: string[];
  targets: { learningItemId: string; tokens: string[] }[];
  /** Legacy generation metadata only: a flat list cannot safely define equivalence classes. */
  acceptableMorphology: string[];
}): {
  taskResult: 'pass' | 'fail';
  itemResults: { learningItemId: string; result: 'pass' | 'basic_pass' | 'fail' }[];
} {
  const selected = input.selectedTokens;
  const reference = input.referenceTokens;
  const complete = selected.length > 0 && selected.length === reference.length;
  const sequenceOk =
    complete &&
    selected.every((token, i) => normalizeToken(token) === normalizeToken(reference[i]!));
  const evidence = input.targets.map((target) => {
    const positions = scrambleTargetPositions(reference, target.tokens);
    return (
      complete &&
      positions !== null &&
      positions.every((i) => normalizeToken(selected[i]!) === normalizeToken(reference[i]!))
    );
  });
  const taskPass = sequenceOk && evidence.length > 0 && evidence.every(Boolean);
  return {
    taskResult: taskPass ? 'pass' : 'fail',
    itemResults: input.targets.map((target, i) => ({
      learningItemId: target.learningItemId,
      result: taskPass ? 'pass' : evidence[i] ? 'basic_pass' : 'fail',
    })),
  };
}
