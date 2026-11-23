/**
 * Block vocabulary, JSON extraction and normalisation for one transcribed page.
 * Pure: no Host services, no I/O.
 */

/** Structural block kinds a page may produce. */
export const BLOCK_TYPES = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'verse', 'quote', 'code', 'toc', 'address', 'list',
  'table', 'figure', 'caption', 'footnote', 'unknown',
  'header', 'footer', 'page-number', 'watermark',
])

/** Kinds removed from the book entirely (page furniture). */
export const DROP_TYPES = new Set(['header', 'footer', 'page-number', 'watermark'])

/**
 * Kinds whose inner newlines are meaningful and must survive reflow: one line
 * per verse line, code line, address line, table row and list item. The
 * renderers split these texts on `\n`, so collapsing them here would silently
 * turn a table into its header row and a list into one item.
 */
export const PRESERVE_NEWLINE_TYPES = new Set(['verse', 'code', 'address', 'toc', 'table', 'list'])

const HEADING = /^h[1-6]$/

/**
 * Smallest share of the page a figure box may cover. A box thinner than this is
 * a stray line or a model rounding artefact, not an illustration: cropping it
 * would embed a sliver of page margin as the picture.
 */
const MIN_BBOX_AREA = 0.02

/**
 * Largest share of the page a figure box may cover. Above it the box is the
 * whole page (or more): the "figure" is the page bitmap itself, so cropping it
 * would duplicate the text instead of showing an illustration.
 */
const MAX_BBOX_AREA = 0.95

/** True when a block kind is a heading. */
export function isHeading(type) {
  return HEADING.test(type)
}

/**
 * Validate and normalise a model-supplied figure box.
 *
 * The contract is `[x0, y0, x1, y1]`, four numbers in 0..1, normalised against
 * the page image with the origin at its top-left corner. The box must have a
 * positive width and height; an area below {@link MIN_BBOX_AREA} or above
 * {@link MAX_BBOX_AREA} is treated as "the model did not really see a figure"
 * and rejected rather than cropped.
 *
 * Invalid input is never repaired into a guess: the box is dropped and one
 * issue is recorded on the block, so the figure falls back to its caption-only
 * shape instead of embedding a random slice of the page.
 *
 * @param {unknown} value - raw `bbox` from the model.
 * @param {string[]} [issues] - issue sink (mutated); the caller owns the page.
 * @returns {[number, number, number, number] | undefined} rounded box, or undefined.
 */
export function normalizeBbox(value, issues = []) {
  if (!Array.isArray(value) || value.length !== 4) {
    issues.push('figure bbox must be an array of four numbers; dropped')
    return undefined
  }
  if (!value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    issues.push('figure bbox has non-finite entries; dropped')
    return undefined
  }
  const [x0, y0, x1, y1] = value
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1) {
    issues.push('figure bbox is outside the page (0..1); dropped')
    return undefined
  }
  if (x1 <= x0 || y1 <= y0) {
    issues.push('figure bbox has no area; dropped')
    return undefined
  }
  const area = (x1 - x0) * (y1 - y0)
  if (area < MIN_BBOX_AREA) {
    issues.push(`figure bbox area ${area.toFixed(4)} is below ${MIN_BBOX_AREA}; dropped`)
    return undefined
  }
  if (area > MAX_BBOX_AREA) {
    issues.push(`figure bbox area ${area.toFixed(4)} is above ${MAX_BBOX_AREA}; dropped`)
    return undefined
  }
  // Four decimals are finer than any renderer can show at the page sizes this
  // pipeline handles (a 3000px page edge gives ~0.3px per step) and keep the
  // report/cache readable.
  const round = number => Math.round(number * 10000) / 10000
  return [round(x0), round(y0), round(x1), round(y1)]
}

/**
 * Remove a Markdown code fence and any prose around the JSON object.
 * @param {string} raw - model output.
 * @returns {string} text that starts with `{` and ends with `}` when one exists.
 */
