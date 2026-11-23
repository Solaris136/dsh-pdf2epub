/**
 * HTTP surface and job bookkeeping for the pdf2epub plugin: one POST that
 * starts a conversion, four GET readers (progress, two produced files, and any
 * EPUB on disk unpacked as JSON), and the module-level state table those
 * readers project from.
 *
 * Five host contracts shape this file (see docs/api-contracts.md §4, §5, §7):
 *  - A registered route is unauthenticated, so every entry point re-checks
 *    `ctx.connection.requestRejection` before it does anything else.
 *  - The webserver hands only GET/HEAD to a `resource`; a POST has to be the
 *    Node-style `handler`. The starter is therefore the one handler route and
 *    the four readers are resources.
 *  - A job is process-local. A registered route is unowned, so the `jobs`
 *    service — whose controller is bound to one agent — is not reachable from
 *    it; `ctx.jobs.start` therefore failed every real click with "no job
 *    controller serves this agent". {@link startConversionJob} mints its own
 *    id and drives the conversion against this module's own state table
 *    instead: it returns synchronously, the run settles the record, and a
 *    failure is folded into that record rather than escaping as an unhandled
 *    rejection that would take the process down.
 *  - The two file readers serve only the artifacts this plugin produced (see
 *    {@link producedArtifacts}); the suffix whitelist is a second gate, not the
 *    access decision, so a caller cannot read an arbitrary EPUB from disk.
 *  - `GET /epub` is the deliberate exception to that last rule: it unpacks any
 *    `.epub` the caller names, because opening a book the user already owns is
 *    the same trust level as DSH's own PDF preview. It is a read-only JSON
 *    projection with a fixed size cap, never a general file reader.
 *  - That route also takes an optional `sessionId`. A caller holding a
 *    workspace-relative path — which is exactly what a click in the Sidebar
 *    produces, because a `dsh-resource://file/session/<sid>/<tail>` address
 *    strips the Session's workspace root — cannot be served from the host
 *    process' own cwd. `path.resolve()` against `process.cwd()` was the original
 *    bug: it answered `404 not found` for every real click. A relative `path`
 *    is now rooted at the Session's working directory (`ctx.workingDirectory`),
 *    and a relative path with no `sessionId` is refused with an explanation
 *    instead of being guessed at.
 */

import { unzipSync } from 'fflate'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The six exact route paths this plugin owns. */
export const ROUTE_PATHS = Object.freeze({
  run: '/dsh-pdf2epub/run',
  state: '/dsh-pdf2epub/state',
  models: '/dsh-pdf2epub/models',
  book: '/dsh-pdf2epub/book',
  file: '/dsh-pdf2epub/file',
  epub: '/dsh-pdf2epub/epub',
})

/**
 * What each produced artifact kind is served with: the suffix its files carry
 * and the content type its reader answers.
 */
const ARTIFACT_MEDIA = Object.freeze({
  epub: Object.freeze({ suffix: '.epub', type: 'application/epub+zip' }),
  report: Object.freeze({ suffix: '.report.json', type: 'application/json' }),
  book: Object.freeze({ suffix: '.book.json', type: 'application/json' }),
})

/** Suffixes `GET /file` serves, derived from {@link ARTIFACT_MEDIA}. */
const FILE_SUFFIXES = Object.freeze([ARTIFACT_MEDIA.epub.suffix, ARTIFACT_MEDIA.report.suffix])

/** The one suffix `GET /book` serves: the JSON chapter list the reading view renders. */
const BOOK_SUFFIXES = Object.freeze([ARTIFACT_MEDIA.book.suffix])

/** Prefix every job id {@link startConversionJob} mints carries. */
const JOB_ID_PREFIX = 'pdf2epub'

/** Largest `POST /run` body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024

/** Largest `.epub` `GET /epub` will read from disk, in bytes. */
const MAX_EPUB_BYTES = 64 * 1024 * 1024

/** Largest single image `GET /epub` inlines as a data URL, in bytes. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

/** Total raw image bytes `GET /epub` inlines into one response, in bytes. */
const MAX_INLINE_IMAGES_BYTES = 24 * 1024 * 1024

/**
 * Largest total uncompressed size `GET /epub` will inflate, in bytes.
 *
 * The 64 MiB cap is on the file, and deflate can expand roughly a thousandfold
 * (a zip bomb), so without this a small archive could exhaust the host's memory
 * inside `unzipSync` before any later check runs. A quarter of a gigabyte of
 * XHTML is far past any real book.
 */
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024

/** Suffix `GET /epub` accepts, matched case-insensitively. */
const EPUB_SUFFIX_RE = /\.epub$/i

/** Media types whose spine documents `GET /epub` treats as chapters. */
const CONTENT_MEDIA_RE = /^(?:application\/xhtml\+xml|text\/html)$/

/** Suffix used when a spine item declares no media type at all. */
const CONTENT_SUFFIX_RE = /\.x?html?$/i

/** Entries kept in {@link producedArtifacts} before the oldest is dropped. */
const MAX_ARTIFACTS = 200

/**
 * Job records kept in {@link states} before the oldest settled one is dropped.
 *
 * A settled record is only ever polled some more, so losing the oldest one costs
 * nothing — but nothing used to drop them, and a long-lived host that starts a
 * conversion per click grew the table without bound (review finding S5). Active
 * records are never evicted, so the table can pass the cap while more than this
 * many conversions run at once; it comes back under the cap as they settle.
 */
const MAX_STATES = 50

/**
 * Absolute paths of the files this plugin produced, oldest first.
 *
 * The two file readers refuse everything else: the routes are reachable from a
 * same-origin page, so "any absolute path whose suffix is whitelisted" would
 * hand out unrelated EPUBs and JSON reports on the machine. `jobId` records
 * provenance only — `'tool'` marks a conversion started from the model tool
 * rather than a background job, and no route reads it.
 *
 * @type {Map<string, { kind: 'epub' | 'report' | 'book', jobId: string }>}
 */
const producedArtifacts = new Map()

/**
 * Live state of every started job, keyed by the id {@link startConversionJob}
 * minted.
 *
 * Module scope on purpose: `POST /run` writes here while `GET /state` reads
 * (the tool converts inline and keeps no state), and concurrent jobs stay
 * isolated by key. Settled entries are kept so a late poll still reads the
 * terminal state, under the {@link MAX_STATES} cap.
 *
 * @type {Map<string, object>}
 */
const states = new Map()

/* -------------------------------------------------------------------------- */
/* Conversion                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Absolute URL of the conversion pipeline, resolved against this module.
 *
 * Kept as a `URL` rather than a path: {@link loadPipeline} appends a version
 * query to `href`, and the result has to stay a valid module specifier on every
 * platform (a raw Windows path would need escaping first).
 *
 * That query also decides whether the pipeline's own submodules are re-read:
 * their import specifiers carry `?v=<LOCAL_MODULE_VERSION>` (see
 * `src/pipeline.js`), and those URLs are only seen when the pipeline module
 * itself is evaluated again. The file's mtime cannot express "only the
 * submodules changed", which is why the second stamp below exists.
 */
const PIPELINE_URL = new URL('../pipeline.js', import.meta.url)

/**
 * Manual API stamp mixed into the pipeline's cache-bust query, next to the mtime.
 *
 * WHY: the mtime query re-evaluates `pipeline.js` when THAT file changes, but its
 * submodules are separate URLs and are only re-read because `pipeline.js` is
 * evaluated again and resolves them afresh. Change `model/assemble.js`,
 * `epub/build.js` or `host/bridge.js`, bump `LOCAL_MODULE_VERSION` in
 * `src/pipeline.js`, reload the plugin — and `pipeline.js` is byte-for-byte
 * unchanged, so the mtime query is identical, the loader hands back the module
 * it already has, and the new submodule URLs are never resolved. This constant
 * makes the loader's URL move when that stamp does, which is what lets the two
 * levels bust independently: mtime covers the pipeline body, the API version
 * covers "a submodule changed but the entry file did not".
 *
 * WHEN TO BUMP: in the same edit as `LOCAL_MODULE_VERSION` in `src/pipeline.js` —
 * the two numbers are one fact written twice — and therefore whenever any file
 * under `src/model/`, `src/epub/`, `src/pdf/` or `src/host/` changes. Bumping it
 * on its own is harmless: it costs one re-evaluation of the pipeline.
 *
 * Both this and the mtime are a development / hot-reload convenience, not a
 * shipping mechanism. Every reloaded revision stays in the ESM cache for the
 * life of the process, so a release still has to be verified after restarting
 * the host.
 */
const PIPELINE_API_VERSION = 3

/** Composed cache-bust stamp (`<mtime>-<PIPELINE_API_VERSION>`) the module below was loaded with; `undefined` until a load succeeds. */
let pipelineVersion

/** Namespace of the pipeline module as last loaded, or `undefined` before the first load. */
let pipelineModule

