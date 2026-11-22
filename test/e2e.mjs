/**
 * dsh-pdf2epub end-to-end harness.
 *
 * Runs the real pipeline (`src/pipeline.js`) against a fake Host: no provider
 * API, no DSH runtime, no network. Seven scenarios cover the happy path,
 * cross-review of a page that fails a sentinel, fail-fast on a text-only model,
 * cache reuse, structured table/list blocks, a failed page staying out of the
 * page cache, and the cache key including the render settings.
 *
 *   node test/e2e.mjs
 *
 * Artifacts land in `.out/e2e/`; the process exits 1 when any scenario fails.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { strFromU8, unzipSync } from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.out')
const E2E_DIR = path.join(OUT, 'e2e')
const LONG_PDF = path.join(OUT, 'test-long.pdf')
const SHORT_PDF = path.join(OUT, 'test.pdf')
/** Built by this harness (single-page fixtures come from src/pdf/smoke.mjs). */
const TWO_PAGE_PDF = path.join(OUT, 'test-two-pages.pdf')
const PIPELINE = path.join(ROOT, 'src', 'pipeline.js')

const PRIMARY = 'fake/model'
const REVIEW_MODELS = ['fake/a', 'fake/b']

/**
 * Root cause shared by the token checks in (a) and (b), kept as a regression
 * hint: the page ledger must reach `runConversion`. `transcribeOnce()` has to
 * record spend into the ledger it is handed, and `transcribePage()` has to fold
 * every call's ledger into the page's own one.
 */
const LEDGER_CAUSE =
  '回归提示：transcribeOnce() 必须把花费记进调用方传入的 ledger，transcribePage() 再把各次调用的 ledger 合进本页 ledger；' +
  '否则 runConversion 合到的永远是 0，report.tokens 全为 0'

/** A page that fails a sentinel is retried — the retry call must carry `prompt`. */
const RETRY_CAUSE =
  '回归提示：重试调用必须传 prompt（transcribeOnce 会用 prompt.user + retryNote）；漏传会让任何哨兵不通过的页直接抛 TypeError'

/**
 * A cache hit spends nothing in this run. The entry's historical ledger belongs
 * to `reused`, never to the run's own `ledger`: folding it back makes a fully
 * cached rerun report the first run's bill a second time.
 */
const REUSE_CAUSE =
  '回归提示：命中缓存的分支应 mergeLedger(reused, cached.ledger)，而不是 mergeLedger(ledger, cached.ledger)；' +
  '否则第二次全命中缓存的重跑会把第一次的账再报一遍，report.tokens.calls/input 不为 0'

/** `extractPageText()` only returns `{ text, blockCount }`; `hasText` lives on `extractPageTextDetailed()`. */
const HASTEXT_CAUSE =
  '回归提示：baseline 必须用 extractPageTextDetailed()（或等价方式）拿到 hasText；extractPageText() 不返回该字段，' +
  '会让「有文本层」的页被判成扫描页，needsCrossReview 与 source 都跟着错'

/**
 * A page that produced no book text must not enter the resume cache. A cache hit
 * is replayed as an answer, so caching a 429 turns one failure into a permanent
 * hole in the book: later runs call no model, yet the job reports completion.
 */
const POISON_CAUSE =
  '回归提示：只有 pageHasBookText(page) 为真才写缓存（blocks 非空、没有 error、至少一个非页眉/页脚正文块），' +
  'readCache 也必须拒绝 blocks 为空/带 error 的条目并删除它；否则一次 429 或取消会被缓存成永久缺页：' +
  '后续运行模型零调用、作业却显示完成'

/** The cache key must cover the input file and the render settings, not just page number + model. */
const SETTINGS_CAUSE =
  '回归提示：页缓存目录要同时带输入指纹（路径 + 大小 + mtime）与设置指纹（dpi + 主模型）；' +
  '只按页号和模型名分目录，会让改 dpi、换提示词版本或换书之后错误复用旧页'

const state = { checks: 0, failures: [], notes: [], epubs: [], happy: null }
let pipeline = null

/* ------------------------------------------------------------------ *
 * fake Host
 * ------------------------------------------------------------------ */

/**
 * Build a Host double implementing exactly the three seams the pipeline uses.
 *
 * @param {{ textOnly?: boolean, gateNoise?: boolean, tableAndList?: boolean, failPages?: number[] }} [options] -
 *   `textOnly` makes `resolveModelInfo` advertise text-only input; `gateNoise`
 *   puts a control character in every page footer, a real sentinel hit;
 *   `tableAndList` adds a one-column pipe table and a three-item list to the
 *   page; `failPages` makes exactly those 1-based pages fail with a 429 the way
 *   a real provider does, by finishing the stream with an `error` reason.
 * @returns {object} a Host context plus `__stats` counters (`pages` is the
 *   1-based page number of every call, in call order).
 */
