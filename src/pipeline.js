/**
 * The conversion pipeline: render each page, transcribe it with a vision model,
 * run the page sentinels, cross-review the weak pages with additional models,
 * then assemble a reflowable EPUB 3 with a machine-readable report.
 *
 * Pages are independent, so the pool is embarrassingly parallel and every page
 * that produced book text is cached on disk: an interrupted run resumes where it
 * stopped. The cache is keyed by the input file and the settings that produced
 * the page, and a page that failed, was cancelled or came back empty is never
 * written: a poisoned entry would be replayed as an answer on every later run,
 * leaving the book silently short a page.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { buildEpub } from './epub/build.js'
import { openPdf } from './pdf/index.js'
import { DROP_TYPES, parsePageJson, plainBlock, countableCharacters } from './model/blocks.js'
import { transcriptionPrompt, retryNote } from './model/prompt.js'
import { checkPage, needsCrossReview, resolvePageRecord } from './model/gate.js'
import { buildChapters, flattenPages, renderChapterHtml, stripIllegalXml } from './model/assemble.js'
import { addUsage, emptyLedger, estimateTokens, mergeLedger, normalizeUsage } from './model/usage.js'
import { callModel, checkImageCapability, imageBlock, parseRoute } from './host/bridge.js'

/**
 * Bumped whenever the prompt or the block schema changes, to invalidate caches.
 * 2: table and list blocks keep their rows, and the page record carries the
 * finish kind and the sent image size, so every page-2 cache entry is stale.
 */
export const PROMPT_VERSION = 2

/** Hard ceiling on pages, so a mis-specified input cannot run forever. */
const MAX_PAGES = 5000

/**
 * Highest render DPI that can still reach the model.
 *
 * The attachment store normalises an image to at most 2048×2048 pixels and the
 * provider's vision budget projects one page to roughly 1092×1540 pixels, so an
 * A4 page rendered above ~150 DPI is downsampled back to the same visible
 * resolution: the extra DPI only costs render time and upload bytes.
 */
const MAX_EFFECTIVE_DPI = 150

/**
 * Run one conversion.
 *
 * @param {object} options - run inputs.
 * @param {object} options.host - Host context (llm, attachments, fs).
 * @param {object} options.spec - user request.
 * @param {object} options.config - plugin configuration.
 * @param {(event: object) => void} [options.onProgress] - progress sink.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<object>} `{ epubPath, reportPath, bookJsonPath, report, tokens, pagesFailed }`,
 *   where `tokens` is this run's own spend with the cache-reused spend under
 *   `reused`, and `pagesFailed` counts the pages that produced no book text.
 */
