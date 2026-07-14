/**
 * bench/lib/cer.js — Character Error Rate, the primary Suite B accuracy
 * metric (benchmark-plan.md: "use CER, not WER; WER is meaningless for
 * CJK"). Levenshtein distance / GT length, both sides NFKC-normalized and
 * whitespace-collapsed first.
 */

function levenshteinDistance(a, b) {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

export function normalizeForCer(text) {
  return (text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Returns null (not 0) when the normalized reference is empty — there is no rate to compute, and 0 would misleadingly read as "perfect". */
export function characterErrorRate(hypothesis, reference) {
  const ref = normalizeForCer(reference);
  const hyp = normalizeForCer(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : null;
  return levenshteinDistance(hyp, ref) / ref.length;
}
