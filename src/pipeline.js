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
 * leaving the book silently short a page. The one deliberate exception is a page
 * that is *visually blank* (`blank-page`): the empty block list really is the
 * answer there, so it is cached with `blank: true` and a rerun pays nothing for
 * it - see {@link blankPageVerdict} and {@link cacheProblem}.
 *
 * ONE BOOK, ONE DIRECTORY. Every artifact of one book lands in a directory named
 * after the input file, `<outputDir>/<pdf file name>/`: the EPUB and its two JSON
 * sidecars beside the per-page cache under `pages/` and the cropped pictures under
 * `images/`. `outputDir` defaults to the PDF's own directory, so by default the
 * folder sits next to the book it was produced from. The page cache used to live
 * in a dot-prefixed `<outputDir>/.pdf2epub-<inputKey>/` whose name carried the
 * input fingerprint; the directory is now the file name, so that isolation moved
 * into the cached payload itself - see {@link readCache}.
 *
 * A run that produces no book text at all is a failure, but never a silent one:
 * the per-page reasons are written to `<bookDir>/<book>.report.json` before the
 * error is thrown, and the thrown message names that file. The page cache cannot
 * help there - a failed page is deliberately never cached - so the report is the
 * only record of WHY the model's answers did not become a book, and it keeps the
 * opening of each reply (`raw`) alongside the classification (`failure`), so
 * "the model returned empty blocks", "the reply was not JSON" and "the call
 * failed" stay distinguishable after the process is gone.
 *
 * A run may cover a page selection (`spec.pages` / `spec.excludePages`) instead
 * of the whole document, which is how a 700-page book is transcribed in batches
 * without ever touching the PDF: the selection decides which pages are rendered
 * and sent to a model, but it is deliberately NOT part of the cache key, so the
 * pages of one batch are reused by every later batch and by the final whole-book
 * run. Copying or renaming the PDF to "split" it would change the input
 * fingerprint and throw that away - see {@link inputFingerprint}.
 */

/* -------------------------------------------------------------------------- */
/* Local submodule cache stamp                                                */
/* -------------------------------------------------------------------------- */

/**
 * Version stamp carried by every local import below.
 *
 * WHY THIS EXISTS: Node's ESM cache is process-wide and keyed by URL, and a
 * plugin reload (`plugin_manager set_plugin` false then true) re-evaluates only
 * the entry modules - `index.js` and `src/host/server.js`. That file busts its
 * own import of THIS one by appending the module's mtime to the specifier (see
 * `loadPipeline`), so an edited pipeline is re-evaluated; the static imports
 * written here are resolved by URL like any other module, and without a query
 * they keep the identity they were given on the FIRST load. A re-evaluated
 * pipeline would therefore still hold the submodules from that first load:
 * editing `model/assemble.js`, `epub/build.js` or `host/bridge.js` and reloading
 * the plugin changed nothing, and a conversion kept replaying the old assembly
 * code. Stamping these specifiers gives each revision of the pipeline its own
 * submodule identity, which is what makes a reload reach one level down.
 *
 * WHEN TO BUMP: whenever a file under `src/model/`, `src/epub/`, `src/pdf/` or
 * `src/host/` changes - this file excepted. A forgotten bump is invisible: the
 * running host silently keeps the previous copy of the edited module.
 * `src/host/server.js` carries a matching `PIPELINE_API_VERSION` and has to be
 * bumped together with this number, because the pipeline URL only moves with
 * `pipeline.js`'s own mtime: with the file itself unchanged the loader would
 * hand back the module it already has and never see the import URLs below.
 *
 * The value is repeated as a literal in the `?v=` of every local import below,
 * since a static import specifier cannot be an expression. Bump this constant
 * AND every `?v=` in the same edit, or the stamp reaches only half the graph.
 *
 * SCOPE: only the imports written in this file are stamped. A module reached
 * through another one (`model/blocks.js` via `model/gate.js`, `epub/css.js` via
 * `epub/build.js`) keeps the plain URL its importer uses, so changing one of
 * those still wants a stamp in that importer, or a real host restart.
 *
 * This is a development / hot-reload convenience, not a shipping mechanism:
 * every reloaded revision stays in the ESM cache for the life of the process,
 * so a release still has to be verified after restarting the host.
 */
const LOCAL_MODULE_VERSION = 13

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/* Every `?v=` below must equal LOCAL_MODULE_VERSION, defined above. */
import { buildEpub } from './epub/build.js?v=13'
import { openPdf } from './pdf/index.js?v=13'
import { DROP_TYPES, parsePageJson, plainBlock, countableCharacters } from './model/blocks.js?v=13'
import { transcriptionPrompt, retryNote } from './model/prompt.js?v=13'
import { checkPage, needsCrossReview, resolvePageRecord } from './model/gate.js?v=13'
import { buildChapters, flattenPages, renderChapterHtml, stripIllegalXml } from './model/assemble.js?v=13'
import { addUsage, emptyLedger, estimateTokens, mergeLedger, normalizeUsage } from './model/usage.js?v=13'
import { REASONING_HEADROOM, callModel, imageBlock, parseRoute, resolveRoute } from './host/bridge.js?v=13'

/**
 * Bumped whenever the prompt or the block schema changes, to invalidate caches.
 * 2: table and list blocks keep their rows, and the page record carries the
 * finish kind and the sent image size, so every page-2 cache entry is stale.
 * 3: `figure` blocks carry a page-normalised `bbox` and the page record carries
 * the cropped image (`figures`), so a page cached before figures were extracted
 * would silently rebuild a book without its plates.
 * 4: four rules were added to the system prompt - page footnotes (`footnote`,
 * marker kept at the start of the text, cross-page continuation flagged), in-text
 * note marks kept verbatim, page numbers that sit in the middle of the outer
 * margin (and the folio form `131b`) typed as `page-number`, and running heads
 * typed as `header` while a chapter's opening page is explicitly declared to
 * carry none. A page transcribed under prompt 3 classified the same ink as plain
 * `p` (footnote text flowed into the body) and could only be fixed by asking the
 * model again, so every page-3 entry is stale.
 */
export const PROMPT_VERSION = 4

/** Hard ceiling on pages, so a mis-specified input cannot run forever. */
const MAX_PAGES = 5000

/**
 * Pages transcribed one after another at the start of a run, in document order.
 *
 * Their page furniture seeds the hint list the rest of the book is transcribed
 * against, and each one can be handed the real tail of the page before it. A
 * page selection keeps the same behaviour: the first pages *of the selection*
 * run serially, because inside the pool "the previous page" is not well defined.
 */
const SEED_PAGES = 3

/**
 * Long edge of the cover image, in pixels.
 *
 * A shelf thumbnail is shown at a fraction of a screen, so a page rendered at the
 * transcription DPI (1241x1814 for an A4 scan) is several times more pixels than
 * a cover can use. 1400 keeps the title on a scanned cover crisp without making
 * every book pay for a full-resolution page bitmap.
 */
const COVER_LONG_EDGE = 1400

/** Where the cover image lives inside the EPUB (relative to OEBPS). */
const COVER_HREF = 'images/cover.png'

/**
 * Render DPI for a cropped figure. One notch above the page render: the box is
 * small, so the extra pixels are cheap and the illustration reads better on a
 * high-DPI screen. `cropRegion` still caps the long edge at 1600px.
 */
const FIGURE_DPI = 200

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
 * How much of one model reply a failed page keeps for the report.
 *
 * Enough to see whether the model refused, rambled, or emitted something that
 * merely looks like JSON; not enough to turn a failed 500-page run's report into
 * a copy of the book. Truncation is marked with an ellipsis.
 */
const RAW_EXCERPT_CHARS = 400

/**
 * Warning that only a report written for a run which produced no book carries.
 *
 * That report is the run's only artifact, so it has to say so itself: a reader
 * who opens it later - without the thrown error in hand - must not mistake it
 * for the report of a book with an empty chapter.
 */
const NO_BOOK_TEXT_WARNING =
  'no EPUB was written: the conversion produced no book text, so this report exists for diagnostics only'

/**
 * Share of a page that must carry ink for "the model returned no blocks" to be a
 * failure rather than a correct answer.
 *
 * A truly blank page (a verso left empty by the printer, a divider) is what the
 * model says it is, and the measured ink of one is 0.000 - see
 * {@link blankPageVerdict}. The threshold is deliberately far above zero and just
 * as deliberately tiny: 0.5% of a 36-dpi A4 page is ~630 pixels, which is more
 * than a stray speck of dust and less than one line of body text (a page with two
 * lines of 24pt text measures ~1.9%). A page whose ink stays below it is blank;
 * anything above it is a page the model failed to read, and keeps the failure
 * behaviour it always had.
 */
const BLANK_PAGE_INK_RATIO = 0.005

/**
 * `page.failure` of a page that is provably blank.
 *
 * It is a failure *class* (so the record shape and the report entry match every
 * other classification) but not a failed page: `ok` stays true, the page is not
 * counted in `stats.pagesFailed` / `stats.pagesDegraded`, it is counted in
 * `stats.pagesBlank` instead, and its cache entry says `blank: true`.
 */
const BLANK_PAGE_FAILURE = 'blank-page'