export async function runConversion(options) {
  const { host, spec, config, onProgress, signal } = options
  const emit = (event) => { onProgress?.({ at: Date.now(), ...event }) }
  const startedAt = Date.now()

  const inputPath = path.resolve(spec.input)
  const info = await stat(inputPath).catch(() => null)
  if (info === null || !info.isFile()) throw new Error(`PDF not found: ${inputPath}`)

  const outputDir = path.resolve(spec.outputDir ?? config.outputDir ?? path.dirname(inputPath))
  await mkdir(outputDir, { recursive: true })

  const primaryRoute = parseRoute(spec.model ?? config.primaryModel)
  const reviewRoutes = (spec.reviewModels ?? config.reviewModels ?? []).map(parseRoute)
  const allRoutes = [primaryRoute, ...reviewRoutes]

  for (const route of allRoutes) {
    const problem = await checkImageCapability(host, route, signal)
    if (problem !== null && route === primaryRoute) throw new Error(problem)
  }

  // `dpi` above the effective ceiling cannot change what the model sees (the
  // provider projection downsamples the page), so render at the ceiling and
  // report both numbers instead of pretending the knob keeps scaling. It is
  // resolved before the cache directory is built because it is part of the key.
  const requestedDpi = clamp(spec.dpi ?? config.dpi ?? 150, 72, 300)
  const dpi = Math.min(requestedDpi, MAX_EFFECTIVE_DPI)

  // Two fingerprints, because a cache hit must mean "the same file, read with the
  // same recipe", not merely "page N of some PDF in this directory": dropping a
  // different book at the same path or changing the DPI lands in a different page
  // directory, so it cannot reuse a page transcribed from another input or
  // another setting. (The prompt version is the third part of that key; it is
  // checked against the payload rather than the directory name - see
  // `settingsFingerprint()`.)
  const inputKey = inputFingerprint(inputPath, info)
  const settingsKey = settingsFingerprint(dpi, primaryRoute)
  // `bookId` stays a pure path hash on purpose: it seeds the EPUB identifier,
  // which should not move when the same book is re-edited at the same path.
  const bookId = createHash('sha256').update(inputPath).digest('hex').slice(0, 12)
  const workDir = path.join(outputDir, `.pdf2epub-${inputKey}`)
  const pageDir = path.join(workDir, 'pages', settingsKey)
  await mkdir(pageDir, { recursive: true })
  const cache = {
    dir: pageDir,
    inputKey,
    dpi,
    model: `${primaryRoute.provider}/${primaryRoute.model}`,
  }

  const pdf = await openPdf(inputPath)
  // Two ledgers, on purpose. `ledger` holds only what *this* run spent; `reused`
  // holds the historical spend of the pages a cache hit saved us from paying
  // again. Keeping them apart is the difference between billing a rerun
  // correctly and replaying the first run's bill.
  const ledger = emptyLedger()
  const reused = emptyLedger()
  // 1-based numbers of the pages served from the disk cache in this run, so the
  // report can flag them per page.
  const cachedPages = new Set()
  try {
    if (pdf.pageCount > MAX_PAGES) throw new Error(`document has ${pdf.pageCount} pages, above the ${MAX_PAGES} page ceiling`)
    const documentInfo = pdf.info()
    // PDF metadata reaches the OPF `dc:title` / `dc:creator` without passing any
    // page sentinel, so illegal XML code points are stripped here; a title that
    // cleans down to nothing falls back to the file name.
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const titleSource = spec.title ?? documentInfo.title
    const title = stripIllegalXml(titleSource ?? baseName).trim() || baseName
    const authorSource = spec.author ?? documentInfo.author
    const author = typeof authorSource === 'string' ? stripIllegalXml(authorSource) : undefined
    const language = spec.language ?? config.language ?? 'zh-CN'
    const maxTokens = clamp(spec.maxTokens ?? config.maxTokens ?? 4000, 512, 16000)
    const concurrency = clamp(spec.concurrency ?? config.concurrency ?? 4, 1, 16)
    const splitLevel = clamp(spec.splitLevel ?? config.splitLevel ?? 2, 1, 6)
    const force = spec.force === true

    emit({ phase: 'start', input: inputPath, pages: pdf.pageCount, outputDir })

    const furniture = new Set()
    const pages = new Array(pdf.pageCount)

    const transcribe = async (pageIndex, previousTail = null) => {
      if (signal?.aborted === true) throw new Error('cancelled')
      const cached = force ? null : await readCache(cache, pageIndex)
      if (cached !== null) {
        pages[pageIndex] = cached.page
        // Not `mergeLedger(ledger, cached.ledger)`: the entry's ledger describes
        // an earlier run. Folding it into the run's own ledger would make a fully
        // cached rerun report the first run's tokens as if they had been spent
        // again, so it goes to `reused` instead.
        mergeLedger(reused, cached.ledger)
        cachedPages.add(pageIndex + 1)
        // Re-seed the hint set from the cache, or a resumed run would transcribe
        // the remaining pages against fewer furniture hints than a single run.
        for (const hint of cached.furniture ?? []) furniture.add(hint)
        emit({ phase: 'page', page: pageIndex + 1, total: pdf.pageCount, status: 'cached' })
        return
      }
      const result = await transcribePage({
        host, pdf, pageIndex, totalPages: pdf.pageCount,
        primary: primaryRoute, reviews: reviewRoutes,
        dpi, maxTokens, furniture: [...furniture], previousTail, signal,
      })
      pages[pageIndex] = result.page
      mergeLedger(ledger, result.ledger)
      for (const hint of result.furniture) furniture.add(hint)
      // Only a page that actually produced book text may enter the resume cache.
      // A cache entry is replayed as if it were an answer, so caching a 429, a
      // cancellation or an empty reply freezes the failure into the run's state:
      // every later run would report `completed` while that page stays blank
      // forever (B1, the silent-page-loss bug). Writing nothing is the choice
      // made here - there is no stale file left to delete, and the next run
      // sees a miss and transcribes the page again. `pageHasBookText()` rejects
      // the three bad shapes: no blocks, a page carrying an `error`, and a page
      // that is nothing but furniture (which `flattenPages()` drops, so it would
      // still leave a hole in the book). A page still in flight when the run is
      // cancelled is retried even if what it had produced so far parsed, because
      // that text may be a truncated fragment.
      if (signal?.aborted !== true && pageHasBookText(result.page)) {
        await writeCache(cache, pageIndex, result)
      }
      emit({
        phase: 'page',
        page: pageIndex + 1,
        total: pdf.pageCount,
        status: result.page.degraded ? 'degraded' : result.page.reviewed ? 'reviewed' : 'ok',
        chars: result.page.chars,
        ms: result.page.ms,
        tokens: result.ledger.total,
      })
    }

    // The first pages run in order for two reasons: their page furniture seeds the
    // hint list the rest of the book is transcribed against, and each one can be
    // handed the real tail of the page before it, so the model's `continues` verdict
    // is a decision rather than a guess. Inside the pool "the previous page" is not
    // well defined — a neighbour may finish before or after its predecessor — so
    // pool pages get no tail at all; a guessed one would make the output depend on
    // completion order.
    const seedCount = Math.min(3, pdf.pageCount)
    for (let index = 0; index < seedCount; index += 1) {
      await transcribe(index, pageTail(pages[index - 1]))
    }
    await mapPool(range(seedCount, pdf.pageCount), concurrency, index => transcribe(index, null))

    if (signal?.aborted === true) throw new Error('cancelled')

    emit({ phase: 'assemble', pages: pdf.pageCount })
    const flattened = flattenPages(pages.filter(Boolean))
    const chapters = buildChapters(flattened.blocks, { splitLevel, fallbackTitle: title })
    // `buildChapters` always returns at least one chapter, so a zero-chapter
    // book cannot happen; a document with no book text at all is still a real
    // failure, and the message says which kind.
    if (flattened.blocks.length === 0) {
      const pagesWithBlocks = pages.filter(Boolean).filter(page => page.blocks.length > 0).length
      throw new Error(pagesWithBlocks === 0
        ? 'no book text produced: every page came back empty (image-only scan, or every model call failed)'
        : 'no book text produced: every block was page furniture')
    }

    const epubChapters = chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      level: chapter.level,
      html: renderChapterHtml(chapter),
    }))

    const epubBytes = buildEpub({
      title,
      language,
      author,
      identifier: `urn:uuid:${bookIdToUuid(bookId)}`,
      chapters: epubChapters,
    })

    const base = baseName
    const epubPath = path.join(outputDir, `${base}.epub`)
    const reportPath = path.join(outputDir, `${base}.report.json`)
    const bookJsonPath = path.join(outputDir, `${base}.book.json`)
    await writeFile(epubPath, epubBytes)

    // Sidecar for the reading view, which does not unpack the EPUB: it gets the
    // very chapters the archive was assembled from, so the two cannot disagree.
    const book = { title, author, language, chapters: epubChapters }
    await writeFile(bookJsonPath, `${JSON.stringify(book, null, 2)}\n`)

    // What this run actually spent, plus what the cache let it skip. The same
    // object is returned directly, so a caller that never reads the report file
    // sees identical numbers.
    const tokens = {
      ...ledger,
      estimated: ledger.estimated === true,
      reused: { ...reused },
    }
    const report = buildReport({
      input: inputPath, epubPath, reportPath, bookJsonPath, title, author, language,
      pdf, pages, flattened, chapters, tokens, cachedPages, startedAt,
      primaryRoute, reviewRoutes, requestedDpi, dpi,
    })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    emit({ phase: 'done', epubPath, reportPath, tokens: ledger.total, pagesFailed: report.stats.pagesFailed })
    return {
      epubPath,
      reportPath,
      bookJsonPath,
      report,
      tokens,
      // Same number as `report.stats.pagesFailed`, next to the report on purpose:
      // a caller that logs only the returned paths would otherwise call a book
      // with an empty page in it "completed".
      pagesFailed: report.stats.pagesFailed,
    }
  } finally {
    pdf.close()
  }
}