/**
 * Load the conversion pipeline, re-evaluating it whenever its file changed.
 *
 * Deferred instead of imported at module load so registering the tool and the
 * routes never depends on the pipeline's native dependencies (mupdf is a WASM
 * module that initialises on import). A load failure therefore surfaces on the
 * first conversion, inside the caller's own error handling, rather than through
 * the host's plugin loader. Nothing is cached on failure, so a repaired install
 * converts without restarting the host.
 *
 * WHY THE MTIME QUERY — Node's ESM cache is process-wide and keyed by URL, and a
 * plugin reload (`plugin_manager set_plugin` false then true) only re-evaluates
 * `index.js` and this file. `pipeline.js` was already imported once, so it keeps
 * running the copy from the FIRST load forever: editing it and reloading changed
 * nothing, and a conversion kept replaying the old pipeline down to a
 * byte-identical report. Appending the file's own modification time to the URL
 * gives an edited file a new module identity, so an edit takes effect on the next
 * conversion without restarting the host.
 *
 * WHY THE SECOND STAMP — the mtime says nothing about the pipeline's own
 * `import`s. Those carry a manual `?v=` (see `LOCAL_MODULE_VERSION` in
 * `src/pipeline.js`) and only take effect when this loader hands out a NEW
 * pipeline module; with `pipeline.js` untouched the mtime query is unchanged and
 * the old module — old submodules included — is returned. The API version below
 * is therefore part of the query as well, so bumping it after a submodule-only
 * change forces that re-evaluation. The two halves bust independently: mtime for
 * the pipeline body, API version for the graph below it.
 *
 * The stamp is the file's mtime, never `Date.now()`: a per-call query would mint
 * a fresh URL on every call and rebuild the pipeline's module-level state each
 * time. An unchanged file (and an unchanged API version) keeps one URL, hence
 * one module object. This whole scheme is a development convenience — a released
 * version should still be verified after a host restart, and every reloaded
 * revision stays in the ESM cache for the life of the process.
 *
 * One `stat` runs per call (microseconds) and the module is cached against the
 * composed stamp, so an untouched install pays a stat plus a compare and nothing
 * else. A failed `stat` is not treated as fatal: the plain URL is imported so a
 * real load error is thrown as-is instead of being masked by this helper. That
 * plain URL is also the one reason a load can land outside the stamp table: a
 * missing file has no mtime to name it with.
 *
 * Exported so the `.out` checks can pin this behaviour without running a
 * conversion: a changed stamp must load a new module object, an unchanged one
 * must reuse the module already loaded.
 *
 * @returns {Promise<{ runConversion: (options: object) => Promise<object>, PROMPT_VERSION: number }>} the pipeline module of its current revision.
 */
export async function loadPipeline() {
  const version = await pipelineStamp()
  if (version === undefined) return import(PIPELINE_URL.href)
  const stamp = `${version}-${PIPELINE_API_VERSION}`
  if (pipelineModule !== undefined && stamp === pipelineVersion) return pipelineModule
  const loaded = await import(`${PIPELINE_URL.href}?v=${stamp}`)
  pipelineVersion = stamp
  pipelineModule = loaded
  return loaded
}

/**
 * The pipeline file's modification time, truncated to whole milliseconds.
 *
 * `mtimeMs` is fractional on some filesystems, and any change of the file has to
 * show up as a different stamp, so it is truncated to an integer before it
 * becomes a URL: two reads of one untouched file then agree exactly. `undefined`
 * means "no usable stamp" — the path is missing, is not a regular file, or
 * `stat` failed — which sends {@link loadPipeline} down its uncached
 * plain-import path.
 *
 * @returns {Promise<number | undefined>} a millisecond stamp, or `undefined`.
 */
async function pipelineStamp() {
  try {
    const info = await stat(fileURLToPath(PIPELINE_URL))
    return info.isFile() ? Math.trunc(info.mtimeMs) : undefined
  } catch {
    return undefined
  }
}

/**
 * The host slice `runConversion` consumes.
 *
 * The pipeline only ever touches `llm` and `attachments` (see
 * `src/host/bridge.js`), so the seam stays explicit instead of handing the
 * whole context over.
 *
 * @param {object} ctx - plugin context.
 * @returns {{ llm: object, attachments: object }} host services for the pipeline.
 */
function hostOf(ctx) {
  return { llm: ctx.llm, attachments: ctx.attachments }
}

/**
 * Validate and normalize one conversion request.
 *
 * Only supplied keys are copied: the pipeline falls back to the plugin
 * configuration and then to its own defaults, and treats `undefined` as absent.
 * Rejecting bad types here keeps a typo from surfacing as a 72-dpi render.
 *
 * @param {unknown} input - untrusted arguments (tool call or POST body).
 * @returns {object} a spec `runConversion` accepts.
 * @throws {Error} when a field has an unusable type.
 */
export function parseSpec(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('pdf2epub: arguments must be an object')
  }
  const args = /** @type {Record<string, unknown>} */ (input)
  if (typeof args.input !== 'string' || args.input.trim() === '') {
    throw new Error('pdf2epub: "input" must be the PDF path (absolute, or relative to the working directory)')
  }
  /** @type {Record<string, unknown>} */
  const spec = { input: args.input }
  if (args.outputDir !== undefined) spec.outputDir = requireString(args.outputDir, 'outputDir')
  if (args.model !== undefined) spec.model = requireString(args.model, 'model')
  if (args.reviewModels !== undefined) spec.reviewModels = requireStringArray(args.reviewModels, 'reviewModels')
  for (const key of ['dpi', 'maxTokens', 'concurrency', 'splitLevel']) {
    if (args[key] !== undefined) spec[key] = requireNumber(args[key], key)
  }
  /* Page selection and metadata overrides: only the type is checked here. The
   * page expression's grammar and its bounds against the real page count belong
   * to the pipeline (`parsePageList` / `resolvePageSelection`), and a blank
   * title/author/publisher means "keep the PDF's own metadata", so an empty
   * string is passed through instead of being refused here. */
  for (const key of ['pages', 'excludePages', 'title', 'author', 'publisher']) {
    if (args[key] === undefined) continue
    if (typeof args[key] !== 'string') throw new Error(`pdf2epub: "${key}" must be a string`)
    spec[key] = args[key]
  }
  if (args.cover !== undefined) {
    if (typeof args.cover !== 'boolean') throw new Error('pdf2epub: "cover" must be a boolean')
    spec.cover = args.cover
  }
  /* Footnote layout: the two values are the whole vocabulary, so a typo is
   * refused here instead of silently falling back to the default. */
  if (args.footnotePlacement !== undefined) {
    const value = requireString(args.footnotePlacement, 'footnotePlacement')
    if (value !== 'chapter' && value !== 'inline') {
      throw new Error('pdf2epub: "footnotePlacement" must be "chapter" or "inline"')
    }
    spec.footnotePlacement = value
  }
  if (args.footnoteLinks !== undefined) {
    if (typeof args.footnoteLinks !== 'boolean') throw new Error('pdf2epub: "footnoteLinks" must be a boolean')
    spec.footnoteLinks = args.footnoteLinks
  }
  if (args.force !== undefined) {
    if (typeof args.force !== 'boolean') throw new Error('pdf2epub: "force" must be a boolean')
    spec.force = args.force
  }
  return spec
}

/**
 * Resolve the primary model route for one request.
 *
 * `primaryModel` is configuration, so it may legitimately be empty (a fresh
 * install loads, shows its panel, and fails here — with a message naming the
 * setting — only when a conversion actually starts). A per-call `model` wins,
 * exactly as it does inside the pipeline.
 *
 * @param {object} config - normalized plugin configuration.
 * @param {object} spec - validated spec.
 * @returns {string} the `provider/model` route to use.
 * @throws {Error} when neither the request nor the configuration names one.
 */
function requireModelRoute(config, spec) {
  const route = typeof spec?.model === 'string' && spec.model.trim() !== ''
    ? spec.model
    : config?.primaryModel
  if (typeof route !== 'string' || route.trim() === '') {
    throw new Error('dsh-pdf2epub: primaryModel is not configured; set it to provider/model in the plugin settings')
  }
  return route
}

/**
 * Run one conversion to completion and project it onto the canonical tool value.
 *
 * @param {object} ctx - plugin context carrying `llm` and `attachments`.
 * @param {object} config - normalized plugin configuration.
 * @param {object} spec - validated spec (see {@link parseSpec}).
 * @param {{ signal?: AbortSignal, onProgress?: (event: object) => void }} [options] - cancellation and progress sink.
 * @returns {Promise<{ ok: true, epubPath: string, reportPath: string, bookJsonPath: string, pages: number, chapters: number, tokens: { input: number, output: number, total: number }, degradedPages: number }>} canonical value declared by the tool's `output.schema`.
 * @throws {Error} when no model route is configured, or the pipeline fails.
 */
export async function convertToCanonical(ctx, config, spec, options = {}) {
  requireModelRoute(config, spec)
  const { runConversion } = await loadPipeline()
  const result = await runConversion({
    host: hostOf(ctx),
    spec,
    config,
    signal: options.signal,
    onProgress: options.onProgress,
  })
  return finalizeConversion(result)
}

/**
 * Derive the canonical value from a pipeline result.
 *
 * The pipeline already writes all three files (`<book>.epub`,
 * `<book>.report.json`, `<book>.book.json`); this only validates that it
 * reported them and flattens the report into the counts and token totals the
 * tool contract declares.
 *
 * @param {object} result - pipeline result (`{ epubPath, reportPath, bookJsonPath, report }`).
 * @returns {Promise<object>} canonical value.
 * @throws {Error} when the pipeline returned no usable output path.
 */
async function finalizeConversion(result) {
  const epubPath = requireOutputPath(result?.epubPath, 'epubPath')
  const reportPath = requireOutputPath(result?.reportPath, 'reportPath')
  const bookJsonPath = requireOutputPath(result?.bookJsonPath, 'bookJsonPath')
  const report = result?.report !== null && typeof result?.report === 'object' ? result.report : {}

  const tokens = report.tokens !== null && typeof report.tokens === 'object' ? report.tokens : {}
  return {
    ok: true,
    epubPath,
    reportPath,
    bookJsonPath,
    pages: wholeNumber(report?.book?.pages, Array.isArray(report.pages) ? report.pages.length : 0),
    chapters: wholeNumber(report?.book?.chapters, report?.stats?.chapters),
    tokens: {
      input: wholeNumber(tokens.input),
      output: wholeNumber(tokens.output),
      total: wholeNumber(tokens.total),
    },
    degradedPages: wholeNumber(
      report?.stats?.pagesDegraded,
      Array.isArray(report.pages) ? report.pages.filter(page => page?.degraded === true).length : 0,
    ),
  }
}

/* -------------------------------------------------------------------------- */
/* Conversion runner                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Runs one conversion to its canonical value.
 *
 * Module-level and replaceable so `test/harness/host-check.mjs` can drive both
 * outcomes of the executor without a vision model: pass a function to
 * {@link setConversionRunner}, and pass nothing to put the real pipeline back.
 * Nothing else ever changes it, so the shipped path always calls
 * {@link convertToCanonical} — which imports `runConversion` from
 * `src/pipeline.js` on first use.
 *
 * @type {(ctx: object, config: object, spec: object, options: { onProgress?: (event: object) => void }) => Promise<object>}
 */
let conversionRunner = convertToCanonical

