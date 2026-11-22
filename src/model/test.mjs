/**
 * Unit tests for the pure model layer. Run with `node src/model/test.mjs`.
 *
 * Tests are registered first and run afterwards so a body may be async (the
 * Host bridge seam is promise-based); the body handle is what makes the
 * `normalizeBlock -> renderBlock` chain testable end to end, which is where the
 * table and list corruption used to hide.
 */

import assert from 'node:assert/strict'

import { countableCharacters, normalizeBlock, parsePageJson, stripToJson } from './blocks.js'
import {
  buildChapters,
  escapeHtml,
  flattenPages,
  looksLikeContinuation,
  renderBlock,
  renderChapterHtml,
  renderTable,
  smartJoin,
  stripIllegalXml,
} from './assemble.js'
import {
  characterSimilarity,
  checkPage,
  levenshtein,
  needsCrossReview,
  pickMedoid,
  resolvePageRecord,
} from './gate.js'
import { addUsage, emptyLedger, estimateTokens, normalizeUsage } from './usage.js'
import { callModel, checkImageCapability, collectStream, imageBlock } from '../host/bridge.js'

const queue = []
function test(name, body) {
  queue.push({ name, body })
}

/** The text a page record contributes to cross-review similarity. */
function pageText(page) {
  return page.blocks.map(block => block.text).join('\n')
}

/** A page record the sentinels accept as a parsed model reply. */
function pageRecord(blocks) {
  return { blocks, notes: '', raw: '{"blocks":[]}' }
}

test('stripToJson removes fences and prose', () => {
  const raw = 'here you go:\n```json\n{"blocks":[]}\n```\nthanks'
  assert.equal(stripToJson(raw), '{"blocks":[]}')
})

test('parsePageJson accepts a fenced reply', () => {
  const page = parsePageJson('```json\n{"blocks":[{"type":"P","text":" hello "},{"type":"header","text":"p.1"}]}\n```')
  assert.equal(page.blocks.length, 2)
  assert.equal(page.blocks[0].type, 'p')
  assert.equal(page.blocks[0].text, 'hello')
  assert.equal(page.dropped, 1)
})

test('parsePageJson rejects prose without blocks', () => {
  assert.throws(() => parsePageJson('I cannot read this page'), /not parseable/)
})

test('normalizeBlock collapses paragraph newlines but keeps verse', () => {
  const paragraph = normalizeBlock({ type: 'p', text: '第一行\n第二行' })
  assert.equal(paragraph.text, '第一行 第二行')
  const verse = normalizeBlock({ type: 'verse', text: '床前明月光\n疑是地上霜' })
  assert.equal(verse.text, '床前明月光\n疑是地上霜')
})

test('normalizeBlock keeps table rows and separators (S2)', () => {
  const block = normalizeBlock({ type: 'table', text: '| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |' })
  assert.equal(block.type, 'table')
  assert.equal(block.text, '| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |')
  assert.equal(block.text.split('\n').length, 3)

  const html = renderTable(block.text)
  assert.match(html, /<table>/)
  assert.match(html, /<thead>/)
  assert.match(html, /<tbody>/)
  assert.match(html, /<th>名<\/th>/)
  assert.match(html, /<td>甲<\/td>/)
  assert.ok(!html.includes('<td>---</td>'))
  assert.ok(!html.includes('---'))
})

test('normalizeBlock keeps list items on separate lines (S2)', () => {
  const block = normalizeBlock({ type: 'list', text: '- 第一项\n- 第二项\n- 第三项' })
  assert.equal(block.type, 'list')
  assert.equal(block.text.split('\n').length, 3)

  const html = renderBlock(block)
  assert.equal(html, '<ul><li>第一项</li><li>第二项</li><li>第三项</li></ul>')
  assert.equal((html.match(/<li>/g) ?? []).length, 3)
  assert.ok(!html.includes('第一项 - '))
})