/**
 * Transcribe one page, including retries and cross-review.
 * @param {object} args - page job.
 * @param {{ type: string, text: string } | null} args.previousTail - tail of the page before this one, when it is known.
 * @returns {Promise<{ page: object, ledger: object, furniture: string[] }>} page record and its token spend.
 */
async function transcribePage(args) {
  const { host, pdf, pageIndex, totalPages, primary, reviews, dpi, maxTokens, previousTail, signal } = args
  // `furniture` below is what this page emits; the incoming hint list gets its own
  // name so the two cannot shadow each other.
  const furnitureHints = args.furniture ?? []
  const ledger = emptyLedger()
  const pageStarted = Date.now()
  const rendered = await pdf.renderPage(pageIndex, { dpi })
  // `extractPageTextDetailed` is the only variant that also reports whether the
  // page carried a real text layer, and both the cross-review decision and the
  // page source need that; the plain extractor would leave `hasText` undefined.
  const baseline = pdf.extractPageTextDetailed(pageIndex)
  const image = await imageBlock(host, rendered.png)
  const imageRef = image.attachment ?? {}
  const imageSize = typeof imageRef.width === 'number' && typeof imageRef.height === 'number'
    ? { width: imageRef.width, height: imageRef.height, bytes: typeof imageRef.bytes === 'number' ? imageRef.bytes : null }
    : null
  const prompt = transcriptionPrompt({
    pageNumber: pageIndex + 1,
    totalPages,
    previousTail: previousTail ?? null,
    furnitureHint: furnitureHints,
  })

  let attempt = await transcribeOnce({ host, route: primary, prompt, image, maxTokens, signal, ledger })
  let verdict = checkPage(attempt.page, { baselineText: baseline.text })

  if (!verdict.ok) {
    // `prompt` must be passed again: a retry is a second full call, not a delta.
    const retry = await transcribeOnce({
      host, route: primary, prompt, image, maxTokens, signal, ledger,
      extra: retryNote(verdict.issues.join('; ')),
    })
    const retryVerdict = checkPage(retry.page, { baselineText: baseline.text })
    if (retryVerdict.ok || retry.page.blocks.length > attempt.page.blocks.length) {
      attempt = retry
      verdict = retryVerdict
    }
  }

  const candidates = [{ text: pageText(attempt.page), page: attempt.page }]
  const models = [`${primary.provider}/${primary.model}`]
  let reviewed = false
  if (needsCrossReview(verdict, baseline.hasText)) {
    for (const route of reviews) {
      const extra = await transcribeOnce({ host, route, prompt, image, maxTokens, signal, ledger })
      candidates.push({ text: pageText(extra.page), page: extra.page })
      models.push(`${route.provider}/${route.model}`)
    }
    reviewed = candidates.length > 1
  }

  // The medoid can be a reviewer's page, so the sentinels run again on the text
  // that actually enters the book: `ratio`, `issues` and `ok` describe the kept
  // page, and a failed sentinel is never overwritten by a good agreement score.
  const resolved = resolvePageRecord(candidates, { baselineText: baseline.text })
  const kept = resolved.page
  const blockList = kept.blocks.map(plainBlock)
  // The kept attempt can be a reviewer's page, so the failure message comes from
  // the page that actually wins - not from the primary call that was discarded.
  // It stays on the page record because two things need it downstream: the
  // report (a reader must be able to tell a blank page from an empty one) and
  // the cache gate (a page with an error produced no book text).
  const error = typeof kept.error === 'string' && kept.error !== '' ? kept.error : null
  const page = {
    page: pageIndex + 1,
    source: baseline.hasText ? 'vlm+text-layer' : 'vlm',
    chars: countableCharacters(kept.blocks),
    baselineChars: baseline.text.replace(/\s+/g, '').length,
    ratio: resolved.verdict.ratio,
    ok: resolved.ok,
    reviewed,
    agreement: resolved.agreement,
    degraded: resolved.degraded,
    issues: resolved.verdict.issues,
    error,
    notes: kept.notes ?? '',
    models,
    finishKind: kept.finishKind ?? null,
    truncated: kept.truncated === true,
    image: imageSize,
    blocks: blockList,
    ms: Date.now() - pageStarted,
  }
  const furniture = blockList
    .filter(block => block.type === 'header' || block.type === 'footer' || block.type === 'page-number')
    .map(block => block.text.slice(0, 40))
  return { page, ledger, furniture }
}

