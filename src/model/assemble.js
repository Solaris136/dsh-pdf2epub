/**
 * Turn transcribed pages into a book model: paragraph joining across pages,
 * chapter splitting by heading level, and XHTML body markup per chapter.
 */

import { DROP_TYPES, PRESERVE_NEWLINE_TYPES, isHeading } from './blocks.js'
import { levenshtein } from './gate.js'

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
 * Shape of a figure href the pipeline writes: `images/fig-<page>-<n>.png`,
 * relative to OEBPS. Anything else (an absolute path, a remote URL, a `..`
 * segment) is not a figure of this book, so the renderer ignores it instead of
 * emitting a link a reader would try to follow.
 */
const FIGURE_IMAGE_RE = /^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/

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
 * True when `next` is the page right after `previous`.
 *
 * A page break can only tear a paragraph between two pages that touch in the
 * document. A page *selection* (`pages: "73,216"`) puts two unrelated pages next
 * to each other in the flattened list, and welding them is the defect this
 * predicate exists to stop: page 73 ends mid-sentence and page 216 opens with a
 * `continues` flag, and without this check the book reads "…都是根速，这似乎表明"
 * across a gap of 143 pages.
 *
 * @param {unknown} previous - page number of the earlier block.
 * @param {unknown} next - page number of the later block.
 * @returns {boolean} true only for consecutive integers.
 */
export function pagesAreAdjacent(previous, next) {
  return Number.isInteger(previous) && Number.isInteger(next) && next === previous + 1
}

/**
 * Decide whether two paragraph blocks are one paragraph torn by a page break.
 *
 * Models rarely set `continues`, so the fallback has to be inferable from the
 * text alone. A merge requires every one of: both blocks are paragraphs, they
 * come from adjacent pages, the earlier one does not end a sentence, and the
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
  if (!pagesAreAdjacent(prevBlock.page, block.page)) return false
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
 * Dropped page furniture a paragraph may be sewn back together across.
 *
 * A leaf mark is printed in the margin beside the running text, and the model
 * sometimes reports it as its own `page-number` block BETWEEN the two halves of
 * one paragraph - page 375 of the pilot book came back as
 * `…胡马雍在喀布尔的要塞里出` | `215b` | `生。诗人大毛拉…`. The furniture carries no
 * text, so once it is dropped the two `p` blocks are the two halves of one
 * sentence and must be re-joined; a running head or a footer split a line the
 * same way. `watermark` is also dropped ({@link DROP_TYPES}) but is deliberately
 * NOT in here: it is not a mark that splits a line, and a page carrying one is
 * not evidence that a paragraph runs through it.
 */
const SPLIT_FURNITURE = new Set(['page-number', 'footer', 'header'])

/**
 * Decide whether a paragraph was cut in two by page furniture.
 *
 * The defect this exists for is not a page break: the model answered ONE page
 * with two `p` blocks and put the margin leaf mark as a `page-number` block in
 * between, so `…要塞里出` and `生。诗人大毛拉…` (page 375 of the pilot book) reached
 * the book as two paragraphs once the mark was dropped, and the sentence read as
 * if it had been cut. A join requires every one of:
 *
 *   1. both blocks are paragraphs - the only kind a split line can be;
 *   2. between them there is nothing but dropped furniture
 *      ({@link SPLIT_FURNITURE}); a heading, a table, a figure, a verse line, a
 *      footnote or any other kept block is a paragraph boundary, not a gap to
 *      close;
 *   3. the two blocks touch - the same page, or consecutive pages (a page
 *      selection can put two unrelated pages side by side, which is why the page
 *      numbers must prove the proximity - {@link pagesAreAdjacent});
 *   4. the earlier half does not end a sentence, so a real paragraph boundary -
 *      this book prints every one of them with `。` - is never welded shut.
 *
 * The right-hand opener tests of {@link looksLikeContinuation} are deliberately
 * NOT repeated here: that heuristic exists because a page break leaves the model
 * free to start a new paragraph on the next page, while a margin mark inside a
 * page cannot invent one - if the earlier half stops mid-word, the next `p` is
 * the rest of that word. The full stop of condition 4 is the boundary that
 * matters, and it is checked.
 *
 * @param {{ type: string, text: string, page: number } | undefined} previous - last kept block.
 * @param {{ type: string }} block - block that follows the furniture.
 * @param {number} pageNumber - page of `block`.
 * @param {string[]} gapTypes - kinds of the blocks dropped between the two.
 * @returns {boolean} true when the two halves are one paragraph.
 */
function joinsAcrossFurniture(previous, block, pageNumber, gapTypes) {
  if (previous === undefined || previous === null) return false
  if (block.type !== 'p' || previous.type !== 'p') return false
  if (gapTypes.length === 0) return false
  if (!gapTypes.every(type => SPLIT_FURNITURE.has(type))) return false
  if (pageNumber !== previous.page && !pagesAreAdjacent(previous.page, pageNumber)) return false
  const left = String(previous.text ?? '').trimEnd()
  if (left === '') return false
  return !SENTENCE_END.has(left.charAt(left.length - 1))
}

/**
 * Carry a figure's image payload across the flatten step.
 *
 * The crop is attached to the block after corruption checks and before the page
 * is folded into chapters, so `flattenPages` must not rebuild a figure from
 * `{type, text}` alone: the `href` is what lets the renderer emit an `<img>`,
 * and `bbox` is what lets a cached run re-crop the same region.
 *
 * @param {object} entry - block object being appended.
 * @param {{ type: string, bbox?: unknown, image?: unknown }} block - source block.
 * @returns {object} `entry`, with the figure fields copied when present.
 */
function carryFigure(entry, block) {
  if (entry.type !== 'figure') return entry
  if (Array.isArray(block.bbox) && block.bbox.length === 4) entry.bbox = [...block.bbox]
  if (typeof block.image === 'string' && block.image !== '') entry.image = block.image
  return entry
}

/**
 * Offset between the full-width ASCII block (U+FF01-U+FF5E) and ASCII.
 * `（` (U+FF08) minus this offset is `(` (U+0028), and so on for the whole block.
 */
const FULLWIDTH_ASCII_OFFSET = 0xfee0

/**
 * CJK punctuation whose half-width counterpart is NOT in the U+FF01-U+FF5E
 * block, so the arithmetic fold below cannot reach it and it is named here.
 *
 * The full-width `（` `）` `：` `，` `；` `！` `？` are all inside U+FF01-U+FF5E and
 * need no entry; the ideographic comma and full stop are the two marks from that
 * family that sit in the CJK Symbols and Punctuation block (U+3001, U+3002) and
 * survive the fold unless they are mapped explicitly. Width is all that is being
 * folded here - `、` and `,` stay distinguishable from a full-width `，` only
 * before the fold, exactly as `（）` and `()` do after it; no mark is reworded.
 */
const CJK_PUNCTUATION_HALFWIDTH = new Map([
  ['\u3001', ','], // 、
  ['\u3002', '.'], // 。
])

/**
 * Characters {@link foldWidth} rewrites: the full-width ASCII block plus the two
 * CJK marks {@link CJK_PUNCTUATION_HALFWIDTH} has to name.
 */
const WIDTH_FOLD = /[\uff01-\uff5e\u3001\u3002]/g

/**
 * The same character class as {@link WIDTH_FOLD}, without the `g` flag.
 *
 * A global regular expression keeps state between calls, so `.test()` on it answers
 * differently on the second call of the same character; the contents correction asks
 * "is this ONE character folded?" per character and needs an answer that does not
 * depend on what was asked before.
 */
const WIDTH_FOLD_ONE = /[\uff01-\uff5e\u3001\u3002]/

/**
 * Fold one character to its half-width form.
 * @param {string} char - a character matched by {@link WIDTH_FOLD}.
 * @returns {string} the half-width character.
 */
function foldWidth(char) {
  const mapped = CJK_PUNCTUATION_HALFWIDTH.get(char)
  if (mapped !== undefined) return mapped
  return String.fromCharCode(char.charCodeAt(0) - FULLWIDTH_ASCII_OFFSET)
}

/**
 * Comparison key of a heading or a running head.
 *
 * A line the model typed once as a `header` and once as an `h1` is the same
 * printed line, but the two answers differ in whatever typography the model
 * happened to copy, so the key is built in three steps and the demotion rule
 * compares keys only:
 *
 *  1. leading and trailing whitespace goes, and every inner run of whitespace -
 *     a full-width space (`\u3000`), a newline, a tab - collapses to one space;
 *  2. width is folded: the full-width ASCII block U+FF01-U+FF5E becomes
 *     U+0021-U+007E, so a full-width `（）` `：` `，` `；` `！` `？` equals its
 *     half-width form, and the two CJK marks outside that block with a half-width
 *     counterpart are mapped by hand (`、` to `,`, `。` to `.`). Only width is
 *     folded - case, digits and wording are untouched, and `，` still differs
 *     from `、` after the fold;
 *  3. every remaining space is removed, because a running head is sometimes set
 *     with letter-spacing the transcription keeps as spaces (`费 尔 干 纳` against
 *     `费尔干纳`), and typographic spacing alone must not stop the match.
 *
 * Step 3 is a deliberate trade-off: `A B` and `AB` produce the same key, so a
 * heading that differs from the `header` beside it only by one space is demoted.
 * The probability is very low, and the failure direction is the acceptable one:
 * the demotion costs one chapter title (its text stays in the book, it just no
 * longer opens a chapter), not a chapter built out of page furniture - a book
 * that is a little coarser is far easier to notice and repair than a navigation
 * document with hundreds of empty duplicate entries.
 *
 * Everything the three steps do not fold still counts, so a heading that merely
 * *resembles* a running head stays book text.
 *
 * @param {unknown} text - raw block text.
 * @returns {string} the comparison key; `''` for empty or whitespace-only text.
 */
function headingKey(text) {
  return String(text ?? '')
    .trim()
    // `\s` already carries the full-width space (U+3000), so this is the one step
    // that removes it; step 3 then has only ordinary spaces left to delete.
    .replace(/\s+/g, ' ')
    .replace(WIDTH_FOLD, foldWidth)
    .replace(/ /g, '')
}

/**
 * Heading levels that open a chapter.
 *
 * The heading demotion pass below is limited to these two on purpose: a running
 * head is a chapter-level line, while `h3` and deeper are section headings inside
 * a chapter, and demoting one of those would delete real book structure (an
 * `h3 小结` printed above a page's `header` is a section title, not furniture).
 */
const CHAPTER_HEADING_LEVELS = new Set(['h1', 'h2'])