/**
 * Replace the conversion runner (test seam).
 *
 * @param {((ctx: object, config: object, spec: object, options: { onProgress?: (event: object) => void }) => Promise<object>) | null | undefined} runner - the replacement, or nothing to restore the real pipeline.
 * @returns {void}
 */
export function setConversionRunner(runner) {
  conversionRunner = typeof runner === 'function' ? runner : convertToCanonical
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                      */
/* -------------------------------------------------------------------------- */

/** Job phases that never change again: a settled record is what a late poll reads. */
const TERMINAL_PHASES = new Set(['done', 'failed', 'cancelled'])

/**
 * Whether one phase is settled.
 *
 * @param {unknown} phase - job phase.
 * @returns {boolean} true when nothing will move the record again.
 */
function isTerminalPhase(phase) {
  return TERMINAL_PHASES.has(String(phase))
}

/**
 * Mint one job id.
 *
 * `randomUUID` rather than a counter: two routes starting a conversion in the
 * same tick must not collide, and the id is only ever an opaque key.
 *
 * @returns {string} job id, `pdf2epub-<uuid>`.
 */
function newJobId() {
  return `${JOB_ID_PREFIX}-${randomUUID()}`
}

/**
 * Drop the oldest settled records until the table fits {@link MAX_STATES}.
 *
 * Insertion order is creation order, so the first matching keys are the oldest.
 * A running record is skipped — a poller may still be watching it — which means
 * the table can stay above the cap while more than that many conversions run,
 * and comes back under it as they settle.
 *
 * @returns {void}
 */
function pruneStates() {
  if (states.size <= MAX_STATES) return
  for (const [jobId, state] of states) {
    if (states.size <= MAX_STATES) return
    if (isTerminalPhase(state.phase)) states.delete(jobId)
  }
}

/**
 * Start one conversion and return at once.
 *
 * The record is written before this returns, so the `{ jobId }` a caller gets
 * back can be polled immediately. Everything after that point is asynchronous:
 * the conversion runs against this module's own state table — no `jobs` service
 * is involved, which is what makes the route work on an unowned HTTP request —
 * and its outcome is folded into that table by {@link executeJob}.
 *
 * A conversion problem is the job's outcome, never this call's error, so this
 * does not throw for one. The route still wraps it in a try/catch for the
 * runtime faults a `randomUUID` could raise.
 *
 * @param {object} ctx - plugin context carrying `llm` and `attachments`.
 * @param {object} config - normalized plugin configuration.
 * @param {object} spec - validated spec (see {@link parseSpec}).
 * @returns {{ jobId: string }} id `GET /state` accepts.
 */
export function startConversionJob(ctx, config, spec) {
  const jobId = newJobId()
  const state = createState(jobId, spec)
  states.set(jobId, state)
  pruneStates()
  // Deliberately not awaited: the route answers with the id immediately, and
  // `executeJob` handles its own failure. The extra catch is the last seatbelt —
  // an unexpected throw in that error path must not become an unhandled
  // rejection, which would take the host process down.
  void executeJob(ctx, config, spec, state).catch(() => {})
  return { jobId }
}

/**
 * Run one job to completion and fold its outcome into its record.
 *
 * @param {object} ctx - plugin context carrying `llm` and `attachments`.
 * @param {object} config - normalized plugin configuration.
 * @param {object} spec - validated spec.
 * @param {object} state - mutable record in {@link states}.
 * @returns {Promise<void>} resolves once the record is settled.
 */
async function executeJob(ctx, config, spec, state) {
  try {
    const canonical = await conversionRunner(ctx, config, spec, {
      onProgress: event => applyProgress(state, event),
    })
    settleCompleted(state, canonical)
    // Only a conversion that returned its three files is registered; a failure
    // throws before this line, exactly as the tool path does.
    recordArtifacts(state.jobId, canonical)
  } catch (error) {
    settleFailed(state, error)
  } finally {
    pruneStates()
  }
}

/**
 * Move one record to its successful terminal state.
 *
 * @param {object} state - mutable record.
 * @param {object} canonical - canonical conversion value.
 * @returns {void}
 */
function settleCompleted(state, canonical) {
  const pages = wholeNumber(canonical?.pages, state.total)
  state.phase = 'done'
  state.status = 'completed'
  state.page = pages
  state.total = pages
  state.tokens = {
    input: wholeNumber(canonical?.tokens?.input),
    output: wholeNumber(canonical?.tokens?.output),
    total: wholeNumber(canonical?.tokens?.total),
  }
  if (typeof canonical?.epubPath === 'string') state.epubPath = canonical.epubPath
  if (typeof canonical?.reportPath === 'string') state.reportPath = canonical.reportPath
  if (typeof canonical?.bookJsonPath === 'string') state.bookJsonPath = canonical.bookJsonPath
  state.error = null
  state.updatedAt = Date.now()
}

/**
 * Move one record to its failed terminal state.
 *
 * The message is kept verbatim so the panel can show what the pipeline said (a
 * missing PDF, a model that takes no image, a refused write) instead of a
 * generic failure. Nothing is registered as an artifact.
 *
 * @param {object} state - mutable record.
 * @param {unknown} error - thrown value.
 * @returns {void}
 */
function settleFailed(state, error) {
  state.phase = 'failed'
  state.status = 'failed'
  state.error = errorMessage(error)
  state.updatedAt = Date.now()
}

/**
 * Create the state record for one starting job.
 *
 * Written before `POST /run` answers, so the first poll already sees a queued
 * record under a running status. `pageStatus` is the last per-page verdict the
 * pipeline reported (`ok`, `cached`, `reviewed`, `degraded`); it is kept apart
 * from `status`, which is this layer's job lifecycle.
 *
 * @param {string} jobId - id minted by {@link startConversionJob}.
 * @param {object} spec - validated spec.
 * @returns {object} mutable state record (internal columns included).
 */
function createState(jobId, spec) {
  const now = Date.now()
  return {
    jobId: String(jobId),
    input: spec.input,
    phase: 'queued',
    page: 0,
    total: 0,
    status: 'running',
    pageStatus: null,
    tokens: { input: null, output: null, total: 0 },
    epubPath: null,
    reportPath: null,
    bookJsonPath: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Fold one pipeline progress event into a job's state record.
 *
 * Phases are the pipeline's own (`start`, `page`, `assemble`, `done`) plus
 * `failed` from this layer. `tokens.total` is the pipeline's running count; the
 * input/output split only exists once the report is written.
 *
 * The event's own `status` is the page's verdict (`ok`, `cached`, `reviewed`,
 * `degraded`), not the job's, so it lands in `pageStatus`; `status` stays the
 * lifecycle value (`running` until {@link executeJob} settles it) and a reader
 * of `/state` never sees a page verdict standing in for it.
 *
 * A settled record is never moved again: a straggling event from a run that has
 * already failed must not reopen it.
 *
 * @param {object} state - mutable state record.
 * @param {object} event - progress event from `runConversion`.
 * @returns {void}
 */
function applyProgress(state, event) {
  if (isTerminalPhase(state.phase)) return
  state.updatedAt = Date.now()
  if (typeof event?.status === 'string' && event.status !== '') state.pageStatus = event.status
  const phase = event?.phase
  if (phase === 'start') {
    state.phase = 'start'
    state.total = wholeNumber(event.pages, state.total)
    return
  }
  if (phase === 'page') {
    state.phase = 'page'
    state.page = wholeNumber(event.page, state.page)
    state.total = wholeNumber(event.total, state.total)
    state.tokens = { ...state.tokens, total: wholeNumber(event.tokens, state.tokens.total) }
    return
  }
  if (phase === 'assemble') {
    state.phase = 'assemble'
    return
  }
  if (phase === 'done') {
    state.phase = 'done'
    state.tokens = { ...state.tokens, total: wholeNumber(event.tokens, state.tokens.total) }
    if (typeof event.epubPath === 'string') state.epubPath = event.epubPath
    if (typeof event.reportPath === 'string') state.reportPath = event.reportPath
  }
}

/**
 * The public state projection of one job.
 *
 * @param {string} jobId - id returned by `POST /run`.
 * @returns {{ jobId: string, phase: string, page: number, total: number, status: string, pageStatus: string | null, tokens: { input: number | null, output: number | null, total: number }, epubPath: string | null, reportPath: string | null, bookJsonPath: string | null, error: string | null, createdAt: number } | undefined} projection, or `undefined` for an unknown id.
 */
export function readJobState(jobId) {
  const state = states.get(String(jobId))
  if (state === undefined) return undefined
  return {
    jobId: state.jobId,
    phase: state.phase,
    page: state.page,
    total: state.total,
    status: state.status,
    pageStatus: state.pageStatus,
    tokens: {
      input: state.tokens.input,
      output: state.tokens.output,
      total: state.tokens.total,
    },
    epubPath: state.epubPath,
    reportPath: state.reportPath,
    bookJsonPath: state.bookJsonPath,
    error: state.error,
    createdAt: state.createdAt,
  }
}

/**
 * How many job records the table holds (diagnostics and tests).
 *
 * `GET /state` answers for one id and cannot describe the table, so the cap
 * on it is observable only through this counter — it reports the bound
 * {@link pruneStates} enforces, nothing else.
 *
 * @returns {number} live record count.
 */
export function stateCount() {
  return states.size
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Record the three files one successful conversion produced.
 *
 * This is the write side of {@link producedArtifacts}, used by both sources of
 * a conversion: the job runner passes its job id, the `pdf2epub` tool passes
 * `'tool'` once the call it awaited returned. A failed conversion throws before
 * reaching here, so nothing is registered for it.
 *
 * The cap counts ENTRIES, not conversions: at three entries per conversion the
 * oldest are dropped one at a time, so a partially evicted conversion can leave
 * its EPUB served while its report and sidecar are already gone. That is
 * deliberate — a long-lived host loses the ability to serve very old files,
 * never memory — but it means a registered path is not a durable handle.
 *
 * @param {string} jobId - job id, or `'tool'` for a conversion started from the model tool. Kept for provenance; no route reads it.
 * @param {{ epubPath: string, reportPath: string, bookJsonPath: string }} canonical - canonical result.
 * @returns {number} registered artifact count after the write.
 */
export function recordArtifacts(jobId, canonical) {
  const produced = [
    ['epub', canonical?.epubPath],
    ['report', canonical?.reportPath],
    ['book', canonical?.bookJsonPath],
  ]
  for (const [kind, target] of produced) {
    if (typeof target === 'string' && target !== '') {
      producedArtifacts.set(path.resolve(target), { kind, jobId: String(jobId) })
    }
  }
  while (producedArtifacts.size > MAX_ARTIFACTS) {
    const oldest = producedArtifacts.keys().next()
    if (oldest.done === true) break
    producedArtifacts.delete(oldest.value)
  }
  return producedArtifacts.size
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One optional Host service, or `null` when this Host does not expose it.
 *
 * `ctx.get()` is the reflective read: these two services are not in `inject`,
 * because a conversion that carries an explicit `model` needs neither, and a
 * missing service must not roll the plugin back.
 *
 * @param {object} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {object | null} the service, or `null`.
 */
function optionalService(ctx, name) {
  try {
    const service = ctx.get(name)
    return service === undefined || service === null ? null : service
  } catch {
    return null
  }
}

/**
 * The first non-empty string among the candidates.
 *
 * The registry types are structural, and a Host may publish a provider as `id`,
 * `provider` or `name`; reading all three keeps one release's naming drift from
 * emptying the dropdown.
 *
 * @param {...unknown} candidates - values to test in order.
 * @returns {string} the first non-empty string, or `''`.
 */
function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * Build catalogue groups from the `llm` registry.
 *
 * The second choice after `sessionController.modelCatalog()`, and the same
 * providers one level down: `listProviders()` plus `listModels()` is what this
 * profile can route *now*. A provider that refuses to list its models is skipped
 * instead of failing the whole catalogue.
 *
 * @param {object} llm - the `llm` service.
 * @returns {Promise<object[]>} catalogue groups.
 */
async function catalogFromProviders(llm) {
  const providers = await llm.listProviders()
  const groups = []
  for (const info of Array.isArray(providers) ? providers : []) {
    if (info === null || typeof info !== 'object') continue
    const id = firstString(info.id, info.provider, info.name)
    if (id === '') continue
    let listed = []
    try {
      listed = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
    } catch {
      listed = []
    }
    const models = []
    for (const model of Array.isArray(listed) ? listed : []) {
      if (model === null || typeof model !== 'object') continue
      const modelId = firstString(model.id, model.model, model.name)
      if (modelId === '') continue
      const entry = { id: modelId }
      const name = firstString(model.name, model.displayName)
      if (name !== '' && name !== modelId) entry.name = name
      const description = firstString(model.description)
      if (description !== '') entry.description = description
      models.push(entry)
    }
    if (models.length === 0) continue
    groups.push({ id, name: firstString(info.name, info.displayName, id), models })
  }
  return groups
}

/**
 * The profile's model catalogue, in the wire shape the panel already parses.
 *
 * `sessionController.modelCatalog()` is the built-in model picker's own source
 * (`dsh-api-session-controller`): `{ default, groups, failures }`, where
 * `groups[].id` is the provider id — exactly what `client.js`'s
 * `readModelCatalog` reads — so a catalogue with groups is passed through
 * untouched. An empty or failing answer falls through to the `llm` registry,
 * which carries the same providers one level down.
 *
 * The panel cannot reach the generated `ctx.remote.session` namespace from a
 * hand-written bundle, which is why the Host serves the catalogue here instead.
 *
 * @param {object} ctx - plugin context.
 * @returns {Promise<object>} wire `ModelCatalog`.
 * @throws {Error} when no source can name a single model, carrying every reason.
 */
async function readModelCatalog(ctx) {
  const notes = []

  const controller = optionalService(ctx, 'sessionController')
  if (controller !== null && typeof controller.modelCatalog === 'function') {
    try {
      const catalog = await controller.modelCatalog()
      if (catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.groups) && catalog.groups.length > 0) {
        return catalog
      }
      notes.push('sessionController.modelCatalog() listed no group')
    } catch (error) {
      notes.push(`sessionController.modelCatalog() failed: ${errorMessage(error)}`)
    }
  } else {
    notes.push('this Host exposes no sessionController.modelCatalog()')
  }

  const llm = optionalService(ctx, 'llm')
  if (llm !== null && typeof llm.listProviders === 'function') {
    try {
      const groups = await catalogFromProviders(llm)
      if (groups.length > 0) return { default: null, groups, failures: [] }
      notes.push('llm.listProviders() listed no model')
    } catch (error) {
      notes.push(`llm.listProviders() failed: ${errorMessage(error)}`)
    }
  } else {
    notes.push('this Host exposes no llm.listProviders()')
  }

  throw new Error(notes.join('; '))
}/**
 * Register the six exact routes on the host webserver.
 *
 * Every route answers through one of two response styles, picked by the
 * webserver's own dispatch rule: the five readers are resources returning a
 * Fetch `Response`, the starter is a Node handler writing to `res` (a POST never
 * reaches a resource). Both fences check `requestRejection` first, because the
 * webserver itself authenticates nothing.
 *
 * `GET /models` answers the panel's 「模型」 dropdown with the profile's model
 * catalogue (see {@link readModelCatalog}); it is the one reader that carries no
 * job or path, because its caller is the panel's own mount.
 *
 * The two produced-file readers add two gates after the fence: the path must be
 * in {@link producedArtifacts} (otherwise 404, which reveals nothing), and it
 * must carry the suffix that reader serves. `GET /epub` skips the registry on
 * purpose and gates on the `.epub` suffix, the 64 MiB cap and the archive's own
 * structure instead. It alone also accepts `sessionId`, because its caller is
 * the reading view and holds a workspace-relative path rather than an absolute
 * one; see {@link resolveEpubPath}.
 *
 * @param {object} ctx - plugin context carrying `webServer`, `connection`, `llm`, `attachments`.
 * @param {object} config - normalized plugin configuration.
 * @returns {void}
 */
export function registerRoutes(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATHS.state,
    resource: async (request) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) return new Response('forbidden', { status: 403 })
      const url = requestUrl(request)
      if (url === undefined) return jsonResponse(400, { error: 'malformed request URL' })
      const jobId = url.searchParams.get('jobId')
      if (jobId === null || jobId === '') return jsonResponse(400, { error: 'jobId is required' })
      const state = readJobState(jobId)
      if (state === undefined) return jsonResponse(404, { error: 'unknown job', jobId })
      return jsonResponse(200, state)
    },
  }), `pdf2epub: GET ${ROUTE_PATHS.state}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATHS.models,
    resource: async (request) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) return new Response('forbidden', { status: 403 })
      try {
        return jsonResponse(200, await readModelCatalog(ctx))
      } catch (error) {
        // A catalogue is optional: the panel keeps the free-text control and
        // says why, so a Host without either service degrades instead of failing.
        return jsonResponse(503, { error: errorMessage(error) })
      }
    },
  }), `pdf2epub: GET ${ROUTE_PATHS.models}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATHS.book,
    resource: async (request) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) return new Response('forbidden', { status: 403 })
      const url = requestUrl(request)
      if (url === undefined) return jsonResponse(400, { error: 'malformed request URL' })
      const resolved = resolveRequestPath(url.searchParams.get('path'))
      if (resolved.path === undefined) return jsonResponse(400, { error: resolved.error })
      // The registry decides what exists; an unknown path is simply not found.
      const artifact = producedArtifacts.get(resolved.path)
      if (artifact === undefined) return jsonResponse(404, { error: 'not found', path: resolved.path })
      // Second gate: this route serves the book sidecar and nothing else.
      const media = ARTIFACT_MEDIA.book
      if (artifact.kind !== 'book' || !resolved.path.endsWith(media.suffix)) {
        return jsonResponse(400, { error: `path must end with ${BOOK_SUFFIXES.join(' or ')}` })
      }
      const text = await readOrUndefined(resolved.path, 'utf8')
      if (text === undefined) return jsonResponse(404, { error: 'not found', path: resolved.path })
      return new Response(text, { status: 200, headers: { 'content-type': media.type } })
    },
  }), `pdf2epub: GET ${ROUTE_PATHS.book}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATHS.file,
    resource: async (request) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) return new Response('forbidden', { status: 403 })
      const url = requestUrl(request)
      if (url === undefined) return jsonResponse(400, { error: 'malformed request URL' })
      const resolved = resolveRequestPath(url.searchParams.get('path'))
      if (resolved.path === undefined) return jsonResponse(400, { error: resolved.error })
      // The registry decides what exists; an unknown path is simply not found.
      const artifact = producedArtifacts.get(resolved.path)
      if (artifact === undefined) return jsonResponse(404, { error: 'not found', path: resolved.path })
      // Second gate: this route serves the EPUB and the report, never the book sidecar.
      const media = ARTIFACT_MEDIA[artifact.kind]
      if (media === undefined || artifact.kind === 'book' || !resolved.path.endsWith(media.suffix)) {
        return jsonResponse(400, { error: `path must end with ${FILE_SUFFIXES.join(' or ')}` })
      }
      const bytes = await readOrUndefined(resolved.path)
      if (bytes === undefined) return jsonResponse(404, { error: 'not found', path: resolved.path })
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': media.type, 'content-length': String(bytes.byteLength) },
      })
    },
  }), `pdf2epub: GET ${ROUTE_PATHS.file}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATHS.epub,
    resource: async (request) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) return new Response('forbidden', { status: 403 })
      const url = requestUrl(request)
      if (url === undefined) return jsonResponse(400, { ok: false, error: 'malformed request URL' })
      // `sessionId` is optional: an absolute `path` needs no Session, and every
      // caller that already has one keeps working unchanged.
      const resolved = resolveEpubPath(ctx, url.searchParams.get('path'), url.searchParams.get('sessionId'))
      if (resolved.path === undefined) return jsonResponse(resolved.status, { ok: false, error: resolved.error })
      // Unlike /book and /file this route is not backed by the artifact
      // registry: any EPUB on disk is fair game, so the suffix check and the
      // size caps are the only gates.
      if (!EPUB_SUFFIX_RE.test(resolved.path)) {
        return jsonResponse(400, { ok: false, error: 'path must end with .epub' })
      }
      const read = await readEpubFile(resolved.path)
      if (read.error !== undefined) return jsonResponse(read.status, { ok: false, error: read.error })
      try {
        return jsonResponse(200, parseEpubArchive(read.bytes, resolved.path))
      } catch (error) {
        return jsonResponse(statusOf(error) ?? 500, { ok: false, error: errorMessage(error) })
      }
    },
  }), `pdf2epub: GET ${ROUTE_PATHS.epub}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATHS.run,
    handler: async (request, response) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) {
        // A Node handler cannot return a Fetch Response, so the fence writes it.
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
        return
      }
      if (request.method !== 'POST') {
        sendNodeJson(response, 405, { error: 'use POST' }, { allow: 'POST' })
        return
      }
      let spec
      try {
        spec = parseSpec(await readJsonBody(request))
      } catch (error) {
        sendNodeJson(response, 400, { error: errorMessage(error) })
        return
      }
      try {
        // Refuse synchronously, so an unconfigured install is told why at the
        // click rather than through a job that fails on its first tick.
        requireModelRoute(config, spec)
      } catch (error) {
        sendNodeJson(response, 400, { error: errorMessage(error) })
        return
      }
      try {
        // The executor answers with the id and finishes on its own; a conversion
        // that goes wrong is written to the state table, not reported here.
        sendNodeJson(response, 200, startConversionJob(ctx, config, spec))
      } catch (error) {
        sendNodeJson(response, 500, { error: `cannot start a pdf2epub job: ${errorMessage(error)}` })
      }
    },
  }), `pdf2epub: POST ${ROUTE_PATHS.run}`)
}

/* -------------------------------------------------------------------------- */
/* EPUB unpacking (GET /epub)                                                */
/* -------------------------------------------------------------------------- */

/**
 * An error carrying the HTTP status the route should answer with.
 *
 * @param {string} message - what is wrong with the archive.
 * @param {number} [status] - HTTP status; 415 (the file is not a usable EPUB) by default.
 * @returns {Error & { status: number }} error the route turns into `{ ok: false }`.
 */
function archiveError(message, status = 415) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * The status an error asks for, when it carries one.
 *
 * @param {unknown} error - thrown value.
 * @returns {number | undefined} an HTTP status, or `undefined` (the route answers 500).
 */
function statusOf(error) {
  const status = /** @type {{ status?: unknown }} */ (error)?.status
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined
}

/**
 * Read one `.epub` from disk under {@link MAX_EPUB_BYTES}.
 *
 * `stat` runs first so a multi-gigabyte file is refused before it is read into
 * memory; the second check covers a file that grew between the two calls. Any
 * read failure is reported as "not found" rather than 500, so a path the caller
 * may not see (EACCES on another user's file) is indistinguishable from a path
 * that does not exist.
 *
 * @param {string} target - absolute path, already shape-checked by {@link resolveRequestPath}.
 * @returns {Promise<{ bytes: Uint8Array, error?: undefined, status?: undefined } | { bytes?: undefined, error: string, status: number }>} the archive bytes, or the refusal.
 */
async function readEpubFile(target) {
  let info
  try {
    info = await stat(target)
  } catch {
    return { error: 'not found', status: 404 }
  }
  if (!info.isFile()) return { error: 'not a regular file', status: 404 }
  if (info.size > MAX_EPUB_BYTES) {
    return { error: `file is larger than ${MAX_EPUB_BYTES} bytes`, status: 413 }
  }
  let bytes
  try {
    bytes = await readFile(target)
  } catch {
    return { error: 'not found', status: 404 }
  }
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    return { error: `file is larger than ${MAX_EPUB_BYTES} bytes`, status: 413 }
  }
  return { bytes }
}

/* ------------------------------ zip entries ------------------------------ */

/**
 * Strip a zip entry name down to the form hrefs are resolved against.
 *
 * Some writers prefix names with `./` (or use `\` separators); OCF hrefs never
 * carry either, so the index is built on the stripped form and a lookup cannot
 * miss because of spelling alone.
 *
 * @param {string} name - raw zip entry name.
 * @returns {string} canonical entry name.
 */
function canonicalEntryName(name) {
  let clean = String(name).replace(/\\/g, '/')
  while (clean.startsWith('./')) clean = clean.slice(2)
  return clean
}

/**
 * Index the entries `unzipSync` returned.
 *
 * Two maps on purpose: the exact one is the correct lookup, and the
 * case-insensitive one is the fallback for archives whose OPF href and zip entry
 * disagree on case (common enough to be worth one extra map). The first entry
 * wins on a duplicate name, so a later `./OEBPS/x` cannot shadow `OEBPS/x`.
 *
 * @param {Record<string, Uint8Array>} rawEntries - `unzipSync` output.
 * @returns {{ byName: Map<string, Uint8Array>, byLowerName: Map<string, string> }} entry index.
 */
function indexEntries(rawEntries) {
  /** @type {Map<string, Uint8Array>} */
  const byName = new Map()
  /** @type {Map<string, string>} */
  const byLowerName = new Map()
  for (const [rawName, bytes] of Object.entries(rawEntries)) {
    if (!(bytes instanceof Uint8Array)) continue
    const name = canonicalEntryName(rawName)
    if (name === '' || name.endsWith('/')) continue
    if (!byName.has(name)) byName.set(name, bytes)
    const lower = name.toLowerCase()
    if (!byLowerName.has(lower)) byLowerName.set(lower, name)
  }
  return { byName, byLowerName }
}

/**
 * Look one zip entry up by its canonical name.
 *
 * @param {{ byName: Map<string, Uint8Array>, byLowerName: Map<string, string> }} index - entry index.
 * @param {string | undefined} name - canonical entry name.
 * @returns {Uint8Array | undefined} the bytes, or `undefined` when the archive has no such entry.
 */
function entryBytes(index, name) {
  if (typeof name !== 'string' || name === '') return undefined
  const direct = index.byName.get(name)
  if (direct !== undefined) return direct
  const lower = index.byLowerName.get(name.toLowerCase())
  return lower === undefined ? undefined : index.byName.get(lower)
}

/* ------------------------------ paths ------------------------------------ */

/**
 * Collapse `.` and `..` in a zip-internal path.
 *
 * Returns `undefined` the moment a `..` would climb above the archive root.
 * That is the whole traversal defence: the result is only ever used as a key
 * into the entry index, so an href like `../../etc/passwd` resolves to nothing
 * instead of to a host file. Paths that stay inside resolve normally, which is
 * what `../styles/book.css` from `OEBPS/text/` needs.
 *
 * @param {string} value - path already joined with its base directory.
 * @returns {string | undefined} canonical path, or `undefined` when it escapes the archive.
 */
function normalizeZipPath(value) {
  /** @type {string[]} */
  const segments = []
  for (const segment of String(value).replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * Percent-decode an href path segment by segment.
 *
 * Manifest hrefs are URLs, entry names are not, so `%E5%B0%81%E9%9D%A2.png` has
 * to become `封面.png` before the lookup. A malformed escape keeps the raw text
 * instead of throwing, because a broken href must not fail the whole book.
 *
 * @param {string} value - href path.
 * @returns {string} decoded path.
 */
function decodePercentPath(value) {
  try {
    return value.split('/').map(segment => decodeURIComponent(segment)).join('/')
  } catch {
    return value
  }
}

/**
 * Resolve one manifest or nav href against the directory of the file naming it.
 *
 * Fragments and queries are cut first (`#ch1`, `?v=2` are not part of the entry
 * name), then the path is resolved and normalized by {@link normalizeZipPath}.
 * Absolute URLs (`http:`, `data:`) and archive-absolute paths (`/OEBPS/...`)
 * are refused rather than guessed at.
 *
 * @param {string} baseDir - zip-internal directory of the referring document, `''` at the root.
 * @param {string} href - href as written in the OPF or the nav document.
 * @returns {string | undefined} canonical zip entry name, or `undefined` when unresolvable.
 */