export function stripToJson(raw) {
  let text = String(raw ?? '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return text
  return text.slice(start, end + 1)
}

/**
 * Normalise one raw block into the canonical shape.
 * @param {unknown} raw - a block object from model output.
 * @param {number} index - position, used for diagnostics only.
 * @returns {{ type: string, text: string, continues: boolean, bbox?: number[], uncertain?: string[], issues: string[] }}
 */
export function normalizeBlock(raw, index) {
  const issues = []
  const object = raw !== null && typeof raw === 'object' ? raw : {}
  let type = String(object.type ?? 'p').trim().toLowerCase()
  if (!BLOCK_TYPES.has(type)) {
    issues.push(`block ${index}: unknown type "${type}" mapped to p`)
    type = 'p'
  }
  let text = object.text
  if (typeof text !== 'string') {
    if (text === undefined || text === null) text = ''
    else text = String(text)
    issues.push(`block ${index}: non-string text coerced`)
  }
  // A heading or paragraph carries no meaningful leading/trailing whitespace;
  // preserved-newline kinds keep their shape except for trailing blanks.
  if (PRESERVE_NEWLINE_TYPES.has(type)) {
    text = text.replace(/[ \t]+$/gm, '').trim()
  } else {
    text = text.replace(/[\t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').trim()
    // Collapse runs of blank lines; a single newline survives only in preserved kinds.
    text = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ')
  }
  const continues = object.continues === true
  const uncertain = Array.isArray(object.uncertain)
    ? object.uncertain.filter(item => typeof item === 'string').slice(0, 12)
    : undefined
  const block = { type, text, continues, issues }
  // A bbox is only meaningful on a figure. Any other kind that carries one is
  // ignored on purpose: cropping a slice of the page next to a paragraph would
  // turn ordinary text into a picture. A figure may omit it - the prompt says so
  // for pages without artwork - and omission is a valid answer, not an issue.
  if (type === 'figure' && object.bbox !== undefined && object.bbox !== null) {
    const prefix = issues.length
    const bbox = normalizeBbox(object.bbox, issues)
    if (bbox !== undefined) block.bbox = bbox
    // `normalizeBbox` messages are fine as they are; only tag them with the
    // block position so a multi-figure page report can locate the bad one.
    for (let i = prefix; i < issues.length; i += 1) issues[i] = `block ${index}: ${issues[i]}`
  }
  if (uncertain !== undefined && uncertain.length > 0) block.uncertain = uncertain
  return block
}

/**
 * Parse one model response into blocks.
 * @param {string} raw - model text.
 * @returns {{ blocks: ReturnType<typeof normalizeBlock>[], notes: string, dropped: number }}
 * @throws {Error} when no JSON object survives extraction.
 */
export function parsePageJson(raw) {
  const json = stripToJson(raw)
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`page JSON is not parseable: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('page JSON is not an object')
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.blocks) ? parsed.blocks : null
  if (list === null) throw new Error('page JSON has no blocks array')
  const blocks = list.map((item, index) => normalizeBlock(item, index))
  const notes = typeof parsed.notes === 'string' ? parsed.notes : ''
  const dropped = blocks.filter(block => DROP_TYPES.has(block.type)).length
  return { blocks, notes, dropped }
}

/**
 * Character count of a block list, ignoring page furniture and whitespace.
 * @param {readonly {type: string, text: string}[]} blocks - blocks in document order.
 * @returns {number} comparable size used by the page sentinels.
 */
export function countableCharacters(blocks) {
  let total = 0
  for (const block of blocks) {
    if (DROP_TYPES.has(block.type)) continue
    total += block.text.replace(/\s+/g, '').length
  }
  return total
}

/** Drop the trailing `issues` field so a block can be stored as plain JSON. */
export function plainBlock(block) {
  const out = { type: block.type, text: block.text, continues: block.continues === true }
  // The box is what lets the pipeline crop the figure after the page has been
  // chosen (and a resume cache re-crop it later), so it has to survive into the
  // page record. It is only ever set on a figure by `normalizeBlock`.
  if (block.type === 'figure' && Array.isArray(block.bbox)) out.bbox = [...block.bbox]
  if (Array.isArray(block.uncertain) && block.uncertain.length > 0) out.uncertain = block.uncertain
  return out
}