/**
 * Flatten pages into one block list, resolving `continues`, joining paragraphs
 * torn by a page break, re-sewing a paragraph split by page furniture, dropping
 * furniture, and deleting a folio the model typed into its own paragraph.
 *
 * A paragraph torn by a page break is joined by the `continues` flag or by
 * {@link looksLikeContinuation}. A paragraph split by page furniture on the SAME
 * page is a different defect and has its own, narrower rule
 * ({@link joinsAcrossFurniture}): the model answered `…要塞里出`, then a
 * `page-number` block holding the leaf mark `215b`, then `生。…`, and after the
 * furniture was dropped the two `p` blocks read as two paragraphs - the sentence
 * was cut in half. Such a pair is re-joined across nothing but dropped
 * `page-number` / `footer` / `header` blocks, and only when the first half did not
 * end a sentence; a heading, a table, a figure, a verse line or any other kept
 * block between them is a paragraph boundary and stops the join. The `continues`
 * flag is neither required nor enough: a same-page split usually arrives WITH the
 * flag (the model reports what it was taught for page breaks) and with the two
 * halves on one page, so the rule answers the flag branch as well - the explicit
 * flag must not cost the join it is describing.
 *
 * A merged block reports the page its text now ends on, so the next block on
 * that page is not mistaken for yet another page break. A `continues` flag that
 * points at a block kind which cannot be continued is ignored, the block starts
 * on its own, and the refused join is counted in `rejectedJoins` so the report
 * can show it instead of silently corrupting the structure.
 *
 * A join also requires the two pages to be adjacent ({@link pagesAreAdjacent}),
 * so a non-contiguous page selection cannot weld the end of one page onto the
 * start of a page a hundred pages later. The refused `continues` flag is kept on
 * the block and counted in `rejectedJoins`.
 *
 * Chapter boundaries stay hard without extra work here: every chapter but the
 * implied first one opens with a heading block, and a heading is not in
 * {@link JOINABLE_TYPES}, so a flagged continuation that follows a chapter title
 * is refused by the same rule that refuses a continuation into a figure.
 *
 * RUNNING HEADS ARE NOT CHAPTER TITLES. A running head is page furniture and the
 * model is asked to type it as `header`, but it sometimes answers `h1` instead:
 * in a real 764-page book page 537 came back with the odd-page running head
 * 「回历九三二年(公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日)的事件」 as a
 * chapter title. That built a chapter out of nothing, added an entry to the
 * navigation document, and broke the page's continuation because its first
 * paragraph now followed a "title" instead of the previous page.
 *
 * A chapter-level (`h1`/`h2`) heading is demoted by TWO criteria, and BOTH have to
 * hold - each one on its own was measured wrong on a real book:
 *
 *  1. SAME PAGE - the heading's {@link headingKey} equals the key of a `header`
 *     block printed on its OWN page. That is the page-537 shape: the model
 *     reported one printed line twice on one page, once as furniture and once as
 *     a title.
 *  2. SAME NAME AS THE OPEN CHAPTER, AND THAT NAME IS A RUNNING HEAD SOMEWHERE -
 *     the heading's key equals the title of the chapter that is currently open AT
 *     ITS OWN LEVEL, AND the same key occurs in the `header` text of SOME page of
 *     the book. That is the page-704 shape: the index section 「索引与译名对照」
 *     opens at page 701 as `h1` (followed on the same page by the `h2` section
 *     「人 名」), and page 704 repeats the very same line as its running head but
 *     answers it as `h1` with no `header` block on that page at all, so criterion
 *     1 cannot see it. The book then carried TWO chapters of that name and the
 *     人名 index was cut in half (ch088 pages 701-703, ch089 pages 704-741).
 *     "At its own level" is what makes this work: the heading on page 704 is a
 *     SIBLING of the `h1` on page 701, so the chapter it repeats is that one, not
 *     the `h2` 「人 名」 chapter that happens to be the most recently opened one.
 *
 * Why criterion 2 needs BOTH halves. The book-wide half alone is the rule that
 * destroyed a real book: in 《巴布尔回忆录》 the running head and the chapter title
 * are THE SAME TEXT (「回历九〇X年(公元 …)的事件」 is printed in the margin of every
 * continuation page and centered as the chapter title on the chapter's first page,
 * which prints no running head), so a book-wide set of header texts matched every
 * one of those titles: of the 9 year-heading `h1`s in the first 190 cached pages
 * only 1 survived and the book came out with 2 chapters where it should have had a
 * dozen. The name half alone is no better - two consecutive chapters may carry the
 * same title by design (the 人名 index of every chapter is titled 「人 名」, scenario
 * (ai)), and only a running head of that same text says the second one is page
 * furniture rather than a chapter. ANDed the two halves are exact: a year-chapter
 * title IS a running head but is NOT the name of the chapter before it (every year
 * has its own title), while a running head mistyped as a title on a page with no
 * `header` is necessarily the name of the chapter it interrupts.
 *
 * So the book is scanned twice: once up front to collect the `header` keys of the
 * WHOLE book (one cheap O(pages) pass, criterion 2's second half), and then page
 * by page, each page collecting its own `header` keys before its blocks are walked
 * (criterion 1, and criterion 2's first half comes from the heading kept last).
 *
 * "The chapter that is currently open at its own level" is read here as the most
 * recent KEPT chapter-level heading of the same level (`h1` against `h1`, `h2`
 * against `h2`), with the deeper levels forgotten as soon as a shallower chapter
 * opens. `flattenPages` does not know the caller's `splitLevel`, and at the default
 * (`splitLevel: 2`) every `h1` and `h2` opens a chapter, which makes this reading
 * identical to the outline's "previous sibling or ancestor" position. With
 * `splitLevel: 1` an `h2` stays inside its chapter, so this reading is one heading
 * coarse - the cost is at most one demoted section heading that would also have
 * had to be the previous heading's exact name AND printed as a running head
 * somewhere, and it is stated here rather than threading the option through a
 * function whose job is the block list.
 *
 * THE TRADE-OFF, stated where the rule is: what the two criteria still miss is a
 * heading whose page prints no `header` AND whose text differs from the open
 * chapter's title - e.g. a running head of the PREVIOUS chapter left at the top of
 * a page that starts the next one. The failure direction is the acceptable one: a
 * missed demotion leaves one extra short chapter, while a wrong demotion deletes a
 * real chapter title and folds its text into the chapter before it. One short
 * chapter is far easier to notice and repair than a book that lost its table of
 * contents.
 *
 * A repeated chapter-level title is NOT demoted on repetition alone. "Keep only the
 * first occurrence of an identical title" was the old fallback for a book whose
 * model never typed `header` at all, and it destroyed real structure: an index
 * section is titled 「人 名」 in every chapter's index, and the second one lost its
 * heading. Being printed more than once is not evidence of page furniture; being
 * printed on a page that also carries a `header` of the same text is, and so is
 * repeating the open chapter's name when that name is printed as a running head
 * somewhere in the book.
 *
 * The comparison uses {@link headingKey} keys rather than raw strings, so the same
 * printed line matches across the model's re-typesetting: whitespace (including
 * 排字空距 and full-width spaces) is folded away, and the width of ASCII and CJK
 * punctuation is folded to half-width, so a full-width `（）` in the `header` block
 * matches a half-width `()` in the heading beside it - the exact pair a real book
 * produced. Case, wording and digits still count, so a heading that merely
 * *resembles* a running head is not demoted; the one deliberate cost of the key is
 * documented on {@link headingKey}.
 *
 * @param {{ page: number, blocks: {type: string, text: string, continues?: boolean, bbox?: number[], image?: string}[] }[]} pages - pages in order.
 * @returns {{ blocks: { type: string, text: string, page: number, continues?: boolean, bbox?: number[], image?: string }[], dropped: number, joined: number, rejectedJoins: number, demotedHeadings: number }} `demotedHeadings` counts chapter-level headings dropped by the two running-head criteria (same page as a same-text `header`, or the open chapter's name while that name is printed as a `header` somewhere in the book).
 */
export function flattenPages(pages) {
  const blocks = []
  let dropped = 0
  let joined = 0
  let rejectedJoins = 0
  let demotedHeadings = 0
  // Kinds of the blocks dropped between the last kept block and the one being
  // visited. It is what lets a paragraph split by a leaf mark be recognised:
  // page 375 of the pilot book answered one page as `…要塞里出` / `215b` / `生。…`,
  // and after the `page-number` block was dropped the two `p` blocks were the two
  // halves of one sentence. {@link joinsAcrossFurniture} reads this list, so it
  // must hold the kinds of NON-kept blocks only, and be emptied whenever a block
  // is kept (pushed or appended to).
  const gapTypes = []

  /* ------------ the running heads of the book, and the chapter open at each level ------------ */
  // DELIBERATE: the keys are built from each block's own `text`, i.e. the full
  // transcription of the printed line (49 characters for the pilot book's running
  // head). This must never reuse the pipeline's `furnitureHint`, which is
  // `block.text.slice(0, 40)` before it is shown to the model. A truncated hint is
  // a 40-character prefix no heading can ever equal, so the demotion would silently
  // stop matching exactly the long running heads it exists for - test/e2e.mjs
  // scenario (am) is the page that is 60+ characters long.
  //
  // The book-wide set below is criterion 2's second half and is built ONCE, before
  // any page is walked: it only ever answers "is this text printed as a running head
  // anywhere in this book", which is a property of the whole document. It is never
  // used on its own - the same page's set is criterion 1, and criterion 2 also
  // demands that the heading repeat the open chapter's title. See the two criteria
  // on `flattenPages`.
  const bookHeaderKeys = new Set()
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.type !== 'header') continue
      const key = headingKey(block.text)
      if (key !== '') bookHeaderKeys.add(key)
    }
  }
  // The title key of the chapter that is open at each chapter level: `1` for the
  // h1 chapter, `2` for the h2 chapter inside it. `''` means "no chapter of that
  // level has opened yet". A heading is compared against the entry of ITS OWN
  // level, because that is the chapter a running head repeats: page 701 of
  // 《巴布尔回忆录》 opens 「索引与译名对照」 as `h1` and then 「人 名」 as `h2`, so
  // the `h1` on page 704 is a SIBLING of the first `h1` - comparing it against the
  // immediately preceding chapter (`人 名`) could never match, and the duplicate
  // chapter survived. A kept chapter also CLOSES the levels below it, so the next
  // `h2` starts its own chapter instead of "repeating" a section title of the
  // chapter before.
  const openChapterKeys = new Map()
  const append = (previous, text, pageNumber) => {
    const piece = text.replace(/^[ \t]+/, '')
    // Verse keeps its line break; a torn paragraph is reflowed by smartJoin.
    previous.text = previous.type === 'verse'
      ? `${previous.text}\n${piece}`
      : smartJoin(previous.text, piece)
    previous.page = pageNumber
    joined += 1
  }
  /**
   * Put two halves separated by page furniture back together.
   *
   * {@link append} alone is not enough here: the space before the furniture - and
   * after it - existed only to keep the margin mark apart, exactly the spacing
   * {@link stripFoliage} eats with the token, so it must not survive as a gap
   * inside a word (`要塞里出` + `生` must read 出生, not `出 生`). A CJK pair needs
   * no separator at all and `smartJoin` provides one only for Latin words.
   */
  const sew = (previous, text, pageNumber) => {
    previous.text = String(previous.text ?? '').trimEnd()
    append(previous, text, pageNumber)
  }
  for (const page of pages) {
    // The folios of *this* page, collected once before the blocks are visited,
    // so the order the model put the page number in cannot matter.
    const folioTokens = collectFolioTokens(page.blocks)
    // The running heads of *this* page, for the same reason: the first criterion
    // judges a heading against its own page only, so this set is built before the
    // blocks are walked and never survives the page. It is the book-wide set above
    // that a heading has to match as well before a same-name heading is demoted.
    const pageHeaderKeys = new Set()
    for (const block of page.blocks) {
      if (block.type !== 'header') continue
      const key = headingKey(block.text)
      if (key !== '') pageHeaderKeys.add(key)
    }
    for (const block of page.blocks) {
      if (DROP_TYPES.has(block.type)) { dropped += 1; gapTypes.push(block.type); continue }
      // A chapter-level heading that repeats this page's `header` - or that repeats
      // the open chapter's name while that name is a running head somewhere in the
      // book - is furniture the model mistyped. It leaves the book exactly like the
      // `header` block it should have been: counted in `dropped` (it is furniture)
      // and again in `demotedHeadings`, which is the number the report shows so the
      // defect is visible rather than silent. A heading that satisfies neither
      // criterion is a real chapter title and is kept, whatever else the book
      // printed.
      if (CHAPTER_HEADING_LEVELS.has(block.type)) {
        const key = headingKey(block.text)
        const level = Number(block.type.slice(1))
        const samePageHead = key !== '' && pageHeaderKeys.has(key)
        // Both halves of criterion 2, spelled out: the name of the chapter that is
        // open AT THIS LEVEL, AND evidence that this name is printed as a running
        // head somewhere. Either half alone is wrong on real data - see
        // `flattenPages`.
        const repeatsOpenChapter = key !== '' && key === (openChapterKeys.get(level) ?? '')
          && bookHeaderKeys.has(key)
        if (samePageHead || repeatsOpenChapter) {
          dropped += 1
          demotedHeadings += 1
          // It is a heading that USED to stand between the paragraphs: even
          // though it leaves the book, it must not let the two sides join as if
          // the gap were furniture (its own kind is not in {@link SPLIT_FURNITURE}).
          gapTypes.push(block.type)
          continue
        }
        // A kept chapter-level heading opens a chapter: it becomes what the next
        // heading of its own level is compared against, and it closes the deeper
        // levels the chapter before it had opened.
        for (const deeper of [...openChapterKeys.keys()]) {
          if (deeper > level) openChapterKeys.delete(deeper)
        }
        openChapterKeys.set(level, key)
      }
      const raw = String(block.text ?? '')
      const text = FOLIAGE_TYPES.has(block.type) ? stripFoliage(raw, folioTokens) : raw
      if (text.trim() === '' && block.type !== 'figure') {
        // Nothing to emit, but the block did stand between the paragraphs: an
        // empty `p` / `table` / heading is not furniture, so it keeps the two
        // sides apart instead of letting them join through it.
        gapTypes.push(block.type)
        continue
      }
      const previous = blocks[blocks.length - 1]
      // A paragraph split by a leaf mark is usually flagged `continues: true` by
      // the model: the flag says "this block continues the paragraph before it",
      // and the model applies it to a same-page split too - which the flag branch
      // below cannot accept, because that branch exists for PAGE breaks. The
      // furniture rule answers both branches, so it is evaluated once and used
      // twice.
      const rejoin = joinsAcrossFurniture(previous, block, page.page, gapTypes)
      if (block.continues === true && previous !== undefined) {
        if (pagesAreAdjacent(previous.page, page.page)
          && JOINABLE_TYPES.has(previous.type) && previous.type === block.type) {
          append(previous, text, page.page)
          gapTypes.length = 0
          continue
        }
        if (rejoin) {
          sew(previous, text, page.page)
          gapTypes.length = 0
          continue
        }
        // Keep the marker on the block that starts here: the page break is still
        // real information for a human reviewing the conversion.
        rejectedJoins += 1
        blocks.push(carryFigure({ type: block.type, text, page: page.page, continues: true }, block))
        gapTypes.length = 0
        continue
      }
      // The explicit flag is authoritative; the heuristic only covers replies
      // that never set it.
      if (looksLikeContinuation(previous, { type: block.type, text, page: page.page })) {
        append(previous, text, page.page)
        gapTypes.length = 0
        continue
      }
      // A leaf mark the model typed as its own `page-number` block splits one
      // paragraph into two `p` blocks; with the furniture dropped the halves are
      // one sentence again. {@link joinsAcrossFurniture} lists the four
      // conditions - the second half is NOT judged for opening a new sentence,
      // because the first half stopping mid-word is the proof that it is the rest
      // of it.
      if (rejoin) {
        sew(previous, text, page.page)
        gapTypes.length = 0
        continue
      }
      blocks.push(carryFigure({ type: block.type, text, page: page.page }, block))
      gapTypes.length = 0
    }
  }
  return { blocks, dropped, joined, rejectedJoins, demotedHeadings }
}