function resolveHref(baseDir, href) {
  let target = String(href).trim()
  const cut = target.search(/[?#]/)
  if (cut >= 0) target = target.slice(0, cut)
  if (target === '') return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return undefined
  if (target.startsWith('/')) return undefined
  const decoded = decodePercentPath(target)
  return normalizeZipPath(baseDir === '' ? decoded : `${baseDir}/${decoded}`)
}

/* ------------------------------ text helpers ----------------------------- */

/** The XML entities plus the handful of HTML names that show up in nav labels. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
})

/** Numeric or named reference; a bare `&` does not match. */
const ENTITY_RE = /&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9._-]*));/g

/**
 * Decode XML/HTML character references.
 *
 * Unknown named references are kept verbatim: inventing a replacement would
 * change a chapter title, and the only consumers here are titles and nav
 * labels, where a stray `&nbsp;` is readable as-is.
 *
 * @param {string} source - markup text.
 * @returns {string} text with references decoded.
 */
function decodeEntities(source) {
  const text = String(source)
  if (!text.includes('&')) return text
  return text.replace(ENTITY_RE, (whole, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const code = Number.parseInt(decimal ?? hex, decimal !== undefined ? 10 : 16)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[/** @type {keyof typeof NAMED_ENTITIES} */ (name.toLowerCase())] ?? whole
  })
}

