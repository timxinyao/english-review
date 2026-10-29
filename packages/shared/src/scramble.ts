/** Shared token comparison for generated references and deterministic assembly grading. */
export function normalizeScrambleToken(t: string): string {
  return t
    .trim()
    .toLowerCase()
    .replace(/[.?!,"]+$/g, '')
    .replace(/^[("]+/g, '');
}

/** Match the surface actually used in the reference, including separable phrasal verbs. */
export function scrambleTargetPositions(reference: string[], tokens: string[]): number[] | null {
  if (tokens.length === 0) return null;
  const positions: number[] = [];
  for (let i = 0; i < reference.length && positions.length < tokens.length; i += 1) {
    if (
      normalizeScrambleToken(reference[i]!) === normalizeScrambleToken(tokens[positions.length]!)
    ) {
      positions.push(i);
    }
  }
  return positions.length === tokens.length ? positions : null;
}