/* ------------------------------------------------------------------ *
 * folio removal
 *
 * The book prints its page number in the middle of the outer margin, and the
 * model sometimes reports that same number twice on one page: as a `page-number`
 * block (dropped as furniture) and inline in the paragraph that runs past it. The
 * dropped copy is the right one, so the inline copy has to go too - but only when
 * it is provably the same token, and only when it stands alone, never as part of
 * a word (`24b` inside `124b` or inside a catalogue number is text).
 *
 * The same margin carries a SECOND mark, which the equality rule above can never
 * see: a leaf mark - one to four digits with a single letter, `a` for the recto
 * half of the leaf and `b` for the verso half (`3a`, `9b`, `35a`, `124b`). It is
 * printed beside the page number, not instead of it, so on the pilot book's page
 * 90 the `page-number` block holds `58` while the sentences carry `35a` and
 * `35b`: `即准备战斗,35a 开向米儿咱的部队` (the page cache keeps that comma
 * half-width; the rendered book shows `，`). A second rule therefore exists, and
 * it judges a token by its SHAPE and its CONTEXT rather than by equality - see
 * {@link stripFoliage} for the guards a token has to pass.
 *
 * That rule was first shipped without a citation guard, and on the first 95 pages
 * of the pilot book it deleted four tokens, three of which were real text: `（见
 * f. 376b）`, `（f. 49a）` and `见本书编叶 179b。` are cross-page references, and
 * deleting them corrupts the book far worse than the ugly margin marks the rule
 * exists for. The citation guard (`f.` / `叶` / `页` / `前` / `后` / `见` /
 * `参看` / `本书`) is what keeps them, and it is not optional.
 * ------------------------------------------------------------------ */

/** Block kinds whose text is running prose and may carry a stray folio. */
const FOLIAGE_TYPES = new Set(['p', 'quote', 'caption', 'footnote', 'list'])

/**
 * Longest token still treated as a folio, in characters.
 *
 * A real folio is short (`41`, `24b`, `xii`). A longer `page-number` block is a
 * model misclassification of running text, and deleting that string from a
 * paragraph would remove book content, so it is ignored.
 */
const MAX_FOLIO_TOKEN = 12

/**
 * Characters a standalone folio may sit next to: whitespace and punctuation.
 *
 * This is the STRICT boundary, used by the equality rule. The leaf rule is
 * deliberately looser - only a Latin letter or digit refuses an occurrence - so a
 * margin mark typed straight against Chinese text is still judged; its guards
 * live in {@link isLeafMark}.
 */
const FOLIO_BOUNDARY = new Set(Array.from(
  ` \t\n\r\u3000，。、；：！？…—·"“”‘’'()（）[]［］{}【】《》〈〉「」『』〔〕,.;:!?<>/\\|-`,
))

/**
 * Shape of a leaf mark: one to four digits and a single `a` or `b`.
 *
 * This is a candidate FINDER, not the rule. It matches unanchored so that the
 * scan can find a token inside a longer text, and every occurrence is then judged
 * by the guards of {@link isLeafMark} - a bare number is never a candidate, so
 * `1494`, `1525` and `公元 1525 年` cannot be touched by this rule.
 */
const LEAF_MARK_SHAPE = /\d{1,4}[ab]/g

/** The same shape, anchored: guard 1 of {@link isLeafMark}. */
const LEAF_MARK_EXACT = /^\d{1,4}[ab]$/

/**
 * A character that glues a leaf mark into a longer number or word: a Latin letter
 * or a digit of EITHER width.
 *
 * The full-width digits matter: `normalizePunctuation` turns `２` into `2` when the
 * page is rendered, so `２35a` is the number `235a` in the finished book, and
 * deleting the `35a` half of it would corrupt a quantity.
 */
const GLUING_CHAR = /[A-Za-z0-9\uff10-\uff19]/

/**
 * A character that makes a neighbouring leaf mark part of CJK running text.
 *
 * This is the guard that keeps the rule out of print in other scripts, where
 * `in 1994a study` is a sentence and not a folio.
 *
 * Ideographs and kana are the obvious half; CJK punctuation counts too, because
 * the margin mark of this book was frequently transcribed right behind a
 * full-width `，` or `。` (`即准备战斗，35a 开向`), and that shape - a standalone
 * mark wedged behind a Chinese sentence mark - is the most reliable one there is.
 * The CJK Symbols and Punctuation block is named explicitly (from `\u3001`, so the
 * ideographic space stays a space and cannot satisfy the guard): `。` `、` `《`
 * live there and would otherwise fall outside every other range below.
 *
 * A HALF-WIDTH sentence mark is not in here, and that is not an oversight: the
 * pass reads the transcription, where that comma is still `,` (U+002C), so
 * {@link isCjkContext} resolves it to its Chinese context (`，`) rather than
 * widening this character class and making every `,` look Chinese.
 *
 * Two marks from outside the CJK blocks are named at the end, because this book
 * prints them exactly where a leaf mark's Chinese neighbour sits: the middle dot
 * `·` (U+00B7) of a name (`赛伊德· 184b`, page 325) and the curly quotation marks
 * `‘’“”` (U+2018-U+201D) that close a sentence right before a line-end mark
 * (`什么也不要放过。” 197b`, page 345). They are typography, not letters, and
 * adding them does not weaken the citation guard - that guard still runs behind
 * any neighbour, so `（见 f. 200b）”` stays a reference and not a margin mark.
 */
const CJK_NEIGHBOUR = /[\u3001-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u00b7\u2018\u2019\u201c\u201d]/

/**
 * Half-width sentence marks {@link normalizePunctuation} re-typesets to full
 * width once the page is rendered as a book.
 */
const HALFWIDTH_SENTENCE_MARK = new Set([',', ';', ':', '?', '!'])

/**
 * How many characters, on the same line, count as "nearby" when a half-width
 * mark is resolved to its Chinese context (guard 3 of {@link isLeafMark}).
 *
 * Three is the same span {@link normalizePunctuation} uses for its own context
 * test, so the leaf rule and the renderer agree about which commas are Chinese
 * rather than each having its own idea of it.
 */
const MARK_CONTEXT_WINDOW = 3

/* ------------------------------------------------------------------ *
 * position guards
 *
 * Both folio rules read a token as a margin mark on the strength of its SHAPE and
 * its EQUALITY with the page's `page-number` block. Neither of those properties
 * says anything about WHERE the token stands, and two real defects of
 * 《巴布尔回忆录》 came from exactly that omission:
 *
 *   1. `公元 1529 年 9 月 7 日` (page 15) lost its month. The page's `page-number`
 *      block reads `9`, the month is `9`, and the equality rule deleted it. The
 *      finished book read `公元 1529 年月 7 日`.
 *   2. The 64-page index (pages 701-764) lost its locators. Every entry ends in one
 *      (`马利克·阿力·库特比,217b`, `阿布都勒·库杜斯,23a,38b`), which is exactly
 *      the leaf-mark shape, so the shape rule deleted them - 1650 of them in the
 *      live cache. An index without its page references is not an index.
 *
 * A folio is printed in the MARGIN: it stands alone, at the edge of the block or
 * between two spaces, and it is never a member of a comma-separated list. The
 * guards below encode that positional fact, and every one of them is one-sided on
 * purpose - it can only REFUSE a deletion. Missing a margin mark leaves an ugly
 * number in the text; deleting a month or an index locator corrupts the book.
 * ------------------------------------------------------------------ */

/** Any whitespace, including the ideographic space this book indents with. */
const WHITESPACE_CHAR = /[\s\u3000]/

/**
 * Punctuation a folio never follows: a token behind one of these is a list member
 * (`217b, 23a, 38b`) or an index locator (`库特比,217b`), not a margin mark.
 */
const LIST_MARK = new Set([',', '，', '、', ';', '；'])

/**
 * Words that turn a neighbouring NUMBER into a date, a directed reference or a
 * volume: `年` `月` `日` `时` `分` `秒` make `9` the ninth month or day, `页` `卷`
 * `章` `节` make `135` a cross-reference (`第 135 页`). A NUMBER beside one of
 * them is never a margin mark.
 *
 * "Number" is literal, and {@link PURE_DIGITS} is what enforces it: this set only
 * protects a token made of digits. A leaf mark - one to four digits and a letter,
 * `175b` - is not a year, a month, a day or a volume number, so the unit beside it
 * is ordinary prose and the mark still has to go. Page 309 of 《巴布尔回忆录》
 * prints `当我在回历九一七年 175b (公元 1511 年)夺取撒马尔罕时`, and reading the
 * `年` before the mark as a date context kept it in the finished book.
 */
const DATE_UNIT = new Set(['年', '月', '日', '时', '分', '秒', '页', '卷', '章', '节'])

/**
 * A token that is nothing but digits - the only shape {@link DATE_UNIT} speaks
 * about, and the only shape a date, a month, a day or a page reference is printed
 * in.
 *
 * Full-width digits count: {@link normalizePunctuation} re-typesets `１５２９` to
 * `1529` before the book is rendered, so the two widths are the same number, and
 * this guard is one-sided on purpose - it can only refuse a deletion. A leaf mark
 * (`175b`) never matches, which is exactly the point: a letter suffix cannot be a
 * year or a month, so the date guard must not hide it.
 */
const PURE_DIGITS = /^[0-9\uff10-\uff19]+$/

/**
 * The three entry shapes the index of this book prints, used by the index guard.
 *
 * The guard refuses to read a token as a folio when the LINE it sits on is an
 * index entry, because in an index a `\d{1,4}[ab]` token IS the point of the line:
 *
 *   - a bilingual headword opens it (`Malik 'Ali qutbi 马利克·阿力·库特比,217b`,
 *     `Baba'Ali 巴巴·阿力,174b`) - 874 of the 878 affected blocks of the real
 *     cache start with the Latin transcription;
 *   - a locator list runs through it (`…,13b,14b,55a`, `…，125a—131b，132b`): two
 *     or more locators followed by a list mark are a list, never prose;
 *   - a bare entry closes with a comma-separated locator and carries no sentence
 *     mark at all (`丁 · 巴耳班,267b`, `赫杜米之子,154b`) - the two real entries
 *     whose headword is Chinese only.
 *
 * Prose escapes all three: a margin mark inside a sentence stands in a line that
 * has sentence punctuation and no comma-separated locator list. The guards are
 * therefore a REFUSAL, not a licence: the leaf rule still needs its shape, CJK and
 * citation guards before it deletes anything.
 */