/**
 * Plain text of a metadata value or a nav label: tags dropped, entities decoded,
 * whitespace collapsed, and `undefined` when nothing readable is left.
 *
 * @param {string} source - inner markup.
 * @returns {string | undefined} plain text.
 */
function textOfMarkup(source) {
  const text = decodeEntities(String(source).replace(/<[^>]*>/g, ' '))
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed === '' ? undefined : collapsed
}

/** First `<?xml ... encoding="...">` or `<meta charset="...">` in the head. */
const XML_ENCODING_RE = /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i
const META_CHARSET_RE = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i

/**
 * Decode one archive entry as text.
 *
 * UTF-8 is the default. A document that declares another encoding (a GBK
 * chapter, a Latin-1 CSS file) is decoded with it when the runtime knows the
 * label, and falls back to UTF-8 otherwise — a wrong guess must not fail the
 * whole book.
 *
 * @param {Uint8Array} bytes - raw entry.
 * @returns {string} decoded text.
 */
function decodeDocument(bytes) {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).toString('latin1')
  const declared = XML_ENCODING_RE.exec(head)?.[1] ?? META_CHARSET_RE.exec(head)?.[1]
  if (declared !== undefined && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      // Unknown or unsupported label: UTF-8 below.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/* ------------------------------ OPF / nav -------------------------------- */

/**
 * Read one element's inner markup.
 *
 * Namespace prefixes are accepted (`<opf:manifest>`) because the OPF is XML and
 * the prefix is the author's choice.
 *
 * @param {string} xml - document text.
 * @param {string} tag - local name without prefix.
 * @returns {string | undefined} inner markup, or `undefined` when the element is absent.
 */
function elementBlock(xml, tag) {
  const re = new RegExp(`<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][-A-Za-z0-9_.]*:)?${tag}\\s*>`, 'i')
  const match = re.exec(xml)
  return match === null ? undefined : match[1]
}

/**
 * Read the attributes of one start tag.
 *
 * A regex reader, not an XML parser, on purpose: the requirement is a light
 * package-document read and the host must not gain an XML dependency. Attribute
 * order, quote style and namespace prefixes are all tolerated.
 *
 * @param {string} source - the tag's attribute text (everything between the name and `>`).
 * @returns {Record<string, string>} attributes keyed by lower-case name.
 */
function readAttributes(source) {
  /** @type {Record<string, string>} */
  const attributes = {}
  const re = /([A-Za-z_][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  return attributes
}

/**
 * Every `<dc:name>` value in the package document, in document order.
 *
 * @param {string} opf - package document.
 * @param {'title' | 'creator' | 'language'} name - local name.
 * @returns {string[]} non-empty values.
 */
function metadataTexts(opf, name) {
  const re = new RegExp(`<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][-A-Za-z0-9_.]*:)?${name}\\s*>`, 'gi')
  /** @type {string[]} */
  const values = []
  for (const match of opf.matchAll(re)) {
    const text = textOfMarkup(match[1])
    if (text !== undefined) values.push(text)
  }
  return values
}

/**
 * Read manifest, spine and metadata out of a package document.
 *
 * The manifest keeps its document order because CSS is concatenated in it, and
 * a map by id covers the spine's `idref`s. A spine reference the manifest does
 * not declare is simply dropped.
 *
 * @param {string} opf - package document text.
 * @returns {{ items: Array<{ id: string, href: string, mediaType: string, properties: string }>, byId: Map<string, { id: string, href: string, mediaType: string, properties: string }>, idrefs: string[], titles: string[], creators: string[], languages: string[] }} parsed package document.
 * @throws {Error & { status: number }} 415 when the document has no `<manifest>`.
 */
function parsePackageDocument(opf) {
  const manifest = elementBlock(opf, 'manifest')
  if (manifest === undefined) throw archiveError('package document has no <manifest> element')

  /** @type {Array<{ id: string, href: string, mediaType: string, properties: string }>} */
  const items = []
  /** @type {Map<string, { id: string, href: string, mediaType: string, properties: string }>} */
  const byId = new Map()
  for (const match of manifest.matchAll(/<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?item\b([^>]*?)\/?>/gi)) {
    const attributes = readAttributes(match[1])
    const href = (attributes.href ?? '').trim()
    if (href === '') continue
    const id = (attributes.id ?? '').trim() || `item-${items.length + 1}`
    const item = {
      id,
      href,
      mediaType: (attributes['media-type'] ?? '').split(';')[0].trim().toLowerCase(),
      properties: (attributes.properties ?? '').trim().toLowerCase(),
    }
    items.push(item)
    if (!byId.has(id)) byId.set(id, item)
  }

  /** @type {string[]} */
  const idrefs = []
  const spine = elementBlock(opf, 'spine')
  if (spine !== undefined) {
    for (const match of spine.matchAll(/<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?itemref\b([^>]*?)\/?>/gi)) {
      const idref = (readAttributes(match[1]).idref ?? '').trim()
      if (idref !== '') idrefs.push(idref)
    }
  }

  return {
    items,
    byId,
    idrefs,
    titles: metadataTexts(opf, 'title'),
    creators: metadataTexts(opf, 'creator'),
    languages: metadataTexts(opf, 'language'),
  }
}

/**
 * @typedef {{ href: string, title: string | undefined, level: number }} NavEntry
 */

/**
 * Flatten `<nav epub:type="toc">` into entries carrying their nesting depth.
 *
 * The nav is read with a tag walk instead of a DOM: `<ol>`/`<ul>` push and pop
 * the depth, and the text of the `<a>` that closes at that depth becomes the
 * label. `level` is therefore the list nesting the link sits in, 1-based, which
 * is what a TOC renderer wants. A `<li>` with a `<span>` and no link (a part
 * heading) contributes no entry but still keeps its children at the right
 * depth, because the depth only tracks lists.
 *
 * Entries are returned unresolved: the caller resolves each href against the
 * OPF directory and keeps only the ones that name a spine chapter, so a nav
 * that also links a cover page or an external URL cannot invent a chapter.
 *
 * @param {string} source - nav document text.
 * @returns {NavEntry[]} entries in document order.
 */
function parseNavigationDocument(source) {
  /** @type {NavEntry[]} */
  const entries = []

  let body
  for (const match of source.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav\s*>/gi)) {
    const attributes = readAttributes(match[1])
    const types = `${attributes['epub:type'] ?? ''} ${attributes.type ?? ''}`.trim().toLowerCase().split(/\s+/)
    if (types.includes('toc')) {
      body = match[2]
      break
    }
  }
  if (body === undefined) return entries

  let depth = 0
  /** @type {{ href: string, level: number, from: number } | null} */
  let pending = null
  for (const match of body.matchAll(/<(\/?)(ol|ul|li|a)\b([^>]*)>/gi)) {
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()
    if (name === 'ol' || name === 'ul') {
      depth = closing ? Math.max(0, depth - 1) : depth + 1
      continue
    }
    if (name === 'li') continue
    if (closing) {
      if (pending !== null) {
        entries.push({
          href: pending.href,
          title: textOfMarkup(body.slice(pending.from, match.index)),
          level: pending.level,
        })
        pending = null
      }
      continue
    }
    const href = (readAttributes(match[3]).href ?? '').trim()
    if (href === '') continue
    // An unclosed previous anchor loses its entry but must not swallow this one.
    if (pending !== null) {
      entries.push({
        href: pending.href,
        title: textOfMarkup(body.slice(pending.from, match.index)),
        level: pending.level,
      })
    }
    pending = { href, level: Math.max(1, depth), from: match.index + match[0].length }
  }
  if (pending !== null) {
    entries.push({ href: pending.href, title: textOfMarkup(body.slice(pending.from)), level: pending.level })
  }
  return entries
}

/**
 * The package document named by `META-INF/container.xml`.
 *
 * The container is the only supported way to find the OPF — the file name and
 * its directory are the author's choice, so `OEBPS/content.opf` is never
 * assumed. When the container is absent or names nothing usable, the first
 * `.opf` entry in archive order is taken and a warning records the fallback.
 *
 * @param {{ byName: Map<string, Uint8Array>, byLowerName: Map<string, string> }} index - entry index.
 * @param {string[]} warnings - response warnings, appended to.
 * @returns {string} canonical path of the package document.
 * @throws {Error & { status: number }} 415 when the archive has no OPF at all.
 */
function findPackageDocument(index, warnings) {
  const container = entryBytes(index, 'META-INF/container.xml')
  if (container !== undefined) {
    const source = decodeDocument(container)
    const match = /<rootfile\b[^>]*?\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(source)
    const declared = (match?.[1] ?? match?.[2] ?? '').trim()
    if (declared !== '') {
      const resolved = normalizeZipPath(decodePercentPath(declared))
      if (resolved !== undefined) return resolved
    }
  }
  for (const name of index.byName.keys()) {
    if (/\.opf$/i.test(name)) {
      warnings.push('container.xml names no package document; using the first .opf entry')
      return name
    }
  }
  throw archiveError('no package document (OPF) found in the archive')
}

/**
 * The navigation document, if the archive has one.
 *
 * Preferred source is the manifest item carrying `properties="nav"`. Archives
 * that omit the property (or the manifest entry) fall back to any entry named
 * `nav.xhtml` / `nav.html`, which is where the file conventionally lives. A
 * declared nav that points at a missing entry is skipped, so the fallback still
 * applies instead of failing the book.
 *
 * @param {{ byName: Map<string, Uint8Array>, byLowerName: Map<string, string> }} index - entry index.
 * @param {string} opfDir - directory of the package document.
 * @param {{ items: Array<{ href: string, properties: string }> }} pkg - parsed package document.
 * @returns {string | undefined} canonical path of a nav document that exists.
 */
function findNavigationPath(index, opfDir, pkg) {
  const declared = pkg.items.find(item => item.properties.split(/\s+/).includes('nav'))
  if (declared !== undefined) {
    const resolved = resolveHref(opfDir, declared.href)
    if (resolved !== undefined && entryBytes(index, resolved) !== undefined) return resolved
  }
  for (const name of index.byName.keys()) {
    if (/(^|\/)nav\.x?html?$/i.test(name)) return name
  }
  return undefined
}

/* ------------------------------ chapter content -------------------------- */

/**
 * Reduce one content document to the markup between `<body>` and `</body>`.
 *
 * Nothing is sanitized: the document comes from the user's own book and the
 * client renders it in a sandboxed iframe with a fixed CSP, so rewriting it
 * here would only risk damaging the text. A document without a usable `<body>`
 * pair is still reduced by dropping the wrappers named in the requirement.
 *
 * @param {string} source - XHTML document text.
 * @returns {string} body-inner markup.
 */
function bodyFragment(source) {
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(source)
  if (bodyMatch !== null) return bodyMatch[1].trim()
  return source
    .replace(/<\?xml\b[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE\b[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<\/?body\b[^>]*>/gi, '')
    .trim()
}

/**
 * The first `<h1>` in one content document, as plain text.
 *
 * @param {string} source - XHTML document text.
 * @returns {string | undefined} heading text.
 */
function firstHeadingText(source) {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(source)
  return match === null ? undefined : textOfMarkup(match[1])
}

/**
 * Whether one spine item is a text chapter rather than a fixed-layout image page.
 *
 * `application/xhtml+xml` is the normal case; `text/html` is accepted because
 * hand-made EPUBs use it, and an item that declares no media type is judged by
 * its suffix.
 *
 * @param {{ mediaType: string }} item - manifest item.
 * @param {string} entryName - canonical entry name.
 * @returns {boolean} true when the document should become a chapter.
 */
function isContentDocument(item, entryName) {
  if (item.mediaType !== '') return CONTENT_MEDIA_RE.test(item.mediaType)
  return CONTENT_SUFFIX_RE.test(entryName)
}

/**
 * Build a base64 data URL for one image.
 *
 * @param {string} mediaType - image media type.
 * @param {Uint8Array} bytes - image bytes.
 * @returns {string} `data:` URL.
 */
function imageDataUrl(mediaType, bytes) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/* ------------------------------ the whole book --------------------------- */

/**
 * Unpack one EPUB into the JSON the reading view renders.
 *
 * Read order is fixed and each entry is touched once: index the zip, find the
 * OPF through the container, parse manifest/spine/metadata, read the nav, walk
 * the spine for chapter bodies, then inline CSS and images. `unzipSync` runs
 * once for the whole request — no chapter ever re-opens the archive — and its
 * filter refuses an archive whose declared payload is past
 * {@link MAX_EXPANDED_BYTES} before anything is inflated.
 *
 * Chapters follow spine order, not nav order; the nav only supplies labels and
 * levels, and an anchor that does not resolve to a spine chapter is dropped
 * (a nav may also link a cover page or an external site). When a chapter's
 * body cannot be decoded, that chapter is kept with an empty `html` and a
 * warning, so one broken document cannot cost the whole book.
 *
 * @param {Uint8Array} bytes - the archive.
 * @param {string} filePath - absolute path on disk, used only for the title fallback.
 * @returns {object} response body: `ok: true` plus title/author/language/toc/chapters/css/images.
 * @throws {Error & { status: number }} 415 when the archive cannot produce a book, 413 when it expands past the cap.
 */
function parseEpubArchive(bytes, filePath) {
  /** @type {string[]} */
  const warnings = []

  let rawEntries
  let expandedBytes = 0
  let expansionExceeded = false
  try {
    rawEntries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
      // The filter runs on the central directory, before any entry is inflated,
      // so a zip bomb is refused without its payload ever reaching memory.
      filter: (entry) => {
        expandedBytes += entry.originalSize
        if (expandedBytes > MAX_EXPANDED_BYTES) {
          expansionExceeded = true
          return false
        }
        return true
      },
    })
  } catch (error) {
    throw archiveError(`not a readable EPUB archive: ${errorMessage(error)}`)
  }
  if (expansionExceeded) {
    throw archiveError(`archive expands to more than ${MAX_EXPANDED_BYTES} bytes`, 413)
  }
  const index = indexEntries(rawEntries)
  if (entryBytes(index, 'mimetype') === undefined) warnings.push('mimetype entry missing from archive')

  const opfPath = findPackageDocument(index, warnings)
  const opfBytes = entryBytes(index, opfPath)
  if (opfBytes === undefined) throw archiveError(`package document ${opfPath} is missing from the archive`)
  const opf = decodeDocument(opfBytes)
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const pkg = parsePackageDocument(opf)

  const navPath = findNavigationPath(index, opfDir, pkg)
  /** @type {NavEntry[]} */
  let navEntries = []
  if (navPath === undefined) {
    warnings.push('navigation document not found; TOC generated from the spine')
  } else {
    const navSource = decodeDocument(/** @type {Uint8Array} */ (entryBytes(index, navPath)))
    navEntries = parseNavigationDocument(navSource)
  }

  // A nav link is relative to the nav document (EPUB 3, §5.1), which is only
  // the OPF directory in the common layout. Both bases are tried, so a nav in
  // its own folder resolves, and so does a producer that wrongly wrote its
  // links relative to the OPF.
  const navDir = navPath === undefined || !navPath.includes('/')
    ? opfDir
    : navPath.slice(0, navPath.lastIndexOf('/'))
  const navBases = navDir === opfDir ? [opfDir] : [navDir, opfDir]

  /** @type {Map<string, string | undefined>} nav labels keyed by resolved chapter path */
  const navTitles = new Map()
  for (const entry of navEntries) {
    for (const base of navBases) {
      const entryName = resolveHref(base, entry.href)
      if (entryName !== undefined && !navTitles.has(entryName)) navTitles.set(entryName, entry.title)
    }
  }

  /** @type {Array<{ id: string, number: number, title: string | undefined, html: string, path: string }>} */
  const chapters = []
  for (const idref of pkg.idrefs) {
    const item = pkg.byId.get(idref)
    if (item === undefined) continue
    const entryName = resolveHref(opfDir, item.href)
    if (entryName === undefined) {
      warnings.push(`spine item ${idref} points outside the archive`)
      continue
    }
    const documentBytes = entryBytes(index, entryName)
    if (documentBytes === undefined) {
      warnings.push(`spine item ${idref} points at the missing entry ${entryName}`)
      continue
    }
    if (!isContentDocument(item, entryName)) continue

    const number = chapters.length + 1
    const id = `ch${String(number).padStart(3, '0')}`
    /** @type {string | undefined} */
    let source
    let html = ''
    try {
      source = decodeDocument(documentBytes)
      html = bodyFragment(source)
    } catch {
      source = undefined
      warnings.push(`chapter ${id} unparsable`)
    }
    chapters.push({
      id,
      number,
      title: navTitles.get(entryName) ?? (source === undefined ? undefined : firstHeadingText(source)),
      html,
      path: entryName,
    })
  }
  if (chapters.length === 0) throw archiveError('the spine declares no readable chapter')

  // `id` is the chapter's position in the spine, so the TOC and the chapter list
  // agree without the client having to match hrefs.
  /** @type {Map<string, { id: string, number: number, title: string | undefined, path: string }>} */
  const chapterByPath = new Map()
  for (const chapter of chapters) if (!chapterByPath.has(chapter.path)) chapterByPath.set(chapter.path, chapter)

  /** @type {Array<{ id: string, title: string, level: number, href: string }>} */
  const toc = []
  for (const entry of navEntries) {
    /** @type {{ chapter: { id: string, number: number, title: string | undefined }, entryName: string } | undefined} */
    let matched
    for (const base of navBases) {
      const entryName = resolveHref(base, entry.href)
      const chapter = entryName === undefined ? undefined : chapterByPath.get(entryName)
      if (chapter !== undefined) {
        matched = { chapter, entryName }
        break
      }
    }
    if (matched === undefined) continue
    const { chapter, entryName } = matched
    toc.push({
      id: chapter.id,
      title: entry.title ?? chapter.title ?? `Chapter ${chapter.number}`,
      level: entry.level,
      href: entryName,
    })
  }
  if (toc.length === 0) {
    if (navEntries.length > 0) warnings.push('navigation document lists no spine chapter; TOC generated from the spine')
    for (const chapter of chapters) {
      toc.push({
        id: chapter.id,
        title: chapter.title ?? `Chapter ${chapter.number}`,
        level: 1,
        href: chapter.path,
      })
    }
  }

  // CSS: every text/css manifest item, manifest order, newline separated.
  /** @type {string[]} */
  const cssParts = []
  for (const item of pkg.items) {
    if (item.mediaType !== 'text/css') continue
    const entryName = resolveHref(opfDir, item.href)
    const cssBytes = entryBytes(index, entryName)
    if (cssBytes !== undefined) cssParts.push(decodeDocument(cssBytes))
  }

  /** @type {Array<{ href: string, mediaType: string, data: string }>} */
  const images = []
  let skippedImages = 0
  let inlinedImageBytes = 0
  let imagesTruncated = false
  for (const item of pkg.items) {
    if (!item.mediaType.startsWith('image/')) continue
    const entryName = resolveHref(opfDir, item.href)
    const imageBytes = entryBytes(index, entryName)
    if (entryName === undefined || imageBytes === undefined) continue
    if (imageBytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      skippedImages += 1
      continue
    }
    if (inlinedImageBytes + imageBytes.byteLength > MAX_INLINE_IMAGES_BYTES) {
      imagesTruncated = true
      break
    }
    inlinedImageBytes += imageBytes.byteLength
    images.push({ href: entryName, mediaType: item.mediaType, data: imageDataUrl(item.mediaType, imageBytes) })
  }

  const firstNavTitle = navEntries.find(entry => entry.title !== undefined)?.title
  const title = pkg.titles[0] ?? firstNavTitle ?? path.basename(filePath, path.extname(filePath))
  const book = {
    ok: true,
    title,
    author: pkg.creators[0] ?? '',
    language: pkg.languages[0] ?? 'und',
    toc,
    chapters: chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title ?? `Chapter ${chapter.number}`,
      html: chapter.html,
      href: chapter.path,
    })),
    css: cssParts.join('\n'),
    images,
  }
  if (skippedImages > 0) book.skippedImages = skippedImages
  if (imagesTruncated) book.imagesTruncated = true
  if (warnings.length > 0) book.warnings = warnings
  return book
}

