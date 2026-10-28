/** Rule-first scramble grading (spec §6.1; plan Task 3). */

export function normalizeToken(t: string): string {
  return t
    .trim()
    .toLowerCase()
    .replace(/[.?!,"]+$/g, "")
    .replace(/^[("]+/g, "");
}

function morphSet(acceptableMorphology: string[]): Set<string> {
  const set = new Set<string>();
  for (const m of acceptableMorphology) {
    const n = normalizeToken(m);
    if (n) set.add(n);
  }
  return set;
}

/** True if `needle` equals `hay` under exact ignore-case or shared morphology group. */
function tokensMatch(a: string, b: string, morph: Set<string>): boolean {
  const na = normalizeToken(a);
  const nb = normalizeToken(b);
  if (na === nb) return true;
  return morph.has(na) && morph.has(nb);
}

/**
 * Ordered (not necessarily contiguous) subsequence match.
 * Phrasal targets like wear/down must pass inside "wear me down".
 */
export function targetTokensPresent(
  selected: string[],
  targetTokens: string[],
  morph: Set<string>,
): boolean {
  if (targetTokens.length === 0) return false;
  let ti = 0;
  for (const tok of selected) {
    if (tokensMatch(tok, targetTokens[ti]!, morph)) {
      ti += 1;
      if (ti === targetTokens.length) return true;
    }
  }
  return false;
}

export function judgeScramble(input: {
  selectedTokens: string[];
  referenceTokens: string[];
  targets: { learningItemId: string; tokens: string[] }[];
  acceptableMorphology: string[];
}): {
  taskResult: "pass" | "fail";
  itemResults: { learningItemId: string; result: "pass" | "fail" }[];
} {
  const morph = morphSet(input.acceptableMorphology);
  const selected = input.selectedTokens;
  const reference = input.referenceTokens;

  if (selected.length === 0) {
    return {
      taskResult: "fail",
      itemResults: input.targets.map((t) => ({ learningItemId: t.learningItemId, result: "fail" })),
    };
  }

  const itemResults = input.targets.map((t) => ({
    learningItemId: t.learningItemId,
    result: (targetTokensPresent(selected, t.tokens, morph) ? "pass" : "fail") as "pass" | "fail",
  }));

  const allTargetsPass = itemResults.every((r) => r.result === "pass");
  const lengthOk = selected.length === reference.length;
  const sequenceOk =
    lengthOk && selected.every((tok, i) => tokensMatch(tok, reference[i]!, morph));

  const taskResult: "pass" | "fail" = allTargetsPass && sequenceOk ? "pass" : "fail";
  return { taskResult, itemResults };
}