const INDEX_HEADWORD = /^\s*['‘’]?[A-Za-z]/
const INDEX_LOCATOR_IN_LIST = /\d{1,4}[ab](?=[ \t]*[,，、;；—–])/g
const INDEX_LOCATOR_AT_TAIL = /[,，、][ \t]*\d{1,4}[ab][ \t]*$/
const INDEX_SENTENCE_MARK = /[。！？，]/

/**
 * Every leaf-mark-shaped token of one block, in order of first appearance.
 *
 * Only the token strings are returned: whether a given occurrence is a margin
 * leaf mark or a number that belongs to the sentence is decided occurrence by
 * occurrence, by {@link isLeafMark}.
 *
 * @param {string} text - block text.
 * @returns {string[]} the distinct candidate tokens.
 */
function leafMarksIn(text) {
  const tokens = new Set()
  for (const match of text.matchAll(LEAF_MARK_SHAPE)) tokens.add(match[0])
  return [...tokens]
}

/**
 * The folio tokens printed on one page, taken from its `page-number` blocks.
 * @param {{ type: string, text: string }[]} blocks - blocks of one page.
 * @returns {string[]} trimmed, de-duplicated, longest first.
 */
function collectFolioTokens(blocks) {
  if (!Array.isArray(blocks)) return []
  const tokens = new Set()
  for (const block of blocks) {
    if (block?.type !== 'page-number') continue
    const token = String(block.text ?? '').trim()
    if (token === '' || token.length > MAX_FOLIO_TOKEN) continue
    tokens.add(token)
  }
  return [...tokens].sort((left, right) => right.length - left.length)
}

/**
 * Index of the nearest character on one side of a token that is neither a space
 * nor a tab, or `-1` when that side of the line ends first.
 *
 * Guard 3 measures the distance to a neighbour in CHARACTERS, so a section sign
 * or a CJK mark counts as one, and a line break is a hard edge: a token that
 * opens a line must be judged by the other side, never by the last character of
 * the previous line.
 *
 * @param {string} text - block text.
 * @param {number} from - first index to inspect (the step points away from the token).
 * @param {number} step - `-1` to scan backwards, `1` to scan forwards.
 * @returns {number} the index found, or `-1`.
 */
function neighbourIndex(text, from, step) {
  for (let index = from; index >= 0 && index < text.length; index += step) {
    const char = text[index]
    if (char === '\n' || char === '\r') return -1
    if (char !== ' ' && char !== '\t') return index
  }
  return -1
}

/**
 * True when a CJK character sits within {@link MARK_CONTEXT_WINDOW} positions of
 * `index` on one side, without crossing a line break.
 * @param {string} text - block text.
 * @param {number} index - position to look from (not inspected itself).
 * @param {number} step - `-1` to scan backwards, `1` to scan forwards.
 * @returns {boolean} true when CJK text is nearby.
 */
function cjkNearby(text, index, step) {
  for (let cursor = index + step, seen = 0;
    cursor >= 0 && cursor < text.length && seen < MARK_CONTEXT_WINDOW;
    cursor += step, seen += 1) {
    const char = text[cursor]
    if (char === '\n' || char === '\r') return false
    if (CJK_NEIGHBOUR.test(char)) return true
  }
  return false
}

/**
 * True when the character at `index` is enough Chinese context for a leaf mark.
 *
 * A CJK character is. A HALF-WIDTH sentence mark is too, when Chinese text sits
 * within {@link MARK_CONTEXT_WINDOW} of it: {@link stripFoliage} runs on the
 * transcription, before {@link normalizePunctuation} re-typesets the comma, so on
 * page 90 of the pilot book the leaf mark stands behind `,` (U+002C) in the page
 * cache while the rendered book shows `，` - the same page, two widths. Judging
 * only the character as typed would refuse the commonest shape the rule exists
 * for, so the mark is resolved the way the renderer will resolve it: a `,` in a
 * Chinese line counts as Chinese punctuation.
 *
 * Width is the ONLY thing widened here. No character is rewritten, and
 * {@link normalizePunctuation}'s own behaviour is untouched.
 *
 * @param {string} text - block text.
 * @param {number} index - index of the neighbouring character.
 * @returns {boolean} true when that neighbour proves Chinese context.
 */
function isCjkContext(text, index) {
  const char = text[index]
  if (CJK_NEIGHBOUR.test(char)) return true
  if (!HALFWIDTH_SENTENCE_MARK.has(char)) return false
  return cjkNearby(text, index, -1) || cjkNearby(text, index, 1)
}

/**
 * True when the token at `[at, end)` has Chinese text on at least one side,
 * skipping the spaces that only keep the margin mark apart (guard 3).
 *
 * Skipping is what lets a mark the model spaced out - `河 3a 流`, `即 9a 公元` -
 * be recognised as the margin mark it is, while `in 1994a study` still has a
 * Latin neighbour on both sides and stays a sentence.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when one side is CJK context.
 */
function leafCjkContext(text, at, end) {
  const left = neighbourIndex(text, at - 1, -1)
  if (left !== -1 && isCjkContext(text, left)) return true
  const right = neighbourIndex(text, end, 1)
  if (right !== -1 && isCjkContext(text, right)) return true
  return false
}

/**
 * Reference markers a leaf mark may follow, split by strength: a token behind one
 * of these is a cross-page reference, not a margin mark.
 *
 * {@link CITATION_STRONG} markers are words that only ever introduce a reference,
 * so this rule trusts them even across a comma or a colon - the book sets
 * `编叶，179b`, `见 f.: 376b` and `参看本书 171a 注。`, and the punctuation there is
 * typography of the reference itself.
 *
 * `f\.` already covers `ff.` (the `f.` suffix is the same), but the longer form
 * is named because it is the abbreviation the book actually prints, and a future
 * edit must not "simplify" it away. A bare `f` is guarded against a Latin word
 * before it, so `of` and `half` do not become references. `见` also covers
 * `参见`; `参看` and `本书` are named because this book writes references that
 * end on them (`① 参看本书 171a 注。` - page 318 of the real cache, the one
 * deletion the first version of this guard got wrong).
 *
 * {@link CITATION_WEAK} markers are positional Chinese words (`前` / `后`) that
 * are ordinary prose as often as they are references, so they count only when
 * they stand IMMEDIATELY before the token. `…到达那里后，101a 在图拉克花园扎营`
 * (page 185) is a leaf mark behind a sentence comma, not a reference to leaf
 * 101a: stripping the comma before looking for a weak marker turned every
 * `…后，NNNb` in the book into a citation. The comma is therefore only skipped
 * for the strong markers - see {@link citedBefore}.
 */
const CITATION_STRONG = /(?:ff\.|f\.|(?:^|[^A-Za-z])f|叶|页|见|参看|本书)$/

/** The positional markers, matched only when they are the last thing before the token. */
const CITATION_WEAK = /(?:前|后)$/

/**
 * True when the text before `at` ends with a citation marker (guard 4).
 *
 * The marker is separated from the number by a space - and sometimes by a colon
 * or a comma as well (`见 f.: 376b`, `编叶，179b`) - so both are skipped before
 * the STRONG marker itself is looked for. This is the guard the pilot's real data
 * asked for: `（见 f. 376b）`, `（f. 49a）` and `见本书编叶 179b。` are
 * cross-references, and the first version of this rule deleted them.
 *
 * A comma or a colon is NOT skipped for {@link CITATION_WEAK}: `后，101a` is a
 * Chinese sentence comma, and only a `前` / `后` printed straight against the
 * number is positional.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @returns {boolean} true when a reference marker precedes the token.
 */
function citedBefore(text, at) {
  const head = text.slice(0, at).replace(/[ \t\u3000]+$/, '')
  if (CITATION_STRONG.test(head)) return true
  const afterColon = head.replace(/[:：]$/, '').replace(/[ \t\u3000]+$/, '')
  if (CITATION_STRONG.test(afterColon)) return true
  const afterComma = head.replace(/[,，]$/, '').replace(/[ \t\u3000]+$/, '')
  if (CITATION_STRONG.test(afterComma)) return true
  return CITATION_WEAK.test(head)
}

/**
 * The four guards of the leaf-mark rule, in one place: true only when the token
 * at `[at, end)` is a margin leaf mark and not book text.
 *
 *  1. SHAPE - {@link LEAF_MARK_EXACT}, one to four digits and one `a`/`b`;
 *  2. STANDALONE, relaxed - only a Latin letter or a digit ({@link GLUING_CHAR})
 *     glues it to a longer word. `x124b` and `35ab` stay; a mark typed straight
 *     against Chinese text (`山区，4a在`, `曾23a有`, `领精35b锐`) is still the
 *     margin mark and is judged by the remaining guards, because that is exactly
 *     how this book prints it;
 *  3. CJK CONTEXT - {@link leafCjkContext}: the nearest non-space neighbour on
 *     either side is Chinese (a half-width `,` in a Chinese line counts, see
 *     {@link isCjkContext}), which keeps `in 1994a study` out;
 *  4. CITATION - {@link citedBefore}: a token behind a strong marker (`f.` /
 *     `f` / `ff.` / `叶` / `页` / `见` / `参看` / `本书`) is a cross-reference and
 *     is never deleted; a weak marker (`前` / `后`) also protects it, but only
 *     when it stands immediately before the token.
 *
 * There is no page gate on top of these four: a page whose model never emitted a
 * `page-number` block still prints the mark (page 221 of the pilot book), and
 * refusing to look there was the one shape the fifth guard cost - it hid two real
 * leaf marks and bought nothing, because the other guards already keep a page of
 * plain prose untouched.
 *
 * DELIBERATE TRADE-OFF, stated where the rule is: when a catalogue number is
 * structurally indistinguishable from a leaf mark - `这批编号是 124b 的产品`, the
 * shape of scenario (y) - the guards above cannot tell them apart, and the rule
 * chooses cleaning over keeping. Guard 4 covers the reference shapes that carry
 * their own evidence; a bare number in Chinese prose carries none.
 *
 * KNOWN TRADE-OFF, accepted and NOT to be "fixed" by loosening guard 3: a leaf
 * mark wedged INSIDE a broken Latin word keeps its token - page 419 of
 * 《巴布尔回忆录》 prints `静修之所(hu- 233a jra)`, where the mark is spliced into
 * the middle of `hu-…-jra`, so both neighbours are Latin and there is no CJK
 * context to prove anything. Guard 3 is the main defence against deleting real
 * citations (a previous version of this rule deleted 1650 index locators), so one
 * surviving mark in 764 pages is the price of keeping the guard. The form
 * `(hu- NNNx jra)` is therefore expected to stay in the book.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when the occurrence may be deleted.
 */
function isLeafMark(text, at, end) {
  if (!LEAF_MARK_EXACT.test(text.slice(at, end))) return false
  const before = at === 0 ? '' : text[at - 1]
  const after = end >= text.length ? '' : text[end]
  // Guard 2, relaxed: only a Latin letter or a digit makes the token part of a
  // longer word; a Chinese neighbour is allowed.
  if (GLUING_CHAR.test(before) || GLUING_CHAR.test(after)) return false
  return leafCjkContext(text, at, end) && !citedBefore(text, at)
}

/**
 * The nearest non-whitespace character on each side of `[at, end)`, skipping the
 * spaces a folio is set apart with.
 *
 * An empty string means that side of the block ends first. This is the reader the
 * position guards share: they all ask "what does the folio stand next to", and the
 * answer must not be the space that only exists to keep it apart.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {{ left: string, right: string }} the two neighbouring characters, `''` at an edge.
 */
function edgeCharacters(text, at, end) {
  let left = at - 1
  while (left >= 0 && WHITESPACE_CHAR.test(text[left])) left -= 1
  let right = end
  while (right < text.length && WHITESPACE_CHAR.test(text[right])) right += 1
  return {
    left: left >= 0 ? text[left] : '',
    right: right < text.length ? text[right] : '',
  }
}

/**
 * True when the token stands where a margin mark stands: at an edge of the block,
 * or between two spaces (position guard 1).
 *
 * `… 9 月 …` fails it - the month is glued to `月` - and so does `库特比,217b`,
 * whose left neighbour is the index comma. `58 这是一段正文` and `…致敬。215b` pass
 * it at the block edges, and `…停下来 58 又继续…` passes it between the two spaces
 * that only exist to keep the folio apart.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when the token is isolated.
 */
function isMarginPosition(text, at, end) {
  if (at === 0 || end >= text.length) return true
  return WHITESPACE_CHAR.test(text[at - 1]) && WHITESPACE_CHAR.test(text[end])
}

/**
 * True when the nearest non-blank neighbour is list punctuation (position guard
 * 2): `库特比, 217b` is a locator list even when the comma is followed by a
 * space, so the space is skipped before the punctuation is looked for.
 *
 * The set is the comma, the ideographic comma and the semicolon, in both widths.
 * A sentence-full-stop `。` is deliberately NOT in it: `…到了那里。58` is a folio at
 * the end of a sentence, the commonest shape the equality rule exists for.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when the token follows or precedes a list mark.
 */
function followsListMark(text, at, end) {
  const { left, right } = edgeCharacters(text, at, end)
  return LIST_MARK.has(left) || LIST_MARK.has(right)
}

/**
 * True when the token is a date, a directed page reference or a volume number
 * (position guard 3): the token is a pure number ({@link PURE_DIGITS}) and its
 * nearest non-blank neighbour is one of {@link DATE_UNIT}.
 *
 * `公元 1529 年 9 月 7 日` reads as `9` next to `年` and `月`; `第 135 页` reads
 * as `135` next to `页`. None of those numbers may be deleted, and the guard is
 * asked by BOTH rules, because a leaf-shaped token can sit in a date too.
 *
 * BUT ONLY A PURE NUMBER IS PROTECTED. `回历九一七年 175b` puts a leaf mark next
 * to `年`, and `175b` is not a year: a token with a letter suffix cannot be a
 * year, a month, a day, a volume or a page reference, so the unit beside it says
 * nothing about it. The guard therefore returns false for anything that is not
 * {@link PURE_DIGITS}, and the leaf rule's other guards (shape, CJK context,
 * citation) decide. This is the `175b` on page 309 of 《巴布尔回忆录》.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when a date/reference unit is adjacent to a pure number.
 */
function inDateContext(text, at, end) {
  if (!PURE_DIGITS.test(text.slice(at, end))) return false
  const { left, right } = edgeCharacters(text, at, end)
  return DATE_UNIT.has(left) || DATE_UNIT.has(right)
}

/**
 * True when the token stands in an index entry (position guard 4) - the block's
 * line is one of the three entry shapes described on {@link INDEX_HEADWORD}.
 *
 * The check is per LINE, not per block: the model typed the index as short `p`
 * blocks and the body as paragraphs, but the index also arrives as long lists of
 * one-line entries, and a headword on another line says nothing about this one.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when the token belongs to an index or locator list.
 */
function isIndexContext(text, at, end) {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const breakAt = text.indexOf('\n', end)
  const line = text.slice(lineStart, breakAt === -1 ? text.length : breakAt)
  if (INDEX_HEADWORD.test(line)) return true
  if ((line.match(INDEX_LOCATOR_IN_LIST) ?? []).length >= 2) return true
  return !INDEX_SENTENCE_MARK.test(line) && INDEX_LOCATOR_AT_TAIL.test(line)
}

/**
 * The position guards of the EQUALITY rule: true when a token that is equal to the
 * page's `page-number` block is nevertheless not that page number.
 *
 * Every guard can only refuse a deletion - see the block comment above
 * {@link WHITESPACE_CHAR} for the two real defects they exist for.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when the occurrence must be kept.
 */
function keepsFolio(text, at, end) {
  return inDateContext(text, at, end)
    || !isMarginPosition(text, at, end)
    || followsListMark(text, at, end)
    || isIndexContext(text, at, end)
}

/**
 * The position guards of the LEAF rule: a leaf-shaped token inside an index entry
 * is book text, not a margin mark.
 *
 * The date guard ({@link inDateContext}) is still asked, but it can no longer
 * refuse a leaf mark: it only speaks about pure numbers ({@link PURE_DIGITS}), and
 * a leaf mark carries a letter suffix, so `回历九一七年 175b` loses its token
 * (page 309 of 《巴布尔回忆录》). The guard stays in the chain because the shape
 * this function is handed is the shape it was written for; a pure number never
 * reaches the leaf rule, so the date branch here is dead for it and documented
 * rather than removed.
 *
 * The list/position guards of {@link keepsFolio} are NOT repeated here and must
 * not be: a margin mark of this book is overwhelmingly printed right behind a
 * Chinese sentence comma (`即准备战斗，35a 开向`, scenarios (an) and (aq)), so a
 * `,` on its own proves nothing on this side of the rule. A bare comma only
 * becomes evidence when the line is an index entry, which is what
 * {@link isIndexContext} tests.
 *
 * @param {string} text - block text.
 * @param {number} at - index of the token's first character.
 * @param {number} end - index just past the token.
 * @returns {boolean} true when the occurrence must be kept.
 */
function keepsLeafMark(text, at, end) {
  return inDateContext(text, at, end) || isIndexContext(text, at, end)
}

/**
 * Delete every standalone occurrence of `token`, together with the spaces that
 * separated it from the surrounding text.
 *
 * The two rules differ only in guard 2, so it is a flag rather than a second
 * deletion loop: the equality rule takes a strictly bounded token, the leaf rule
 * accepts a token typed against Chinese text and refuses only a Latin neighbour.
 *
 * @param {string} text - block text.
 * @param {string} token - folio to remove.
 * @param {{ relaxed?: boolean, accept?: (text: string, at: number, end: number) => boolean, keeps?: (text: string, at: number, end: number) => boolean }} [options] -
 *   `relaxed` widens guard 2 to "not glued to a Latin letter or a digit"; `accept`
 *   is an extra condition the occurrence must satisfy, called with the whole text
 *   and the occurrence's span so it can look past the immediate neighbours. The
 *   leaf rule passes {@link isLeafMark} here, so the deletion mechanics - and the
 *   spacing they eat - stay in one place instead of being written a second time.
 *   `keeps` is the POSITION guard: when it is true the occurrence is book text
 *   whatever its shape or its equality, and is left alone ({@link keepsFolio} /
 *   {@link keepsLeafMark}).
 * @returns {{ text: string, removed: boolean }} the text, and whether anything was deleted.
 */
function removeFolioToken(text, token, options = {}) {
  const relaxed = options.relaxed === true
  const accept = options.accept
  const keeps = options.keeps
  let out = ''
  let index = 0
  let removed = false
  for (;;) {
    const at = text.indexOf(token, index)
    if (at === -1) {
      out += text.slice(index)
      break
    }
    const before = at === 0 ? '' : text[at - 1]
    const afterAt = at + token.length
    const after = afterAt >= text.length ? '' : text[afterAt]
    const bounded = relaxed
      ? !GLUING_CHAR.test(before) && !GLUING_CHAR.test(after)
      : (before === '' || FOLIO_BOUNDARY.has(before))
        && (after === '' || FOLIO_BOUNDARY.has(after))
    const deletable = bounded
      && (accept === undefined || accept(text, at, afterAt) === true)
      && (keeps === undefined || keeps(text, at, afterAt) !== true)
    if (!deletable) {
      out += text.slice(index, afterAt)
      index = afterAt
      continue
    }
    // Absorb the whitespace on both sides: `倾向 24b 于` has to become `倾向于`,
    // not `倾向 于` - the spaces only existed to keep the folio apart. Two latin
    // words would be glued together by the same rule, so there one space stays.
    let start = at
    while (start > index && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1
    let end = afterAt
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1
    const left = start > 0 ? text[start - 1] : ''
    const right = end < text.length ? text[end] : ''
    out += text.slice(index, start)
    if (LATIN_WORD.test(left) && LATIN_WORD.test(right)) out += ' '
    index = end
    removed = true
  }
  return { text: out, removed }
}

/**
 * Remove page numbers the model typed into a paragraph as well as into its own
 * `page-number` block, and remove the leaf marks printed in the same margin.
 *
 * Two rules run, in this order, and only the FIRST is gated on the page carrying
 * a usable `page-number` block:
 *
 *  1. the inline copy of the page number itself: an occurrence whose text equals
 *     the block's, deleted wherever it stands alone. Without a `page-number`
 *     block there is no token to look for, so this rule needs the block;
 *  2. a leaf mark the model typed into the sentence instead of into the block.
 *     Such a token can never equal the page number (page 90 of the pilot book
 *     prints `58` in the margin and carries `35a` in the running text), so it is
 *     judged by shape and context, and it does NOT need the page to report a page
 *     number: the page prints the mark beside the page number, and a page whose
 *     model never emitted the `page-number` block still carries it (page 221 of
 *     the pilot book - the fifth guard used to hide those marks). An occurrence
 *     is deleted only when ALL FOUR guards hold ({@link isLeafMark} has them;
 *     this is the list a reviewer reads):
 *
 *       - SHAPE - {@link LEAF_MARK_EXACT}, one to four digits and one `a`/`b`;
 *       - STANDALONE, relaxed - only a Latin letter or a digit glues it to a
 *         longer word, so `x124b` and `35ab` stay while a mark typed straight
 *         against Chinese text (`山区，4a在`, `曾23a有`, `领精35b锐`) is still
 *         judged;
 *       - CJK CONTEXT - {@link leafCjkContext}: after skipping spaces, the nearest
 *         character on at least one side is Chinese, so `河 3a 流` and `即 9a 公元`
 *         are deleted while `in 1994a study` stays. A half-width `,` inside a
 *         Chinese line counts as Chinese punctuation ({@link isCjkContext}):
 *         this pass runs before {@link normalizePunctuation}, so the comma is
 *         still U+002C here (`即准备战斗,35a 开向`);
 *       - CITATION - {@link citedBefore}: a token behind a strong marker (`f.` /
 *         `f` / `ff.` / `叶` / `页` / `见` / `参看` / `本书`) is a cross-page
 *         reference and is never deleted (`（见 f. 376b）`, `（f. 49a）`,
 *         `见本书编叶 179b。` are all real book text); the weak markers `前` /
 *         `后` protect it too, but only printed straight against the number -
 *         `…到达那里后，101a` is a margin mark behind a comma, not a reference.
 *
 * Both rules also ask the POSITION guards ({@link keepsFolio} / {@link keepsLeafMark}),
 * and those are the newest addition: a token is a margin mark only where the margin
 * prints it. The equality rule refuses a PURE NUMBER beside `年` `月` `日` `时` `分`
 * `秒` `页` `卷` `章` `节` (position guard 3), a token that is not alone at an edge or
 * between two spaces (position guard 1), a token whose nearest non-blank neighbour
 * is list punctuation `,` `，` `、` `;` `；` (position guard 2), and a token inside
 * an index entry (position guard 4). The shape rule refuses the date and index ones
 * too. Without them two real defects of the pilot book survived into the finished
 * EPUB: page 15 lost the month of `公元 1529 年 9 月 7 日` because the page's
 * `page-number` block was `9`, and the 64-page index lost 1650 locators
 * (`马利克·阿力·库特比,217b`) because a locator has exactly the leaf-mark shape.
 *
 * Neither rule ever deletes a token made only of digits: `1494` and `公元 1525 年`
 * are a year and a quantity, not folios. And nothing here rewrites wording - a
 * deleted mark takes only the spacing that existed to keep it apart, through
 * {@link removeFolioToken}.
 *
 * @param {string} text - block text.
 * @param {string[]} folioTokens - `page-number` texts of the page the block is on.
 * @returns {string} the text without stray folios.
 */
export function stripFoliage(text, folioTokens) {
  const value = String(text ?? '')
  if (value === '') return value
  const tokens = Array.isArray(folioTokens) ? folioTokens : []
  let out = value
  let removed = false
  for (const raw of tokens) {
    const token = String(raw ?? '').trim()
    if (token === '' || token.length > MAX_FOLIO_TOKEN) continue
    const result = removeFolioToken(out, token, { keeps: keepsFolio })
    out = result.text
    removed = removed || result.removed
  }
  // Rule 2, the leaf mark. Every guard is handed to the shared deletion helper
  // through `accept`, so the space-eating rule stays identical for both rules:
  // `即准备战斗,35a 开向` becomes `即准备战斗,开向`, while a mark between two latin
  // words would leave the one space that separates them. Guard 2 is the relaxed
  // one, which is why this call is not symmetric with the loop above. `keeps` is
  // the position guard of this side of the rule: a date unit or an index entry.
  for (const token of leafMarksIn(out)) {
    const result = removeFolioToken(out, token, {
      relaxed: true,
      accept: isLeafMark,
      keeps: keepsLeafMark,
    })
    out = result.text
    removed = removed || result.removed
  }
  if (!removed) return value
  // Whatever spacing the deletion left behind collapses: two spaces from a folio
  // that sat between two spaces, and the gap after a full-width mark, which
  // carries its own side bearing.
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([，。、；：！？）】》”’])[ \t]+/g, '$1')
}

/**
 * Largest heading level XHTML has (and `renderBlock` clamps to).
 */
const MAX_HEADING_LEVEL = 6

/**
 * Repair a heading level that skips one.
 *
 * A model reads size and weight off the page, so a section that is visibly two
 * steps below the chapter title is reported as `h3` even when no `h2` was ever
 * seen (`h1` then `h3`, the shape that makes screen readers and the navigation
 * document complain). Three rules, all about the outline rather than the page:
 *
 *   1. no jump: a heading may go at most one level deeper than the heading
 *      before it, so a `h1` followed by an `h3` becomes `h1`, `h2`;
 *   2. never above its chapter, and never the chapter title's own level: a
 *      heading inside a chapter is at least `chapter level + 1`;
 *   3. at least `h2`, so a heading is never rendered as the top of a document
 *      that starts with its chapter title.
 *
 * The previous heading is the *emitted* one. A chapter title passed through here
 * (`chapterLevel === 0`) sets the baseline for the headings under it; the implied
 * first chapter has no heading of its own, so its caller passes `previous = 0`
 * and its first heading is taken at face value - there is nothing above it to
 * skip from.
 *
 * A level that already satisfies the rules is returned unchanged, which keeps a
 * well-formed document byte-identical.
 *
 * @param {number} requested - level the model asked for (1..6).
 * @param {number} previous - level of the heading before it, or 0 when there is none.
 * @param {number} chapterLevel - level of the chapter title the heading sits under, or 0 outside a chapter.
 * @returns {number} the level to emit.
 */
export function clampHeadingLevel(requested, previous, chapterLevel) {
  const wanted = Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.trunc(requested)))
  // The first heading of the book defines the baseline: there is nothing above
  // it to skip from, so it is taken at face value.
  let level = previous > 0 ? Math.min(wanted, previous + 1) : wanted
  if (chapterLevel > 0) level = Math.max(level, chapterLevel + 1, 2)
  return Math.min(MAX_HEADING_LEVEL, level)
}