test('normalizeBlock records an unknown type instead of dropping the text', () => {
  const block = normalizeBlock({ type: 'paragraph', text: '正文' }, 3)
  assert.equal(block.type, 'p')
  assert.equal(block.text, '正文')
  assert.match(block.issues.join(' '), /unknown type/)
})

test('countableCharacters ignores furniture and whitespace', () => {
  const total = countableCharacters([
    { type: 'p', text: '一二 三' },
    { type: 'footer', text: '第 12 页' },
  ])
  assert.equal(total, 3)
})

test('smartJoin keeps CJK tight and separates latin words', () => {
  assert.equal(smartJoin('一个句子的', '后半段'), '一个句子的后半段')
  assert.equal(smartJoin('word', 'end'), 'word end')
  assert.equal(smartJoin('结尾，', 'Next'), '结尾，Next')
})

test('flattenPages resolves continues and drops furniture', () => {
  const pages = [
    { page: 1, blocks: [{ type: 'p', text: '这是第一页的正文' }, { type: 'footer', text: '1' }] },
    { page: 2, blocks: [{ type: 'p', text: '紧接着的续写', continues: true }, { type: 'p', text: '新段落' }] },
  ]
  const flat = flattenPages(pages)
  assert.equal(flat.blocks.length, 2)
  assert.equal(flat.blocks[0].text, '这是第一页的正文紧接着的续写')
  assert.equal(flat.blocks[1].text, '新段落')
  assert.equal(flat.dropped, 1)
  assert.equal(flat.joined, 1)
  assert.equal(flat.rejectedJoins, 0)
})

test('flattenPages does not join into a heading', () => {
  const pages = [
    { page: 1, blocks: [{ type: 'h2', text: '第一章' }] },
    { page: 2, blocks: [{ type: 'p', text: '正文', continues: true }] },
  ]
  const flat = flattenPages(pages)
  assert.equal(flat.blocks.length, 2)
  assert.equal(flat.blocks[1].text, '正文')
  assert.equal(flat.rejectedJoins, 1)
})

test('flattenPages refuses to merge continues into a table (S3)', () => {
  const table = '| a |\n| - |\n| 1 |'
  const flat = flattenPages([
    { page: 1, blocks: [{ type: 'table', text: table }] },
    { page: 2, blocks: [{ type: 'table', text: '| 2 |', continues: true }] },
  ])
  assert.equal(flat.blocks.length, 2)
  assert.equal(flat.blocks[0].text, table)
  assert.equal(flat.blocks[1].text, '| 2 |')
  assert.equal(flat.blocks[1].continues, true)
  assert.equal(flat.joined, 0)
  assert.equal(flat.rejectedJoins, 1)
})

test('flattenPages refuses to merge continues into a figure caption (S3)', () => {
  const flat = flattenPages([
    { page: 1, blocks: [{ type: 'figure', text: '图 1 说明' }] },
    { page: 2, blocks: [{ type: 'p', text: '续文', continues: true }] },
  ])
  assert.equal(flat.blocks.length, 2)
  assert.equal(flat.blocks[0].text, '图 1 说明')
  assert.equal(flat.blocks[1].text, '续文')
  assert.equal(flat.rejectedJoins, 1)
})

test('flattenPages joins continued verse with a line break (S3)', () => {
  const joined = flattenPages([
    { page: 1, blocks: [{ type: 'verse', text: '床前明月光' }] },
    { page: 2, blocks: [{ type: 'verse', text: '疑是地上霜', continues: true }] },
  ])
  assert.equal(joined.blocks.length, 1)
  assert.equal(joined.blocks[0].text, '床前明月光\n疑是地上霜')
  assert.equal(joined.joined, 1)
  assert.equal(joined.rejectedJoins, 0)

  // Paragraph into verse is a kind change, not a continuation.
  const mixed = flattenPages([
    { page: 1, blocks: [{ type: 'verse', text: '第一行' }] },
    { page: 2, blocks: [{ type: 'p', text: '散文续写', continues: true }] },
  ])
  assert.equal(mixed.blocks.length, 2)
  assert.equal(mixed.rejectedJoins, 1)
})