/* -------------------------------------------------------------------------- */
/* Request / response plumbing                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a JSON Fetch response.
 *
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {Response} response with the JSON content type.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Write a JSON response to a Node `ServerResponse`.
 *
 * @param {object} response - Node response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @param {Record<string, string>} [headers] - extra headers (for example `allow`).
 * @returns {void}
 */
function sendNodeJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  })
  response.end(text)
}

/**
 * Parse the request URL the webserver handed over.
 *
 * @param {Request} request - Fetch request built by the webserver.
 * @returns {URL | undefined} parsed URL, or `undefined` when the request carries none.
 */
function requestUrl(request) {
  try {
    return new URL(request.url)
  } catch {
    return undefined
  }
}

/**
 * Read and parse one JSON request body.
 *
 * @param {AsyncIterable<Uint8Array>} request - Node request stream.
 * @returns {Promise<unknown>} parsed body.
 * @throws {Error} when the body is oversized, empty or not JSON.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new Error('request body must be JSON')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`request body is not valid JSON: ${errorMessage(error)}`)
  }
}

/**
 * Validate one `?path=` value and resolve it to the key the registry uses.
 *
 * Only shape is checked here — a non-empty string without `..` that resolves to
 * an absolute path. Whether the file may be served is each route's own
 * decision: the artifact registry's for `/book` and `/file`, and the `.epub`
 * suffix plus the size cap for `/epub`.
 *
 * `/epub` does not use this directly any more: it may receive a Session-relative
 * path and has to root it somewhere, which is what {@link resolveEpubPath} adds.
 *
 * @param {string | null} raw - query value.
 * @returns {{ path: string, error?: undefined } | { path?: undefined, error: string }} resolved absolute path, or the reason the value is unusable.
 */
