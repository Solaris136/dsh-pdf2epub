/**
 * Page sentinels: deterministic checks that decide whether a transcribed page is
 * trustworthy enough to enter the book, or must go to cross-review.
 */

import { countableCharacters, DROP_TYPES } from './blocks.js'

/** Control characters that must never appear in book text. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

/** A page whose baseline is shorter than this cannot be ratio-checked. */
const MIN_BASELINE = 120

/** Allowed relative difference between transcribed and baseline character counts. */
const RATIO_TOLERANCE = 0.15

/** A single block larger than this is almost certainly a runaway generation. */
const MAX_BLOCK_CHARS = 12000

/** Reviewer agreement below this is a weak majority, not a decision. */
const AGREEMENT_FLOOR = 0.9

/**
 * Run every page-level sentinel.
 * @param {{ blocks: {type: string, text: string}[], raw: string }} page - parsed page.
 * @param {{ baselineText?: string }} context - baseline text for the same page, when available.
 * @returns {{ ok: boolean, issues: string[], ratio: number | null }}
 */
export function checkPage(page, context = {}) {
  const issues = []
  // A malformed page must produce an issue rather than a TypeError: this is the
  // guard that decides whether a page may enter the book, so it has to survive
  // the shapes a broken model reply can take (`blocks` missing, a null entry).
  const source = page !== null && typeof page === 'object' ? page : {}
  const blocks = Array.isArray(source.blocks) ? source.blocks : []
  if (blocks.length === 0) issues.push('no blocks produced')
  if (typeof source.raw !== 'string' || source.raw.trim() === '') issues.push('empty model output')

  const content = blocks.filter(block => !DROP_TYPES.has(block?.type))
  if (blocks.length > 0 && content.length === 0) issues.push('only page furniture, no book text')

  for (const [index, block] of blocks.entries()) {
    const text = block?.text
    if (typeof text !== 'string') issues.push(`block ${index} has non-string text`)
    else if (text.length > MAX_BLOCK_CHARS) issues.push(`block ${index} exceeds ${MAX_BLOCK_CHARS} chars`)
    if (CONTROL.test(typeof text === 'string' ? text : '')) issues.push(`block ${index} contains control characters`)
  }

  const countable = blocks
    .filter(block => block !== null && typeof block === 'object')
    .map(block => ({ type: block.type, text: typeof block.text === 'string' ? block.text : '' }))
  const chars = countableCharacters(countable)
  const baseline = typeof context.baselineText === 'string'
    ? context.baselineText.replace(/\s+/g, '').length
    : 0
  let ratio = null
  if (baseline >= MIN_BASELINE && chars > 0) {
    ratio = chars / baseline
    if (Math.abs(ratio - 1) > RATIO_TOLERANCE) {
      issues.push(`character ratio ${ratio.toFixed(3)} outside ±${Math.round(RATIO_TOLERANCE * 100)}% of the text layer`)
    }
  }

  return { ok: issues.length === 0, issues, ratio }
}

/**
 * Decide whether a page needs a second and third opinion.
 * @param {{ ok: boolean, issues: string[] }} verdict - result of {@link checkPage}.
 * @param {boolean} hasTextLayer - whether the PDF page carried a real text layer.
 * @returns {boolean} true when cross-review should run.
 */
export function needsCrossReview(verdict, hasTextLayer) {
  if (!verdict.ok) return true
  // A scanned page has no ratio guard, so a clean parse alone is weak evidence.
  return !hasTextLayer
}

/**
 * Pick the medoid of several candidate page results: the candidate closest to
 * every other candidate, by normalised character similarity of its full text.
 * @param {{ text: string }[]} candidates - one entry per model.
 * @returns {number} index of the winning candidate.
 */
export function pickMedoid(candidates) {
  if (candidates.length <= 1) return 0
  const scores = candidates.map(() => 0)
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const similarity = characterSimilarity(candidates[i].text, candidates[j].text)
      scores[i] += similarity
      scores[j] += similarity
    }
  }
  let best = 0
  for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[best]) best = i
  return best
}

/**
 * Similarity in [0,1] from the length-normalised Levenshtein distance.
 * Runs on the first 6000 characters to stay cheap on runaway pages.
 * @param {string} a - first text.
 * @param {string} b - second text.
 * @returns {number} 1 means identical.
 */
export function characterSimilarity(a, b) {
  const left = String(a ?? '').replace(/\s+/g, '').slice(0, 6000)
  const right = String(b ?? '').replace(/\s+/g, '').slice(0, 6000)
  if (left === right) return 1
  const longest = Math.max(left.length, right.length)
  if (longest === 0) return 1
  return 1 - levenshtein(left, right) / longest
}

/**
 * Resolve the candidate page that actually enters the book.
 *
 * The medoid decision can pick a reviewer's page, so the sentinels are run again
 * on the winning page: `ratio`, `issues` and `ok` must describe the text that is
 * kept, never the primary text that was discarded. Degradation is the union of
 * the two kinds of evidence - a failed sentinel or a weak majority - so neither
 * one can overwrite the other. `agreement` stays null when no reviewer ran, so a
 * single-candidate page is not reported as a unanimous one.
 *
 * @param {{ text: string, page: { blocks: {type: string, text: string}[], raw: string } }[]} candidates - primary page first, then reviewers.
 * @param {{ baselineText?: string }} [context] - baseline text for the same page, when available.
 * @returns {{ index: number, page: object, verdict: { ok: boolean, issues: string[], ratio: number | null }, agreement: number | null, degraded: boolean, ok: boolean }}
 */
export function resolvePageRecord(candidates, context = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('resolvePageRecord needs at least one candidate page')
  }
  const index = pickMedoid(candidates)
  const kept = candidates[index]
  const reference = String(kept.text ?? '')
  const agreement = candidates.length > 1
    ? Math.min(...candidates.map(candidate => characterSimilarity(String(candidate.text ?? ''), reference)))
    : null
  const verdict = checkPage(kept.page, context)
  // `ok` is the sentinel verdict; `degraded` additionally records a weak majority,
  // so a page can be ok-but-degraded but never failed-and-healthy.
  const degraded = !verdict.ok || (agreement !== null && agreement < AGREEMENT_FLOOR)
  return { index, page: kept.page, verdict, agreement, degraded, ok: verdict.ok && !degraded }
}

/**
 * Bounded Levenshtein distance with two rolling rows.
 * @param {string} a - first string.
 * @param {string} b - second string.
 * @returns {number} edit distance.
 */
export function levenshtein(a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = new Array(b.length + 1)
  let current = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length]
}