/**
 * One model call plus parse, recording its spend in the caller's ledger.
 *
 * The ledger is shared by every attempt on a page; a private one here would be
 * thrown away by the caller and the run's token total would stay at zero.
 *
 * @param {object} args - call job.
 * @returns {Promise<{ page: object, ledger: object }>} parsed page and its spend.
 */
async function transcribeOnce(args) {
  const { host, route, prompt, image, maxTokens, signal, extra } = args
  const ledger = args.ledger ?? emptyLedger()
  const user = extra === undefined ? prompt.user : `${prompt.user}\n${extra}`
  const outcome = await callModel(host, {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    user,
    image,
    maxTokens,
    signal,
  })
  const usage = normalizeUsage(outcome.usage)
  addUsage(ledger, usage, outcome.usage)
  if (usage === null && outcome.text !== '') {
    // Provider reported nothing usable; keep an estimate so the report is never blank.
    const inputEstimate = estimateTokens(prompt.user) + 1200
    const outputEstimate = estimateTokens(outcome.text)
    ledger.input += inputEstimate
    ledger.output += outputEstimate
    ledger.total += inputEstimate + outputEstimate
    ledger.estimated = true
  }
  const finishKind = outcome.finishKind ?? null
  const truncated = outcome.truncated === true
  if (outcome.error !== null) {
    return {
      page: { blocks: [], notes: '', raw: '', error: outcome.error, finishKind, truncated },
      ledger,
    }
  }
  try {
    const parsed = parsePageJson(outcome.text)
    return { page: { ...parsed, raw: outcome.text, finishKind, truncated }, ledger }
  } catch (error) {
    // A truncated reply is not a malformed reply: name the token budget, or the
    // report sends the reader hunting for a JSON bug that is really a size cap.
    const message = truncated
      ? `${error.message} (response stopped at maxTokens: ${maxTokens})`
      : error.message
    return {
      page: { blocks: [], notes: '', raw: outcome.text, error: message, finishKind, truncated },
      ledger,
    }
  }
}