function createFakeHost(options = {}) {
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, imageSaves: 0, resolves: 0, routes: [], pages: [] }
  const failing = new Set(Array.isArray(options.failPages) ? options.failPages : [])

  return {
    __stats: stats,

    llm: {
      async resolveModelInfo(provider, model) {
        stats.resolves += 1
        stats.routes.push(`${provider}/${model}`)
        if (options.textOnly === true) return { inputModalities: ['text'] }
        return { inputModalities: ['text', 'image'] }
      },

      /** Async generator: `callModel()` only ever iterates the returned value. */
      async *stream(request) {
        const page = pageNumberFrom(request)
        const model = String(request.model ?? '')
        stats.calls += 1
        stats.pages.push(page)
        stats.routes.push(`${request.provider}/${model}`)

        // A failed call is `finish.reason.kind === 'error'`, with the failure at
        // `reason.failure` — exactly what the Host's stream contract delivers for
        // a 429 (`collectStream()` turns it into `error`). No text, no usage.
        if (failing.has(page)) {
          yield { kind: 'finish', reason: { kind: 'error', failure: { code: 429, message: `429 Too Many Requests (page ${page})` } } }
          return
        }

        const blocks = [
          { type: 'h2', text: `第${page}章` },
          { type: 'p', text: bodyFor(page, model), continues: false },
          ...(options.tableAndList === true ? layoutBlocks() : []),
          { type: 'footer', text: `页脚${page}${options.gateNoise === true ? '\u0007' : ''}` },
        ]
        const json = JSON.stringify({ blocks })
        const inputTokens = 1000 + page * 10
        const outputTokens = 40 + json.length

        stats.inputTokens += inputTokens
        stats.outputTokens += outputTokens

        yield { kind: 'block-start' }
        for (const chunk of splitInto(json, 3)) yield { kind: 'text-delta', text: chunk }
        yield { kind: 'usage', usage: { inputTokens, outputTokens } }
        yield { kind: 'finish' }
      },
    },

    attachments: {
      async saveImage(input) {
        if (!(input?.data instanceof Uint8Array)) {
          throw new Error('fake host: saveImage input.data must be a Uint8Array')
        }
        if (![0x89, 0x50, 0x4e, 0x47].every((byte, index) => input.data[index] === byte)) {
          throw new Error('fake host: saveImage input.data must start with the PNG magic')
        }
        // The attachment seam only carries bytes; intrinsic size comes from IHDR.
        const size = pngSize(input.data)
        if (size === null) throw new Error('fake host: saveImage input.data has no readable IHDR')
        stats.imageSaves += 1
        return {
          id: 'img',
          mediaType: 'image/png',
          width: Number.isInteger(input.width) ? input.width : size.width,
          height: Number.isInteger(input.height) ? input.height : size.height,
        }
      },
    },
  }
}

/** Three deliberately different body lengths, keyed by the model id. */
function bodyFor(page, model) {
  const base = `这是第${page}页的正文。<p>`
  if (model === 'a') return `${base}复核模型 A 补充了更长的一段文字，用来制造明显的长度差异。`
  if (model === 'b') return `第${page}页。`
  return base
}

/**
 * Blocks whose source is multi-line Markdown. A pipe table and a bullet list
 * only survive as real structures if `normalizeBlock()` keeps their newlines;
 * collapse them into one line and the table loses `<tbody>`/`<td>` and the list
 * becomes a single `<li>`.
 */
function layoutBlocks() {
  return [
    { type: 'table', text: '| 词语 |\n| --- |\n| 甲 |' },
    { type: 'list', text: '- 第一项\n- 第二项\n- 第三项' },
  ]
}

/** Concatenate the text parts of the last user turn. */
function userText(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const user = [...messages].reverse().find(message => message?.role === 'user')
  const parts = Array.isArray(user?.content) ? user.content : []
  return parts.filter(part => part?.type === 'text').map(part => part.text).join('\n')
}

/** Read the page number the prompt announces as 「第 N 页」. */
function pageNumberFrom(request) {
  const match = /第\s*(\d+)\s*页/.exec(userText(request))
  return match === null ? 1 : Number(match[1])
}

/** Split a string into `count` non-empty chunks, preserving order. */
function splitInto(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count))
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

