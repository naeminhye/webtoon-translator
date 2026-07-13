/**
 * bench/lib/corpus.js — corpus.json loader/validator.
 *
 * Shared by label.html now, and by the Suite A/B/C runners later (Phases
 * 2-4) so every bench entry point agrees on what a valid manifest looks
 * like instead of re-deriving the rules per-suite.
 */

const VALID_TIERS = new Set(['easy', 'medium', 'hard', 'edge']);

export function validateCorpus(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return ['manifest is not an object'];
  }
  if (!Array.isArray(manifest.pages)) {
    errors.push('manifest.pages must be an array');
    return errors;
  }

  const seenIds = new Set();
  manifest.pages.forEach((page, i) => {
    const where = `pages[${i}]`;
    if (!page.id) {
      errors.push(`${where}.id is missing`);
    } else if (seenIds.has(page.id)) {
      errors.push(`${where}.id "${page.id}" is duplicated`);
    } else {
      seenIds.add(page.id);
    }
    if (!VALID_TIERS.has(page.tier)) {
      errors.push(`${where}.tier "${page.tier}" must be one of ${[...VALID_TIERS].join('/')}`);
    }
    if (!page.file) errors.push(`${where}.file is missing`);
    if (!Number.isFinite(page.width) || page.width <= 0) errors.push(`${where}.width must be a positive number`);
    if (!Number.isFinite(page.height) || page.height <= 0) errors.push(`${where}.height must be a positive number`);
    if (!page.sourceLanguage) errors.push(`${where}.sourceLanguage is missing`);
    if (!Number.isFinite(page.regionCount)) errors.push(`${where}.regionCount must be a number`);
  });

  return errors;
}

export async function loadCorpus(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load corpus manifest at ${url}: HTTP ${res.status}`);
  }
  const manifest = await res.json();
  const errors = validateCorpus(manifest);
  if (errors.length) {
    throw new Error(`Invalid corpus manifest (${url}):\n  ${errors.join('\n  ')}`);
  }
  return manifest;
}

/** Best-effort fetch of a page's existing GT file — null (not thrown) if absent, since most pages start unlabeled. */
export async function tryLoadJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