/**
 * Split a flat block list into chapters at or above the configured heading level.
 *
 * A heading is consumed as the chapter title and never enters `blocks`, so a
 * chapter can legitimately have no body: part title pages, plate sections and a
 * table-of-contents front matter are all headings with nothing after them.
 * A chapter that carries no body block at all - only headings, or nothing - is
 * usually an artefact of a page whose text ran out, and it is dropped: a document
 * holding nothing but its own title tells a reader nothing and a table of contents
 * an entry that leads nowhere. What decides between an artefact and real structure
 * is the level of the heading that opened the chapter, not the chapter's emitted
 * level: two shapes stay, because dropping them would delete book text rather
 * than an empty page:
 *
 *   - the implied first chapter, which has no heading of its own and may hold the
 *     front matter's stray headings (`h3 珍藏本` before the first real h1);
 *   - a chapter opened by an `h1` heading, which is a part title page (部扉页)
 *     even when the chapter after it is a sibling `h1` rather than a deeper one -
 *     a translation that repeats the part title as the first chapter of each part
 *     reads exactly like that, and it is also why a document whose blocks are
 *     *all* headings survives: its chapters are `h1`s, and dropping them would
 *     empty the book.
 *
 * Everything else - an empty `h2`, `h3`, ... chapter - is dropped. "There is
 * another chapter after it" is deliberately not a reason to keep one: a heading
 * the model hallucinated on a blank page is followed by a chapter too.
 *
 * An entirely empty document still yields one chapter, so callers never have to
 * handle a zero-chapter book.
 *
 * `id`s are assigned after that filter, so `ch001`, `ch002`, ... stay continuous
 * and a dropped chapter never leaves a gap in the file names.
 *
 * Heading levels are clamped as the outline is built ({@link clampHeadingLevel}):
 * the chapter title keeps a level that starts a chapter, while a heading that
 * stays inside a chapter is rewritten to the one level the outline allows, so a
 * jump such as `h1` then `h3` is repaired into `h1` then `h2` before the renderer
 * or the navigation document ever sees it. The input blocks are not mutated: a
 * corrected heading is a new block, so a caller holding the flattened list still
 * sees the model's original answer.
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
  // Chapters opened by a heading, mapped to the requested level of that heading
  // (`1` for `h1`, `2` for `h2`, ...) - the level the block itself carried, taken
  // before `clampHeadingLevel` repaired the outline. `chapter.level` cannot stand
  // in for it: the outline is clamped, so a heading that was `h3` in the model's
  // answer may be emitted at a level that starts a chapter. The other chapters are
  // the implied first one, whose synthetic title is not book content.
  const openedByHeading = new Map()
  // Level of the most recently emitted heading (chapter titles included), or 0
  // before the first one. Opening a chapter resets it to that chapter's level,
  // so a heading inside a chapter is measured from its own chapter title; the
  // implied first chapter has no heading, so it resets the baseline to 0 and its
  // first heading keeps the level the model gave it.
  let previousLevel = 0
  let current = null
  const open = (title, level, fromHeading, sourceLevel = 0) => {
    current = { id: '', title, level, blocks: [] }
    if (fromHeading === true) openedByHeading.set(current, sourceLevel)
    previousLevel = fromHeading === true ? level : 0
    chapters.push(current)
    return current
  }
  for (const block of blocks) {
    if (isHeading(block.type)) {
      const requested = Number(block.type.slice(1))
      if (requested <= splitLevel) {
        const heading = stripIllegalXml(block.text).trim()
        open(heading === '' ? fallbackTitle : heading, clampHeadingLevel(requested, previousLevel, 0), true, requested)
        continue
      }
      if (current === null) open(fallbackTitle, 1, false)
      const level = clampHeadingLevel(requested, previousLevel, current.level)
      previousLevel = level
      current.blocks.push(level === requested ? block : { ...block, type: `h${level}` })
      continue
    }
    if (current === null) open(fallbackTitle, 1, false)
    current.blocks.push(block)
  }
  // Keep a chapter that carries body content, the implied first chapter, and a
  // heading-only chapter opened by an `h1` (a part title page - see the rule
  // above); drop the rest. Whether the rest of the document has body text is not
  // consulted: an `h1` part title page is book structure either way, and the
  // all-headings document keeps its chapters through the same test.
  const hasBody = chapter => chapter.blocks.some(block => !isHeading(block.type))
  const kept = chapters.filter(chapter => {
    if (hasBody(chapter)) return true
    const sourceLevel = openedByHeading.get(chapter)
    if (sourceLevel === undefined) return true
    return sourceLevel === 1
  })
  if (kept.length === 0) {
    kept.push({ id: '', title: fallbackTitle, level: 1, blocks: [] })
  }
  return kept.map((chapter, index) => ({
    ...chapter,
    id: `ch${String(index + 1).padStart(3, '0')}`,
  }))
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

/* ------------------------------------------------------------------ *
 * deterministic text repair
 *
 * Two repairs run on rendered prose, after the model has spoken and before any
 * markup exists. Both are pure and idempotent: they only ever add the closing
 * bracket a sentence is missing, or re-typeset a punctuation mark whose width is
 * the wrong one for the surrounding script - they never rewrite wording, so a
 * second pass over their own output changes nothing.
 * ------------------------------------------------------------------ */