/**
 * Run one conversion.
 *
 * @param {object} options - run inputs.
 * @param {object} options.host - Host context (llm, attachments, fs).
 * @param {object} options.spec - user request; `spec.sessionId`, when supplied,
 *   is the session routing id every model call carries (see {@link resolveSessionId}).
 *   `spec.outputDir` defaults to `config.outputDir`, and then to the PDF's own
 *   directory, so by default the book is written beside the file it came from.
 *   Every artifact of a run lands in `<outputDir>/<input file name>/`.
 * @param {object} options.config - plugin configuration.
 * @param {(event: object) => void} [options.onProgress] - progress sink.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {(pageIndex: number, bbox: number[], options?: { dpi?: number }) => Promise<{ png: Uint8Array }>} [options.cropRegion] -
 *   crop seam. Defaults to the PDF handle's `cropRegion`; a test swaps it out to
 *   prove that a crop failure warns and falls back to a caption-only figure
 *   instead of failing the page (which would lose a page of text over a picture).
 * @param {(dpi: number) => Promise<{ png: Uint8Array, width: number, height: number }>} [options.renderCover] -
 *   cover render seam. Defaults to the PDF handle's `renderPage(0, { dpi })`; a
 *   test swaps it out to prove that a cover that cannot be rendered becomes a
 *   warning instead of failing a book that is otherwise complete.
 * @param {(pageIndex: number) => number} [options.pageInkRatio] -
 *   ink seam. Defaults to the PDF handle's own `pageInkRatio(pageIndex)` (a
 *   coarse 36-dpi render, see `src/pdf/index.js`); a test swaps it out to decide
 *   the blank-page verdict for a page it cannot render as blank. It is consulted
 *   only when a page answered with no blocks at all, so it costs nothing on a
 *   normal page.
 * @param {string} [options.spec.modified] - ISO 8601 modification timestamp for
 *   `dcterms:modified`. Defaults to the input file's own mtime (see
 *   {@link resolveModified}), which keeps a cache-only rerun byte-identical.
 * @returns {Promise<object>} `{ epubPath, reportPath, bookJsonPath, report, tokens, pagesFailed }`,
 *   where `tokens` is this run's own spend with the cache-reused spend under
 *   `reused`, `pagesFailed` counts the pages that produced no book text, and all
 *   three paths point inside `report.book.directory`.
 * @throws {Error} when the run cannot produce a book. A document whose every
 *   page came back without text gets its diagnostic `<bookDir>/<book>.report.json`
 *   written first, and the message ends with `; diagnostics written to <absolute path>`.
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

  // One capability + reasoning probe per route, before any page is rendered: the
  // image verdict can still fail the run fast, and the reasoning level has to be
  // available for every call afterwards. The lowest advertised level is chosen on
  // purpose - this route family cannot disable thinking (`thinkingLevelMap.off`
  // is `null` in the pi-ai catalog, so `off` is not in the list), which makes the
  // cheapest level the only deterministic setting; naming no level at all leaves
  // the provider default in charge of a budget the answer also needs. The value is
  // never hard-coded, and a route without reasoning simply gets none.
  const reasoningEfforts = new Map()
  for (const route of allRoutes) {
    const resolved = await resolveRoute(host, route, signal)
    if (resolved.problem !== null && route === primaryRoute) throw new Error(resolved.problem)
    if (resolved.reasoningEffort !== undefined) {
      reasoningEfforts.set(`${route.provider}/${route.model}`, resolved.reasoningEffort)
    }
  }

  // `dpi` above the effective ceiling cannot change what the model sees (the
  // provider projection downsamples the page), so render at the ceiling and
  // report both numbers instead of pretending the knob keeps scaling. It is
  // resolved before the cache directory is built because it is part of the key.
  const requestedDpi = clamp(spec.dpi ?? config.dpi ?? 150, 72, 300)
  const dpi = Math.min(requestedDpi, MAX_EFFECTIVE_DPI)

  // The two fingerprints still describe the cache key, but neither names a
  // directory any more: a hit has to mean "the same file, read with the same
  // recipe", and that is now checked against the cached payload as it is read
  // (see `readCache()`), because the directory is named after the input file.
  // (The prompt version is the third part of that key; it is checked the same
  // way - see `settingsFingerprint()`.)
  const inputKey = inputFingerprint(inputPath, info)
  const settingsKey = settingsFingerprint(dpi, primaryRoute)
  // `bookId` stays a pure path hash on purpose: it seeds the EPUB identifier,
  // which should not move when the same book is re-edited at the same path, and
  // it doubles as the fallback session routing id resolved just below.
  const bookId = createHash('sha256').update(inputPath).digest('hex').slice(0, 12)
  // Resolved once, before any page starts: the provider header this feeds is
  // required on every call, and every page of this book has to carry the same
  // value or the provider routes each call separately and its prefix cache never
  // hits. See `resolveSessionId()` for the two sources.
  const sessionId = resolveSessionId(spec.sessionId, bookId)

  // Opened before a single output path is built: the book's directory is named
  // after the input file's own name, and this is where the handle is acquired.
  // The `finally` below owns it from here on, so a failure while the directories
  // are created cannot leak it.
  const pdf = await openPdf(inputPath)
  try {
    if (pdf.pageCount > MAX_PAGES) throw new Error(`document has ${pdf.pageCount} pages, above the ${MAX_PAGES} page ceiling`)
    const documentInfo = pdf.info()
    // Metadata reaches the OPF `dc:title` / `dc:creator` / `dc:publisher` without
    // passing any page sentinel, so illegal XML code points are stripped here.
    // The caller's own value wins over the PDF's, and the PDF's over the file
    // name: a scanned book usually carries no `/Title` at all, and its file name
    // (`babur-body`, a download artefact) is the least trustworthy of the three.
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const title = firstMetadataText(spec.title, documentInfo.title, baseName) || baseName
    const author = firstMetadataText(spec.author, documentInfo.author) || undefined
    // `pdf.info()` exposes no publisher field (mupdf reports title and author
    // only), so this resolves to the caller's value or to nothing; the read is
    // kept so a reader that starts reporting one is picked up without a change.
    const publisher = firstMetadataText(spec.publisher, documentInfo.publisher) || undefined
    const language = spec.language ?? config.language ?? 'zh-CN'
    // `dcterms:modified` must be a real date, not the 1970 placeholder: a reader
    // and a library both show it. It is derived from the input file rather than
    // from the wall clock so that rebuilding a book from the page cache produces
    // the same archive twice (`.out` artifacts and the reproducibility contract
    // both depend on that); a caller may pass its own value.
    const modified = resolveModified(spec.modified, info)
    const maxTokens = clamp(spec.maxTokens ?? config.maxTokens ?? 4000, 512, 16000)
    const concurrency = clamp(spec.concurrency ?? config.concurrency ?? 4, 1, 16)
    const splitLevel = clamp(spec.splitLevel ?? config.splitLevel ?? 2, 1, 6)
    // Where a page-bottom footnote lands. `chapter` is the default: a note is
    // printed under the last line of a printed page, so reflowing the page with
    // the note still in place leaves it in the middle of a sentence the next page
    // continues. `inline` stays available for a reader whose popup wants the note
    // in the flow. Only `inline` is special-cased, so a value the plugin
    // configuration did not clamp (a stale profile, say) still produces a book.
    const footnotePlacement = spec.footnotePlacement ?? config.footnotePlacement
    const footnoteLinks = spec.footnoteLinks ?? config.footnoteLinks
    const force = spec.force === true
    // Which pages this run converts, resolved before a single page is rendered or
    // sent: bad syntax is a caller error, and it must not cost a model call. The
    // selection is NOT part of the cache key (see `settingsFingerprint`), so a
    // batch reuses the pages an earlier batch transcribed.
    const selection = resolvePageSelection(spec, pdf.pageCount)

    // ONE BOOK, ONE DIRECTORY. The directory is named after the INPUT FILE, not
    // after the title: a file name is predictable and stable (it does not move
    // when `title` comes from the caller on one run and from the PDF's metadata on
    // the next), and a user who sees the folder already knows which PDF produced
    // it. Everything the run produces lands inside it - the EPUB and its two JSON
    // sidecars next to the `pages/` cache and the `images/` directory - so one
    // book's artifacts can be found, moved or deleted together. The previous
    // layout buried the page cache in a dot-prefixed `<outputDir>/.pdf2epub-
    // <inputKey>/` nobody would think to open, and kept every book's pictures in
    // one `images/` shared by the whole output directory.
    const outputName = bookDirectoryName(baseName)
    const bookDir = path.join(outputDir, outputName)
    // `outputDir` defaults to the PDF's own directory (see above), so the folder
    // normally sits next to the book it was produced from. The report records
    // whether that is the case, so a caller can tell the two apart.
    const alongsideInput = isSamePath(outputDir, path.dirname(inputPath))
    // A file that carries no extension is its own stem, so the folder would be the
    // input file itself and `mkdir` would clobber (or fail on) the PDF. That is a
    // caller-visible mistake, so it is named as one instead of surfacing an EEXIST.
    if (isSamePath(bookDir, inputPath)) {
      throw new Error(`pdf2epub: the artifact directory would be the input file itself (${bookDir}); `
        + 'rename the PDF, or pass an "outputDir" to put this book\'s files somewhere else')
    }
    const epubPath = path.join(bookDir, `${outputName}.epub`)
    const reportPath = path.join(bookDir, `${outputName}.report.json`)
    const bookJsonPath = path.join(bookDir, `${outputName}.book.json`)
    // Only the book's own folder is new: the page cache keeps its settings segment
    // (`pages/<dpi>-<model>/`), so a DPI or model change still lands in its own
    // namespace and cannot reuse a page transcribed another way.
    const pageDir = path.join(bookDir, 'pages', settingsKey)
    const imagesDir = path.join(bookDir, 'images')
    // An existing `bookDir` is a resumed run and is reused untouched; a fresh one
    // gets the page cache of the previous layout moved in, best effort, and the
    // report records what happened either way (see `prepareBookDirectory`).
    const layoutWarning = await prepareBookDirectory({
      bookDir,
      pageDir,
      imagesDir,
      legacyPagesDir: path.join(outputDir, `.pdf2epub-${inputKey}`, 'pages'),
    })
    // Warnings about where this run's files live. They are not page failures, so
    // they ride in `report.warnings` without touching any page record.
    const pathWarnings = layoutWarning === null ? [] : [layoutWarning]

    const cache = {
      dir: pageDir,
      inputKey,
      dpi,
      model: `${primaryRoute.provider}/${primaryRoute.model}`,
    }
    // The crop seam: the real renderer unless a caller injects one (see the
    // `cropRegion` option above). Kept as one function so a page transcribed now
    // and a page restored from cache crop through exactly the same path.
    const cropFigure = typeof options.cropRegion === 'function'
      ? options.cropRegion
      : (pageIndex, bbox, cropOptions) => pdf.cropRegion(pageIndex, bbox, cropOptions)
    // The cover seam, same idea: page 1 rendered by the real renderer unless a
    // caller replaced it (see the `renderCover` option above).
    const renderCover = typeof options.renderCover === 'function'
      ? options.renderCover
      : coverDpi => pdf.renderPage(0, { dpi: coverDpi })
    // The ink seam: the page's own coarse render unless a caller replaced it (see
    // the `pageInkRatio` option above). It answers one question - how much of the
    // page is printed on - and is consulted only for a page whose reply carried no
    // blocks at all (see `blankPageVerdict`).
    const measureInk = typeof options.pageInkRatio === 'function'
      ? options.pageInkRatio
      : pageIndex => pdf.pageInkRatio(pageIndex)
    // Assets embedded into the EPUB: one `{ href, mediaType, data }` per extracted
    // figure, across every page. Duplicates cannot happen - the href carries the
    // page number - so this is a plain append list.
    const figureAssets = []
    // Human-readable reasons a figure fell back to caption-only. They are not page
    // failures: the text of the page is still good, so the page stays `ok` and only
    // the run-level `warnings` records that the book is missing a picture.
    const figureWarnings = []
    // Two ledgers, on purpose. `ledger` holds only what *this* run spent; `reused`
    // holds the historical spend of the pages a cache hit saved us from paying
    // again. Keeping them apart is the difference between billing a rerun
    // correctly and replaying the first run's bill.
    const ledger = emptyLedger()
    const reused = emptyLedger()
    // 1-based numbers of the pages served from the disk cache in this run, so the
    // report can flag them per page.
    const cachedPages = new Set()

    emit({
      phase: 'start',
      input: inputPath,
      pages: pdf.pageCount,
      selectedPages: selection.pages.length,
      outputDir,
      bookDir,
    })

    const furniture = new Set()
    const pages = new Array(pdf.pageCount)
    // 1-based position of each selected page inside this run, so a progress event
    // can say "12 of 51" while `page` stays the document page number it names.
    const positions = new Map(selection.indices.map((index, at) => [index, at + 1]))
    const selectedTotal = selection.indices.length

    const transcribe = async (pageIndex, previousTail = null) => {
      if (signal?.aborted === true) throw new Error('cancelled')
      const cached = force ? null : await readCache(cache, pageIndex)
      if (cached !== null) {
        pages[pageIndex] = cached.page
        // A cache hit skips the model, not the pictures: the EPUB needs the PNG
        // bytes again, and the cache stores the box, not the bitmap. The box is
        // re-cropped deterministically from the same page - not read back from
        // the book's `images/` directory, which a user may have pruned, and which
        // another book sharing this file name may have overwritten.
        const restored = await restoreCachedFigures({
          page: cached.page, pageIndex, cropRegion: cropFigure,
        })
        figureAssets.push(...restored.assets)
        figureWarnings.push(...restored.warnings)
        // Not `mergeLedger(ledger, cached.ledger)`: the entry's ledger describes
        // an earlier run. Folding it into the run's own ledger would make a fully
        // cached rerun report the first run's tokens as if they had been spent
        // again, so it goes to `reused` instead.
        mergeLedger(reused, cached.ledger)
        cachedPages.add(pageIndex + 1)
        // Re-seed the hint set from the cache, or a resumed run would transcribe
        // the remaining pages against fewer furniture hints than a single run.
        for (const hint of cached.furniture ?? []) furniture.add(hint)
        emit({
          phase: 'page',
          page: pageIndex + 1,
          total: pdf.pageCount,
          position: positions.get(pageIndex) ?? null,
          selectedTotal,
          status: 'cached',
        })
        return
      }
      const result = await transcribePage({
        host, pdf, pageIndex, totalPages: pdf.pageCount,
        primary: primaryRoute, reviews: reviewRoutes,
        dpi, maxTokens, sessionId, furniture: [...furniture], previousTail, signal, reasoningEfforts,
        imagesDir, cropRegion: cropFigure, pageInkRatio: measureInk,
      })
      pages[pageIndex] = result.page
      figureAssets.push(...result.assets)
      figureWarnings.push(...result.warnings)
      mergeLedger(ledger, result.ledger)
      for (const hint of result.furniture) furniture.add(hint)
      // Only a page that actually produced book text may enter the resume cache,
      // with one exception: a provably blank page (`blank-page`) is cached even
      // though its block list is empty, because that empty list IS the answer.
      // A cache entry is replayed as if it were an answer, so caching a 429, a
      // cancellation or an empty reply from a page that has ink freezes the
      // failure into the run's state: every later run would report `completed`
      // while that page stays blank forever (B1, the silent-page-loss bug).
      // Writing nothing is the choice made here - there is no stale file left to
      // delete, and the next run sees a miss and transcribes the page again.
      // `pageCacheable()` rejects the bad shapes: no blocks, a page carrying an
      // `error`, and a page that is nothing but furniture (which `flattenPages()`
      // drops, so it would still leave a hole in the book). A page still in flight
      // when the run is cancelled is retried even if what it had produced so far
      // parsed, because that text may be a truncated fragment.
      if (signal?.aborted !== true && pageCacheable(result.page)) {
        await writeCache(cache, pageIndex, result)
      }
      emit({
        phase: 'page',
        page: pageIndex + 1,
        total: pdf.pageCount,
        position: positions.get(pageIndex) ?? null,
        selectedTotal,
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
    //
    // With a page selection the same rule applies to the selection: its first
    // pages run serially and each is handed the tail of the page before it *in the
    // selection*. The prompt keeps announcing the document's page count (never the
    // batch size), so the text a page is transcribed against does not depend on
    // how the book was split - which is what lets a batched page and a whole-book
    // page share one cache entry.
    const seedCount = Math.min(SEED_PAGES, selectedTotal)
    for (let position = 0; position < seedCount; position += 1) {
      const index = selection.indices[position]
      await transcribe(index, position === 0 ? null : pageTail(pages[selection.indices[position - 1]]))
    }
    await mapPool(selection.indices.slice(seedCount), concurrency, index => transcribe(index, null))

    if (signal?.aborted === true) throw new Error('cancelled')

    emit({ phase: 'assemble', pages: pdf.pageCount, selectedPages: selectedTotal })
    const flattened = flattenPages(pages.filter(Boolean))
    const chapters = buildChapters(flattened.blocks, { splitLevel, fallbackTitle: title })
    // What this run actually spent, plus what the cache let it skip. The same
    // object is returned directly, so a caller that never reads the report file
    // sees identical numbers. It is built before the "no book text" check
    // because the diagnostic report written on that path bills the same spend:
    // a failed conversion still cost tokens, and hiding that would be worse.
    const tokens = {
      ...ledger,
      estimated: ledger.estimated === true,
      reused: { ...reused },
    }
    // `buildChapters` always returns at least one chapter, so a zero-chapter
    // book cannot happen; a document with no book text at all is still a real
    // failure, and the message says which kind.
    if (flattened.blocks.length === 0) {
      const pagesWithBlocks = pages.filter(Boolean).filter(page => page.blocks.length > 0).length
      const message = pagesWithBlocks === 0
        ? 'no book text produced: every page came back empty (image-only scan, or every model call failed)'
        : 'no book text produced: every block was page furniture'
      // Diagnostics before the throw, deliberately. A failed page never enters
      // the page cache, so once this process exits nothing else remembers why
      // the model's answers did not become a book. Writing the report first is
      // what turns one opaque sentence into a per-page record: the classification
      // (`empty-blocks` / `unparsable` / `transport`) plus the opening of the
      // model's own reply. `chapters: []` keeps the shape identical to a real
      // report while saying, truthfully, that no chapter survived. It goes to the
      // book's own directory like every other artifact, so a failed run leaves its
      // diagnosis where the successful one would have left its book.
      const report = buildReport({
        input: inputPath, epubPath: null, reportPath, bookJsonPath: null,
        bookDir, outputName, alongsideInput,
        title, author, publisher, language, pdf, pages, flattened, chapters: [],
        tokens, cachedPages, startedAt, primaryRoute, reviewRoutes, requestedDpi, dpi,
        figuresExtracted: figureAssets.length, figureWarnings, pathWarnings,
        selection: selection.info, cover: false, coverWarning: null,
        failed: true,
      })
      const diagnosis = await writeDiagnosticReport(reportPath, report)
      throw new Error(`${message}; ${diagnosis}`)
    }

    // The chapter titles are decided by `buildChapters()` and are the only reliable
    // statement of how each chapter is really titled, so they are handed to the
    // renderer as well: a printed contents page is transcribed on its own, with no
    // chapter context, and that is where the model slips (`回忆` for `回历`, 14
    // entries of the real 764-page book). The contents pass is a deterministic match
    // against these titles - never a string replacement - so the book's prose
    // (`《巴布尔回忆录》`) is untouched. `buildChapters()` already ran, which is what
    // makes the two-phase order here (decide the structure, then render it) enough.
    const chapterTitles = chapters.map(chapter => chapter.title)
    const epubChapters = chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      level: chapter.level,
      html: renderChapterHtml(chapter, {
        chapterTitles,
        footnotePlacement: footnotePlacement === 'inline' ? 'inline' : 'chapter',
        footnoteLinks: footnoteLinks !== false,
        language,
      }),
    }))

    // Pool pages finish in whatever order the model answers, so the assets would
    // otherwise be pushed in completion order: sort by href (which starts with
    // the page number) to keep the manifest ids and the zip entry order - and
    // with them the EPUB bytes - independent of timing.
    figureAssets.sort((left, right) => (left.href < right.href ? -1 : left.href > right.href ? 1 : 0))

    // The cover is page 1 of the document rendered as a picture; it is not a
    // member of the page selection and adds no page to the book (when the
    // selection does include page 1, that page is transcribed like any other, and
    // the cover render is a second, smaller read of the same page). A failure here
    // costs the picture only: the text is already transcribed, and a conversion
    // must not fail over a thumbnail.
    let coverImage = null
    let coverWarning = null
    if (spec.cover === true) {
      try {
        coverImage = await renderCoverImage(pdf, renderCover)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        coverWarning = `page 1: the cover image could not be rendered (${reason.slice(0, 200)}); `
          + 'the EPUB is written without a cover'
      }
    }
    // The size the render actually produced, so the report can state it instead
    // of repeating the 1400px target the page box and whole-DPI rounding may miss.
    const coverSize = coverImage === null
      ? null
      : { width: coverImage.width ?? null, height: coverImage.height ?? null }
    // The cover also lands on disk next to the book, so a user browsing the
    // directory can see the shelf picture without unpacking the archive. The disk
    // copy is a convenience: the EPUB already embeds the same bytes, so a write
    // failure is a warning line, never a failed conversion.
    if (coverImage !== null) {
      try {
        await writeFile(path.join(imagesDir, 'cover.png'), coverImage.data)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        pathWarnings.push(`the cover image could not be written next to the book (${reason.slice(0, 200)}); `
          + 'the EPUB still embeds it')
      }
    }

    const epubBytes = buildEpub({
      title,
      language,
      author,
      // `publisher` is optional: `build.js` writes `dc:publisher` only when one is
      // given, and rejects nothing when the PDF carried none.
      publisher,
      identifier: `urn:uuid:${bookIdToUuid(bookId)}`,
      // `dcterms:modified`: a real date (see above), never the fixed placeholder.
      modified,
      chapters: epubChapters,
      // One manifest item per cropped figure. `buildEpub` encodes the href for
      // the OPF and keeps the decoded name for the zip entry, so the manifest and
      // the `../images/...` reference inside a chapter point at the same file.
      assets: figureAssets,
      // `null` when no cover was asked for (or the render failed): `buildEpub`
      // then emits no cover page, no `cover-image` manifest property and no
      // cover entry, exactly as before.
      coverImage,
    })

    // `epubPath`, `reportPath` and `bookJsonPath` were resolved with the book's
    // directory at the top of this run; all three live in it.
    await writeFile(epubPath, epubBytes)

    // Sidecar for the reading view, which does not unpack the EPUB: it gets the
    // very chapters the archive was assembled from, so the two cannot disagree.
    // `publisher`/`cover` are extra metadata the reader ignores; the fields it
    // reads (title, language, chapters) keep their names and shapes.
    const book = {
      title, author, language, publisher, cover: coverImage !== null, chapters: epubChapters,
    }
    await writeFile(bookJsonPath, `${JSON.stringify(book, null, 2)}\n`)

    const report = buildReport({
      input: inputPath, epubPath, reportPath, bookJsonPath,
      bookDir, outputName, alongsideInput,
      title, author, publisher, language,
      pdf, pages, flattened, chapters, tokens, cachedPages, startedAt,
      primaryRoute, reviewRoutes, requestedDpi, dpi,
      figuresExtracted: figureAssets.length, figureWarnings, pathWarnings,
      selection: selection.info, cover: coverImage !== null, coverSize, coverWarning,
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
 * Transcribe one page, including retries, cross-review and figure extraction.
 * @param {object} args - page job.
 * @param {{ type: string, text: string } | null} args.previousTail - tail of the page before this one, when it is known.
 * @param {string} args.imagesDir - absolute directory the cropped figure PNGs are written to.
 * @param {Function} args.cropRegion - crop seam (`pdf.cropRegion` or a test replacement).
 * @param {(pageIndex: number) => number} [args.pageInkRatio] - ink seam
 *   (`pdf.pageInkRatio` or a test replacement); consulted only for a page whose
 *   reply carried no blocks at all.
 * @returns {Promise<{ page: object, ledger: object, furniture: string[], assets: object[], warnings: string[] }>}
 *   page record, its token spend, and the figure assets/warnings the page contributed.
 */