function resolveRequestPath(raw) {
  if (typeof raw !== 'string' || raw === '') return { error: 'path is required' }
  if (raw.includes('..')) return { error: 'path must not contain ".."' }
  const resolved = path.resolve(raw)
  if (!path.isAbsolute(resolved)) return { error: 'path must be absolute' }
  return { path: resolved }
}

/* -------------------------------------------------------------------------- */
/* Session working directories                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read one Host service without assuming it is there.
 *
 * `ctx.get(name)` is how a Host plugin reaches a service it did not declare in
 * `inject`; the plain-property read is a descriptor read, so a Cordis getter is
 * never invoked (a getter would throw for a name this fiber did not inject,
 * which is the opposite of the "is it installed?" question being asked).
 *
 * @param {object | null | undefined} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {unknown} the service, or `undefined`.
 */
function hostService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // "not provided in this deployment" is the normal answer here.
    }
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(ctx, name)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(ctx, name)
    if (descriptor === undefined || !('value' in descriptor)) return undefined
    const direct = descriptor.value
    return direct === undefined || direct === null ? undefined : direct
  } catch {
    return undefined
  }
}

/**
 * Resolve the absolute working directory one Session's relative paths are
 * rooted at.
 *
 * The Host contract is two services deep: `ctx.sessions.get(sessionId)` finds a
 * *live* session, and `ctx.workingDirectory.get(session)` reads its committed
 * directory without touching the filesystem (`api-catalog`: `get(session:
 * Session): string`). The Session header's `cwd` is the fallback, because a
 * session started before the working-directory service existed still records
 * where it was created. Nothing here guesses: a Session this Host does not know
 * is reported as unknown so the route can answer 404 rather than call some
 * other directory "close enough".
 *
 * @param {object} ctx - plugin context carrying `sessions` and `workingDirectory`.
 * @param {string} sessionId - Session the relative path belongs to.
 * @returns {{ directory: string, error?: undefined } | { directory?: undefined, error: string, status: number }} the root, or why it could not be read.
 */