test('looksLikeContinuation joins a paragraph torn by a page break', () => {
  const previous = { type: 'p', text: '他被这突如其来的', page: 7 }
  const block = { type: 'p', text: '场面吓住了。', page: 8 }
  assert.equal(looksLikeContinuation(previous, block), true)
})

test('looksLikeContinuation refuses a block after a finished sentence', () => {
  const previous = { type: 'p', text: '这句话到这里就结束了。', page: 7 }
  const block = { type: 'p', text: '场面吓住了。', page: 8 }
  assert.equal(looksLikeContinuation(previous, block), false)
})

test('looksLikeContinuation refuses a block that opens with a capital', () => {
  const previous = { type: 'p', text: 'The sentence runs off the end of', page: 7 }
  const block = { type: 'p', text: 'The next page starts a brand new paragraph.', page: 8 }
  assert.equal(looksLikeContinuation(previous, block), false)
})

test('looksLikeContinuation refuses an enumerated block', () => {
  const previous = { type: 'p', text: '上一页没有写完的一句', page: 7 }
  const block = { type: 'p', text: '2. 第二点', page: 8 }
  assert.equal(looksLikeContinuation(previous, block), false)
})

test('looksLikeContinuation refuses two blocks on the same page', () => {
  const previous = { type: 'p', text: '同一页上的前一段', page: 7 }
  const block = { type: 'p', text: '紧接着的另一段', page: 7 }
  assert.equal(looksLikeContinuation(previous, block), false)
})

test('flattenPages joins a cross-page paragraph without a continues flag', () => {
  const pages = [
    { page: 1, blocks: [{ type: 'p', text: '他被这突如其来的' }] },
    { page: 2, blocks: [{ type: 'p', text: '场面吓住了。' }] },
  ]
  const flat = flattenPages(pages)
  assert.equal(flat.blocks.length, 1)
  assert.equal(flat.blocks[0].text, '他被这突如其来的场面吓住了。')
  assert.equal(flat.joined, 1)
})

test('flattenPages keeps a paragraph that ended with a full stop separate', () => {
  const pages = [
    { page: 1, blocks: [{ type: 'p', text: '上一页到这里就结束了。' }] },
    { page: 2, blocks: [{ type: 'p', text: '下一页起了一个新的段落。' }] },
  ]
  const flat = flattenPages(pages)
  assert.equal(flat.blocks.length, 2)
  assert.equal(flat.blocks[1].text, '下一页起了一个新的段落。')
  assert.equal(flat.joined, 0)
})

test('buildChapters splits on the configured level and drops empty chapters', () => {
  const blocks = [
    { type: 'h2', text: '第一章', page: 1 },
    { type: 'p', text: '甲', page: 1 },
    { type: 'h3', text: '小标题', page: 2 },
    { type: 'p', text: '乙', page: 2 },
    { type: 'h2', text: '第二章', page: 3 },
    { type: 'p', text: '丙', page: 3 },
  ]
  const chapters = buildChapters(blocks, { splitLevel: 2 })
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].title, '第一章')
  assert.equal(chapters[0].blocks.length, 3)
  assert.equal(chapters[1].title, '第二章')
})

test('buildChapters opens a fallback chapter before the first heading', () => {
  const chapters = buildChapters([{ type: 'p', text: '序言内容', page: 1 }], { splitLevel: 2, fallbackTitle: '前言' })
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, '前言')
})

test('buildChapters keeps an empty level-1 part heading (S4)', () => {
  const chapters = buildChapters([
    { type: 'h1', text: 'Part I', page: 1 },
    { type: 'h2', text: 'Ch1', page: 2 },
    { type: 'p', text: '正文', page: 2 },
  ], { splitLevel: 2 })
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].title, 'Part I')
  assert.equal(chapters[0].level, 1)
  assert.equal(chapters[0].blocks.length, 0)
  assert.equal(chapters[1].title, 'Ch1')
  assert.equal(chapters[1].blocks.length, 1)
})