/** Concatenate a page's block text for similarity comparison. */
function pageText(page) {
  return page.blocks.map(block => block.text).join('\n')
}

/**
 * The words a page ends on, for the next page's prompt.
 * Furniture is skipped because a header or page number says nothing about how the
 * body continues; blocks with no text are skipped for the same reason.
 *
 * @param {{ blocks: { type: string, text: string }[] } | undefined} page - a transcribed page record.
 * @returns {{ type: string, text: string } | null} the last block's final 80 characters, or null.
 */
function pageTail(page) {
  const blocks = page?.blocks
  if (!Array.isArray(blocks)) return null
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (DROP_TYPES.has(block.type)) continue
    const text = String(block.text ?? '').trim()
    if (text === '') continue
    return { type: block.type, text: text.slice(-80) }
  }
  return null
}

/**
 * Build the machine-readable report.
 *
 * `tokens` is the run's own spend (with `reused` alongside it); `byPage` is
 * derived here because the per-page cached flag only exists at run level.
 *
 * `stats.pagesFailed` is not "the call threw": it counts every page that
 * contributed no book text (no blocks, an `error`, or furniture only), and the
 * same predicate gates the page cache. That is why the warning can promise that
 * a plain re-run retries them - a failed page was never written to the cache.
 */
function buildReport(args) {
  const { input, epubPath, reportPath, bookJsonPath, title, author, language, pdf, pages, flattened, chapters, tokens, cachedPages, startedAt, primaryRoute, reviewRoutes, requestedDpi, dpi } = args
  const list = pages.filter(Boolean)
  const failedPages = list.filter(page => !pageHasBookText(page))
  const failureWarning = pagesFailedWarning(failedPages)
  return {
    schema: 'dsh-pdf2epub/report@1',
    generatedAt: new Date().toISOString(),
    input,
    outputs: { epub: epubPath, report: reportPath, book: bookJsonPath },
    bookJsonPath,
    book: { title, author, language, pages: pdf.pageCount, chapters: chapters.length },
    models: {
      primary: `${primaryRoute.provider}/${primaryRoute.model}`,
      reviewers: reviewRoutes.map(route => `${route.provider}/${route.model}`),
    },
    stats: {
      pagesTranscribed: list.length,
      pagesFromTextLayer: list.filter(page => page.source === 'vlm+text-layer').length,
      pagesCrossReviewed: list.filter(page => page.reviewed).length,
      pagesDegraded: list.filter(page => page.degraded).length,
      pagesFailed: failedPages.length,
      blocks: flattened.blocks.length,
      blocksDropped: flattened.dropped,
      blocksJoined: flattened.joined,
      blocksRejectedJoins: flattened.rejectedJoins,
      chapters: chapters.length,
    },
    tokens: {
      ...tokens,
      byPage: list.map(page => ({
        page: page.page,
        chars: page.chars,
        models: page.models,
        // True when this page cost nothing in this run; its spend is in `reused`.
        cached: cachedPages.has(page.page),
      })),
    },
    rendering: {
      requestedDpi,
      effectiveDpi: dpi,
      maxEffectiveDpi: MAX_EFFECTIVE_DPI,
      note: 'above the effective ceiling the provider projection downsamples the page, so extra DPI changes nothing the model sees',
    },
    timing: { totalMs: Date.now() - startedAt },
    // Empty unless a page ended up with nothing to contribute. A `completed`
    // conversion is still true - the book was written - so the honest signal is
    // this list plus `stats.pagesFailed` and the per-page `error`, not a status
    // code the report does not own.
    warnings: failureWarning === null ? [] : [failureWarning],
    limitations: {
      images: 'figure blocks carry captions only; page artwork is not extracted',
    },
    pages: list.map(page => ({
      page: page.page,
      source: page.source,
      chars: page.chars,
      baselineChars: page.baselineChars,
      ratio: page.ratio === null ? null : Number(page.ratio.toFixed(3)),
      ok: page.ok,
      reviewed: page.reviewed,
      degraded: page.degraded,
      agreement: page.agreement === null ? null : Number(page.agreement.toFixed(3)),
      models: page.models,
      finishKind: page.finishKind,
      truncated: page.truncated,
      image: page.image,
      issues: page.issues,
      // The failure text, so a reader can tell "the model was rate limited" from
      // "the page really is blank"; null when the page came back normally.
      error: page.error ?? null,
      ms: page.ms,
    })),
  }
}