/**
 * Half-width punctuation a Chinese sentence writes full-width, keyed by the
 * character the transcription produced.
 */
const FULL_WIDTH_PUNCTUATION = new Map([
  [',', '，'],
  [';', '；'],
  [':', '：'],
  ['?', '？'],
  ['!', '！'],
])

/**
 * A URL inside running text. Its punctuation is part of the address, so
 * re-typesetting a `?` or a `,` inside it would corrupt the link; the spans this
 * matches are copied through untouched.
 */
const URL_IN_TEXT = /\b(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>"'）】，。；：？！、]+/g

/** How many characters on each side of a mark count as "its context". */
const PUNCTUATION_CONTEXT = 3

/** Block kinds whose text is set as running Chinese prose. */
const PUNCTUATION_TYPES = new Set(['p', 'quote', 'caption', 'list', 'footnote'])

/**
 * Block kinds that get the half-open bracket repaired.
 *
 * A `list` is left out on purpose: a bracket opened inside one item and closed in
 * the next is real content, and the per-item text the renderer sees is not the
 * whole sentence. `code` and `verse` keep their exact characters.
 */
const BRACKET_TYPES = new Set(['p', 'quote', 'caption', 'footnote'])

/** True when a CJK character sits within {@link PUNCTUATION_CONTEXT} of `index`. */
function hasCjkContext(text, index) {
  const before = text.slice(Math.max(0, index - PUNCTUATION_CONTEXT), index)
  const after = text.slice(index + 1, index + 1 + PUNCTUATION_CONTEXT)
  return CJK.test(before) || CJK.test(after)
}

/**
 * True when the mark at `index` sits between two digits.
 *
 * That is the shapes the caller must not touch: `12:30` is a clock time and `1:3`
 * a ratio, but the same guard also keeps a thousands separator (`1,000`) and a
 * numeric range in a table cell from turning into sentence punctuation.
 */
function isNumericSeparator(text, index) {
  const before = text[index - 1] ?? ''
  const after = text[index + 1] ?? ''
  return /[0-9]/.test(before) && /[0-9]/.test(after)
}

/** True when `index` falls inside one of the `[start, end)` spans. */
function insideSpan(spans, index) {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return true
  }
  return false
}

/**
 * Normalise the punctuation of one line of running text.
 *
 * Full-width digits become ASCII, runs of whitespace collapse to one space, and a
 * half-width `,` `;` `:` `?` `!` becomes its full-width form when the sentence
 * around it is Chinese. The mark also absorbs the space that followed it: `，`
 * carries its own side bearing, so the model's `, ` would otherwise open a gap
 * mid-sentence.
 *
 * @param {string} line - one line, no newline.
 * @returns {string} the normalised line.
 */
function normalizePunctuationLine(line) {
  // Full-width digits first, so the numeric-separator guard below compares
  // ASCII digits no matter which width the model used.
  const text = line
    .replace(/[\uff10-\uff19]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[ \t\u00a0\u3000]{2,}/g, ' ')
    .trim()
  if (text === '') return ''
  const urls = []
  for (const match of text.matchAll(URL_IN_TEXT)) urls.push([match.index, match.index + match[0].length])
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const full = FULL_WIDTH_PUNCTUATION.get(char)
    if (full === undefined || insideSpan(urls, index) || isNumericSeparator(text, index) || !hasCjkContext(text, index)) {
      out += char
      continue
    }
    // The converted mark stands in for the model's space as well, so the text
    // does not end up with a gap after every comma.
    out = out.replace(/ +$/, '') + full
    while (text[index + 1] === ' ') index += 1
  }
  return out
}

/**
 * Normalise half-width punctuation and full-width digits in running Chinese text.
 *
 * The fix the research asked for: a model converts half-width punctuation to
 * full-width on some pages and leaves it alone on others, and the same paragraph
 * can carry a full-width `；` next to a half-width `,`. The decision here is
 * local and repeatable: a mark becomes full-width exactly when a CJK character is
 * within {@link PUNCTUATION_CONTEXT} characters of it, and a `,` `;` `:` between
 * two digits (a clock time, a ratio, a thousands separator) is never touched.
 * URLs are copied through verbatim, quotes keep whichever shape the model chose,
 * and newlines survive - a list needs one item per line.
 *
 * @param {string} text - block text.
 * @returns {string} the same text with its punctuation normalised.
 */
export function normalizePunctuation(text) {
  const value = String(text ?? '')
  if (value === '') return value
  return value.split('\n').map(normalizePunctuationLine).join('\n')
}

/**
 * Close a sentence whose parenthesis was left half open.
 *
 * The shape is a real defect of page-by-page transcription: `（f.131b)` splits
 * across a page break, the model writes the opener on one page and never returns
 * to it. Widths are pooled (`（` and `(` are both openers) because the model mixes
 * them freely, and exactly one missing closer is repaired; two or more is treated
 * as genuine content - a nested remark, or a pair that really does continue on
 * the next page - and left alone. A closer is only ever appended, never inserted
 * or re-width-ised, and the appended one is full-width because that is what a
 * Chinese sentence uses.
 *
 * @param {string} text - block text.
 * @returns {string} the text, plus a closing `）` when exactly one is missing.
 */
export function balanceBrackets(text) {
  const value = String(text ?? '')
  let depth = 0
  for (const char of value) {
    if (char === '（' || char === '(') depth += 1
    else if (char === '）' || char === ')') depth -= 1
  }
  // `depth === 1` is exactly "one opener is still open", which also covers the
  // case where the text happens to end on a nested pair: the outer one is what
  // is missing.
  return depth === 1 ? `${value}）` : value
}

/**
 * The text of one prose block after the deterministic repairs.
 *
 * @param {string} type - block type.
 * @param {string} text - block text.
 * @returns {string} text ready to be escaped.
 */
function proseText(type, text) {
  let value = PUNCTUATION_TYPES.has(type) ? normalizePunctuation(text) : text
  if (BRACKET_TYPES.has(type)) value = balanceBrackets(value)
  return value
}

/* ------------------------------------------------------------------ *
 * table of contents
 *
 * A `toc` block is a page of a printed contents list, not prose: one entry per
 * line, indentation for the level, a dotted leader, and the printed page number
 * at the end. Rendering it as verse loses all four, so the block is parsed into
 * entries and emitted as a real `<nav epub:type="toc">` list - the shape a reader
 * and an assistive technology can both navigate.
 * ------------------------------------------------------------------ */

/** A dotted leader: the run of dots (or middle dots) between title and page. */
const TOC_LEADER_RUN = /[ \t\u3000]*[.…∙⋯·]{2,}[ \t\u3000]*/g

/** A single leader mark padded by spaces, which the same pass would miss. */
const TOC_LEADER_PADDED = /[ \t\u3000]+[.…∙⋯·][ \t\u3000]+/g

/** A leader run still attached to the end of the title. */
const TOC_LEADER_TAIL = /[ \t\u3000.…∙⋯·]+$/

/** Leading indentation of one contents line. */
const TOC_INDENT = /^[ \t\u3000]*/

/**
 * A contents entry with its printed page number behind a leader, e.g.
 * `费尔干纳 …… 1`; `\d` is the page, everything before the leader is the title.
 */
const TOC_LINE_WITH_LEADER = /[ \t\u3000]*[.…∙⋯·]+[ \t\u3000.…∙⋯·]*(\d{1,5})[ \t\u3000]*$/

/** The same without a leader: at least one space before the page number. */
const TOC_LINE_WITH_SPACE = /[ \t\u3000]+(\d{1,5})[ \t\u3000]*$/

/**
 * Indentation of a contents line, as a heading depth.
 *
 * The book indents each level with a full-width space (`\u3000`) on top of the
 * previous one, and a half-width space is half of that column, so two of them
 * count as one. The first column is the first level below the part, which is why
 * an unindented entry is level 1 and a two-column entry is level 2.
 *
 * @param {string} indent - the line's leading whitespace.
 * @returns {number} 1..6.
 */
function tocIndentLevel(indent) {
  let full = 0
  let half = 0
  for (const char of indent) {
    if (char === '\u3000') full += 1
    else half += 1
  }
  return Math.min(MAX_HEADING_LEVEL, Math.max(1, full + Math.floor(half / 2)))
}

/**
 * Parse the text of one or more `toc` blocks into entries.
 *
 * Blank lines are dropped (a page break inside the printed list leaves an empty
 * line behind), the leader is typography rather than text, and the trailing
 * number is the printed page the entry points at.
 *
 * @param {string} text - `toc` block text, one entry per line.
 * @returns {{ level: number, title: string, page: string }[]} the entries.
 */
export function parseTocEntries(text) {
  const entries = []
  for (const line of String(text ?? '').split('\n')) {
    const indent = TOC_INDENT.exec(line)?.[0] ?? ''
    let rest = line.slice(indent.length)
    if (rest.trim() === '') continue
    let page = ''
    const withLeader = TOC_LINE_WITH_LEADER.exec(rest)
    const withSpace = withLeader === null ? TOC_LINE_WITH_SPACE.exec(rest) : null
    const match = withLeader ?? withSpace
    if (match !== null) {
      page = match[1]
      rest = rest.slice(0, match.index)
    }
    const title = rest
      .replace(TOC_LEADER_RUN, ' ')
      .replace(TOC_LEADER_PADDED, ' ')
      .replace(TOC_LEADER_TAIL, '')
      .replace(/[ \t\u3000]{2,}/g, ' ')
      .trim()
    if (title === '') continue
    entries.push({ level: tocIndentLevel(indent), title, page })
  }
  return entries
}

/**
 * Largest edit distance between a contents entry and a chapter title that is still
 * read as the model slipping on the entry, not as a different line.
 *
 * One is the defect itself: `回忆` for `回历`, a single character. Two is one short
 * word, which is what a character plus a width or digit variant costs. A wider
 * window starts matching the NEXT year heading - `回历九〇〇年` against
 * `回历九〇一年` is already distance 1 on the comparison key - so two is also the
 * widest window that is still safe in this book.
 */