test('buildChapters survives a document made only of headings (S4)', () => {
  const headings = buildChapters([
    { type: 'h1', text: '第一章', page: 1 },
    { type: 'h1', text: '第二章', page: 2 },
  ])
  assert.equal(headings.length, 2)
  assert.equal(headings[0].title, '第一章')
  assert.equal(headings[0].blocks.length, 0)

  // An all-empty document must never produce a zero-chapter book.
  const empty = buildChapters([])
  assert.equal(empty.length, 1)
  assert.equal(empty[0].title, '正文')
  assert.equal(empty[0].level, 1)
  assert.equal(empty[0].blocks.length, 0)

  const furnished = buildChapters([], { fallbackTitle: '未命名' })
  assert.equal(furnished.length, 1)
  assert.equal(furnished[0].title, '未命名')
})

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;')
})

test('escapeHtml strips XML-illegal code points (P0-5)', () => {
  const illegal = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/
  const cleaned = escapeHtml('a\x00b\x0bc')
  assert.equal(cleaned, 'abc')
  assert.ok(!illegal.test(cleaned))
  // Escaping still happens after the removal.
  assert.equal(escapeHtml('a<b'), 'a&lt;b')
  assert.equal(escapeHtml('<b>&"\x00'), '&lt;b&gt;&amp;&quot;')
  // Noncharacters and lone surrogates cannot be encoded at all.
  assert.equal(escapeHtml('a\ufffeb\uffffc'), 'abc')
  assert.equal(escapeHtml('a\ud800b'), 'ab')
  assert.equal(escapeHtml('a\udc00b'), 'ab')
  // A valid surrogate pair and the three legal whitespace controls survive.
  assert.equal(escapeHtml('😀'), '😀')
  assert.equal(escapeHtml('a\tb\nc\rd'), 'a\tb\nc\rd')
})

test('stripIllegalXml keeps legal text and removes illegal code points (P0-5)', () => {
  assert.equal(stripIllegalXml('ok\ttext\n'), 'ok\ttext\n')
  assert.equal(stripIllegalXml('x\u0000\u000b\u001fy'), 'xy')
  assert.equal(stripIllegalXml('x\ufffe\uffffy'), 'xy')
  assert.equal(stripIllegalXml(undefined), '')
})

test('buildChapters strips illegal code points from chapter titles (P0-5)', () => {
  const chapters = buildChapters([{ type: 'h1', text: 'Part\x00 I\ufffe', page: 1 }])
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, 'Part I')
  const fallback = buildChapters([], { fallbackTitle: '正\x00文' })
  assert.equal(fallback[0].title, '正文')
})

test('renderChapterHtml never emits XML-illegal code points (P0-5)', () => {
  const illegal = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/
  const html = renderChapterHtml({
    title: 'T\x00',
    blocks: [
      { type: 'p', text: 'a\u0007b' },
      { type: 'table', text: '| a\u0000 |\n| --- |\n| 1 |' },
      { type: 'list', text: '- 甲\ufffe\n- 乙' },
    ],
  })
  assert.ok(!illegal.test(html), `illegal code point survived: ${JSON.stringify(html)}`)
  assert.ok(html.includes('ab'))
})

test('renderTable turns a pipe table into XHTML', () => {
  const html = renderTable('| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |')
  assert.match(html, /<table>/)
  assert.match(html, /<th>名<\/th>/)
  assert.match(html, /<td>甲<\/td>/)
  assert.ok(!html.includes('---'))
})

