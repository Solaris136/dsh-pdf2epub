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

/** True when a block kind is a heading. */
export function isHeading(type) {
  return HEADING.test(type)
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
 * @returns {{ type: string, text: string, continues: boolean, uncertain?: string[], issues: string[] }}
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
  if (Array.isArray(block.uncertain) && block.uncertain.length > 0) out.uncertain = block.uncertain
  return out
}