const TOC_TITLE_MAX_DISTANCE = 2

/**
 * Largest length difference still corrected, in characters.
 *
 * An edit distance bounds the length difference from above, so this is a cheap
 * pre-filter rather than an additional bound: it keeps the comparison from running
 * the O(n·m) table over pairs that cannot pass anyway. It is stated as a rule of
 * its own because it is what a future change to {@link TOC_TITLE_MAX_DISTANCE}
 * would still have to respect.
 */
const TOC_TITLE_MAX_LENGTH_DELTA = 3

/**
 * The printed parenthetical expansion inside a chapter title.
 *
 * The kind of group this matches is `(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)`
 * in `回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件`, and the
 * shape `（1503—1504）` in `英译者补回历九〇八年至九〇九年（1503—1504）的事件`. One
 * level only - no title of this book nests one group inside another - and the
 * character class refuses both widths of both brackets, so an unmatched opener
 * leaves the rest of the line intact instead of eating it.
 */
const TOC_TITLE_PARENTHETICAL = /[（(][^（()）]*[)）]/g

/**
 * The two characters this book uses for a zero in a year (`九〇〇` / `九○八`).
 *
 * They are the same glyph to a reader - `〇` U+3007 is the ideographic number zero,
 * `○` U+25CB the white circle - and the book itself mixes them: the chapter on page
 * 186 is titled `回历九○八年(…)的事件` while the contents page prints
 * `回忆九〇八年(1502—1503)的事件`. They are folded to one form for the contents
 * comparison only (see {@link tocTitleKey}), never in the text itself.
 */
const TOC_ZERO_FOLD = /[○◯]/g

/**
 * Comparison key of one title in a printed contents list.
 *
 * On top of {@link headingKey} - which already folds whitespace and punctuation
 * width - two things are folded away, and the real contents page of
 * 《巴布尔回忆录》 needs both:
 *
 *   1. THE PARENTHETICAL EXPANSION IS DROPPED ({@link TOC_TITLE_PARENTHETICAL}).
 *      The book ABBREVIATES its own contents: the contents page prints
 *      `回历九〇〇年(1494—1495)的事件` while the chapter title on the body page
 *      reads `回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件`.
 *      Compared as printed, the pair is 13+ edits apart, so a 2-edit window would
 *      never see it and the correction would fix 1 of the 14 real defects; compared
 *      without the expansion both sides read `回历九〇〇年的事件` and the single
 *      character that is wrong is the single character that differs. The expansion
 *      is dropped on BOTH sides, and it is dropped for the "already correct" test
 *      as well: a correctly abbreviated entry matches its chapter's key exactly and
 *      is therefore never rewritten into the long form;
 *   2. THE TWO CJK ZEROS ARE ONE CHARACTER ({@link TOC_ZERO_FOLD}). Without the
 *      fold, an entry that costs `○` where its chapter costs `〇` is distance 2 from
 *      its own title and distance 2 from the year before it - a tie, which rule 6
 *      below refuses - and that is exactly the pair page 186 and the contents page
 *      print.
 *
 * Everything else still counts, so two different chapters keep two different keys.
 *
 * @param {unknown} text - a contents entry or a chapter title.
 * @returns {string} the comparison key; `''` for empty text or a title that is
 *   nothing but its parenthetical expansion.
 */
function tocTitleKey(text) {
  return headingKey(String(text ?? '').replace(TOC_TITLE_PARENTHETICAL, ''))
    .replace(TOC_ZERO_FOLD, '〇')
}

/**
 * Most single-character substitutions one contents entry may take.
 *
 * The defect this pass was written for is ONE character (`回忆` for `回历`), and the
 * match window ({@link TOC_TITLE_MAX_DISTANCE}) is two, so a pair that reached the
 * substitution step at all can legitimately need at most two. Three is therefore a
 * cap with headroom, not a quota: an entry that would need four is a different line,
 * and the pass keeps it as transcribed rather than guess. Refusing costs a typo that
 * was already there; guessing costs a printed entry, which is the worse trade.
 */
const TOC_SUBSTITUTE_MAX = 3

/**
 * The stand-in a whole parenthetical group is aligned as.
 *
 * Any character no transcription can contain would do; U+0001 is a control character
 * `gate.js` already refuses in book text, so a page can never print it.
 */
const TOC_MASK_CHAR = '\u0001'

/**
 * Fold one character the way {@link tocTitleKey} folds it.
 *
 * The substitution step asks two questions per aligned pair - "do these characters
 * differ?" and "do they differ to a READER, or only in typography?" - and the second
 * one has to be answered in the same terms the match was made in, or the pass would
 * spend its budget rewriting a full-width `，` into a half-width one, which is the
 * page's typography and not the model's mistake. Only the two folds the key applies
 * are reproduced: width, and the two CJK zeros. Whitespace never reaches this
 * function (see {@link substituteTocChars}).
 *
 * @param {string} char - one character of an entry or a title.
 * @returns {string} the character as {@link tocTitleKey} would compare it.
 */
function foldTocChar(char) {
  if (char === '○' || char === '◯') return '〇'
  if (WIDTH_FOLD_ONE.test(char)) return foldWidth(char)
  return char
}

/**
 * Mark the characters that sit inside a parenthetical group.
 *
 * The groups are the ones {@link TOC_TITLE_PARENTHETICAL} matches, so this mask and
 * the comparison key agree by construction on where a group is. Those characters are
 * then handed to the alignment as one repeated stand-in ({@link TOC_MASK_CHAR})
 * instead of their real text, because the contents page ABBREVIATES where the chapter
 * expands: `(1494—1495)` against `(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)`.
 * Aligned by content, the `1494` of the entry would pair with the `1495` of the
 * chapter and the pass would "correct" a printed date; aligned as a run of
 * placeholders, a group character costs nothing against another group character and
 * the alignment of the text AROUND the group does not depend on how long the group is.
 *
 * @param {string} text - a contents entry or a chapter title.
 * @returns {{ masked: string, inside: Uint8Array }} the text with every
 *   parenthesised character replaced by {@link TOC_MASK_CHAR}, and one flag per
 *   character saying whether it was one of them.
 */
function maskParentheticals(text) {
  const inside = new Uint8Array(text.length)
  for (const match of text.matchAll(TOC_TITLE_PARENTHETICAL)) {
    const start = match.index ?? 0
    for (let at = start; at < start + match[0].length; at += 1) inside[at] = 1
  }
  let masked = ''
  for (let at = 0; at < text.length; at += 1) {
    masked += inside[at] === 1 ? TOC_MASK_CHAR : text[at]
  }
  return { masked, inside }
}

/**
 * Align two strings character by character along the Levenshtein edit path.
 *
 * {@link levenshtein} answers "how far apart are these two lines", which is all a
 * threshold needs; a substitution needs the PATH, i.e. which character of the entry
 * stands opposite which character of the title. So the same table is built here - one
 * row per character, substitution, insertion and deletion all costing 1 - and then
 * walked back from the corner, and the walk is what says "this character is a slip"
 * (a diagonal step between two different characters) as opposed to "these two lines
 * say different amounts" (a step off the diagonal, which is skipped entirely).
 *
 * Cost is O(n·m) time and memory; both strings here are one contents line, tens of
 * characters, so the full table is cheaper than a rolling row plus a second pass.
 *
 * The diagonal is preferred whenever it is on an optimal path, even when the pair is
 * a substitution: a substitution keeps the entry's length and structure, while a
 * deletion followed by an insertion would silently rewrite two neighbours, and this
 * pass is not allowed to change how long an entry is.
 *
 * @param {string} left - the entry side.
 * @param {string} right - the title side.
 * @returns {[number, number][]} the paired positions, ascending on both sides. A
 *   position only appears when the two characters stand opposite each other; a
 *   character that is only inserted or only deleted is absent from the result.
 */
function alignCharacters(left, right) {
  const rows = left.length + 1
  const width = right.length + 1
  const table = new Int32Array(rows * width)
  for (let column = 0; column < width; column += 1) table[column] = column
  for (let row = 1; row < rows; row += 1) {
    table[row * width] = row
    const leftCode = left.charCodeAt(row - 1)
    for (let column = 1; column < width; column += 1) {
      const cost = leftCode === right.charCodeAt(column - 1) ? 0 : 1
      const diagonal = table[(row - 1) * width + (column - 1)] + cost
      const up = table[(row - 1) * width + column] + 1
      const across = table[row * width + (column - 1)] + 1
      const cheapest = diagonal < up ? diagonal : up
      table[row * width + column] = cheapest < across ? cheapest : across
    }
  }
  const pairs = []
  let row = left.length
  let column = right.length
  while (row > 0 && column > 0) {
    const cost = left.charCodeAt(row - 1) === right.charCodeAt(column - 1) ? 0 : 1
    if (table[row * width + column] === table[(row - 1) * width + (column - 1)] + cost) {
      pairs.push([row - 1, column - 1])
      row -= 1
      column -= 1
    } else if (table[row * width + column] === table[(row - 1) * width + column] + 1) {
      row -= 1
    } else {
      column -= 1
    }
  }
  pairs.reverse()
  return pairs
}

/**
 * Correct one contents entry toward its chapter title, ONE CHARACTER AT A TIME.
 *
 * THE DEFECT THIS REPLACES. Handing the whole chapter title back (`{ ...entry,
 * title: best.title }`) removes the `忆` and with it the printed abbreviation: the
 * contents page prints `回忆九〇〇年(1494—1495)的事件` and the entry came out
 * `回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件` - half again
 * as long, inconsistent with the 19 neighbouring entries that keep their abbreviation,
 * and not what the page says. The typo is one character; the repair has to be one
 * character too.
 *
 * THE RULE. Align the pair ({@link alignCharacters}) and take ONLY the positions where
 * one character stands opposite one character, skipping every insertion and deletion -
 * those are the two lines saying different amounts, which is exactly the abbreviated
 * versus expanded parenthetical, not a slip. A slip is a substitution: the entry's
 * character is wrong, the title's character is right, and the length of the entry is
 * the same before and after. Nothing here can insert or delete a character, so the
 * entry's length and structure survive by construction.
 *
 * WHAT IS NEVER A SLIP, and is therefore skipped even on a paired position:
 *
 *   * a parenthetical group, on EITHER side (`maskParentheticals`): the date numbers
 *     inside one are the page's, and `1493` against `公元 1493 年` is a difference in
 *     how much is spelled out, not a typo;
 *   * whitespace on either side: it is typography, and the key already folds it;
 *   * two characters the comparison key folds to the same thing ({@link foldTocChar}):
 *     a full-width `，` standing where the title has `,` is width, not a slip, and
 *     rewriting it would change the entry's typography for no gain in the key.
 *
 * TWO GUARDS, in the safe direction both times. More than {@link TOC_SUBSTITUTE_MAX}
 * positions wanting a change means this is not the same line with a slip, so the entry
 * comes back untouched rather than half-repaired; and the caller throws away any result
 * whose length changed or which is not strictly closer to the title than the entry
 * started (it re-measures with {@link levenshtein}). Every refusal returns the entry
 * exactly as transcribed.
 *
 * Pure: same inputs, same output, and an entry that is already its title's text is
 * returned as it came in.
 *
 * @param {string} entryTitle - the printed contents entry.
 * @param {string} chapterTitle - the chapter title it is matched against.
 * @returns {string} the entry with at most {@link TOC_SUBSTITUTE_MAX} characters
 *   replaced, or `entryTitle` itself when nothing may be replaced.
 */
function substituteTocChars(entryTitle, chapterTitle) {
  if (entryTitle === chapterTitle) return entryTitle
  const entry = maskParentheticals(entryTitle)
  const chapter = maskParentheticals(chapterTitle)
  const corrected = entryTitle.split('')
  let applied = 0
  for (const [at, from] of alignCharacters(entry.masked, chapter.masked)) {
    const before = entryTitle[at]
    const after = chapterTitle[from]
    if (before === after) continue
    if (entry.inside[at] === 1 || chapter.inside[from] === 1) continue
    if (/\s/.test(before) || /\s/.test(after)) continue
    if (foldTocChar(before) === foldTocChar(after)) continue
    // The cap is checked BEFORE the substitution, so the entry is returned whole:
    // half a correction is worse than none - it would make one entry differ from
    // both the page and the chapter.
    if (applied >= TOC_SUBSTITUTE_MAX) return entryTitle
    corrected[at] = after
    applied += 1
  }
  return applied === 0 ? entryTitle : corrected.join('')
}