test('renderChapterHtml emits a title heading and block markup', () => {
  const html = renderChapterHtml({
    title: '第一章',
    blocks: [
      { type: 'p', text: '正文' },
      { type: 'verse', text: '第一行\n第二行' },
      { type: 'quote', text: '引文' },
    ],
  })
  assert.match(html, /<h1>第一章<\/h1>/)
  assert.match(html, /<p class="verse">第一行<br\/>第二行<\/p>/)
  assert.match(html, /<blockquote><p>引文<\/p><\/blockquote>/)
})

test('checkPage passes a healthy page and flags a short one', () => {
  const healthy = checkPage(
    { blocks: [{ type: 'p', text: '二'.repeat(200) }], raw: '{}' },
    { baselineText: '二'.repeat(205) },
  )
  assert.equal(healthy.ok, true)

  const short = checkPage(
    { blocks: [{ type: 'p', text: '二'.repeat(40) }], raw: '{}' },
    { baselineText: '二'.repeat(200) },
  )
  assert.equal(short.ok, false)
  assert.match(short.issues.join(' '), /character ratio/)
})

test('checkPage flags control characters and empty pages', () => {
  assert.equal(checkPage({ blocks: [], raw: '' }).ok, false)
  const dirty = checkPage({ blocks: [{ type: 'p', text: 'a\u0007b' }], raw: '{}' })
  assert.match(dirty.issues.join(' '), /control characters/)
})

test('checkPage reports malformed pages instead of throwing', () => {
  const missing = checkPage({ raw: '{}' })
  assert.equal(missing.ok, false)
  assert.match(missing.issues.join(' '), /no blocks produced/)
  assert.equal(missing.ratio, null)

  const noPage = checkPage(undefined)
  assert.equal(noPage.ok, false)

  const sparse = checkPage({ blocks: [null, { type: 'p', text: 3 }], raw: '{}' })
  assert.equal(sparse.ok, false)
  assert.match(sparse.issues.join(' '), /non-string text/)
})

test('needsCrossReview trusts a clean text-layer page only', () => {
  assert.equal(needsCrossReview({ ok: true, issues: [] }, true), false)
  assert.equal(needsCrossReview({ ok: true, issues: [] }, false), true)
  assert.equal(needsCrossReview({ ok: false, issues: ['x'] }, true), true)
})

test('levenshtein and similarity behave', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3)
  assert.equal(characterSimilarity('abc', 'abc'), 1)
  assert.ok(characterSimilarity('abc', 'abd') > 0.6)
})

test('pickMedoid chooses the candidate closest to all others', () => {
  const candidates = [{ text: '一致的文本内容' }, { text: '一致的文本内容' }, { text: '完全不同的另一段文字' }]
  assert.equal(pickMedoid(candidates), 0)
})

test('resolvePageRecord re-checks the medoid page and keeps degradation (S5)', () => {
  const baselineText = '甲'.repeat(1000)
  const clean = pageRecord([{ type: 'p', text: '甲'.repeat(1000) }])
  // Same length, one control character: the ratio still passes, the sentinel does not.
  const dirty = pageRecord([{ type: 'p', text: `${'甲'.repeat(999)}\u0007` }])
  const candidates = [
    { text: pageText(clean), page: clean },
    { text: pageText(dirty), page: dirty },
    { text: pageText(dirty), page: dirty },
  ]

  // The primary text alone passes, so the old code reported ok:true for a page
  // whose kept text is the medoid's failing one.
  assert.equal(checkPage(clean, { baselineText }).ok, true)

  const record = resolvePageRecord(candidates, { baselineText })
  assert.equal(record.index, 1)
  assert.equal(record.page, dirty)
  assert.equal(record.ok, false)
  assert.equal(record.degraded, true)
  assert.ok(record.agreement > 0.9, `expected the reviewers to converge, got ${record.agreement}`)
  assert.match(record.verdict.issues.join(' '), /control characters/)
})

