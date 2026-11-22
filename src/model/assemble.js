/**
 * Turn transcribed pages into a book model: paragraph joining across pages,
 * chapter splitting by heading level, and XHTML body markup per chapter.
 */

import { DROP_TYPES, PRESERVE_NEWLINE_TYPES, isHeading } from './blocks.js'

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const LATIN_WORD = /[A-Za-z0-9]/

/** Punctuation that closes a sentence or a quotation, so a following page starts a new block. */
const SENTENCE_END = new Set(Array.from(`。！？；：…“”‘’""''）】》”’!?;:`))

/** A list bullet opens a new item, never a continuation. */
const LIST_OPENER = /^[-*•·]\s*/

/** A capital letter opens a new sentence in a Latin-script book. */
const CAPITAL_OPENER = /^[A-Z]/

/** A numeral label (`2.`, `三、`, `B)`) opens a new enumerated point. */
const ENUM_OPENER = /^[A-Z0-9一二三四五六七八九十]+[、.．)]/

/**
 * Join two fragments with the separator the script requires.
 * @param {string} left - preceding text.
 * @param {string} right - following text.
 * @returns {string} joined text; CJK pairs get no space, latin words get one.
 */
export function smartJoin(left, right) {
  if (left === '') return right
  if (right === '') return left
  const a = left.charAt(left.length - 1)
  const b = right.charAt(0)
  if (CJK.test(a) || CJK.test(b)) return left + right
  if (LATIN_WORD.test(a) && LATIN_WORD.test(b)) return `${left} ${right}`
  return left + right
}

/**
 * Decide whether two paragraph blocks are one paragraph torn by a page break.
 *
 * Models rarely set `continues`, so the fallback has to be inferable from the
 * text alone. A merge requires every one of: both blocks are paragraphs, they
 * come from different pages, the earlier one does not end a sentence, and the
 * later one does not open like a list item, a numeral or a new capitalised
 * sentence.
 *
 * @param {{ type: string, text: string, page: number } | undefined} prevBlock - preceding block.
 * @param {{ type: string, text: string, page: number }} block - block that follows it.
 * @returns {boolean} true when the pair should be merged even without a `continues` flag.
 */
export function looksLikeContinuation(prevBlock, block) {
  if (prevBlock === undefined || prevBlock === null) return false
  if (block.type !== 'p' || prevBlock.type !== 'p') return false
  if (block.page === prevBlock.page) return false
  const left = String(prevBlock.text ?? '').trimEnd()
  if (left === '') return false
  if (SENTENCE_END.has(left.charAt(left.length - 1))) return false
  const right = String(block.text ?? '').trimStart()
  if (right === '') return false
  if (LIST_OPENER.test(right) || CAPITAL_OPENER.test(right) || ENUM_OPENER.test(right)) return false
  return true
}

/**
 * Block kinds that may be joined across a page break.
 *
 * Only a paragraph may continue into another paragraph, and a verse line into
 * another verse line: those two kinds are the ones a PDF page break actually
 * tears in half. Joining into anything else corrupts the structure the renderer
 * depends on - a table row, a figure caption, a list item, a quote or a footnote
 * is a complete unit on its own page.
 */
export const JOINABLE_TYPES = new Set(['p', 'verse'])

/**
 * Flatten pages into one block list, resolving `continues`, joining paragraphs
 * torn by a page break, and dropping furniture.
 *
 * A merged block reports the page its text now ends on, so the next block on
 * that page is not mistaken for yet another page break. A `continues` flag that
 * points at a block kind which cannot be continued is ignored, the block starts
 * on its own, and the refused join is counted in `rejectedJoins` so the report
 * can show it instead of silently corrupting the structure.
 *
 * @param {{ page: number, blocks: {type: string, text: string, continues?: boolean}[] }[]} pages - pages in order.
 * @returns {{ blocks: { type: string, text: string, page: number, continues?: boolean }[], dropped: number, joined: number, rejectedJoins: number }}
 */