/** Read width/height from a PNG's IHDR chunk (signature 8 bytes, then IHDR). */
function pngSize(bytes) {
  if (bytes.length < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

/**
 * Build a valid multi-page PDF by hand (Helvetica, one text line per line of the
 * per-page arrays), with a correctly computed xref table.
 *
 * The fixtures in `.out/` that `src/pdf/smoke.mjs` writes are single-page, and
 * the cache scenarios need a document where one page can fail while the rest of
 * the book still succeeds. Hand-building it keeps the harness offline and
 * dependency-free, exactly like the smoke fixture it is modelled on.
 *
 * @param {string[][]} linesPerPage - text lines for each page, in order.
 * @returns {Buffer} the PDF bytes.
 */
function buildMultiPagePdf(linesPerPage) {
  const pdfString = (s) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
  // Object numbering: 1 catalog, 2 page tree, 3 font, then page/content pairs.
  const fontObject = 3
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${linesPerPage.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${linesPerPage.length} >>`],
    [fontObject, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
  ])
  linesPerPage.forEach((lines, index) => {
    const pageObject = 4 + index * 2
    const contentObject = pageObject + 1
    const content = lines
      .map((line, row) => `BT /F1 24 Tf 72 ${700 - row * 40} Td ${pdfString(line)} Tj ET`)
      .join('\n')
      .concat('\n')
    objects.set(pageObject, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] '
      + `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`)
    objects.set(contentObject, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`)
  })

  const total = objects.size
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  let offset = parts[0].length
  const offsets = new Array(total + 1).fill(0)
  for (let number = 1; number <= total; number += 1) {
    const body = Buffer.from(`${number} 0 obj\n${objects.get(number)}\nendobj\n`, 'latin1')
    offsets[number] = offset
    parts.push(body)
    offset += body.length
  }
  const xrefOffset = offset
  // Every xref entry is exactly 20 bytes: 10 offset + space + 5 gen + space + type + CRLF.
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f\r\n`
  for (let number = 1; number <= total; number += 1) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n\r\n`
  }
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

/* ------------------------------------------------------------------ *
 * pipeline loading (with a minimal, documented load-time repair)
 * ------------------------------------------------------------------ */

/**
 * Import the real pipeline exactly the way a Host would.
 *
 * No patching, no data: URL, no shim: if `src/pipeline.js` cannot be imported
 * this run fails loudly, which is itself the first thing worth knowing.
 *
 * @returns {Promise<object>} the pipeline module.
 */
async function loadPipeline() {
  return import(pathToFileURL(PIPELINE).href)
}

/** Count non-overlapping occurrences of a literal needle. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1
}

/* ------------------------------------------------------------------ *
 * assertions and output
 * ------------------------------------------------------------------ */

/** Record a failure and keep the scenario running, so one root cause cannot hide the rest. */
function recordFailure(label, detail, options = {}) {
  state.checks += 1
  state.failures.push({ label, detail, cause: options.cause })
  return false
}

function expect(label, actual, expected, options = {}) {
  if (isDeepStrictEqual(actual, expected)) {
    state.checks += 1
    return true
  }
  return recordFailure(label, `期望 ${show(expected)}，实际 ${show(actual)}`, options)
}

function expectTrue(label, condition, options = {}) {
  if (condition === true) {
    state.checks += 1
    return true
  }
  return recordFailure(label, options.detail ?? '条件为假', options)
}

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Uint8Array) return `<${value.length} bytes>`
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function shorten(text, limit = 160) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, limit)
}

/** The rendered table markup, for failure messages (empty when nothing rendered). */
function tableSnippet(chapter) {
  const start = chapter.indexOf('<table>')
  if (start === -1) return '没有 <table>'
  const end = chapter.indexOf('</table>', start)
  return shorten(`<table>…${chapter.slice(start, end === -1 ? start + 120 : end)}`)
}

function note(text) {
  state.notes.push(text)
}

function drainNotes() {
  const lines = state.notes.slice()
  state.notes.length = 0
  return lines
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * Every file named `name` under `root`, at any depth.
 *
 * The page cache directory name is the pipeline's business (input fingerprint +
 * settings fingerprint), so the scenarios assert on the cache file name inside
 * whatever directory the pipeline chose instead of hard-coding its layout. A
 * missing directory is not an error: it simply proves no cache file exists.
 */
async function findFilesNamed(root, name) {
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name === name) found.push(full)
    }
  }
  await walk(root)
  return found.sort()
}

function relativeToRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function unzip(buffer) {
  return unzipSync(new Uint8Array(buffer))
}

/* ------------------------------------------------------------------ *
 * scenarios
 * ------------------------------------------------------------------ */