test('resolvePageRecord reports the ratio of the kept page (S5)', () => {
  const baselineText = '乙'.repeat(1000)
  const primary = pageRecord([{ type: 'p', text: '乙'.repeat(1000) }])
  const short = pageRecord([{ type: 'p', text: '乙'.repeat(800) }])
  const candidates = [
    { text: pageText(primary), page: primary },
    { text: pageText(short), page: short },
    { text: pageText(short), page: short },
  ]

  assert.equal(checkPage(primary, { baselineText }).ratio, 1)
  const record = resolvePageRecord(candidates, { baselineText })
  assert.equal(record.page, short)
  assert.equal(Number(record.verdict.ratio.toFixed(3)), 0.8)
  assert.match(record.verdict.issues.join(' '), /character ratio/)
  assert.equal(record.ok, false)
  assert.equal(record.degraded, true)
})

test('resolvePageRecord leaves agreement null without reviewers', () => {
  const only = pageRecord([{ type: 'p', text: '短'.repeat(200) }])
  const record = resolvePageRecord([{ text: pageText(only), page: only }])
  assert.equal(record.index, 0)
  assert.equal(record.agreement, null)
  assert.equal(record.degraded, false)
  assert.equal(record.ok, true)
})

test('normalizeUsage accepts several field spellings', () => {
  assert.deepEqual(
    normalizeUsage({ promptTokens: 10, completionTokens: 5 }),
    { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0, total: 15 },
  )
  assert.deepEqual(
    normalizeUsage({ input_tokens: 7, output_tokens: 3, total_tokens: 10 }),
    { input: 7, output: 3, cached: 0, cacheWrite: 0, reasoning: 0, total: 10 },
  )
  assert.equal(normalizeUsage({ nonsense: 1 }), null)
  assert.equal(normalizeUsage(null), null)
})

test('normalizeUsage counts DSH cache read and write fields (C4)', () => {
  const usage = normalizeUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 })
  assert.equal(usage.input, 10)
  assert.equal(usage.cached, 100)
  assert.equal(usage.cacheWrite, 20)
  assert.equal(usage.total, 135)

  // Older spellings of the same two counters stay readable.
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 4 }).cached, 4)
  assert.equal(normalizeUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 4 }).cached, 4)
  assert.equal(normalizeUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 6 }).cacheWrite, 6)
  // A provider total is authoritative when present.
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 4, totalTokens: 999 }).total, 999)

  const ledger = emptyLedger()
  addUsage(ledger, usage)
  assert.equal(ledger.cached, 100)
  assert.equal(ledger.cacheWrite, 20)
  assert.equal(ledger.total, 135)
})

test('addUsage accumulates and records unknown shapes', () => {
  const ledger = emptyLedger()
  addUsage(ledger, normalizeUsage({ inputTokens: 100, outputTokens: 50 }))
  addUsage(ledger, null, { weird: true })
  assert.equal(ledger.calls, 2)
  assert.equal(ledger.input, 100)
  assert.equal(ledger.total, 150)
  assert.equal(ledger.unknownShapes.length, 1)
})

test('estimateTokens counts CJK near one per character', () => {
  assert.ok(estimateTokens('中文十个字符左右') >= 7)
  assert.ok(estimateTokens('hello world') < 5)
})

test('collectStream reads finish failures from reason.failure (C2)', async () => {
  const stream = (async function* () {
    yield { type: 'text-delta', index: 0, text: '{"blocks":' }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'boom' } } }
  })()
  const result = await collectStream(stream)
  assert.equal(result.text, '{"blocks":')
  assert.equal(result.error, 'boom')
  assert.equal(result.truncated, false)
  assert.equal(result.finish.kind, 'error')
})