/**
 * One human-readable sentence about the pages that produced no text, or null.
 * Page numbers are capped so a broken 400-page run cannot produce a novel.
 *
 * @param {{ page: number }[]} failedPages - failed page records, in page order.
 * @returns {string | null} warning text, or null when every page produced text.
 */
function pagesFailedWarning(failedPages) {
  if (failedPages.length === 0) return null
  const listed = failedPages.slice(0, 10).map(page => page.page).join(', ')
  const numbers = failedPages.length > 10 ? `${listed}, …` : listed
  const noun = failedPages.length === 1 ? 'page' : 'pages'
  return `${failedPages.length} ${noun} produced no text (page ${numbers}); failed pages are not cached, `
    + 'so running this conversion again retries them'
}

/**
 * True when a page produced book text, which is exactly the condition for
 * writing its resume-cache entry.
 *
 * All three parts are load-bearing: an empty block list is a failed call; an
 * `error` marks a failed or cancelled call; and a page consisting only of page
 * furniture contributes no book text because `flattenPages()` drops those
 * blocks, so caching it would still leave a hole in the next run's book.
 *
 * @param {object | null | undefined} page - a page record.
 * @returns {boolean} true when the page may enter the book and the cache.
 */
function pageHasBookText(page) {
  if (page === null || typeof page !== 'object') return false
  const blocks = Array.isArray(page.blocks) ? page.blocks : []
  if (blocks.length === 0) return false
  if (typeof page.error === 'string' && page.error !== '') return false
  return blocks.some(block => block !== null && typeof block === 'object'
    && !DROP_TYPES.has(block.type)
    && String(block.text ?? '').trim() !== '')
}