/**
 * Repair a contents entry against the chapter title it is a slip of.
 *
 * THE DEFECT. The finished book of 《巴布尔回忆录》 came out with 14 entries of its
 * printed contents page reading `回忆八九九年(1493—1494)的事件` where the chapter
 * itself is titled `回历八九九年(公元 1493 年 10 月 12 日至公元 1494 年 10 月 2 日)的事件`:
 * `历` (lì) is the character the page prints, `忆` (yì) is a homophone the model
 * typed instead. The 90 chapter titles were right - each one is a heading block on
 * its own page, transcribed in the context of the chapter it opens - while the
 * contents page is a block of short lines with no chapter context at all, which is
 * exactly where a vision model confuses the two characters. `回忆` is also a real
 * word, so nothing local to the entry marks it as wrong, and the contents page is
 * the first thing a reader sees.
 *
 * THE EVIDENCE. The chapter titles built by `buildChapters()` from the same
 * transcription are the only trustworthy statement of how each chapter is titled,
 * so they are the reference this pass corrects against. It is a pass of its own
 * and never a string replacement: `回忆` is a real word elsewhere in this book
 * (`《巴布尔回忆录》`, all over its prose), and a global 回忆→回历 rewrite would
 * corrupt text that is already correct. Only an ENTRY of a printed contents list,
 * matched against an actual chapter title within {@link TOC_TITLE_MAX_DISTANCE}, is
 * ever rewritten, and a replacement is never more than the few characters that are
 * wrong: the entry keeps the page's own abbreviation, spacing and punctuation width.
 *
 * THE RULES, in the order they are applied to one entry:
 *
 *   1. an entry with no printed page number (`page === ''`) is not touched: it is
 *      very often not a chapter name at all (a section label, a stray line), and
 *      the printed page number is the evidence that the line is an entry of this
 *      list and a name that resolves somewhere;
 *   2. the comparison runs on {@link tocTitleKey} - whitespace and punctuation
 *      width folded, the printed parenthetical expansion dropped, the two CJK
 *      zeros unified - so an abbreviated entry and the long chapter title still
 *      match, and a letter-spaced or full-width title still matches too;
 *   3. when a chapter title produces the SAME key, the entry already names that
 *      chapter and stays byte for byte as transcribed: its own spacing, its own
 *      abbreviation and its own punctuation width are the page's, not the title
 *      block's, and rewriting it would be the "correct entry made longer" defect;
 *   4. otherwise the entry is corrected only when the edit distance is at most
 *      {@link TOC_TITLE_MAX_DISTANCE} AND the length difference is at most
 *      {@link TOC_TITLE_MAX_LENGTH_DELTA}, both measured against the NEAREST
 *      title, so a far entry can never borrow the closeness of another;
 *   5. a candidate that would be a TOTAL rewrite is refused even inside the
 *      distance window (the distance must stay below the shorter of the two keys).
 *      Without this, a two-character entry is within distance 2 of every
 *      two-character title - `人名` against `目 录` is exactly that - and the pass
 *      would rewrite a short index entry into an unrelated title it merely has the
 *      right length for. A correction that keeps no character of the entry is not a
 *      correction, it is a guess;
 *   6. a tie between two titles at the same minimum distance is left alone: two
 *      chapters that close are genuinely indistinguishable, and guessing one of
 *      them would put the wrong title on the entry - the failure direction is
 *      "keep the model's text", never "pick the first candidate";
 *   7. the repair is SEGMENT level, not entry level: the entry and the title are
 *      aligned character by character and only the positions where one character
 *      stands opposite one character are candidates for replacement, at most
 *      {@link TOC_SUBSTITUTE_MAX} of them. Insertions and deletions - which is what
 *      the abbreviated `(1494—1495)` against the expanded `(公元 1494 年 10 月 2 日至
 *      公元 1495 年 9 月 21 日)` looks like to an alignment - are skipped, and so is
 *      every character inside a parenthetical group on either side, so the entry
 *      keeps its printed dates and its printed length. Replacing the whole entry with
 *      the matched title, which is what this pass did first, turned those 14
 *      abbreviated entries into 29-character chapter titles and left the list
 *      visually inconsistent with the 19 entries beside them;
 *   8. a repair that did not keep the entry's length is thrown away, and so, in rule
 *      9, is one that did not move the entry's key strictly closer to the title's:
 *      the entry then stays exactly as printed. Both are re-measured on the shipped
 *      result, so the pass cannot talk itself into a repair it did not actually make.
 *
 * Everything else - a heading of a section that never opened a chapter, a part
 * title, a line the model invented (`附录：引用书目`) - stays exactly as
 * transcribed, because the only claim this pass makes is "this line is that
 * chapter's title".
 *
 * Pure and deterministic: the same entries and the same titles produce the same
 * result, and a second pass over its own output changes nothing (a repaired entry's
 * key now equals its chapter title's, so rule 3 applies).
 *
 * @param {{ level: number, title: string, page: string }[]} entries - parsed contents entries.
 * @param {string[]} [chapterTitles] - titles of the chapters the entries point at; empty or omitted disables the pass entirely.
 * @returns {{ level: number, title: string, page: string }[]} the entries, corrected; the input array is not mutated and the same array is returned when nothing can be decided.
 */
export function reconcileTocEntries(entries, chapterTitles) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  if (!Array.isArray(chapterTitles) || chapterTitles.length === 0) return entries
  // The titles are keyed once, not once per entry: the printed contents of this book
  // is ~100 entries long and the chapter list ~90, so the loop below is the only
  // quadratic part and the key build must not be inside it.
  const titles = []
  for (const raw of chapterTitles) {
    const title = String(raw ?? '')
    const key = tocTitleKey(title)
    if (key !== '') titles.push({ title, key })
  }
  if (titles.length === 0) return entries
  let changed = false
  const corrected = entries.map(entry => {
    if (entry === null || typeof entry !== 'object') return entry
    // Rule 1: no printed page number, no chapter claim.
    if (String(entry.page ?? '') === '') return entry
    const key = tocTitleKey(entry.title)
    if (key === '') return entry
    let best = null
    let bestDistance = TOC_TITLE_MAX_DISTANCE + 1
    let tied = false
    for (const candidate of titles) {
      // Rule 3: the entry already names this chapter (by key), so it is left as the
      // page printed it - abbreviation, spacing and punctuation width included.
      if (candidate.key === key) return entry
      if (Math.abs(candidate.key.length - key.length) > TOC_TITLE_MAX_LENGTH_DELTA) continue
      const distance = levenshtein(key, candidate.key)
      if (distance > TOC_TITLE_MAX_DISTANCE) continue
      // Rule 5: a candidate that replaces every character is not a correction. A
      // two-character entry is within distance 2 of every two-character title
      // (`人名` against `目 录`), and that is a guess, not a match.
      if (distance >= Math.min(key.length, candidate.key.length)) continue
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
        tied = false
      } else if (distance === bestDistance) {
        // Rule 6: an equal-distance rival means the entry does not name one chapter.
        tied = true
      }
    }
    if (best === null || tied) return entry
    const printed = String(entry.title ?? '')
    if (best.title === printed) return entry
    // Rule 7: only the characters that are wrong are replaced. The matched title is
    // the reference, never the text that goes into the book (see substituteTocChars):
    // the contents page abbreviates, the chapter expands, and copying the expansion
    // into the list is the defect this rule exists for.
    const repaired = substituteTocChars(printed, best.title)
    if (repaired === printed) return entry
    // Rule 8: the repair has to be a repair. A substitution cannot change the length,
    // and this is the belt to that brace - if a future edit ever let one through, the
    // entry keeps its printed structure instead of a half-rewritten one.
    if (repaired.length !== printed.length) return entry
    // Rule 9: it must move the entry CLOSER to the title, re-measured on the same key
    // the match was made on. A substitution that the key cannot even see (width, a CJK
    // zero) is not a correction; the entry keeps its own typography.
    if (!(levenshtein(tocTitleKey(repaired), best.key) < bestDistance)) return entry
    changed = true
    return { ...entry, title: repaired }
  })
  // Keep the identity of an untouched list, so a caller can tell "nothing changed"
  // from "everything happened to be rewritten to itself".
  return changed ? corrected : entries
}

/**
 * Render contents entries as one XHTML navigation list.
 *
 * Flat on purpose: the depth is carried by `class="toc-N"`, which keeps the
 * markup simple and lets the stylesheet indent it, instead of nesting `<ol>`s a
 * model-reported level might not line up with.
 *
 * `chapterTitles` is passed straight to {@link reconcileTocEntries}: the printed
 * contents page is corrected against the chapter titles `buildChapters()` produced
 * from the same transcription. The option is optional, and without it the entries
 * render exactly as parsed.
 *
 * @param {{ level: number, title: string, page: string }[]} entries - parsed entries.
 * @param {{ chapterTitles?: string[] }} [options] - chapter titles to reconcile the entries against.
 * @returns {string} `<nav>` markup, or `''` when there is nothing to list.
 */
export function renderTocEntries(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const listed = reconcileTocEntries(entries, options.chapterTitles)
  const items = listed.map(entry => {
    const page = entry.page === '' ? '' : `<span class="toc-page">${escapeHtml(entry.page)}</span>`
    return `    <li class="toc-${entry.level}"><span class="toc-title">${escapeHtml(entry.title)}</span>${page}</li>`
  })
  return ['<nav class="toc" epub:type="toc">', '  <ol>', ...items, '  </ol>', '</nav>'].join('\n')
}

/**
 * Render one block as XHTML.
 * @param {{ type: string, text: string, image?: string }} block - block to render.
 * @param {{ offset?: number, chapterTitles?: string[] }} [options] - `offset` demotes inline headings below the chapter title; `chapterTitles` corrects a `toc` block's entries (see {@link reconcileTocEntries}).
 * @returns {string} markup for the block, or `''` when the block has nothing to show.
 */
export function renderBlock(block, options = {}) {
  const raw = String(block.text ?? '')
  const text = proseText(block.type, raw)
  const offset = options.offset ?? 0
  switch (block.type) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Math.min(6, Math.max(2, Number(block.type.slice(1)) + offset))
      return `<h${level}>${escapeHtml(text)}</h${level}>`
    }
    case 'toc':
      return renderTocEntries(parseTocEntries(text), { chapterTitles: options.chapterTitles })
    case 'verse':
    case 'code':
    case 'address': {
      // One class per semantic kind: a verse line, a code excerpt and an address
      // block are laid out differently, so sharing `class="verse"` lost the
      // distinction the model had already made.
      const lines = escapeHtml(text).split('\n').map(line => line.trimEnd())
      return `<p class="${block.type}">${lines.join('<br/>')}</p>`
    }
    case 'quote':
      return `<blockquote><p>${escapeHtml(text)}</p></blockquote>`
    case 'table':
      return renderTable(text)
    case 'figure': {
      // Chapters live in OEBPS/text/, figures in OEBPS/images/.
      const href = typeof block.image === 'string' && FIGURE_IMAGE_RE.test(block.image)
        ? block.image
        : ''
      const caption = text.trim() === '' ? '' : `<figcaption>${escapeHtml(text)}</figcaption>`
      // A figure with neither a picture nor a caption is an empty box: the model
      // saw artwork it could not crop (a cover, a plate) and had nothing to say
      // about it. `<figure></figure>` says nothing either, so it is not emitted.
      if (href === '' && caption === '') return ''
      if (href === '') return `<figure>${caption}</figure>`
      // The picture comes first and the caption after it, as the plate was laid
      // out on the page. An untitled plate still needs alt text to be readable.
      const alt = text.trim() === '' ? '插图' : escapeHtml(text)
      return `<figure><img src="../${escapeHtml(href)}" alt="${alt}"/>${caption}</figure>`
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
 *
 * The title is emitted at exactly the level the chapter object carries, because
 * the navigation document nests chapters by that same `level`: a level-2 chapter
 * whose document opened with `<h1>` made the two disagree about the book's
 * outline. Consecutive `toc` blocks are gathered into a single `<nav>`: a printed
 * contents list that spans a page break is one list, not one per page.
 *
 * `chapterTitles` carries the titles `buildChapters()` decided on, which is the
 * only statement of how the book's chapters are REALLY titled: a printed contents
 * page is transcribed on its own, with no chapter context, and the model slips
 * there (`回忆` for `回历`, 14 entries of the pilot book). Every `toc` entry is
 * corrected against that list by {@link reconcileTocEntries} - a deterministic
 * match, never a string replacement, so the `《巴布尔回忆录》` in the prose is
 * untouched.
 *
 * @param {{ title: string, level?: number, blocks: {type: string, text: string}[] }} chapter - chapter model.
 * @param {{ omitTitle?: boolean, offset?: number, chapterTitles?: string[] }} [options] - `omitTitle` for chapters already opened by an h1 block; `chapterTitles` for the contents correction.
 * @returns {string} XHTML body fragment.
 */
export function renderChapterHtml(chapter, options = {}) {
  const titleLevel = Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.trunc(Number(chapter.level) || 1)))
  const parts = []
  if (options.omitTitle !== true) {
    parts.push(`<h${titleLevel}>${escapeHtml(chapter.title)}</h${titleLevel}>`)
  }
  const blocks = Array.isArray(chapter.blocks) ? chapter.blocks : []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type === 'toc') {
      const entries = []
      let cursor = index
      while (cursor < blocks.length && blocks[cursor].type === 'toc') {
        entries.push(...parseTocEntries(blocks[cursor].text))
        cursor += 1
      }
      index = cursor - 1
      const nav = renderTocEntries(entries, { chapterTitles: options.chapterTitles })
      if (nav !== '') parts.push(nav)
      continue
    }
    const html = renderBlock(block, { offset: options.offset ?? 0, chapterTitles: options.chapterTitles })
    if (html !== '') parts.push(html)
  }
  return parts.join('\n')
}