async function transcribePage(args) {
  const { host, pdf, pageIndex, totalPages, primary, reviews, dpi, maxTokens, sessionId, previousTail, signal } = args
  const cropRegion = args.cropRegion
  const imagesDir = args.imagesDir
  // Resolved once per route at start-up (`resolveRoute`); forwarded to every call
  // on this page so a retry and a review both use the same reasoning level.
  const reasoningEfforts = args.reasoningEfforts
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

  let attempt = await transcribeOnce({ host, route: primary, prompt, image, maxTokens, sessionId, signal, ledger, reasoningEfforts })
  let verdict = checkPage(attempt.page, { baselineText: baseline.text })

  if (!verdict.ok) {
    // `prompt` must be passed again: a retry is a second full call, not a delta.
    const retry = await transcribeOnce({
      host, route: primary, prompt, image, maxTokens, sessionId, signal, ledger, reasoningEfforts,
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
      const extra = await transcribeOnce({ host, route, prompt, image, maxTokens, sessionId, signal, ledger, reasoningEfforts })
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
  // Crop the figures of the page that actually enters the book. The kept attempt
  // can be a reviewer's page, so cropping from the primary's boxes would embed
  // one model's layout under another model's captions. Cropping is best-effort:
  // a bad box must cost the picture, never the page (see `extractPageFigures`).
  const figureResult = await extractPageFigures({
    pageIndex, sourceBlocks: kept.blocks, targetBlocks: blockList, cropRegion, imagesDir,
  })
  // The kept attempt can be a reviewer's page, so the failure message comes from
  // the page that actually wins - not from the primary call that was discarded.
  // It stays on the page record because two things need it downstream: the
  // report (a reader must be able to tell a blank page from an empty one) and
  // the cache gate (a page with an error produced no book text).
  const error = typeof kept.error === 'string' && kept.error !== '' ? kept.error : null
  // Which of the four ways this page ended up without book text, so a report can
  // count "the model said nothing", "the model said something unparsable", "the
  // call itself died" and "the answer was crowded out by reasoning" apart instead
  // of collapsing them into one number.
  const failure = classifyFailure(kept)
  // A reply with no blocks at all is normally a failed page - but on a page that
  // is visually blank it is the correct answer. Ask the page's own ink how much
  // was printed on it before calling this a failure: the model is right about a
  // blank page, and charging it again on every rerun (a blank page was never
  // cached) is what made a real 764-page run re-pay for page 34 in every batch.
  // The measurement is taken only for this shape - zero blocks, parsed cleanly,
  // no transport error - and a measurement that cannot run never turns a failure
  // into a pass (see `blankPageVerdict`).
  const blank = error === null && failure === 'empty-blocks' && blockList.length === 0
    ? await blankPageVerdict(args.pageInkRatio, pageIndex)
    : false
  // A page with no book text keeps the opening of the model's own reply: the
  // error message says what happened, `raw` is the only evidence of what the
  // model actually produced. A healthy page stores nothing here - the full reply
  // is a second copy of the book and would bloat every cache entry and report.
  const raw = error !== null || failure !== null ? rawExcerpt(kept.raw) : ''
  const page = {
    page: pageIndex + 1,
    source: baseline.hasText ? 'vlm+text-layer' : 'vlm',
    chars: countableCharacters(kept.blocks),
    baselineChars: baseline.text.replace(/\s+/g, '').length,
    ratio: resolved.verdict.ratio,
    // A blank page is a page the conversion got right, so it is `ok` and not
    // degraded; the empty block list is a fact about the book, not a defect.
    ok: blank ? true : resolved.ok,
    reviewed,
    agreement: resolved.agreement,
    degraded: blank ? false : resolved.degraded,
    issues: resolved.verdict.issues,
    // `blank-page` rather than `empty-blocks`, so a report can tell a page that is
    // really blank from one the model failed to read.
    failure: blank ? BLANK_PAGE_FAILURE : failure,
    blank,
    error,
    raw,
    notes: kept.notes ?? '',
    models,
    finishKind: kept.finishKind ?? null,
    truncated: kept.truncated === true,
    // How much thinking the reply carried, in characters. Cheap to keep and the
    // only surviving trace of a reasoning phase that produced no answer.
    reasoningChars: Number.isInteger(kept.reasoningChars) ? kept.reasoningChars : 0,
    image: imageSize,
    blocks: blockList,
    // The plates whose pixels were really written (`{ bbox, href, bytes }`).
    // Empty when the page had no figure, when the model gave no usable box, or
    // when every crop failed; the caption stays in `blocks` either way.
    figures: figureResult.figures,
    ms: Date.now() - pageStarted,
  }
  const furniture = blockList
    .filter(block => block.type === 'header' || block.type === 'footer' || block.type === 'page-number')
    .map(block => block.text.slice(0, 40))
  return {
    page,
    ledger,
    furniture,
    assets: figureResult.assets,
    warnings: figureResult.warnings,
  }
}

/**
 * Crop every figure the kept page asked for and attach it to the page record.
 *
 * This is deliberately best-effort. The text of the page is already decided and
 * validated by the time it runs, so a bad model box, an out-of-bounds region or
 * a renderer error must cost the picture only: the figure keeps its caption and
 * the run records one warning. Failing the page instead would trade a whole page
 * of recovered text for one illustration.
 *
 * Numbering is per page and follows document order (`fig-<page>-<n>.png`), so a
 * resumed run and a fresh one produce the same href for the same figure.
 *
 * @param {object} args - crop job.
 * @param {number} args.pageIndex - 0-based page index.
 * @param {{ type: string, text: string, bbox?: number[] }[]} args.sourceBlocks - kept blocks, boxes included.
 * @param {object[]} args.targetBlocks - the plain blocks stored on the page record, same order.
 * @param {Function} args.cropRegion - crop seam.
 * @param {string} args.imagesDir - absolute directory for the PNG files.
 * @returns {Promise<{ assets: object[], figures: object[], warnings: string[] }>} embeds, page figures and warnings.
 */
async function extractPageFigures(args) {
  const { pageIndex, sourceBlocks, targetBlocks, cropRegion, imagesDir } = args
  const assets = []
  const figures = []
  const warnings = []
  let figureNumber = 0
  for (let index = 0; index < sourceBlocks.length; index += 1) {
    const block = sourceBlocks[index]
    if (block === null || typeof block !== 'object' || block.type !== 'figure') continue
    figureNumber += 1
    const bbox = block.bbox
    // No box is the documented fallback, not a failure: the model saw a caption
    // but could not (or would not) place the picture, so the caption stands alone.
    if (!Array.isArray(bbox)) continue
    const name = `fig-${pageIndex + 1}-${figureNumber}.png`
    const href = `images/${name}`
    try {
      const cropped = await cropRegion(pageIndex, bbox, { dpi: FIGURE_DPI })
      const png = cropped?.png
      if (!(png instanceof Uint8Array) || png.length === 0) {
        throw new Error('cropRegion returned no PNG bytes')
      }
      await writeFile(path.join(imagesDir, name), png)
      const target = targetBlocks[index]
      if (target !== undefined) target.image = href
      assets.push({ href, mediaType: 'image/png', data: png })
      figures.push({ bbox: [...bbox], href, bytes: png.length })
    } catch (error) {
      warnings.push(figureFailureWarning(pageIndex, figureNumber, error))
    }
  }
  return { assets, figures, warnings }
}

/**
 * Rebuild the figure assets of a page served from the resume cache.
 *
 * The cache stores `{ bbox, href, bytes }`, not the bitmap: a cache hit sends no
 * model call, but the EPUB still needs the pixels. The box is re-cropped from
 * the same page instead of reading `images/fig-...png` back from disk. The
 * directory now belongs to this book, but re-cropping is still what keeps the
 * rebuild independent of it: the PNG may have been deleted by hand, may have been
 * evicted with the rest of the book directory, or may carry a different DPI after
 * a settings change. Cropping is deterministic, so the rebuilt EPUB is
 * byte-identical to the one the first run wrote, and a bootstrap-only cache hit
 * still costs no model call. If the crop fails, the figure falls back to
 * caption-only (with a warning and its image link removed, so the chapter cannot
 * point at a file the archive does not contain).
 *
 * @param {object} args - restore job.
 * @param {object} args.page - cached page record.
 * @param {number} args.pageIndex - 0-based page index.
 * @param {Function} args.cropRegion - crop seam.
 * @returns {Promise<{ assets: object[], warnings: string[] }>} embeds and warnings for this page.
 */
async function restoreCachedFigures(args) {
  const { page, pageIndex, cropRegion } = args
  const assets = []
  const warnings = []
  const figures = []
  const blocks = Array.isArray(page?.blocks) ? page.blocks : []
  for (const stored of Array.isArray(page?.figures) ? page.figures : []) {
    const href = typeof stored?.href === 'string' ? stored.href : ''
    if (!/^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(href)) continue
    let data = null
    try {
      const cropped = await cropRegion(pageIndex, stored.bbox, { dpi: FIGURE_DPI })
      if (!(cropped?.png instanceof Uint8Array) || cropped.png.length === 0) {
        throw new Error('cropRegion returned no PNG bytes')
      }
      data = cropped.png
    } catch (error) {
      warnings.push(figureFailureWarning(pageIndex, href, error))
    }
    if (data === null) {
      const block = blocks.find(item => item !== null && typeof item === 'object' && item.image === href)
      if (block !== undefined) delete block.image
      continue
    }
    assets.push({ href, mediaType: 'image/png', data })
    figures.push({ bbox: Array.isArray(stored.bbox) ? [...stored.bbox] : null, href, bytes: data.length })
  }
  // Keep the record in step with the book actually being built: a figure whose
  // bitmap could not be recovered is dropped here, so `stats.figuresExtracted`
  // counts embedded pictures rather than hopeful cache entries.
  page.figures = figures
  return { assets, warnings }
}

/**
 * One human-readable sentence about a figure that fell back to caption-only.
 * @param {number} pageIndex - 0-based page index.
 * @param {number | string} label - figure number, or its href when restoring from cache.
 * @param {unknown} error - what the cropper threw.
 * @returns {string} warning line for `report.warnings`.
 */
function figureFailureWarning(pageIndex, label, error) {
  const reason = error instanceof Error ? error.message : String(error)
  return `page ${pageIndex + 1}: figure ${label} could not be cropped from the page image `
    + `(${reason.slice(0, 200)}); its caption is kept without the illustration`
}

/**
 * One model call plus parse, recording its spend in the caller's ledger.
 *
 * The ledger is shared by every attempt on a page; a private one here would be
 * thrown away by the caller and the run's token total would stay at zero.
 *
 * Every request carries the run's `sessionId`, because the routing header it
 * feeds is mandatory rather than optional: `opencode-go` rejects a call that
 * arrives without `x-opencode-session` with `400 MissingSessionID`, and the
 * provider uses that id both to route the request and to keep a prompt-prefix
 * cache. What the id has to be is *stable and opaque*, not *a real DSH Session*:
 * a caller-supplied Session id is used when there is one (the tool path forwards
 * the calling Agent's own id), and otherwise the book's derived
 * `pdf2epub-<bookId>` plays the same role for every page of the run — see
 * {@link resolveSessionId}. One id per book is the point: a per-page or random
 * value would route every page as a new conversation and lose the cached prefix
 * each page's prompt reuses.
 *
 * @param {object} args - call job.
 * @param {Map<string, string>} [args.reasoningEfforts] - `provider/model` to the reasoning level resolved for it at start-up.
 * @returns {Promise<{ page: object, ledger: object }>} parsed page and its spend. The
 *   page carries `failureKind` (`'transport'`, `'unparsable'`, `'reasoning-budget'`,
 *   or `null`) so the caller can classify an empty page without re-parsing the
 *   model's reply.
 */
async function transcribeOnce(args) {
  const { host, route, prompt, image, maxTokens, sessionId, signal, extra, reasoningEfforts } = args
  const ledger = args.ledger ?? emptyLedger()
  const user = extra === undefined ? prompt.user : `${prompt.user}\n${extra}`
  const outcome = await callModel(host, {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    user,
    image,
    maxTokens,
    // From the route's own capability report, never guessed: an unsupported level
    // makes the Host throw UNSUPPORTED_REASONING_EFFORT.
    reasoningEffort: reasoningEfforts?.get(`${route.provider}/${route.model}`),
    // The provider's per-session routing header derives from this; it is never
    // absent, and never different between two pages of the same book.
    sessionId,
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
  const reasoningChars = Number.isInteger(outcome.reasoningChars) ? outcome.reasoningChars : 0
  // `failureKind` is how a page that produced nothing says which kind of nothing:
  // the call failed (transport), the reply never became JSON (unparsable), the
  // answer was crowded out by reasoning (reasoning-budget), or the reply parsed
  // and carried no blocks (classified by `classifyFailure()`).
  if (outcome.error !== null) {
    // A structured tag from `callModel` beats matching the error text: the same
    // "no text" message means different fixes, and only the bridge knows which
    // one happened.
    const failureKind = outcome.failureKind === 'reasoning-budget' ? 'reasoning-budget' : 'transport'
    return {
      page: { blocks: [], notes: '', raw: '', error: outcome.error, failureKind, finishKind, truncated, reasoningChars },
      ledger,
    }
  }
  try {
    const parsed = parsePageJson(outcome.text)
    return { page: { ...parsed, raw: outcome.text, failureKind: null, finishKind, truncated, reasoningChars }, ledger }
  } catch (error) {
    // A truncated reply is not a malformed reply: name the token budget, or the
    // report sends the reader hunting for a JSON bug that is really a size cap.
    // `maxTokens` is the answer budget; the ceiling actually sent to the provider
    // carries the reasoning headroom on top of it (see `REASONING_HEADROOM`).
    const message = truncated
      ? `${error.message} (response stopped at maxTokens: ${maxTokens} + ${REASONING_HEADROOM} reasoning headroom)`
      : error.message
    return {
      page: { blocks: [], notes: '', raw: outcome.text, error: message, failureKind: 'unparsable', finishKind, truncated, reasoningChars },
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
 * The one exception is a measured blank page (`blank-page`): it contributes no
 * text either, but that is the right answer for the page, so it is counted in
 * `stats.pagesBlank` instead, stays out of `pagesFailed`/`pagesDegraded`, and is
 * cached (see {@link pageCacheable}).
 *
 * The same builder serves the diagnostic report written for a run that produced
 * no book at all (`failed: true`, `chapters: []`): same keys, same page entries,
 * so a reader can diff a failure against a success, and 0 chapters instead of
 * the placeholder chapter `buildChapters()` would otherwise hand back. `outputs`
 * and `bookJsonPath` are null there because neither file was written.
 *
 * @param {object} args - report inputs.
 * @param {string} args.bookDir - absolute directory this book's artifacts live in.
 * @param {string} args.outputName - the sanitised name both the directory and the three files carry.
 * @param {boolean} args.alongsideInput - true when `bookDir` sits in the PDF's own directory.
 * @param {number} [args.figuresExtracted] - figures actually embedded (see `stats.figuresExtracted`).
 * @param {string[]} [args.figureWarnings] - figures that fell back to caption-only.
 * @param {string[]} [args.pathWarnings] - warnings about where the artifacts live (legacy page-cache migration, a cover that could not be written next to the book).
 * @param {object | null} [args.selection] - resolved page selection, or null for a whole-book run.
 * @param {boolean} [args.cover] - true when a cover image was embedded.
 * @param {{ width: number | null, height: number | null } | null} [args.coverSize] - the size the cover render produced.
 * @param {string | null} [args.coverWarning] - why the requested cover is missing, when it is.
 * @param {boolean} [args.failed] - true for the report of a run that produced no book text.
 * @returns {object} the report object, ready to serialise.
 */
function buildReport(args) {
  const { input, epubPath, reportPath, bookJsonPath, bookDir, outputName, alongsideInput, title, author, publisher, language, pdf, pages, flattened, chapters, tokens, cachedPages, startedAt, primaryRoute, reviewRoutes, requestedDpi, dpi, failed = false } = args
  const figuresExtracted = Number.isInteger(args.figuresExtracted) ? args.figuresExtracted : 0
  const figureWarnings = Array.isArray(args.figureWarnings) ? args.figureWarnings : []
  const pathWarnings = Array.isArray(args.pathWarnings) ? args.pathWarnings : []
  const selection = args.selection ?? null
  const cover = args.cover === true
  const coverSize = args.coverSize ?? null
  const coverWarning = typeof args.coverWarning === 'string' && args.coverWarning !== '' ? args.coverWarning : null
  const list = pages.filter(Boolean)
  // A blank page is not a failed page: it has no book text, but the emptiness is
  // a fact about the book, not something the conversion got wrong. It is counted
  // on its own (`stats.pagesBlank`) and kept out of every failure count and
  // warning, so a run that hit three real blank pages reports no failure at all.
  const blankPages = list.filter(page => isBlankPage(page))
  const failedPages = list.filter(page => !isBlankPage(page) && !pageHasBookText(page))
  // One count per failure class: the four causes have different fixes, so the
  // report must not fold them into `pagesFailed` alone. Their sum can stay below
  // `pagesFailed` - a reply that is nothing but page furniture fails without
  // being any of the four (see `failureCounts()`).
  const counts = failureCounts(failedPages)
  const failureWarning = pagesFailedWarning(failedPages)
  const reasoningWarning = reasoningBudgetWarning(counts)
  return {
    schema: 'dsh-pdf2epub/report@1',
    generatedAt: new Date().toISOString(),
    input,
    outputs: { epub: epubPath, report: reportPath, book: bookJsonPath },
    bookJsonPath,
    // `pages` stays the size of the DOCUMENT and `pagesSelected` says how much of
    // it this run covered, so a 40-page batch of a 765-page book reads
    // "pages 765, pagesSelected 40" instead of pretending the book is 40 pages.
    book: {
      title,
      author,
      // Absent when neither the request nor the PDF had one; `JSON.stringify`
      // drops the key, so a report on a book without a publisher has no field to
      // misread as "unknown publisher".
      ...(publisher === undefined ? {} : { publisher }),
      language,
      pages: pdf.pageCount,
      pagesSelected: selection === null ? pdf.pageCount : selection.resolved.length,
      chapters: chapters.length,
      cover,
      // Where the artifacts are, so a caller does not have to re-derive the
      // sanitised directory name from the input path. `outputName` is the name the
      // directory AND the three files carry; `alongsideInput` says whether that
      // directory is the PDF's own (the default) or a caller-chosen `outputDir`.
      directory: bookDir,
      outputName,
      alongsideInput,
    },
    // The selection is echoed so a batched report can be matched to the request
    // that produced it; null means "the whole document".
    selection,
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
      // Pages that are *visually blank* (measured ink below the threshold) and
      // whose empty answer was therefore accepted. They count here and nowhere
      // else: not in `pagesFailed`, not in `pagesDegraded`, not in `pagesEmpty`,
      // and they do not produce the "produced no text" warning.
      pagesBlank: blankPages.length,
      // How the pages that produced no text split up: parsed to zero blocks
      // (`pagesEmpty`), parsed to something that is not JSON (`pagesUnparsable`),
      // never answered at all (`pagesTransportFailed`), or answered only with
      // reasoning (`pagesReasoningBudget`). A blank page is none of these.
      pagesEmpty: counts['empty-blocks'],
      pagesUnparsable: counts.unparsable,
      pagesTransportFailed: counts.transport,
      // The call worked and the model really produced tokens, but all of them
      // went to reasoning: a token-budget problem, not a provider or prompt one.
      pagesReasoningBudget: counts['reasoning-budget'],
      blocks: flattened.blocks.length,
      blocksDropped: flattened.dropped,
      // `h1`/`h2` blocks that were not chapter titles after all: running heads the
      // model typed as headings, and repeated chapter-level titles (see
      // `flattenPages`). They are part of `blocksDropped` too; this number exists
      // so a QC pass can see the defect was recognised instead of silently losing
      // structure.
      demotedHeadings: flattened.demotedHeadings,
      // Headings that were really the rest of the paragraph above - one sentence
      // printed across a page break, whose second half the model set apart and
      // reported as an `h2`/`h3` (`…他真是` | `一个勇士！`). They were sewn back
      // into that paragraph, so the book has neither a broken sentence nor a bold
      // fragment standing in it. Not part of `blocksDropped`: the text is kept.
      headingsAsProse: flattened.proseHeadings,
      blocksJoined: flattened.joined,
      blocksRejectedJoins: flattened.rejectedJoins,
      chapters: chapters.length,
      // Pictures, not figure blocks: a figure the model boxed and the renderer
      // cropped, whose bytes are in the archive. Caption-only figures (no bbox,
      // rejected bbox, or a failed crop) are not counted.
      figuresExtracted,
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
    // code the report does not own. A report written for a run that produced no
    // book says so in its own words as well: it is the run's only artifact.
    warnings: [
      ...(failureWarning === null ? [] : [failureWarning]),
      ...(reasoningWarning === null ? [] : [reasoningWarning]),
      ...figureWarnings,
      // Where the files went: a legacy page cache that could not be moved, or a
      // cover that could not be written beside the book. Neither costs a page.
      ...pathWarnings,
      ...(coverWarning === null ? [] : [coverWarning]),
      ...(failed === true ? [NO_BOOK_TEXT_WARNING] : []),
    ],
    limitations: {
      images: 'figures are cropped from the page bitmap when the model supplies a usable bbox; '
        + 'a figure without one keeps its caption only, and the page bitmap itself is never embedded',
      layout: `one book, one directory: the EPUB, its two JSON sidecars, the page cache under pages/ and `
        + `the pictures under images/ all live in ${bookDir}`,
      cover: cover
        // The report states the size the renderer actually produced: the 1400px
        // target is a request, and the page box plus whole-DPI rounding decide
        // the number that lands in the archive (1403px is one DPI step away from
        // 1390px). Claiming the target here would contradict the file.
        ? `the cover is page 1 of the PDF rendered as a PNG ${coverSizeText(coverSize)}`
          + ' (the target is 1400px on its long edge; the page box and whole-DPI rounding decide the '
          + 'exact size); it is not a page of the text'
        : 'no cover image is embedded, so a shelf view shows the placeholder of the reader',
      selection: selection === null
        ? 'this run covered the whole document'
        : 'this run covered a page selection: the pages outside it are neither transcribed nor embedded, '
          + 'but their page cache entries are untouched and a later run reuses them',
    },
    pages: list.map(page => reportPage(page)),
  }
}

/**
 * One page's entry in the report.
 *
 * `error` says what happened; `failure` says which family it belongs to; `raw` is
 * the opening of the model's own reply. `raw` is attached only when the page
 * produced no book text - on a healthy page it would be a second copy of the
 * book, and the report is meant to describe the run, not archive it.
 * `reasoningChars` is kept for every page: on a page whose answer was crowded out
 * by thinking it is the only surviving measure of what the model did spend the
 * budget on, and on a normal page it says whether thinking ran at all.
 *
 * @param {object} page - page record.
 * @returns {object} report entry.
 */
function reportPage(page) {
  const failure = page.failure ?? null
  const error = page.error ?? null
  return {
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
    reasoningChars: Number.isInteger(page.reasoningChars) ? page.reasoningChars : 0,
    image: page.image,
    issues: page.issues,
    // `{ bbox, href, bytes }` per embedded picture; empty for a caption-only
    // figure, so the report says whether the plate made it into the book.
    figures: Array.isArray(page.figures) ? page.figures : [],
    // One of `empty-blocks` / `unparsable` / `transport` / `reasoning-budget` /
    // `blank-page`; null for a normal page.
    failure,
    // True for a page that is visually blank: the model's empty answer was
    // correct, `ok` is true and the page is cached. False everywhere else.
    blank: page.blank === true,
    // The failure text, so a reader can tell "the model was rate limited" from
    // "the page really is blank"; null when the page came back normally.
    error,
    ...(error === null && failure === null ? {} : { raw: page.raw ?? '' }),
    ms: page.ms,
  }
}

/**
 * Why one attempt ended up with no usable block list, or null when it is fine.
 *
 * The four shapes need different fixes, which is why they are told apart: a reply
 * that parsed into `blocks: []` means the model found no text where the book has
 * some (a scan problem or a prompt problem); a reply that never became JSON means
 * the wrong model answered or the answer was cut off; a call that failed before
 * returning anything (rate limit, timeout, an empty stream) never reached the
 * parser at all; and `reasoning-budget` is the call that worked but whose answer
 * was crowded out by the thinking phase, which a bigger `maxTokens` fixes rather
 * than a look at the provider.
 *
 * @param {{ blocks?: unknown, failureKind?: unknown } | null | undefined} attempt - a page as `transcribeOnce()` returned it.
 * @returns {'empty-blocks' | 'unparsable' | 'transport' | 'reasoning-budget' | null} the failure class.
 */
function classifyFailure(attempt) {
  const tagged = attempt?.failureKind
  if (tagged === 'transport' || tagged === 'unparsable' || tagged === 'reasoning-budget') return tagged
  // A cached page record (or any attempt that parsed cleanly) has no tag: an
  // empty block list there is the `empty-blocks` case, a non-empty one is normal.
  return Array.isArray(attempt?.blocks) && attempt.blocks.length > 0 ? null : 'empty-blocks'
}

/**
 * Decide whether a page the model answered with no blocks at all is truly blank.
 *
 * The ink share comes from {@link INK_DPI} rendering of the same page (see
 * `pageInkRatio()` in `src/pdf/index.js`): an empty content stream draws nothing,
 * so a blank page measures 0.000, while one line of body text already measures a
 * couple of percent. Below {@link BLANK_PAGE_INK_RATIO} the model's empty answer
 * is accepted as correct; at or above it the page keeps the old failure
 * behaviour.
 *
 * Failing to measure is NOT evidence of a blank page: a renderer error, a
 * non-numeric answer or a page handle that will not load all return false, so the
 * page stays the failure it was. The alternative - treating "we could not look"
 * as "there is nothing there" - would silently cache a page that may be full of
 * text as empty, which is exactly the silent-page-loss shape the cache gate
 * exists to prevent.
 *
 * @param {((pageIndex: number) => number) | undefined} measureInk - ink seam.
 * @param {number} pageIndex - 0-based page index.
 * @returns {Promise<boolean>} true when the page is blank and the page record may say so.
 */
async function blankPageVerdict(measureInk, pageIndex) {
  if (typeof measureInk !== 'function') return false
  let ratio
  try {
    // `await` on purpose: the real seam is synchronous, a test's may not be.
    ratio = Number(await measureInk(pageIndex))
  } catch {
    return false
  }
  if (!Number.isFinite(ratio) || ratio < 0) return false
  return Math.min(1, ratio) < BLANK_PAGE_INK_RATIO
}

/**
 * Count failed pages by failure class.
 *
 * `other` covers a page that produced no book text without being one of the four
 * classes - a reply consisting only of page furniture, or blocks whose text is
 * empty - so the counts always add up to `pagesFailed`.
 *
 * @param {{ failure?: string | null }[]} failedPages - pages that produced no book text.
 * @returns {{ 'empty-blocks': number, unparsable: number, transport: number, 'reasoning-budget': number, other: number }} counts.
 */
function failureCounts(failedPages) {
  const counts = { 'empty-blocks': 0, unparsable: 0, transport: 0, 'reasoning-budget': 0, other: 0 }
  for (const page of failedPages) {
    const failure = page?.failure
    if (failure === 'empty-blocks' || failure === 'unparsable' || failure === 'transport' || failure === 'reasoning-budget') {
      counts[failure] += 1
    } else {
      counts.other += 1
    }
  }
  return counts
}

/**
 * The first {@link RAW_EXCERPT_CHARS} characters of a model reply, marked with an
 * ellipsis when there was more.
 *
 * One reply is a few kilobytes at most, but a report can describe thousands of
 * pages, and the field exists to show the shape of the answer - a refusal, prose,
 * a JSON object that parsed to nothing - not to archive it.
 *
 * @param {unknown} value - model reply text.
 * @returns {string} the excerpt.
 */
function rawExcerpt(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length > RAW_EXCERPT_CHARS ? `${text.slice(0, RAW_EXCERPT_CHARS)}…` : text
}

/**
 * Write the diagnostic report of a run that produced no book text.
 *
 * Returns the clause for the error message instead of throwing: a write failure
 * (a read-only output directory) must not replace the conversion's own diagnosis
 * with an EACCES, and the message still names the path either way.
 *
 * @param {string} reportPath - absolute path of the report to write.
 * @param {object} report - report object.
 * @returns {Promise<string>} `diagnostics written to <path>`, or why it could not be.
 */
async function writeDiagnosticReport(reportPath, report) {
  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    return `diagnostics written to ${reportPath}`
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `diagnostics could not be written to ${reportPath}: ${reason}`
  }
}

/**
 * One human-readable sentence about the pages that produced no text, or null.
 * Page numbers are capped so a broken 400-page run cannot produce a novel.
 *
 * The classification clause is what makes this sentence actionable: "6 pages
 * produced no text: 6 returned empty blocks" points at the scan or the prompt,
 * "6 returned unparsable JSON" points at the model or the schema, "6 failed
 * with a transport error" points at the provider, and "6 ran out of output budget
 * on reasoning" points at the token budget - which {@link reasoningBudgetWarning}
 * then spells out, because that one is a setting rather than a fault.
 *
 * @param {{ page: number, failure?: string | null }[]} failedPages - failed page records, in page order.
 * @returns {string | null} warning text, or null when every page produced text.
 */
function pagesFailedWarning(failedPages) {
  if (failedPages.length === 0) return null
  const listed = failedPages.slice(0, 10).map(page => page.page).join(', ')
  const numbers = failedPages.length > 10 ? `${listed}, …` : listed
  const noun = failedPages.length === 1 ? 'page' : 'pages'
  return `${failedPages.length} ${noun} produced no text${failureBreakdown(failedPages)} (page ${numbers}); `
    + 'failed pages are not cached, so running this conversion again retries them'
}

/**
 * A second sentence for a run whose failures were caused by the thinking budget,
 * or null when none were.
 *
 * The summary already says how many pages ran out of budget on reasoning; this
 * says what to do about it. It is worth its own line because the fix is a setting
 * rather than a bug hunt: on a route that cannot disable thinking, `maxTokens` is
 * the only lever the settings expose, and without this sentence a reader would go
 * looking for a scan or prompt problem instead. It only ever appears when such a
 * page exists, so a healthy run's `warnings` stays empty.
 *
 * @param {ReturnType<typeof failureCounts>} counts - failure counts of the run.
 * @returns {string | null} warning text, or null when no page lost its answer to reasoning.
 */
function reasoningBudgetWarning(counts) {
  const pages = counts['reasoning-budget']
  if (pages === 0) return null
  const noun = pages === 1 ? 'page' : 'pages'
  return `${pages} ${noun} returned no text because the reasoning phase left nothing for the answer; `
    + 'this model cannot disable reasoning, so raise maxTokens in the advanced settings'
}

/**
 * The classification clause of {@link pagesFailedWarning}, including its colon:
 * `": 3 returned empty blocks, 2 returned unparsable JSON, 1 failed with a
 * transport error"`, or `''` when nothing was classified.
 *
 * "Transport" rather than "HTTP" on purpose: the class covers a 429, an aborted
 * stream, a network error and an empty answer alike, and naming one of those
 * causes for all of them would send the reader looking in the wrong place.
 *
 * @param {{ failure?: string | null }[]} failedPages - failed page records.
 * @returns {string} clause to append, or the empty string.
 */
function failureBreakdown(failedPages) {
  const counts = failureCounts(failedPages)
  const parts = []
  if (counts['empty-blocks'] > 0) parts.push(`${counts['empty-blocks']} returned empty blocks`)
  if (counts.unparsable > 0) parts.push(`${counts.unparsable} returned unparsable JSON`)
  if (counts.transport > 0) parts.push(`${counts.transport} failed with a transport error`)
  if (counts['reasoning-budget'] > 0) parts.push(`${counts['reasoning-budget']} ran out of output budget on reasoning`)
  if (counts.other > 0) parts.push(`${counts.other} returned no usable blocks`)
  return parts.length === 0 ? '' : `: ${parts.join(', ')}`
}

/**
 * True when a page is a measured blank page (see {@link blankPageVerdict}).
 *
 * The flag is written by `transcribePage()` and survives in the page cache, so a
 * cached blank page is recognised on every later run without measuring anything
 * again.
 *
 * @param {object | null | undefined} page - a page record.
 * @returns {boolean} true only for a page explicitly marked blank.
 */
function isBlankPage(page) {
  return page !== null && typeof page === 'object' && page.blank === true
}

/**
 * True when a page produced book text, which is the condition for writing its
 * resume-cache entry - see {@link pageCacheable} for the blank-page exception.
 *
 * All three parts are load-bearing: an empty block list is a failed call; an
 * `error` marks a failed or cancelled call; and a page consisting only of page
 * furniture contributes no book text because `flattenPages()` drops those
 * blocks, so caching it would still leave a hole in the next run's book.
 *
 * @param {object | null | undefined} page - a page record.
 * @returns {boolean} true when the page may enter the book.
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
 * True when a page may be written to the resume cache.
 *
 * This is {@link pageHasBookText} plus the one exception the blank-page fix
 * needs: a measured blank page is cached with `blocks: []` and `blank: true`,
 * because that empty list is the correct answer and re-transcribing it on every
 * run is pure cost. The exception cannot be used to smuggle a failure in: the
 * record must still carry no `error` and must really have zero blocks, so a page
 * that came back with a truncated reply or a 429 is still never cached.
 *
 * @param {object | null | undefined} page - a page record.
 * @returns {boolean} true when the page may enter the cache.
 */
function pageCacheable(page) {
  if (isBlankPage(page)) {
    return (page.error ?? null) === null && Array.isArray(page.blocks) && page.blocks.length === 0
  }
  return pageHasBookText(page)
}

/**
 * The first readable metadata value, with XML-illegal code points removed.
 *
 * The order the callers pass is the priority order: the caller's own request,
 * then the PDF's own metadata, then the file name. A blank value is treated as
 * absent, so an empty string handed to the tool does not shadow a real title.
 *
 * @param {...unknown} candidates - values in priority order.
 * @returns {string} the first cleaned, non-empty value, or `''`.
 */
function firstMetadataText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const text = stripIllegalXml(candidate).trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * Characters a hand-typed page expression may use for "and" and for a range.
 *
 * The expression is typed by a human on a Chinese keyboard, so the full-width
 * comma, the ideographic comma and the several dashes a Chinese IME produces are
 * all accepted as their ASCII equivalents. Normalising them here (instead of
 * rejecting them) keeps the error messages about real mistakes.
 */
const PAGE_EXPRESSION_SEPARATORS = /[，、;；]/g
const PAGE_EXPRESSION_DASHES = /[–—－~～﹣]/g

/** Full-width digits a Chinese IME produces, mapped back to ASCII. */
function asciiDigits(value) {
  return value.replace(/[\uff10-\uff19]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
}

/**
 * Parse one page expression such as `"1-5,31-35,73"`.
 *
 * Grammar: comma-separated tokens, each either a single 1-based page number or an
 * inclusive `first-last` range. The result is sorted ascending and de-duplicated,
 * so `"3,1-2,2"` is exactly `[1, 2, 3]` and a caller cannot accidentally make the
 * pipeline transcribe a page twice.
 *
 * @param {unknown} expression - the `pages` / `excludePages` value.
 * @param {number} pageCount - pages in the document, for the bounds check.
 * @param {string} optionName - option name, used in every error message.
 * @returns {number[]} ascending, unique, in-range 1-based page numbers.
 * @throws {Error} on bad syntax, a reversed range, an out-of-range page or an empty expression.
 */
function parsePageList(expression, pageCount, optionName) {
  const source = String(expression ?? '')
  const text = asciiDigits(source.replace(PAGE_EXPRESSION_SEPARATORS, ',').replace(PAGE_EXPRESSION_DASHES, '-')).trim()
  if (text === '') {
    throw new Error(`pdf2epub: "${optionName}" is empty; give pages as "1-5,31-35,73", or omit the option to use every page`)
  }
  const pages = new Set()
  for (const rawToken of text.split(',')) {
    const token = rawToken.trim()
    if (token === '') {
      throw new Error(`pdf2epub: "${optionName}" has an empty entry in ${JSON.stringify(source)}; `
        + 'pages are separated by single commas, as in "1-5,31-35,73"')
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token)
    const singleMatch = rangeMatch === null ? /^(\d+)$/.exec(token) : null
    if (rangeMatch === null && singleMatch === null) {
      throw new Error(`pdf2epub: "${optionName}" cannot read ${JSON.stringify(token)} from ${JSON.stringify(source)}; `
        + 'each entry must be a page number ("73") or an inclusive range ("31-35")')
    }
    const first = Number(rangeMatch === null ? singleMatch[1] : rangeMatch[1])
    const last = Number(rangeMatch === null ? singleMatch[1] : rangeMatch[2])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
      throw new Error(`pdf2epub: "${optionName}" uses ${JSON.stringify(token)}, which is not a usable page number`)
    }
    if (first < 1 || last < 1) {
      throw new Error(`pdf2epub: "${optionName}" uses ${JSON.stringify(token)}, but page numbers start at 1`)
    }
    if (first > last) {
      throw new Error(`pdf2epub: "${optionName}" names the range ${JSON.stringify(token)}, which runs backwards; `
        + 'write the first page of the range first ("5-9", not "9-5")')
    }
    if (last > pageCount) {
      throw new Error(`pdf2epub: "${optionName}" names page ${last} of ${JSON.stringify(token)}, `
        + `but this document has ${pageCount} page${pageCount === 1 ? '' : 's'} (1-${pageCount})`)
    }
    for (let page = first; page <= last; page += 1) pages.add(page)
  }
  return [...pages].sort((left, right) => left - right)
}

/**
 * The pages one run converts, as 0-based indices plus what the report says.
 *
 * `pages` narrows the run to a subset; `excludePages` is subtracted from whatever
 * that subset is (or from the whole document when `pages` is absent). The
 * resolved set is never empty: an expression that removes every page is a caller
 * error rather than a run that silently writes an empty book.
 *
 * This is the batching seam, and it deliberately does not touch the cache: the
 * page directory is still keyed by the whole book plus the page number (see
 * {@link settingsFingerprint}), so a batch and the final whole-book run share
 * every page they have in common.
 *
 * @param {object} spec - run request.
 * @param {number} pageCount - pages in the document.
 * @returns {{ indices: number[], pages: number[], info: object | null }} 0-based indices, the
 *   same pages 1-based, and the report's description of the selection (null for a whole-book run).
 * @throws {Error} when an expression is malformed or the selection is empty.
 */
function resolvePageSelection(spec, pageCount) {
  const requested = spec?.pages === undefined ? null : parsePageList(spec.pages, pageCount, 'pages')
  const excluded = spec?.excludePages === undefined ? null : parsePageList(spec.excludePages, pageCount, 'excludePages')
  const removed = new Set(excluded ?? [])
  const chosen = (requested ?? range(1, pageCount + 1)).filter(page => !removed.has(page))
  if (chosen.length === 0) {
    const detail = requested === null
      ? `"excludePages" removes every page of this ${pageCount}-page document`
      : `"excludePages" removes all ${requested.length} page(s) named by "pages"`
    throw new Error(`pdf2epub: the page selection is empty: ${detail}`)
  }
  return {
    indices: chosen.map(page => page - 1),
    pages: chosen,
    // A whole-book run reports no selection at all, so a reader can tell "the
    // book has 765 pages and all of them were converted" from "40 of 765".
    info: requested === null && excluded === null
      ? null
      : {
        pages: requested === null ? null : String(spec.pages),
        excludePages: excluded === null ? null : String(spec.excludePages),
        resolved: chosen,
      },
  }
}

/**
 * Render page 1 as the EPUB cover image.
 *
 * The page bitmap is the only picture this plugin can produce - the renderer
 * emits PNG and nothing else - so the cover is a PNG whose long edge lands as
 * close to {@link COVER_LONG_EDGE} as a whole DPI can get. The DPI that gets
 * there is derived from the page box (points are 1/72 inch) instead of rendering
 * at the transcription DPI and downscaling, which would need an image library
 * this package does not have.
 *
 * Whole-DPI rounding is what makes the target unreachable exactly: an A4 page is
 * 1403px tall at 120 DPI and 1391px at 119, so the loop below renders once more
 * at the neighbouring DPI and keeps that result only when it is closer to the
 * target *and* does not overshoot it. The size that was kept is returned so the
 * report can state it instead of repeating the target.
 *
 * @param {object} pdf - open PDF handle.
 * @param {(dpi: number) => Promise<{ png: Uint8Array, width: number, height: number }>} renderPage -
 *   page-1 renderer (`pdf.renderPage(0, ...)`, or the caller's seam).
 * @returns {Promise<{ href: string, mediaType: string, data: Uint8Array, width: number, height: number }>}
 *   asset for `buildEpub`, plus the rendered size.
 * @throws {Error} when page 1 cannot be rendered (the caller turns that into a warning).
 */
async function renderCoverImage(pdf, renderPage) {
  const info = pdf.info()
  const longEdgePoints = Math.max(Number(info?.pageWidth) || 0, Number(info?.pageHeight) || 0)
  if (longEdgePoints <= 0) throw new Error('page 1 has no usable page box')
  const target = Math.max(1, Math.round((COVER_LONG_EDGE * 72) / longEdgePoints))
  let rendered = await renderPage(target)
  let longEdge = Math.max(rendered.width, rendered.height)
  if (longEdge > 0 && longEdge !== COVER_LONG_EDGE) {
    // One neighbour only: ceil when the render came out short, floor when it
    // overshot. A second render costs one page bitmap, and the result is kept
    // only if it is the better of the two - inside the target if either is, and
    // closer to it otherwise.
    const ratio = COVER_LONG_EDGE / longEdge
    const candidate = Math.max(1, ratio > 1 ? Math.ceil(target * ratio) : Math.floor(target * ratio))
    if (candidate !== target) {
      const retry = await renderPage(candidate)
      const retryEdge = Math.max(retry.width, retry.height)
      if (isBetterCoverEdge(retryEdge, longEdge)) {
        rendered = retry
        longEdge = retryEdge
      }
    }
  }
  if (!(rendered.png instanceof Uint8Array) || rendered.png.length === 0) {
    throw new Error('the renderer produced no PNG bytes for page 1')
  }
  return {
    href: COVER_HREF,
    mediaType: 'image/png',
    data: rendered.png,
    width: Number(rendered.width) || 0,
    height: Number(rendered.height) || 0,
  }
}

/**
 * `dcterms:modified` for one run: the caller's value, or the input file's mtime.
 *
 * The fallback is deliberately not `Date.now()`. Reproducibility is a contract of
 * this module (`build.js` fixes the zip mtime for the same reason): rebuilding a
 * book from its page cache is supposed to produce the same archive, and a wall
 * clock would make every rerun differ in one metadata field. The input file's own
 * modification time is a real date, is stable for as long as the source is, and
 * is what the book was produced from. `buildEpub` still rejects anything that is
 * not a usable date, so a bad `spec.modified` fails loudly at the edge.
 *
 * @param {unknown} explicit - `spec.modified`, when the caller supplied one (`Date` or ISO 8601).
 * @param {{ mtimeMs?: number } | null} info - `stat` result for the input file.
 * @returns {string} `YYYY-MM-DDThh:mm:ssZ`.
 */
function resolveModified(explicit, info) {
  const asIso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (explicit instanceof Date && !Number.isNaN(explicit.getTime())) return asIso(explicit)
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const mtime = Number.isFinite(info?.mtimeMs) ? info.mtimeMs : Date.now()
  return asIso(new Date(Math.trunc(mtime / 1000) * 1000))
}

/**
 * The cover size as the report states it, e.g. `960×1390px`.
 * @param {{ width: number | null, height: number | null } | null} size - rendered cover size.
 * @returns {string} a human-readable size, or a phrase when the size is unknown.
 */
function coverSizeText(size) {
  const width = Number(size?.width)
  const height = Number(size?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'on page 1 of the PDF'
  }
  return `${Math.trunc(width)}×${Math.trunc(height)}px`
}

/**
 * Whether `candidate` is a better cover long edge than `current`.
 *
 * The 1400px target is a ceiling first and a goal second: a size above
 * {@link COVER_LONG_EDGE} loses to any size below it, and between two sizes on
 * the same side of the target the one nearer it wins. Whole-DPI rounding puts
 * 1403 and 1391 one DPI apart on the same A4 page, so both sides have to be
 * compared, not just the overshoot.
 *
 * @param {number} candidate - long edge of the retry.
 * @param {number} current - long edge of the first render.
 * @returns {boolean} true when the retry should replace the first render.
 */
function isBetterCoverEdge(candidate, current) {
  if (!(candidate > 0)) return false
  if (!(current > 0)) return true
  const candidateInside = candidate <= COVER_LONG_EDGE
  const currentInside = current <= COVER_LONG_EDGE
  if (candidateInside !== currentInside) return candidateInside
  return candidateInside ? candidate > current : candidate < current
}

/**
 * Fingerprint of the input file: absolute path, size and mtime.
 *
 * A content hash of the whole book would be more exact but costs a full read on
 * every run, which is heavier than the transcription it protects; size+mtime is
 * enough to make "a different file now sits at this path" a different cache
 * entry, and that is the stale-cache failure this guards against. The value is
 * written into every cache entry as `input` and compared on the way back in (see
 * `cacheProblem()`), which is where the separation between two books lives now
 * that the directory is named after the file instead of after this hash.
 *
 * @param {string} inputPath - resolved absolute input path.
 * @param {{ size: number, mtimeMs: number }} info - `stat` result for the input.
 * @returns {string} 12 hex characters, safe as a path segment.
 */
function inputFingerprint(inputPath, info) {
  const size = Number.isFinite(info?.size) ? info.size : 0
  const mtime = Number.isFinite(info?.mtimeMs) ? Math.trunc(info.mtimeMs) : 0
  return createHash('sha256').update(`${inputPath}\u0000${size}\u0000${mtime}`).digest('hex').slice(0, 12)
}

/**
 * Fingerprint of the settings that produced a page: effective DPI and the
 * primary route. `PROMPT_VERSION` and the input fingerprint are part of the same
 * conceptual key, but both are enforced by `readCache()`'s payload check instead
 * of the directory name, so bumping one heals every stale entry in place rather
 * than orphaning a directory per version.
 *
 * The page selection (`pages` / `excludePages`) is deliberately NOT part of this
 * key. An entry means "page N of this book, produced with these settings", which
 * is just as true when the page came out of a 40-page batch as when it came out of
 * the final whole-book run - and that is the whole point of batching a 700-page
 * scan. Folding the selection in would make every batch a cold start, and the user
 * would then be tempted to split the PDF instead, which changes
 * {@link inputFingerprint} and throws the entire cache away.
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

/* -------------------------------------------------------------------------- */
/* The book's output directory                                                */
/* -------------------------------------------------------------------------- */

/**
 * Longest book directory name, counted in characters rather than bytes.
 *
 * The name is the input file's own stem, and a real book's file name is long: a
 * `巴布尔回忆录 (（印）巴布尔著, 巴布爾 (Babur, Emperor of Hindustan etc.)…` is
 * one file, and a tight cap would cut away the part a human recognises. 100 is
 * the budget that still fits: the deepest path this plugin builds is
 * `<bookDir>/pages/<dpi>-<provider>_<model>/00001.json`, roughly 50 more
 * characters, so this plus that stays inside Windows' 260-character MAX_PATH for
 * any sane output directory. Counted in code points, not bytes - a byte budget
 * would cut a Chinese title at about 33 characters - and never in the middle of a
 * surrogate pair, which is why the cut uses `[...value]`.
 */
const MAX_BOOK_DIR_CHARS = 100

/**
 * Characters Windows forbids in a file or directory name.
 *
 * `\ / : * ? " < > |` are the illegal ones, and the C0 controls (plus DEL and the
 * C1 range) are rejected as well. They are all replaced with `_` rather than
 * dropped, so `A/B` and `A B` cannot collapse onto one directory by accident.
 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g

/** Names Windows reserves for devices, whether or not an extension follows them. */
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * The directory one book's artifacts live in, derived from the input file's name.
 *
 * WHY THE FILE NAME AND NOT THE TITLE: a title can come from the caller on one
 * run and from the PDF's own metadata (`/Title`) on the next, so a directory named
 * after it moves under the same input file - a resumed run would miss the cache
 * that was right there. The file name is stable, predictable, and already means
 * "this book" to the person who saved it, so `<outputDir>/<pdf file name>/` is a
 * directory a user can point at and recognise.
 *
 * The rules are Windows': illegal characters and control characters become `_`,
 * trailing dots and spaces are dropped (Windows cannot keep them), a reserved
 * device name gets a `_` inside its stem, and the whole name is capped at
 * {@link MAX_BOOK_DIR_CHARS} characters with the head kept. A name that sanitises
 * to nothing at all becomes `book`, which is the one case where the result does
 * not describe the input.
 *
 * @param {string} fileNameStem - the input file's name WITHOUT its extension, as
 *   `path.basename(inputPath, path.extname(inputPath))` produces it. The caller
 *   strips the extension, not this function: a stem may legitimately contain dots
 *   (`第1卷.上册`), so guessing where an extension starts would corrupt it.
 * @returns {string} a directory name that is legal on Windows and never empty.
 */
export function bookDirectoryName(fileNameStem) {
  const safe = sanitizeDirectoryName(fileNameStem)
  // Only reachable when the input file is named entirely out of dots and spaces
  // (`...`), or when the caller passes something empty. A directory still has to
  // exist, so the name falls back to a constant rather than throwing.
  return safe === '' ? 'book' : safe
}

/**
 * One candidate directory name, sanitised for Windows, or `''` when nothing
 * usable is left.
 *
 * @param {unknown} value - raw file name stem.
 * @returns {string} the sanitised name, possibly empty.
 */
function sanitizeDirectoryName(value) {
  const replaced = String(value ?? '').replace(ILLEGAL_NAME_CHARS, '_')
  const cut = truncateDirectoryName(stripTrailingDotsAndSpaces(replaced))
  const dot = cut.indexOf('.')
  const stem = dot === -1 ? cut : cut.slice(0, dot)
  if (!WINDOWS_DEVICE_NAME.test(stem)) return cut
  // A device name is reserved before the first dot - `CON.txt` opens the console -
  // so the underscore has to land inside the stem: `CON.txt_` would still be the
  // device. For a name without a dot that is literally "append `_` at the end".
  const tail = dot === -1 ? '' : cut.slice(dot)
  return truncateDirectoryName(`${stem}_${tail}`)
}

/**
 * Drop the trailing dots and spaces Windows silently refuses to keep in a name.
 * @param {string} value - candidate name.
 * @returns {string} the name without a trailing run of `.` or ` `.
 */
function stripTrailingDotsAndSpaces(value) {
  return value.replace(/[. ]+$/, '')
}

/**
 * Cut a name to {@link MAX_BOOK_DIR_CHARS} characters and re-strip its tail.
 *
 * The head is kept, because a title leads: the person looking for
 * `巴布尔回忆录 (（印）巴布尔著…` has to still see `巴布尔回忆录`. Cutting can land
 * on a dot or a space, which Windows would then strip on its own, so the tail rule
 * runs once more after the cut.
 *
 * @param {string} value - sanitised candidate name.
 * @returns {string} the name, at most {@link MAX_BOOK_DIR_CHARS} characters.
 */
function truncateDirectoryName(value) {
  const characters = [...value]
  if (characters.length <= MAX_BOOK_DIR_CHARS) return value
  return stripTrailingDotsAndSpaces(characters.slice(0, MAX_BOOK_DIR_CHARS).join(''))
}

/**
 * Whether two paths name the same location.
 *
 * `path.resolve` normalises `..`, a trailing separator and the platform's
 * separators; `path.relative` is empty exactly when the two land on the same
 * entry, and on Windows it compares case-insensitively, which is what a
 * filesystem there does. Used for the "the artifact directory is the input file"
 * guard and for the report's `alongsideInput` flag.
 *
 * @param {string} left - one path.
 * @param {string} right - the other path.
 * @returns {boolean} true when both resolve to the same location.
 */
function isSamePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === ''
}

/** Whether `target` exists and is a directory. */
async function isDirectory(target) {
  const info = await stat(target).catch(() => null)
  return info !== null && info.isDirectory()
}

/**
 * Create the book's output directory and seed it from the layout this release
 * replaces.
 *
 * Three cases, and the reason they are told apart:
 *
 * 1. `bookDir` already exists - a resumed run. It is reused exactly as it is: its
 *    `pages/` holds the cache this run is supposed to hit, and there is nothing
 *    to migrate into a directory that is already serving this book.
 * 2. `bookDir` is new and an old `<outputDir>/.pdf2epub-<inputKey>/pages/` exists.
 *    The page cache is moved in, best effort. This is a one-time bridge from the
 *    layout where the cache sat in a dot-prefixed directory whose name carried the
 *    input fingerprint.
 * 3. `bookDir` is new and there is nothing to migrate - just three `mkdir`s.
 *
 * The migration is deliberately best effort: an unwritable or cross-volume old
 * directory must cost a cache rebuild, never the conversion. Whatever happens is
 * returned as one warning line for the report, so a user who wonders why a run paid
 * for pages it already had an answer to can read what went wrong.
 *
 * Only `pages/` is migrated. The old `images/` lived directly in the output
 * directory and was shared by every book converted there, so copying out of it
 * could attach another book's illustrations to this one; figures are re-cropped
 * from the pages instead, which is deterministic (see `restoreCachedFigures`).
 *
 * @param {object} args - directory job.
 * @param {string} args.bookDir - absolute directory this book's artifacts live in.
 * @param {string} args.pageDir - this run's page-cache directory (`<bookDir>/pages/<settings>`).
 * @param {string} args.imagesDir - `<bookDir>/images`.
 * @param {string} args.legacyPagesDir - `<outputDir>/.pdf2epub-<inputKey>/pages`, the old layout's cache.
 * @returns {Promise<string | null>} one report warning line, or null when there was nothing to say.
 */
async function prepareBookDirectory(args) {
  const { bookDir, pageDir, imagesDir, legacyPagesDir } = args
  const resumed = await isDirectory(bookDir)
  await mkdir(bookDir, { recursive: true })
  // The migration has to run before `pageDir` exists: it moves the old `pages/`
  // into place as a whole directory, which a rename cannot do onto an existing one.
  const warning = resumed ? null : await migrateLegacyPages(legacyPagesDir, path.join(bookDir, 'pages'))
  await mkdir(pageDir, { recursive: true })
  await mkdir(imagesDir, { recursive: true })
  return warning
}

/**
 * Move the page cache of the previous layout into the book's own directory.
 *
 * `rename` first (same volume, one atomic step, keeps mtimes), then a recursive
 * copy plus a delete for the case `rename` cannot serve - a cross-volume move,
 * where Windows answers EXDEV. Every failure is folded into the returned warning:
 * a conversion must never fail because a cache it could rebuild would not move.
 *
 * @param {string} legacyPagesDir - old `<outputDir>/.pdf2epub-<inputKey>/pages`; may not exist.
 * @param {string} targetPagesDir - `<bookDir>/pages`; does not exist yet.
 * @returns {Promise<string | null>} a warning line describing what happened, or null when there was nothing to migrate.
 */
async function migrateLegacyPages(legacyPagesDir, targetPagesDir) {
  if (!(await isDirectory(legacyPagesDir))) return null
  const legacyRoot = path.dirname(legacyPagesDir)
  try {
    await rename(legacyPagesDir, targetPagesDir)
    // Removes the old `.pdf2epub-<inputKey>` wrapper only when the move left it
    // empty; anything else in there stays exactly where it was.
    await rmdir(legacyRoot).catch(() => {})
    return `moved the page cache written by the previous layout (${legacyPagesDir}) `
      + `into ${targetPagesDir}`
  } catch (renameError) {
    const firstReason = errorText(renameError)
    try {
      await cp(legacyPagesDir, targetPagesDir, { recursive: true, force: true })
      await rm(legacyPagesDir, { recursive: true, force: true })
      await rmdir(legacyRoot).catch(() => {})
      return `moved the page cache written by the previous layout (${legacyPagesDir}) `
        + `into ${targetPagesDir} by copying it, because it could not be renamed `
        + `(${firstReason.slice(0, 200)})`
    } catch (copyError) {
      return `the page cache written by the previous layout (${legacyPagesDir}) could not be moved `
        + `into ${targetPagesDir} (${errorText(copyError).slice(0, 200)}); this run starts from a cold `
        + 'cache and the old directory is left in place'
    }
  }
}

/** The message of a thrown value, for a warning line. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Path of one page's cache entry. */
function cacheFile(dir, pageIndex) {
  return path.join(dir, `${String(pageIndex + 1).padStart(5, '0')}.json`)
}

/**
 * Write one page's cache entry.
 *
 * Called only for pages that may be replayed as an answer (see
 * {@link pageCacheable}): a page that produced book text, or a measured blank
 * page whose entry carries `blocks: []` with `blank: true`.
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
 * different model, DPI or INPUT FILE - must not survive to be rejected again on
 * every run, and deleting it is what lets the page be transcribed and rewritten
 * cleanly.
 *
 * WHERE THE ISOLATION WENT. The page cache directory used to be named after the
 * input fingerprint (`<outputDir>/.pdf2epub-<inputKey>/pages/<settings>/`), so two
 * different PDFs could not share page files even in principle. The directory is
 * now the book's own folder, named after the file, and two different inputs with
 * the same file name (the same book re-downloaded, a corrected scan, another
 * volume with a generic name) land in the SAME folder. What separates them is the
 * fingerprint stored in every payload: `writeCache()` stamps each entry with
 * `input: inputKey`, `cacheProblem()` compares it with this run's key, and a
 * mismatch is a miss - and `readCache()` unlinks the file on the way out, so the
 * next run does not read the stale page again before rejecting it.
 *
 * The cost is honest and worth stating: because the cache is now per directory
 * AND per payload rather than per directory name, the first run of a second book
 * with the same file name OVERWRITES the cached pages of the first (the old entry
 * is deleted, then rewritten from the new pages). Re-converting the first book
 * afterwards pays for its pages again. Keeping both would need one directory per
 * input fingerprint inside the book folder - which is exactly the un-findable
 * layout this change removes - so the trade is taken deliberately: the folder a
 * user can find, isolation paid for per file.
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
 * did) turns one 429 into a permanently blank page. The single exception is a
 * `blank: true` entry with `blocks: []` - a measured blank page, whose empty
 * answer is the content - and it is only accepted when the page really has no
 * blocks and no error, so the relaxation cannot let a failure through. The page
 * number, the input fingerprint, the DPI, the prompt version and the model are
 * checked too, so an entry copied into the wrong directory - or left there by a
 * DIFFERENT PDF that happens to share this file name - is a miss rather than the
 * wrong page.
 *
 * The `input` check is the one that carries the weight now: it is the only thing
 * standing between two books that share a directory name, and `readCache()`
 * deletes the entry it rejects, so the stale file cannot be replayed.
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
  if (typeof page.error === 'string' && page.error !== '') return 'page error'
  // A measured blank page is the one shape whose block list is legitimately
  // empty: `blocks: []` plus `blank: true` is the whole answer, and rejecting it
  // would make a blank page cost a model call on every run. The check stays
  // narrow on purpose - a bare `blocks: []` (an older build's poison) is still
  // rejected and deleted, and a "blank" entry that claims blocks is malformed.
  if (page.blank === true) {
    return Array.isArray(page.blocks) && page.blocks.length === 0 ? null : 'blank page with blocks'
  }
  if (!Array.isArray(page.blocks) || page.blocks.length === 0) return 'no blocks'
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

/**
 * The session identifier every model call of one run carries.
 *
 * The provider's routing header is mandatory (a missing `x-opencode-session` is
 * the `400 MissingSessionID` this was written for) but its value is opaque: it
 * only has to identify "one conversation" stably, so a derived id is a valid
 * answer where no real Session exists. Two sources, in order:
 *
 * 1. `spec.sessionId` - the caller's own id. The tool path puts the calling
 *    Agent's `SessionId` there (`index.js`), and a test or an advanced caller may
 *    pass a value explicitly. A blank or non-string value is ignored rather than
 *    forwarded: an empty header would be rejected the same way a missing one is.
 * 2. `pdf2epub-<bookId>` - the fallback for the paths that hold no Session (the
 *    panel's background job, a direct `runConversion()`): stable for every page
 *    of one book, different for a different book, and never random per page -
 *    a per-page id would route each page as a new conversation and pay for a
 *    cold prompt prefix on every one of them.
 *
 * @param {unknown} explicit - `spec.sessionId`, when the caller supplied one.
 * @param {string} bookId - the book's 12-hex path hash.
 * @returns {string} the session routing identifier, never empty.
 */
function resolveSessionId(explicit, bookId) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return `pdf2epub-${bookId}`
}

/** Derive a stable UUID-shaped identifier from the book hash. */
function bookIdToUuid(hex) {
  const body = (hex + '0'.repeat(32)).slice(0, 32)
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-4${body.slice(13, 16)}-8${body.slice(17, 20)}-${body.slice(20, 32)}`
}