/**
 * Fingerprint of the input file: absolute path, size and mtime.
 *
 * A content hash of the whole book would be more exact but costs a full read on
 * every run, which is heavier than the transcription it protects; size+mtime is
 * enough to make "a different file now sits at this path" a different cache
 * namespace, and that is the stale-cache failure this guards against.
 *
 * @param {string} inputPath - resolved absolute input path.
 * @param {{ size: number, mtimeMs: number }} info - `stat` result for the input.
 * @returns {string} 12 hex characters, safe as a directory name.
 */
function inputFingerprint(inputPath, info) {
  const size = Number.isFinite(info?.size) ? info.size : 0
  const mtime = Number.isFinite(info?.mtimeMs) ? Math.trunc(info.mtimeMs) : 0
  return createHash('sha256').update(`${inputPath}\u0000${size}\u0000${mtime}`).digest('hex').slice(0, 12)
}

/**
 * Fingerprint of the settings that produced a page: effective DPI and the
 * primary route. `PROMPT_VERSION` is part of the same conceptual key, but it is
 * enforced by `readCache()`'s payload check instead of the directory name, so
 * bumping it heals every stale entry in place rather than orphaning a directory
 * per version.
 *
 * @param {number} dpi - effective render DPI.
 * @param {{ provider: string, model: string }} route - primary model route.
 * @returns {string} directory-safe settings segment, for example `100-fake_model`.
 */
function settingsFingerprint(dpi, route) {
  return `${dpi}-${safeSegment(`${route.provider}/${route.model}`)}`
}

/**
 * Make an arbitrary string usable as one path segment on every platform.
 * Two routes that sanitise to the same segment cannot silently share entries:
 * the payload records the exact model, and `readCache()` treats the mismatch as
 * a miss (and deletes the entry).
 */
function safeSegment(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48)
  return cleaned === '' ? 'model' : cleaned
}