function lookupSessionDirectory(ctx, sessionId) {
  const sessions = hostService(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') {
    return {
      status: 500,
      error: 'this Host serves no "sessions" lookup, so a relative path cannot be resolved; send an absolute path',
    }
  }
  let session
  try {
    session = sessions.get(sessionId)
  } catch (error) {
    return { status: 500, error: `cannot look up session "${sessionId}": ${errorMessage(error)}` }
  }
  if (session === undefined || session === null) return { status: 404, error: `unknown session: ${sessionId}` }
  let directory
  const directories = hostService(ctx, 'workingDirectory')
  if (directories !== undefined && typeof directories.get === 'function') {
    try {
      directory = directories.get(session)
    } catch {
      directory = undefined
    }
  }
  if (typeof directory !== 'string' || directory === '') {
    const header = session.header !== null && typeof session.header === 'object' ? session.header : undefined
    directory = header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''
  }
  if (directory === '') return { status: 404, error: `session "${sessionId}" has no working directory` }
  if (!path.isAbsolute(directory)) {
    return { status: 500, error: `session "${sessionId}" reports a non-absolute working directory` }
  }
  return { directory }
}

/**
 * Session-directory lookup the `/epub` route uses.
 *
 * Module-level so a test can replace the "ask the Host which directory this
 * Session owns" step without standing up a Host: everything else — the shape
 * checks, the containment check, the suffix gate, the archive caps — stays the
 * real implementation. {@link setSessionDirectoryLookup} is the only way to
 * change it, and passing no function restores the default.
 *
 * @type {(ctx: object, sessionId: string) => { directory?: string, error?: string, status?: number }}
 */
let sessionDirectoryLookup = lookupSessionDirectory

/**
 * Replace the Session-directory lookup (test seam).
 *
 * @param {((ctx: object, sessionId: string) => { directory?: string, error?: string, status?: number }) | null | undefined} lookup - the replacement, or nothing to restore the default.
 * @returns {void}
 */
export function setSessionDirectoryLookup(lookup) {
  sessionDirectoryLookup = typeof lookup === 'function' ? lookup : lookupSessionDirectory
}

/**
 * Whether `target` is `base` or lives under it.
 *
 * Comparison is case-insensitive on Windows, where `<workspace>` and `<Workspace>`
 * name the same directory and a case-sensitive prefix test would reject a valid path.
 *
 * @param {string} base - directory the path must stay inside.
 * @param {string} target - resolved absolute path.
 * @returns {boolean} true when the target is contained.
 */
function isInsideDirectory(base, target) {
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  const root = fold(base.replace(/[\\/]+$/, ''))
  const value = fold(target)
  return value === root || value.startsWith(`${root}${path.sep}`)
}

/**
 * Resolve the `path` one `/epub` request names.
 *
 * Three shapes, in the order the client can produce them:
 *   - an absolute path: taken as given (this is what a file outside the
 *     workspace produces, and what every existing caller sends);
 *   - a relative path plus `sessionId`: joined to that Session's working
 *     directory, then required to stay inside it;
 *   - a relative path alone: refused with an explanation, because resolving it
 *     against the host process' cwd is precisely the bug this replaced.
 *
 * @param {object} ctx - plugin context, for the Session lookup.
 * @param {string | null} rawPath - the `path` query value.
 * @param {string | null} rawSessionId - the `sessionId` query value.
 * @returns {{ path: string, error?: undefined } | { path?: undefined, error: string, status: number }} the absolute target, or the refusal.
 */
function resolveEpubPath(ctx, rawPath, rawSessionId) {
  if (typeof rawPath !== 'string' || rawPath === '') return { status: 400, error: 'path is required' }
  if (rawPath.includes('..')) return { status: 400, error: 'path must not contain ".."' }
  if (path.isAbsolute(rawPath)) return { path: path.resolve(rawPath) }
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  if (sessionId === '') {
    return {
      status: 400,
      error: 'path is relative; add sessionId=<session id> so the Host can resolve it against that Session\'s '
        + 'working directory, or send an absolute path',
    }
  }
  const resolved = sessionDirectoryLookup(ctx, sessionId)
  if (typeof resolved.directory !== 'string' || resolved.directory === '') {
    return { status: typeof resolved.status === 'number' ? resolved.status : 500, error: resolved.error ?? 'unknown session' }
  }
  if (!path.isAbsolute(resolved.directory)) {
    return { status: 500, error: `session "${sessionId}" reports a non-absolute working directory` }
  }
  const target = path.resolve(resolved.directory, rawPath)
  if (!isInsideDirectory(resolved.directory, target)) {
    return { status: 400, error: `path must stay inside the working directory of session "${sessionId}"` }
  }
  return { path: target }
}


/**
 * Read a file, treating every failure as "not there".
 *
 * @param {string} target - absolute path.
 * @param {'utf8'} [encoding] - omit for bytes.
 * @returns {Promise<string | Uint8Array | undefined>} contents, or `undefined` when unreadable.
 */
async function readOrUndefined(target, encoding) {
  try {
    return encoding === undefined ? await readFile(target) : await readFile(target, encoding)
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Coerce a value to a whole non-negative number.
 *
 * @param {unknown} value - candidate.
 * @param {unknown} [fallback] - used when the candidate is not finite.
 * @returns {number} rounded count, or the fallback's rounded count, or 0.
 */
function wholeNumber(value, fallback = 0) {
  const number = Number(value)
  if (Number.isFinite(number)) return Math.max(0, Math.round(number))
  const spare = Number(fallback)
  return Number.isFinite(spare) ? Math.max(0, Math.round(spare)) : 0
}

/**
 * Require one non-empty string argument.
 *
 * @param {unknown} value - candidate.
 * @param {string} key - field name, for the message.
 * @returns {string} the string.
 * @throws {Error} when the value is not a non-empty string.
 */
function requireString(value, key) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`pdf2epub: "${key}" must be a non-empty string`)
  return value
}

/**
 * Require an array of non-empty strings.
 *
 * @param {unknown} value - candidate.
 * @param {string} key - field name, for the message.
 * @returns {string[]} the strings.
 * @throws {Error} when the value is not such an array.
 */
function requireStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`pdf2epub: "${key}" must be an array of provider/model strings`)
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`pdf2epub: "${key}[${index}]" must be a non-empty provider/model string`)
    }
    return item
  })
}

/**
 * Require a finite number.
 *
 * @param {unknown} value - candidate.
 * @param {string} key - field name, for the message.
 * @returns {number} the number.
 * @throws {Error} when the value is not finite.
 */
function requireNumber(value, key) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`pdf2epub: "${key}" must be a number`)
  return number
}

/**
 * Require one output path returned by the pipeline.
 *
 * @param {unknown} value - candidate.
 * @param {string} key - field name, for the message.
 * @returns {string} absolute path.
 * @throws {Error} when the pipeline returned nothing usable.
 */
function requireOutputPath(value, key) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`pdf2epub: conversion finished without a ${key}`)
  }
  return path.resolve(value)
}

/**
 * Read an error's message without assuming it is an `Error`.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} message text.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