/** (a) One page, no reviewers: EPUB structure, XHTML escaping, furniture dropped, billing. */
async function scenarioHappyPath() {
  const host = createFakeHost()
  const progress = []
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: E2E_DIR },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
    onProgress: event => progress.push(event),
  })
  state.happy = { run, host, progress }
  state.epubs.push(run.epubPath)

  const epubThere = await isFile(run.epubPath)
  const reportThere = await isFile(run.reportPath)
  expectTrue('epubPath 与 reportPath 都存在', epubThere && reportThere,
    { detail: `${relativeToRoot(run.epubPath)}=${epubThere}, ${relativeToRoot(run.reportPath)}=${reportThere}` })
  expect('产物落在 .out/e2e', path.dirname(run.epubPath), E2E_DIR)

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries)
  expectTrue('fflate 能解开 EPUB', names.length > 0, { detail: `entries = ${names.length}` })
  expectTrue('EPUB 含 mimetype', names.includes('mimetype'), { detail: names.join(', ') })
  expectTrue('EPUB 含 OEBPS/text/ch001.xhtml', names.includes('OEBPS/text/ch001.xhtml'), { detail: names.join(', ') })

  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('ch001.xhtml 含「第1章」', chapter.includes('第1章'))
  expectTrue('正文里的 <p> 字面量已转义为 &lt;p&gt;', chapter.includes('&lt;p&gt;'))
  expectTrue('ch001.xhtml 不含未转义的「正文。<p>」', !chapter.includes('正文。<p>'))

  const report = JSON.parse(await readFile(run.reportPath, 'utf8'))
  expect('report.schema', report.schema, 'dsh-pdf2epub/report@1')
  expectTrue('report.stats.blocks > 0', report.stats.blocks > 0, { detail: `blocks = ${report.stats.blocks}` })
  expectTrue('report.stats.blocksDropped >= 1（页脚被丢）', report.stats.blocksDropped >= 1,
    { detail: `blocksDropped = ${report.stats.blocksDropped}` })
  expect('report.stats.chapters', report.stats.chapters, 1)
  expectTrue('report.tokens.input > 0', report.tokens.input > 0, {
    detail: `report.tokens.input = ${report.tokens.input}，但宿主实际计费 inputTokens = ${host.__stats.inputTokens}`,
    cause: LEDGER_CAUSE,
  })
  expectTrue('report.stats.pagesFromTextLayer >= 1（该 PDF 有真实文本层）', report.stats.pagesFromTextLayer >= 1, {
    detail: `pagesFromTextLayer = ${report.stats.pagesFromTextLayer}`,
    cause: HASTEXT_CAUSE,
  })
  expect('report.pages[0].source 为 vlm+text-layer', report.pages[0].source, 'vlm+text-layer', { cause: HASTEXT_CAUSE })
  expect('主模型只调用 1 次（无复核）', host.__stats.calls, 1)
  expect('页图以 PNG 交给宿主 1 次', host.__stats.imageSaves, 1)

  return `epub ${names.length} entries | blocks ${report.stats.blocks} | dropped ${report.stats.blocksDropped} | host calls ${host.__stats.calls} | report tokens ${report.tokens.input}`
}

/** (b) A page that trips the control-character sentinel must be retried, cross-reviewed, and still assemble. */
async function scenarioCrossReview() {
  const host = createFakeHost({ gateNoise: true })
  let run = null
  let crash = null
  try {
    run = await pipeline.runConversion({
      host,
      spec: { input: LONG_PDF, outputDir: path.join(E2E_DIR, 'review') },
      config: { primaryModel: PRIMARY, reviewModels: REVIEW_MODELS, dpi: 100, concurrency: 2 },
    })
  } catch (error) {
    crash = error
  }

  const survived = expectTrue('哨兵不通过的页不应让整次转换抛错', crash === null, {
    detail: crash === null ? '' : `${crash.name}: ${crash.message}`,
    cause: RETRY_CAUSE,
  })
  if (!survived) return '转换在重试阶段中止，复核相关断言无法求值'

  state.epubs.push(run.epubPath)
  const page = run.report.pages[0]
  expect('report.pages[0].reviewed === true', page.reviewed, true)
  expect('该页三个模型都参与了', page.models, ['fake/model', 'fake/a', 'fake/b'])
  expect('report.pages[0].degraded 是布尔值', typeof page.degraded, 'boolean')
  expectTrue('该页确实触发过哨兵（控制字符）', page.issues.some(issue => issue.includes('control characters')),
    { detail: `issues = ${JSON.stringify(page.issues)}` })
  expectTrue('report.tokens.calls >= 3', run.report.tokens.calls >= 3, {
    detail: `report.tokens.calls = ${run.report.tokens.calls}，但宿主实际调用 ${host.__stats.calls} 次`,
    cause: LEDGER_CAUSE,
  })
  expectTrue('report.tokens.input > 0', run.report.tokens.input > 0,
    { detail: `report.tokens.input = ${run.report.tokens.input}`, cause: LEDGER_CAUSE })
  expectTrue('report.tokens.output > 0', run.report.tokens.output > 0,
    { detail: `report.tokens.output = ${run.report.tokens.output}`, cause: LEDGER_CAUSE })
  expectTrue('宿主实际调用 >= 3 次', host.__stats.calls >= 3, { detail: `host calls = ${host.__stats.calls}` })
  expect('report.stats.pagesCrossReviewed', run.report.stats.pagesCrossReviewed, 1)
  expectTrue('复核后仍产出可读正文（不抛错）', run.report.stats.chapters >= 1 && run.report.stats.blocks > 0,
    { detail: `chapters = ${run.report.stats.chapters}, blocks = ${run.report.stats.blocks}` })

  return `reviewed=${page.reviewed} degraded=${page.degraded} agreement=${page.agreement} | host calls ${host.__stats.calls}`
}