/** Path of one page's cache entry. */
function cacheFile(dir, pageIndex) {
  return path.join(dir, `${String(pageIndex + 1).padStart(5, '0')}.json`)
}

/**
 * Write one page's cache entry.
 *
 * Called only for pages that produced book text (see `transcribe()`), so the
 * entry written here is always replayable as an answer.
 */
async function writeCache(cache, pageIndex, result) {
  const payload = {
    version: PROMPT_VERSION,
    dpi: cache.dpi,
    model: cache.model,
    input: cache.inputKey,
    page: result.page,
    ledger: result.ledger,
    furniture: result.furniture,
  }
  await writeFile(cacheFile(cache.dir, pageIndex), JSON.stringify(payload))
}

/**
 * Read one page's cache entry, or null when absent or not trustworthy.
 *
 * A missing file is just a cold start. Anything else that fails validation is
 * deleted before returning null (self-healing): a poisoned entry - the
 * `blocks: []` written by an older build, a truncated write, an entry from a
 * different model or DPI - must not survive to be rejected again on every run,
 * and deleting it is what lets the page be transcribed and rewritten cleanly.
 *
 * @returns {Promise<object | null>} the validated payload, or null.
 */
async function readCache(cache, pageIndex) {
  const target = cacheFile(cache.dir, pageIndex)
  let raw
  try {
    raw = await readFile(target, 'utf8')
  } catch {
    return null
  }
  let payload = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }
  if (cacheProblem(payload, cache, pageIndex) === null) return payload
  await unlink(target).catch(() => {})
  return null
}

/**
 * Why a cache entry cannot be trusted, or null when it can.
 *
 * `blocks` must be a non-empty array of well-formed blocks: length 0 is exactly
 * what a failed page used to leave behind, so accepting it (as the pre-fix code
 * did) turns one 429 into a permanently blank page. The page number, the input
 * fingerprint, the DPI and the model are checked too, so an entry copied into
 * the wrong directory is a miss rather than the wrong page.
 *
 * @returns {string | null} a short reason (handy in a debugger), or null.
 */
function cacheProblem(payload, cache, pageIndex) {
  if (payload === null || typeof payload !== 'object') return 'not a JSON object'
  if (payload.version !== PROMPT_VERSION) return `prompt version ${payload.version}`
  if (payload.model !== cache.model) return `model ${payload.model}`
  if (payload.dpi !== cache.dpi) return `dpi ${payload.dpi}`
  if (payload.input !== cache.inputKey) return `input ${payload.input}`
  const page = payload.page
  if (page === null || typeof page !== 'object') return 'no page record'
  if (page.page !== pageIndex + 1) return `page ${page.page}`
  if (!Array.isArray(page.blocks) || page.blocks.length === 0) return 'no blocks'
  if (typeof page.error === 'string' && page.error !== '') return 'page error'
  const malformed = page.blocks.some(block => block === null || typeof block !== 'object'
    || typeof block.type !== 'string' || typeof block.text !== 'string')
  if (malformed) return 'malformed block'
  if (!pageHasBookText(page)) return 'no book text'
  return null
}

/** Inclusive-exclusive integer range. */
function range(start, end) {
  const out = []
  for (let value = start; value < end; value += 1) out.push(value)
  return out
}

/**
 * Run `worker` over `items` with a fixed number of in-flight tasks.
 * @param {number[]} items - work items.
 * @param {number} limit - maximum concurrency.
 * @param {(item: number) => Promise<void>} worker - task body.
 */
async function mapPool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/** Clamp a numeric option into range, falling back to the default when unusable. */
function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Derive a stable UUID-shaped identifier from the book hash. */
function bookIdToUuid(hex) {
  const body = (hex + '0'.repeat(32)).slice(0, 32)
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-4${body.slice(13, 16)}-8${body.slice(17, 20)}-${body.slice(20, 32)}`
}