export function flattenPages(pages) {
  const blocks = []
  let dropped = 0
  let joined = 0
  let rejectedJoins = 0
  const append = (previous, text, pageNumber) => {
    const piece = text.replace(/^[ \t]+/, '')
    // Verse keeps its line break; a torn paragraph is reflowed by smartJoin.
    previous.text = previous.type === 'verse'
      ? `${previous.text}\n${piece}`
      : smartJoin(previous.text, piece)
    previous.page = pageNumber
    joined += 1
  }
  for (const page of pages) {
    for (const block of page.blocks) {
      if (DROP_TYPES.has(block.type)) { dropped += 1; continue }
      const text = String(block.text ?? '')
      if (text.trim() === '' && block.type !== 'figure') continue
      const previous = blocks[blocks.length - 1]
      if (block.continues === true && previous !== undefined) {
        if (JOINABLE_TYPES.has(previous.type) && previous.type === block.type) {
          append(previous, text, page.page)
          continue
        }
        // Keep the marker on the block that starts here: the page break is still
        // real information for a human reviewing the conversion.
        rejectedJoins += 1
        blocks.push({ type: block.type, text, page: page.page, continues: true })
        continue
      }
      // The explicit flag is authoritative; the heuristic only covers replies
      // that never set it.
      if (looksLikeContinuation(previous, { type: block.type, text, page: page.page })) {
        append(previous, text, page.page)
        continue
      }
      blocks.push({ type: block.type, text, page: page.page })
    }
  }
  return { blocks, dropped, joined, rejectedJoins }
}

/**
 * Split a flat block list into chapters at or above the configured heading level.
 *
 * A heading is consumed as the chapter title and never enters `blocks`, so a
 * chapter can legitimately have no body: part title pages, plate sections and a
 * table-of-contents front matter are all headings with nothing after them.
 * Those titles are book text, so a level-1 part heading is kept even when its
 * chapter has no blocks; only a placeholder chapter with neither a heading nor
 * any block is dropped. An entirely empty document still yields one chapter, so
 * callers never have to handle a zero-chapter book.
 *
 * @param {{ type: string, text: string, page: number }[]} blocks - flattened blocks.
 * @param {{ splitLevel?: number, fallbackTitle?: string }} [options] - `splitLevel` 1 splits only on h1, 2 also on h2.
 * @returns {{ id: string, title: string, level: number, blocks: {type: string, text: string, page: number}[] }[]} chapters.
 */
export function buildChapters(blocks, options = {}) {
  const splitLevel = Number.isInteger(options.splitLevel) ? options.splitLevel : 2
  // Chapter titles reach the navigation document and the OPF without passing a
  // page sentinel, so they are made XML-legal here as well.
  const fallbackTitle = stripIllegalXml(options.fallbackTitle ?? '正文')
  const chapters = []
  const openedByHeading = new Set()
  let current = null
  const open = (title, level, fromHeading) => {
    current = { id: `ch${String(chapters.length + 1).padStart(3, '0')}`, title, level, blocks: [] }
    if (fromHeading === true) openedByHeading.add(current)
    chapters.push(current)
    return current
  }
  for (const block of blocks) {
    if (isHeading(block.type)) {
      const level = Number(block.type.slice(1))
      if (level <= splitLevel) {
        const heading = stripIllegalXml(block.text).trim()
        open(heading === '' ? fallbackTitle : heading, level, true)
        continue
      }
      if (current === null) open(fallbackTitle, 1, false)
      current.blocks.push(block)
      continue
    }
    if (current === null) open(fallbackTitle, 1, false)
    current.blocks.push(block)
  }
  const kept = chapters.filter(chapter => chapter.blocks.length > 0 || (openedByHeading.has(chapter) && chapter.level === 1))
  if (kept.length === 0) {
    kept.push({ id: 'ch001', title: fallbackTitle, level: 1, blocks: [] })
  }
  return kept
}

/**
 * Code points XML 1.0 forbids anywhere in a document: the C0 controls other than
 * tab, line feed and carriage return, plus the two noncharacters. A lone
 * surrogate is not a code point at all and cannot be encoded as UTF-8, so it is
 * removed as well. Everything else stays, including valid surrogate pairs.
 */
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * Delete code points that would make an XHTML or OPF document unparseable.
 *
 * The page sentinels report control characters but do not stop the page from
 * entering the book, so the text still has to be made XML-legal at the edge.
 * Callers apply this before escaping or before writing metadata, never instead
 * of it.
 *
 * @param {unknown} value - raw text from a model reply or PDF metadata.
 * @returns {string} the same text without illegal code points.
 */