/** (e) Multi-line Markdown blocks must build real XHTML table/list structures. */
async function scenarioTableAndList() {
  const host = createFakeHost({ tableAndList: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: path.join(E2E_DIR, 'blocks') },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  state.epubs.push(run.epubPath)

  const entries = unzip(await readFile(run.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  const td = countOf(chapter, '<td>')
  const th = countOf(chapter, '<th>')
  const li = countOf(chapter, '<li>')

  expectTrue('章节里有 <table>', chapter.includes('<table>'))
  expectTrue('表格有 <tbody>（数据行没被当成表头）', chapter.includes('<tbody>'),
    { detail: tableSnippet(chapter) })
  expect('数据行 <td> 数量', td, 1)
  expect('表头 <th> 数量', th, 1)
  expectTrue('列表 <li> 数量', li === 3, { detail: `li = ${li}` })
  expectTrue('表格分隔行没有残留成单元格', !chapter.includes('---'))
  expectTrue('列表项文字都在', chapter.includes('第三项'))

  return `td=${td} th=${th} li=${li} tbody=${chapter.includes('<tbody>')} | host calls ${host.__stats.calls}`
}

/** (c) A route that cannot read images must fail before any model call. */
async function scenarioTextOnly() {
  const host = createFakeHost({ textOnly: true })
  let error = null
  try {
    await pipeline.runConversion({
      host,
      spec: { input: SHORT_PDF, outputDir: path.join(E2E_DIR, 'text-only') },
      config: { primaryModel: PRIMARY, reviewModels: [] },
    })
  } catch (caught) {
    error = caught
  }
  const rejected = expectTrue('runConversion 被 reject', error !== null, { detail: '返回成功而不是抛错' })
  if (!rejected) return '没有错误可检查'
  expectTrue('错误信息含 image', /image/i.test(error.message), { detail: `message = ${error.message}` })
  expect('拒绝前没有发起模型调用', host.__stats.calls, 0)
  return `rejected: ${error.message}`
}

/**
 * (d) Re-running the exact same arguments must be served from the page cache,
 * and a cache hit must cost nothing: the rerun's own ledger stays at zero while
 * the historical spend is visible under `reused`, and the EPUB it rebuilds is
 * byte-identical to the first one.
 */
async function scenarioCacheReuse() {
  if (state.happy === null) {
    return expectTrue('场景 (a) 产出了可比较的 run', false, { detail: 'runConversion 在 (a) 里就失败了' }) ? '' : '跳过'
  }
  const first = state.happy
  // Snapshot the first EPUB *before* the rerun writes the same output path:
  // reading both paths afterwards compares the file with itself and passes for
  // any content.
  const firstEpub = await readFile(first.run.epubPath)
  const host = createFakeHost()
  const progress = []
  const second = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: E2E_DIR },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
    onProgress: event => progress.push(event),
  })

  const cached = progress.filter(event => event.phase === 'page' && event.status === 'cached')
  expect('第二次运行零模型调用', host.__stats.calls, 0)
  expectTrue('onProgress 出现 status:"cached"', cached.length >= 1,
    { detail: progress.map(event => `${event.phase}:${event.status ?? ''}`).join(' -> ') })
  expect('全部页命中缓存', cached.length, second.report.book.pages)

  // 1. 本次没花：命中缓存不得把该页历史 ledger 并进本次账本。
  expect('第二次 report.tokens.calls === 0', second.report.tokens.calls, 0, { cause: REUSE_CAUSE })
  expect('第二次 report.tokens.input === 0', second.report.tokens.input, 0, { cause: REUSE_CAUSE })
  // 2. 复用可见：历史花费记在 reused 里，而不是凭空消失。
  expectTrue('第二次 report.tokens.reused.input > 0', second.report.tokens.reused.input > 0, {
    detail: `reused = ${show(second.report.tokens.reused)}`,
    cause: REUSE_CAUSE,
  })
  expect('第一次 report.tokens.reused.calls === 0（首跑没有复用）', first.run.report.tokens.reused.calls, 0)
  expectTrue('第一次 report.tokens.byPage 每页 cached:false', first.run.report.tokens.byPage.every(entry => entry.cached === false),
    { detail: show(first.run.report.tokens.byPage) })
  expectTrue('第二次 report.tokens.byPage 每页 cached:true', second.report.tokens.byPage.every(entry => entry.cached === true),
    { detail: show(second.report.tokens.byPage) })
  // 返回值与 report 同一口径：同一份 tokens 既随 report 落盘，也直接返回。
  expect('返回值 tokens.input 与 report 一致（首跑）', first.run.tokens?.input, first.run.report.tokens.input)
  expectTrue('返回值 tokens.reused.input > 0（第二次）', (second.tokens?.reused?.input ?? 0) > 0,
    { detail: `second.tokens = ${show(second.tokens)}`, cause: REUSE_CAUSE })

  // 3. 宿主调用 1 -> 0，且重建出的 EPUB 与首跑逐字节一致。
  expect('宿主模型调用次数 1 -> 0', [first.host.__stats.calls, host.__stats.calls], [1, 0])
  const after = await readFile(second.epubPath)
  expectTrue('缓存重建的 EPUB 与首次逐字节一致', firstEpub.equals(after),
    { detail: `${firstEpub.length} vs ${after.length} bytes` })

  return `cached events ${cached.length} | model calls ${first.host.__stats.calls} -> ${host.__stats.calls} | ` +
    `report calls/input ${second.report.tokens.calls}/${second.report.tokens.input} | reused input ${second.report.tokens.reused.input}`
}