test('collectStream flags a max-tokens truncation (C2)', async () => {
  const stream = (async function* () {
    yield { type: 'text-delta', index: 0, text: '{"blocks":[{"type":"p","text":"a"' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })()
  const result = await collectStream(stream)
  assert.equal(result.truncated, true)
  assert.equal(result.error, null)
  assert.equal(result.finish.kind, 'max-tokens')
})

test('collectStream ignores block-end and stray text chunks (C3)', async () => {
  const stream = (async function* () {
    yield { type: 'text-delta', index: 0, text: '{"blocks":[]}' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"blocks":[]}' } }
    yield { type: 'text', text: 'stray chunk that is not a StreamChunk' }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const result = await collectStream(stream)
  assert.equal(result.text, '{"blocks":[]}')
  assert.equal(result.error, null)
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 })
  assert.equal(result.finish.kind, 'stop')
})

test('callModel passes the system prompt as GenerateOptions.system (C1/C7)', async () => {
  const seen = []
  const host = {
    llm: {
      stream(options) {
        seen.push(options)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '{"blocks":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }

  const outcome = await callModel(host, { provider: 'p', model: 'm', system: 'SYS', user: 'U', maxTokens: 100 })
  assert.equal(outcome.text, '{"blocks":[]}')
  assert.equal(outcome.error, null)
  assert.equal(outcome.finishKind, 'stop')
  const options = seen[0]
  assert.equal(options.system, 'SYS')
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.deepEqual(options.messages[0].content, [{ type: 'text', text: 'U' }])
  assert.equal(options.messages.some(message => message.role === 'system'), false)

  // An image rides in the same user turn, and no system slot is invented.
  const image = { type: 'image', attachment: { attachmentId: 'att1' } }
  await callModel(host, { provider: 'p', model: 'm', user: 'U', image, maxTokens: 10 })
  const withImage = seen[1]
  assert.equal('system' in withImage, false)
  assert.equal(withImage.messages.length, 1)
  assert.deepEqual(withImage.messages[0].content[1], image)
})

test('imageBlock sends only SaveImageAttachment fields (C5)', async () => {
  const ref = { attachmentId: 'att1', mediaType: 'image/png', bytes: 3, width: 100, height: 200 }
  const calls = []
  const host = {
    attachments: {
      saveImage: async input => {
        calls.push(input)
        return ref
      },
    },
  }
  const png = new Uint8Array([1, 2, 3])
  const block = await imageBlock(host, png)
  assert.equal(calls.length, 1)
  const allowed = new Set(['data', 'mediaType', 'name'])
  for (const key of Object.keys(calls[0])) {
    assert.ok(allowed.has(key), `unexpected SaveImageAttachment field: ${key}`)
  }
  assert.equal(calls[0].width, undefined)
  assert.equal(calls[0].height, undefined)
  assert.equal(calls[0].mediaType, 'image/png')
  assert.equal(calls[0].data, png)
  assert.deepEqual(block, { type: 'image', attachment: ref })
})

test('checkImageCapability treats an empty modality list as no image (C6)', async () => {
  const route = { provider: 'p', model: 'm' }
  const resolveWith = modalities => ({
    llm: { resolveModelInfo: async () => ({ provider: 'p', id: 'm', name: 'm', inputModalities: modalities }) },
  })

  const empty = await checkImageCapability(resolveWith([]), route)
  assert.match(empty, /does not accept image/)
  assert.match(empty, /none/)
  assert.match(await checkImageCapability(resolveWith(['text']), route), /does not accept image/)
  assert.equal(await checkImageCapability(resolveWith(['text', 'image']), route), null)
  // Absent means unknown, not "no image".
  assert.equal(await checkImageCapability(resolveWith(undefined), route), null)

  const broken = {
    llm: {
      resolveModelInfo: async () => {
        throw new Error('nope')
      },
    },
  }
  assert.match(await checkImageCapability(broken, route), /cannot resolve/)
})

let passed = 0
for (const { name, body } of queue) {
  try {
    await body()
    passed += 1
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    process.stdout.write(`FAIL ${name}\n     ${error.message}\n`)
    process.exitCode = 1
  }
}

process.stdout.write(process.exitCode === 1 ? '\nMODEL LAYER FAILED\n' : `\nMODEL LAYER OK (${passed} tests)\n`)