export function stripIllegalXml(value) {
  return String(value ?? '').replace(XML_ILLEGAL, '')
}

/**
 * Escape text for XHTML text nodes and attributes.
 *
 * Illegal code points are removed before escaping: a model reply can contain
 * control characters, the sentinel only marks the page degraded, and one of them
 * inside a chapter is enough to make the whole EPUB unreadable.
 *
 * @param {string} value - raw text.
 * @returns {string} escaped text.
 */
export function escapeHtml(value) {
  return stripIllegalXml(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render a Markdown pipe table into XHTML, tolerating a missing separator row.
 * @param {string} text - pipe table source.
 * @returns {string} `<table>` markup, or a paragraph when the source is not a table.
 */
export function renderTable(text) {
  const rows = String(text).split('\n').map(line => line.trim()).filter(line => line !== '')
  const cells = rows.map(row => splitRow(row))
  const body = cells.filter((row, index) => !(index === 1 && row.every(cell => /^:?-{2,}:?$/.test(cell))))
  if (body.length === 0) return `<p>${escapeHtml(text)}</p>`
  const [head, ...rest] = body
  const headHtml = `<thead><tr>${head.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
  const bodyHtml = rest.length === 0
    ? ''
    : `<tbody>${rest.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
  return `<table>${headHtml}${bodyHtml}</table>`
}

/**
 * Split one pipe-table row into trimmed cells, honouring a leading and trailing pipe.
 * @param {string} row - raw row text.
 * @returns {string[]} cell values.
 */
function splitRow(row) {
  let value = row
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|').map(cell => cell.trim())
}

/**
 * Render one block as XHTML.
 * @param {{ type: string, text: string }} block - block to render.
 * @param {{ offset?: number }} [options] - `offset` demotes inline headings below the chapter title.
 * @returns {string} markup for the block.
 */
export function renderBlock(block, options = {}) {
  const text = String(block.text ?? '')
  const offset = options.offset ?? 0
  switch (block.type) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Math.min(6, Math.max(2, Number(block.type.slice(1)) + offset))
      return `<h${level}>${escapeHtml(text)}</h${level}>`
    }
    case 'verse':
    case 'code':
    case 'address':
    case 'toc': {
      const cls = block.type === 'code' ? 'code' : 'verse'
      const lines = escapeHtml(text).split('\n').map(line => line.trimEnd())
      return `<p class="${cls}">${lines.join('<br/>')}</p>`
    }
    case 'quote':
      return `<blockquote><p>${escapeHtml(text)}</p></blockquote>`
    case 'table':
      return renderTable(text)
    case 'figure': {
      const caption = text.trim() === '' ? '' : `<figcaption>${escapeHtml(text)}</figcaption>`
      return `<figure>${caption}</figure>`
    }
    case 'footnote':
      return `<aside class="footnote" epub:type="footnote"><p>${escapeHtml(text)}</p></aside>`
    case 'list': {
      const items = text.split('\n').map(line => line.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, '').trim()).filter(Boolean)
      if (items.length === 0) return `<p>${escapeHtml(text)}</p>`
      return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    }
    case 'p':
    case 'caption':
    case 'unknown':
    default:
      return `<p>${escapeHtml(PRESERVE_NEWLINE_TYPES.has(block.type) ? text : text.replace(/\n/g, ' '))}</p>`
  }
}

/**
 * Render a chapter's body markup, prefixed with its own title heading.
 * @param {{ title: string, blocks: {type: string, text: string}[] }} chapter - chapter model.
 * @param {{ omitTitle?: boolean, offset?: number }} [options] - `omitTitle` for chapters already opened by an h1 block.
 * @returns {string} XHTML body fragment.
 */
export function renderChapterHtml(chapter, options = {}) {
  const parts = []
  if (options.omitTitle !== true) parts.push(`<h1>${escapeHtml(chapter.title)}</h1>`)
  for (const block of chapter.blocks) parts.push(renderBlock(block, { offset: options.offset ?? 0 }))
  return parts.join('\n')
}