/**
 * (f) 失败页不污染缓存.
 *
 * A page that produced no text (here: its model call always ends in a 429) must
 * not be written to the resume cache. If it were, every later run would replay
 * the empty entry: no model call, a `completed` job, and one permanently blank
 * page. The test drives that exact sequence on a real two-page PDF: fail page 1,
 * then swap in a healthy fake Host on the same `outputDir` without `force` and
 * require that page 1 is really transcribed while page 2 is still cached.
 */
async function scenarioFailedPageNotCached() {
  await mkdir(OUT, { recursive: true })
  await writeFile(TWO_PAGE_PDF, buildMultiPagePdf([
    ['Two-page fixture, page one.', 'Only plain ASCII on purpose.'],
    ['Two-page fixture, page two.', 'The second page must still transcribe.'],
  ]))
  const outDir = path.join(E2E_DIR, 'failed-page')

  // 1. Page 1 is a 429 on every attempt; page 2 succeeds.
  const broken = createFakeHost({ failPages: [1] })
  const first = await pipeline.runConversion({
    host: broken,
    spec: { input: TWO_PAGE_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  expect('失败页计入 report.stats.pagesFailed', first.report.stats.pagesFailed, 1, { cause: POISON_CAUSE })
  expect('返回值 pagesFailed 与 report 一致', first.pagesFailed, 1, { cause: POISON_CAUSE })
  expectTrue('第 1 页在 report.pages 里带着错误信息',
    typeof first.report.pages[0].error === 'string' && first.report.pages[0].error.includes('429'),
    { detail: `report.pages[0].error = ${show(first.report.pages[0].error)}`, cause: POISON_CAUSE })
  expect('第 2 页没有 error', first.report.pages[1].error, null)
  expectTrue('report.warnings 用一句人话说明缺页',
    first.report.warnings.some(line => line.includes('produced no text') && line.includes('page 1')),
    { detail: `report.warnings = ${show(first.report.warnings)}` })

  // The cache directory name is the pipeline's business, so look for the page
  // files by name: a page-1 entry here is exactly the poison this test forbids.
  const pageOneEntries = await findFilesNamed(outDir, '00001.json')
  const pageTwoEntries = await findFilesNamed(outDir, '00002.json')
  expect('缓存目录里没有第 1 页的文件', pageOneEntries.length, 0,
    { detail: pageOneEntries.map(relativeToRoot).join(', '), cause: POISON_CAUSE })
  expectTrue('成功的第 2 页照常写入缓存', pageTwoEntries.length === 1,
    { detail: pageTwoEntries.map(relativeToRoot).join(', ') || '没有找到 00002.json' })

  // 2. Same outputDir, healthy Host, no `force`: only page 1 may cost a call.
  const good = createFakeHost()
  const second = await pipeline.runConversion({
    host: good,
    spec: { input: TWO_PAGE_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  expectTrue('重跑时第 1 页真的调用了模型', good.__stats.calls >= 1,
    { detail: `host calls = ${good.__stats.calls}`, cause: POISON_CAUSE })
  expectTrue('重跑只请求第 1 页（第 2 页仍命中缓存）',
    good.__stats.pages.length > 0 && good.__stats.pages.every(page => page === 1),
    { detail: `请求过/重试过的页 = ${show(good.__stats.pages)}`, cause: POISON_CAUSE })
  expect('重跑后没有失败页', second.report.stats.pagesFailed, 0, { cause: POISON_CAUSE })
  expectTrue('重跑产物里第 1 页内容非空',
    second.report.pages[0].chars > 0 && second.report.pages[0].error === null,
    { detail: `report.pages[0] = ${show(second.report.pages[0])}`, cause: POISON_CAUSE })
  expect('重跑后没有缺页警告', second.report.warnings, [])
  const entries = unzip(await readFile(second.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('重跑后的 EPUB 含第 1 页正文', chapter.includes('这是第1页的正文'),
    { detail: shorten(chapter), cause: POISON_CAUSE })
  note(`失败页报告：stats.pagesFailed=${first.report.stats.pagesFailed}，`
    + `pages[0].error=${JSON.stringify(first.report.pages[0].error)}，`
    + `warnings=${JSON.stringify(first.report.warnings)}`)

  // 3. The self-healing half: an entry written by an older build ("blocks: []")
  //    must be treated as a miss, deleted, and rewritten - never replayed. That
  //    is what stops a cache poisoned before this fix from poisoning every run
  //    after it.
  const [pageOneFile] = await findFilesNamed(outDir, '00001.json')
  const poisoned = JSON.parse(await readFile(pageOneFile, 'utf8'))
  poisoned.page = { ...poisoned.page, blocks: [], error: '429 Too Many Requests (page 1)' }
  await writeFile(pageOneFile, JSON.stringify(poisoned))

  const healing = createFakeHost()
  const third = await pipeline.runConversion({
    host: healing,
    spec: { input: TWO_PAGE_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  expectTrue('读到毒缓存时第 1 页被重新转录', healing.__stats.pages.includes(1),
    { detail: `请求过的页 = ${show(healing.__stats.pages)}`, cause: POISON_CAUSE })
  const healed = JSON.parse(await readFile(pageOneFile, 'utf8'))
  expectTrue('毒缓存被重写成有内容的条目',
    Array.isArray(healed.page?.blocks) && healed.page.blocks.length > 0 && healed.page.error === null,
    { detail: `重写后的条目 = ${show(healed.page)}`, cause: POISON_CAUSE })
  expectTrue('毒缓存修复后第 1 页进入产物', third.report.pages[0].chars > 0,
    { detail: `report.pages[0].chars = ${third.report.pages[0].chars}`, cause: POISON_CAUSE })

  return `failed pages ${first.report.stats.pagesFailed} -> ${second.report.stats.pagesFailed} | ` +
    `cache page1=${pageOneEntries.length} page2=${pageTwoEntries.length} | ` +
    `rerun calls ${good.__stats.calls} for pages ${good.__stats.pages.join(',') || 'none'} | ` +
    `healed calls ${healing.__stats.calls} for pages ${healing.__stats.pages.join(',') || 'none'}`
}

/**
 * (g) 缓存键包含设置.
 *
 * The page cache must be keyed by the settings that produced the page, not only
 * by the page number and the model name. Same PDF, same outputDir: `dpi: 100`
 * then `dpi: 120` must not reuse the first run's pages, and going back to
 * `dpi: 100` must hit again for free.
 */
async function scenarioCacheKeyIncludesSettings() {
  const outDir = path.join(E2E_DIR, 'settings-key')
  const run = (host, dpi) => pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi, concurrency: 2 },
  })

  const at100 = createFakeHost()
  await run(at100, 100)
  expect('dpi 100 首跑调用模型 1 次', at100.__stats.calls, 1)

  const at120 = createFakeHost()
  await run(at120, 120)
  expectTrue('改 dpi 后没有命中旧缓存（模型调用 > 0）', at120.__stats.calls > 0,
    { detail: `host calls = ${at120.__stats.calls}`, cause: SETTINGS_CAUSE })

  const backTo100 = createFakeHost()
  await run(backTo100, 100)
  expect('回到 dpi 100 命中缓存（模型调用 0）', backTo100.__stats.calls, 0, { cause: SETTINGS_CAUSE })

  // Two settings namespaces under the same outputDir, one page entry each, is
  // the on-disk proof that the key really contains the DPI.
  const pageOneEntries = await findFilesNamed(outDir, '00001.json')
  expect('缓存按设置分成两个命名空间', pageOneEntries.length, 2,
    { detail: pageOneEntries.map(relativeToRoot).join(', '), cause: SETTINGS_CAUSE })

  return `model calls 100/120/100 = ${at100.__stats.calls}/${at120.__stats.calls}/${backTo100.__stats.calls} | ` +
    `page-1 cache entries ${pageOneEntries.length}`
}

/* ------------------------------------------------------------------ *
 * runner
 * ------------------------------------------------------------------ */

const SCENARIOS = [
  ['(a) happy path', scenarioHappyPath],
  ['(b) 坏页走交叉复核', scenarioCrossReview],
  ['(c) 模型不吃图快速失败', scenarioTextOnly],
  ['(d) 缓存可复用', scenarioCacheReuse],
  ['(e) 表格与列表保住结构', scenarioTableAndList],
  ['(f) 失败页不污染缓存', scenarioFailedPageNotCached],
  ['(g) 缓存键包含设置', scenarioCacheKeyIncludesSettings],
]

async function main() {
  for (const file of [LONG_PDF, SHORT_PDF]) {
    if (await isFile(file)) continue
    console.log(`FAIL - 缺少样例 PDF ${relativeToRoot(file)}；先运行 node src/pdf/smoke.mjs 生成`)
    process.exitCode = 1
    return
  }

  await rm(E2E_DIR, { recursive: true, force: true })
  await mkdir(E2E_DIR, { recursive: true })

  pipeline = await loadPipeline()
  const source = await readFile(PIPELINE, 'utf8')
  console.log(`note - 被测 src/pipeline.js @ ${createHash('sha256').update(source).digest('hex').slice(0, 12)}（${source.length} bytes）`)

  const outcomes = []
  for (const [name, body] of SCENARIOS) {
    state.failures = []
    let evidence = null
    try {
      evidence = await body()
    } catch (error) {
      recordFailure('场景内未捕获异常', `${error.name ?? 'Error'}: ${error.message}`, { cause: error.cause })
    }

    const failures = state.failures
    const ok = failures.length === 0
    outcomes.push({ name, ok })

    if (ok) {
      console.log(`ok - ${name}`)
    } else {
      process.exitCode = 1
      console.log(`FAIL - ${name}`)
      for (const entry of failures) {
        console.log(`     ${entry.label === undefined ? '' : `${entry.label}：`}${entry.detail}`)
        if (entry.cause !== undefined) console.log(`     cause：${entry.cause}`)
      }
    }
    if (evidence !== null) console.log(`     ${ok ? '' : 'evidence：'}${evidence}`)
    for (const line of drainNotes()) console.log(`     note：${line}`)
  }

  await listArtifacts()

  const failed = outcomes.filter(outcome => outcome.ok !== true)
  console.log('')
  console.log(`${outcomes.length} scenarios | ${state.checks} checks | ${failed.length} failed`)
  if (failed.length > 0) console.log(`failed：${failed.map(outcome => outcome.name).join('、')}`)
  console.log(failed.length === 0 ? 'E2E OK' : 'E2E FAILED')
}

/** Unzip every produced EPUB once more and report its entry count. */
async function listArtifacts() {
  console.log('artifacts：')
  const paths = [...state.epubs]
  if (paths.length === 0) paths.push(path.join(E2E_DIR, 'test-long.epub'))
  for (const epubPath of new Set(paths)) {
    if (!(await isFile(epubPath))) {
      console.log(`     ${relativeToRoot(epubPath)} -> missing`)
      continue
    }
    const names = Object.keys(unzip(await readFile(epubPath)))
    const chapterCount = names.filter(name => name.startsWith('OEBPS/text/')).length
    console.log(`     ${relativeToRoot(epubPath)} -> ${names.length} entries（${chapterCount} 个 XHTML 文档）`)
  }
  const reportPath = path.join(E2E_DIR, 'test-long.report.json')
  if (await isFile(reportPath)) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    console.log(`     ${relativeToRoot(reportPath)} -> ${report.stats.chapters} chapter(s)`)
  }
}

try {
  await main()
} catch (error) {
  process.exitCode = 1
  console.log(`FAIL - harness\n     ${error?.stack ?? error}`)
  console.log('E2E FAILED')
}
