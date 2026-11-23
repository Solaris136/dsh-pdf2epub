/**
 * Self-test for the pdf2epub Host entry (`index.js` + `src/host/server.js`).
 *
 * Runs the plugin's `apply` against a recording fake context, then drives every
 * registered route with a minimal request stub. The context carries no `jobs`
 * service at all — that is the regression this file pins: a registered route is
 * unowned, so a job controller bound to an agent can never be reached from it
 * and the conversion has to run against `src/host/server.js`'s own state table.
 *
 * No Host process and no model call. The real executor is driven with a PDF that
 * does not exist, so the pipeline fails before it ever asks for a vision model;
 * the success path is driven through the `setConversionRunner` seam, which puts
 * the real runner back when it is passed nothing.
 *
 * Usage: node test/harness/host-check.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = path.join(ROOT, '.out')
const TRUSTED_HOST = '127.0.0.1:53061'
const RUN = '/dsh-pdf2epub/run'
const STATE = '/dsh-pdf2epub/state'
const BOOK = '/dsh-pdf2epub/book'
const FILE = '/dsh-pdf2epub/file'
const EPUB = '/dsh-pdf2epub/epub'

/** Largest job table the host layer keeps, mirrored from `src/host/server.js`. */
const MAX_STATES = 50

const recorded = { tools: [], routes: [], labels: [] }
let passed = 0

/* -------------------------------------------------------------------------- */
/* Fake Host context                                                          */
/* -------------------------------------------------------------------------- */

/** @param {unknown} headers - plain object or Headers. @param {string} key - header name. @returns {string | undefined} */
function headerOf(headers, key) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') return headers.get(key) ?? undefined
  const source = /** @type {Record<string, unknown>} */ (headers)
  const direct = source[key] ?? source[key.toLowerCase()] ?? source[key.toUpperCase()]
  return direct === undefined ? undefined : String(direct)
}

/** Stand-in for ctx.connection.requestRejection: a request without a loopback Host is refused. */
function requestRejection(request) {
  const host = headerOf(request?.headers, 'host')
  if (host === undefined || host !== TRUSTED_HOST) return 403
  return undefined
}

/**
 * The plugin context used by every route test.
 *
 * Deliberately has NO `jobs` member: `ctx.jobs.start` is what used to answer the
 * panel's click with `500 … no job controller serves this agent`, and a route
 * must not need one. `jobs` being absent here is the whole point of the suite.
 */
const ctx = {
  llm: {},
  attachments: {},
  connection: { requestRejection },
  tools: {
    register(definition) {
      recorded.tools.push(definition)
      return () => {}
    },
  },
  webServer: {
    register(route) {
      recorded.routes.push(route)
      return () => {}
    },
  },
  effect(callback, label) {
    recorded.labels.push(label)
    const disposer = callback()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Record one successful assertion. */
function ok(label, detail = '') {
  passed += 1
  console.log(`PASS  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/** Minimal Node ServerResponse stand-in. */
function makeResponseSink() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = { ...headers }
    },
    end(body) {
      if (body !== undefined) this.body = body
    },
  }
}

/**
 * Call one route through whichever response style it registered.
 * @param {object} route - registered route.
 * @param {object} request - request stub.
 * @returns {Promise<{ status: number, type: string | null, body: string }>} observed response.
 */
async function invoke(route, request) {
  if (typeof route.resource === 'function') {
    const response = await route.resource(request)
    return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
  }
  const sink = makeResponseSink()
  await route.handler(request, sink)
  const body = sink.body === undefined ? '' : String(sink.body)
  return { status: sink.statusCode, type: sink.headers['content-type'] ?? null, body }
}

/** A request stub the fence trusts, carrying a URL and an optional JSON body. */
function trusted(target, body) {
  const stub = { headers: { host: TRUSTED_HOST }, url: `http://${TRUSTED_HOST}${target}` }
  if (body !== undefined) {
    stub.method = 'POST'
    stub[Symbol.asyncIterator] = async function* iterator() {
      yield Buffer.from(body, 'utf8')
    }
  }
  return stub
}

/** @param {string} target - route path. @returns {object} matching registered route. */
function routeOf(target) {
  const route = recorded.routes.find(candidate => candidate.path === target)
  assert.ok(route !== undefined, `route ${target} must be registered`)
  return route
}

/** Whether one phase can still move. */
function isSettled(phase) {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled'
}

/**
 * Wait until one job's record reaches a settled phase.
 *
 * Polls the module's own projection — the same one `GET /state` serves. An id
 * that has left the table counts as settled too: only settled records are ever
 * evicted, so its absence cannot hide a conversion that is still running.
 *
 * @param {string} jobId - id returned by `POST /run`.
 * @param {number} [timeoutMs] - how long to wait before failing the assertion.
 * @returns {Promise<object | undefined>} the settled projection, or `undefined` when evicted.
 */
async function settled(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = serverModule.readJobState(jobId)
    if (state === undefined) return undefined
    if (isSettled(state.phase)) return state
    if (Date.now() > deadline) assert.fail(`job ${jobId} did not settle in ${timeoutMs} ms (phase ${state.phase})`)
    await delay(5)
  }
}

/**
 * Wait until one job's record satisfies a predicate.
 *
 * @param {string} jobId - job id.
 * @param {(state: object) => boolean} predicate - condition to reach.
 * @param {number} [timeoutMs] - how long to wait before failing the assertion.
 * @returns {Promise<object>} the record that satisfied the predicate.
 */
async function untilState(jobId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = serverModule.readJobState(jobId)
    if (state !== undefined && predicate(state)) return state
    if (Date.now() > deadline) assert.fail(`job ${jobId} never reached the expected state (last: ${JSON.stringify(state)})`)
    await delay(5)
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const plugin = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
/** Same module instance `index.js` loaded, so the registry it exposes is the one the routes read. */
const serverModule = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'server.js')).href)

const CONFIG = {
  primaryModel: 'test-provider/test-vision',
  reviewModels: [],
  dpi: 150,
  maxTokens: 4000,
  concurrency: 4,
  splitLevel: 2,
  language: 'zh-CN',
}

plugin.apply(ctx, CONFIG)

console.log('=== plugin surface ===')
console.log(`name       : ${plugin.name}`)
console.log(`inject     : ${JSON.stringify(plugin.inject)}`)
console.log(`jobs       : ${'jobs' in ctx ? 'present in the fake context' : 'absent — a route must not need one'}`)
console.log(`Config     : ${plugin.Config === undefined ? 'undefined here (schemastery resolved only inside DSH; defaults merged in apply)' : 'schemastery z.object'}`)
console.log(`effects    : ${recorded.labels.length} — ${recorded.labels.join(' | ')}`)
console.log('')

/* 1. tool registration ---------------------------------------------------- */
assert.equal(recorded.tools.length, 1, 'tools.register must be called exactly once')
const tool = recorded.tools[0]
assert.equal(tool.name, 'pdf2epub')
ok('1  tools.register called once, tool name is pdf2epub')

const paramKeys = Object.keys(tool.parameters.properties)
assert.deepEqual(paramKeys, ['input', 'outputDir', 'model', 'reviewModels', 'dpi', 'maxTokens', 'concurrency', 'splitLevel', 'pages', 'excludePages', 'cover', 'title', 'author', 'publisher', 'force'])
assert.deepEqual(tool.parameters.required, ['input'])
ok('1b tool parameters match the contract', paramKeys.join(', '))

assert.deepEqual(tool.output.schema.required, ['ok', 'epubPath', 'reportPath', 'bookJsonPath', 'pages', 'chapters', 'tokens', 'degradedPages'])
assert.ok(Object.keys(tool.output.schema.properties).length === 8)
ok('1c tool output.schema declares the canonical keys', tool.output.schema.required.join(', '))

/* The host rejects a canonical schema outside its enforced subset at
 * register time (docs/api-contracts.md §5), which a mocked registry cannot
 * catch — so check the same rules here. */
const SUBSET_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
const SUBSET_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
function assertSubsetSchema(node, at) {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${at} must be a schema object`)
  for (const key of Object.keys(node)) assert.ok(SUBSET_KEYWORDS.has(key), `${at}.${key} is outside the host's schema subset`)
  assert.ok('type' in node, `${at} must declare a type`)
  assert.ok(SUBSET_TYPES.includes(node.type), `${at}.type is not a supported type`)
  if ('required' in node) {
    assert.ok(Array.isArray(node.required) && node.required.every(entry => typeof entry === 'string'), `${at}.required must be a string array`)
    for (const key of node.required) assert.ok(Object.hasOwn(node.properties ?? {}, key), `${at}.required names undeclared "${key}"`)
  }
  if ('additionalProperties' in node) assert.ok(typeof node.additionalProperties === 'boolean')
  for (const [key, child] of Object.entries(node.properties ?? {})) assertSubsetSchema(child, `${at}.properties.${key}`)
  if ('items' in node) assertSubsetSchema(node.items, `${at}.items`)
}
assertSubsetSchema(tool.output.schema, 'output.schema')
ok('1d output.schema stays inside the host-enforced JSON Schema subset')

await assert.rejects(() => tool.execute({}, {}), /"input"/)
ok('1e tool execute validates its arguments')
await assert.rejects(
  () => tool.execute({ input: path.join(ROOT, '.out', 'does-not-exist.pdf') }, {}),
  /PDF not found/,
)
ok('1f tool execute reaches the pipeline and surfaces its error')

/* 2. route table ---------------------------------------------------------- */
assert.equal(recorded.routes.length, 5, 'webServer.register must be called five times')
const sortByPath = (left, right) => left.path.localeCompare(right.path)
assert.deepEqual(
  recorded.routes.map(route => ({ kind: route.kind, path: route.path })).sort(sortByPath),
  [
    { kind: 'exact', path: BOOK },
    { kind: 'exact', path: EPUB },
    { kind: 'exact', path: FILE },
    { kind: 'exact', path: RUN },
    { kind: 'exact', path: STATE },
  ],
)
ok('2  webServer.register called 5x with exact paths', recorded.routes.map(route => route.path).join(' '))
for (const route of recorded.routes) {
  const styles = [typeof route.resource, typeof route.handler].filter(type => type === 'function')
  assert.equal(styles.length, 1, `${route.path} must declare exactly one response style`)
  if (route.path === RUN) assert.equal(typeof route.handler, 'function', 'POST /run must be a Node handler')
  else assert.equal(typeof route.resource, 'function', `${route.path} must be a resource`)
}
ok('2b /run is a handler (POST), the four readers are resources')

/* The plugin must load without the `jobs` service (index.js used to inject it,
 * and a composition without it then refused to load the plugin at all). */
assert.deepEqual(plugin.inject.includes('jobs'), false, 'index.js must not inject the jobs service')
assert.equal('jobs' in ctx, false)
ok('2c index.js does not inject "jobs", and the context has none', `inject = ${plugin.inject.join(', ')}`)

/* 3. fence: every route answers 403 to an empty request -------------------- */
const fence = []
for (const route of recorded.routes) {
  try {
    const result = await invoke(route, {})
    assert.equal(result.status, 403, `${route.path} answered ${result.status}, not 403`)
    fence.push(`${route.path} -> 403`)
  } catch (error) {
    assert.fail(`${route.path} threw instead of answering 403: ${error?.message ?? error}`)
  }
}
for (const line of fence) console.log(`      ${line}`)
ok('3  every route returns 403 for an empty untrusted request')

/* Extras: the fence discriminates, and the readers actually work ----------- */

const untrustedHost = await invoke(routeOf(STATE), { headers: { host: 'evil.example' }, url: `http://evil.example${STATE}?jobId=x` })
assert.equal(untrustedHost.status, 403)
ok('4  a non-loopback Host is refused too', 'Host: evil.example -> 403')

const unknownJob = await invoke(routeOf(STATE), trusted(`${STATE}?jobId=nope`))
assert.equal(unknownJob.status, 404)
assert.equal(JSON.parse(unknownJob.body).error, 'unknown job')
assert.match(unknownJob.type ?? '', /application\/json/)
ok('5  GET /state unknown jobId -> 404 JSON', unknownJob.body)

const missingJobId = await invoke(routeOf(STATE), trusted(STATE))
assert.equal(missingJobId.status, 400)
ok('6  GET /state without jobId -> 400')

const bookFixture = path.join(OUT, 'fixture.book.json')
const reportFixture = path.join(OUT, 'fixture.report.json')
const epubFixture = path.join(OUT, 'fixture.epub')
const toolEpub = path.join(OUT, 'tool.epub')
const toolReport = path.join(OUT, 'tool.report.json')
const toolBook = path.join(OUT, 'tool.book.json')
const foreignEpub = path.join(OUT, 'foreign.epub')
const jobEpub = path.join(OUT, 'job.epub')
const jobReport = path.join(OUT, 'job.report.json')
const jobBook = path.join(OUT, 'job.book.json')
const EPUB_BYTES = Buffer.from('PK\u0003\u0004fixture-epub-bytes', 'binary')
const JOB_EPUB_BYTES = Buffer.from('PK\u0003\u0004job-epub-bytes', 'binary')
const enc = value => encodeURIComponent(value)
await mkdir(OUT, { recursive: true })
await writeFile(bookFixture, '{"schema":"fixture","pages":1}\n')
await writeFile(reportFixture, '{"schema":"fixture-report"}\n')
await writeFile(epubFixture, EPUB_BYTES)
await writeFile(jobEpub, JOB_EPUB_BYTES)
await writeFile(jobReport, '{"schema":"job-report"}\n')
await writeFile(jobBook, '{"schema":"job-book"}\n')
/* A real EPUB the plugin never produced: self-built here so the "foreign file"
 * assertion does not depend on another test having run first. */
const { buildEpub } = await import(pathToFileURL(path.join(ROOT, 'src', 'epub', 'build.js')).href)
await writeFile(foreignEpub, buildEpub({
  title: '外来书目',
  language: 'zh-CN',
  identifier: 'urn:uuid:00000000-0000-4000-8000-0000000000ff',
  chapters: [{ title: '唯一章', html: '<h1>唯一章</h1><p>正文。</p>' }],
}))

/** Id of the first job the suite starts: the oldest record, and the first one the cap evicts. */
let firstJobId = ''

try {
  /* The registry, not the filesystem, decides: these files exist but no job
   * produced them, so both readers answer 404 (never 403 — no probing). */
  const bookUnregistered = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(bookFixture)}`))
  assert.equal(bookUnregistered.status, 404)
  assert.equal(JSON.parse(bookUnregistered.body).error, 'not found')
  ok('7  GET /book on an unregistered path -> 404', `${bookUnregistered.status} ${bookUnregistered.body}`)

  const fileUnregistered = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(epubFixture)}`))
  assert.equal(fileUnregistered.status, 404)
  ok('8  GET /file on an unregistered path -> 404', `${fileUnregistered.status} ${fileUnregistered.body}`)

  const foreign = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(foreignEpub)}`))
  assert.equal(foreign.status, 404)
  ok('9  GET /file refuses a real EPUB this plugin did not produce', `${foreign.status} ${foreign.body}`)

  const traversal = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc('.out/../.out/fixture.book.json')}`))
  assert.equal(traversal.status, 400)
  ok('10 GET /book refuses raw "..', `${traversal.status} ${traversal.body}`)

  const noPath = await invoke(routeOf(FILE), trusted(FILE))
  assert.equal(noPath.status, 400)
  ok('11 GET /file without path -> 400', `${noPath.status} ${noPath.body}`)

  /* Seed the registry through the same call the job runner makes on success. */
  serverModule.recordArtifacts('pdf2epub-test-seed', {
    epubPath: epubFixture,
    reportPath: reportFixture,
    bookJsonPath: bookFixture,
  })

  const bookOk = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(bookFixture)}`))
  assert.equal(bookOk.status, 200)
  assert.equal(JSON.parse(bookOk.body).schema, 'fixture')
  ok('12 GET /book serves a registered .book.json verbatim', `${bookOk.status} ${bookOk.type}`)

  const epubOk = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(epubFixture)}`))
  assert.equal(epubOk.status, 200)
  assert.equal(epubOk.type, 'application/epub+zip')
  assert.equal(epubOk.body, EPUB_BYTES.toString('utf8'))
  ok('13 GET /file serves a registered .epub as application/epub+zip', `${epubOk.status} ${epubOk.type}`)

  const reportOk = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(reportFixture)}`))
  assert.equal(reportOk.status, 200)
  assert.equal(reportOk.type, 'application/json')
  ok('14 GET /file serves a registered .report.json as application/json', `${reportOk.status} ${reportOk.type}`)

  const bookOnFile = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(bookFixture)}`))
  assert.equal(bookOnFile.status, 400)
  ok('15 GET /file refuses a registered book sidecar', `${bookOnFile.status} ${bookOnFile.body}`)

  const fileOnBook = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(epubFixture)}`))
  assert.equal(fileOnBook.status, 400)
  ok('16 GET /book refuses a registered EPUB', `${fileOnBook.status} ${fileOnBook.body}`)

  /* Tool path: a conversion started in the conversation has no job id, and the
   * exact call `execute` makes on success is this one. The canonical value is
   * the stub here; everything downstream (registry, routes, content types) is
   * the real implementation. */
  const TOOL_BYTES = Buffer.from('PK\u0003\u0004tool-epub-bytes', 'binary')
  await writeFile(toolEpub, TOOL_BYTES)
  await writeFile(toolReport, '{"schema":"tool-report"}\n')
  await writeFile(toolBook, '{"schema":"tool-book"}\n')
  const toolCanonical = {
    ok: true,
    epubPath: toolEpub,
    reportPath: toolReport,
    bookJsonPath: toolBook,
    pages: 1,
    chapters: 1,
    tokens: { input: 0, output: 0, total: 0 },
    degradedPages: 0,
  }
  const toolSize = serverModule.recordArtifacts('tool', toolCanonical)
  const toolFile = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(toolEpub)}`))
  assert.equal(toolFile.status, 200)
  assert.equal(toolFile.type, 'application/epub+zip')
  assert.equal(toolFile.body, TOOL_BYTES.toString('utf8'))
  ok('17 recordArtifacts("tool", ...) makes a tool-produced EPUB readable', `${toolFile.status} ${toolFile.type}`)

  const toolBookRead = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(toolBook)}`))
  assert.equal(toolBookRead.status, 200)
  assert.equal(JSON.parse(toolBookRead.body).schema, 'tool-book')
  ok('18 ...and its book sidecar readable too', `${toolBookRead.status} ${toolBookRead.type}`)

  const duplicateSize = serverModule.recordArtifacts('tool', toolCanonical)
  assert.equal(duplicateSize, toolSize, 're-registering the same paths must not add entries')
  ok('19 re-registering the same paths adds no entries', `size stays ${duplicateSize}`)

  /* An unconfigured install must load, and fail here with the setting named. */
  const plainRoutes = []
  const plainCtx = { ...ctx, webServer: { register(route) { plainRoutes.push(route); return () => {} } } }
  serverModule.registerRoutes(plainCtx, { primaryModel: '' })
  const jobsBefore = serverModule.stateCount()
  const unconfigured = await invoke(plainRoutes.find(route => route.path === RUN), trusted(RUN, JSON.stringify({ input: '.out/whatever.pdf' })))
  assert.equal(unconfigured.status, 400)
  assert.match(JSON.parse(unconfigured.body).error, /primaryModel is not configured/)
  assert.equal(serverModule.stateCount(), jobsBefore, 'an unconfigured plugin must not start a job')
  ok('20 POST /run on an unconfigured plugin -> 400 naming the setting', unconfigured.body)

  await assert.rejects(
    () => serverModule.convertToCanonical(ctx, { primaryModel: '' }, { input: '.out/whatever.pdf' }),
    /dsh-pdf2epub: primaryModel is not configured; set it to provider\/model in the plugin settings/,
  )
  ok('21 the tool path refuses the same way before touching the pipeline')

  const emptyPost = await invoke(routeOf(RUN), trusted(RUN, ''))
  assert.equal(emptyPost.status, 400)
  ok('22 POST /run with an empty body -> 400', `${emptyPost.status} ${emptyPost.body}`)

  const badSpec = await invoke(routeOf(RUN), trusted(RUN, '{"dpi":150}'))
  assert.equal(badSpec.status, 400)
  assert.match(JSON.parse(badSpec.body).error, /"input"/)
  ok('23 POST /run without input -> 400 naming the field', badSpec.body)

  /* The six options added to the tool contract must reach the pipeline through
   * `POST /run` as well: `parseSpec()` used to whitelist only the old fields, so
   * a page selection, a cover request and a metadata override vanished silently
   * on the panel path. The injected runner captures the spec it is handed. */
  let optionSpec
  serverModule.setConversionRunner(async (runnerCtx, runnerConfig, runnerSpec) => {
    optionSpec = runnerSpec
    return {
      ok: true,
      epubPath: jobEpub,
      reportPath: jobReport,
      bookJsonPath: jobBook,
      pages: 2,
      chapters: 1,
      tokens: { input: 0, output: 0, total: 0 },
      degradedPages: 0,
    }
  })
  const optionRun = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/options.pdf', pages: '1-2', cover: true, title: 'T' })))
  assert.equal(optionRun.status, 200, `POST /run answered ${optionRun.status}: ${optionRun.body}`)
  await settled(JSON.parse(optionRun.body).jobId)
  serverModule.setConversionRunner(null)
  assert.ok(optionSpec !== undefined, 'the injected runner must be reached')
  assert.equal(optionSpec.pages, '1-2')
  assert.equal(optionSpec.cover, true)
  assert.equal(optionSpec.title, 'T')
  for (const key of ['excludePages', 'author', 'publisher']) {
    assert.equal(Object.hasOwn(optionSpec, key), false, `an unsupplied "${key}" must not be added to the spec`)
  }
  ok('23b POST /run hands "pages", "cover" and "title" to the pipeline spec', JSON.stringify({
    pages: optionSpec.pages,
    cover: optionSpec.cover,
    title: optionSpec.title,
    unsuppliedKeysAdded: ['excludePages', 'author', 'publisher'].filter(key => Object.hasOwn(optionSpec, key)),
  }))

  /* ------------------------------------------------------------------------ */
  /* The executor: no job controller, a module-owned state table              */
  /* ------------------------------------------------------------------------ */

  /* 24-26 drive the executor through the `setConversionRunner` seam: the fake
   * holds the run open at two gates, so the "accepted, still running" record and
   * the progress events are observed deterministically instead of by racing a
   * real conversion to completion. */
  let releaseStarted
  const startedGate = new Promise((resolve) => { releaseStarted = resolve })
  let releaseFinished
  const finishedGate = new Promise((resolve) => { releaseFinished = resolve })
  const runnerCalls = []

  serverModule.setConversionRunner(async (runnerCtx, runnerConfig, runnerSpec, options) => {
    runnerCalls.push({ ctx: runnerCtx, config: runnerConfig, spec: runnerSpec })
    await startedGate
    options.onProgress({ phase: 'start', pages: 2, input: runnerSpec.input })
    options.onProgress({ phase: 'page', page: 1, total: 2, status: 'ok', tokens: 26 })
    await finishedGate
    options.onProgress({ phase: 'page', page: 2, total: 2, status: 'degraded', tokens: 45 })
    options.onProgress({ phase: 'assemble', pages: 2 })
    options.onProgress({ phase: 'done', epubPath: jobEpub, reportPath: jobReport, tokens: 45 })
    return {
      ok: true,
      epubPath: jobEpub,
      reportPath: jobReport,
      bookJsonPath: jobBook,
      pages: 2,
      chapters: 2,
      tokens: { input: 100, output: 50, total: 150 },
      degradedPages: 1,
    }
  })

  /* The explicit contract: `POST /run` answers 200 + jobId on a context with no
   * `jobs` field at all (this one), and the state table has the record at once. */
  const accepted = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/injected-success.pdf', dpi: 150 })))
  assert.equal(accepted.status, 200, `POST /run answered ${accepted.status}: ${accepted.body}`)
  const jobId = JSON.parse(accepted.body).jobId
  firstJobId = jobId
  assert.match(jobId, /^pdf2epub-/, 'the id is minted by this module')
  const queued = serverModule.readJobState(jobId)
  assert.ok(queued !== undefined, 'the state table must hold the record as soon as /run answers')
  assert.equal(queued.phase, 'queued')
  assert.equal(queued.status, 'running')
  assert.equal(typeof queued.createdAt, 'number')
  assert.equal(queued.error, null)
  ok('24 POST /run on a ctx with no "jobs" -> 200 { jobId }, record queued/running at once', accepted.body)

  releaseStarted()
  const onPage = await untilState(jobId, state => state.page === 1)
  assert.equal(onPage.phase, 'page')
  assert.equal(onPage.page, 1)
  assert.equal(onPage.total, 2)
  assert.equal(onPage.status, 'running', 'a page verdict must not replace the job lifecycle status')
  assert.equal(onPage.pageStatus, 'ok')
  assert.equal(onPage.tokens.total, 26)
  assert.equal(runnerCalls.length, 1)
  assert.equal(runnerCalls[0].spec.input, '.out/injected-success.pdf')
  assert.equal(runnerCalls[0].ctx, ctx, 'the executor hands the plugin context through')
  ok('25 progress events land in the record', JSON.stringify({ phase: onPage.phase, page: onPage.page, total: onPage.total, pageStatus: onPage.pageStatus, tokens: onPage.tokens }))

  releaseFinished()
  const completed = await settled(jobId)
  assert.ok(completed !== undefined, 'the record must survive settlement')
  assert.equal(completed.phase, 'done')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.page, 2)
  assert.equal(completed.total, 2)
  assert.equal(completed.epubPath, jobEpub)
  assert.equal(completed.reportPath, jobReport)
  assert.equal(completed.bookJsonPath, jobBook)
  assert.deepEqual(completed.tokens, { input: 100, output: 50, total: 150 })
  assert.equal(completed.error, null)
  ok('26 a successful run settles done/completed with its three paths', JSON.stringify({
    phase: completed.phase,
    status: completed.status,
    epubPath: completed.epubPath,
    tokens: completed.tokens,
  }))

  /* recordArtifacts ran as part of that settlement: the two readers must serve
   * the files without any further call. */
  const jobFile = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(jobEpub)}`))
  assert.equal(jobFile.status, 200)
  assert.equal(jobFile.type, 'application/epub+zip')
  assert.equal(jobFile.body, JOB_EPUB_BYTES.toString('utf8'))
  const jobSidecar = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(jobBook)}`))
  assert.equal(jobSidecar.status, 200)
  assert.equal(JSON.parse(jobSidecar.body).schema, 'job-book')
  const reportSidecar = await invoke(routeOf(FILE), trusted(`${FILE}?path=${enc(jobReport)}`))
  assert.equal(reportSidecar.status, 200)
  ok('26b a settled success registers its artifacts for GET /file and GET /book', `${jobFile.status}/+book ${jobSidecar.status}/+report ${reportSidecar.status}`)

  /* Back to the real runner: a missing PDF must fail the job, with a readable
   * message and no artifacts registered — and the process must stay up. */
  serverModule.setConversionRunner(null)
  const failing = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/does-not-exist.pdf' })))
  assert.equal(failing.status, 200)
  const failId = JSON.parse(failing.body).jobId
  const failState = await settled(failId)
  assert.ok(failState !== undefined)
  assert.equal(failState.phase, 'failed')
  assert.equal(failState.status, 'failed')
  assert.match(failState.error, /PDF not found/)
  assert.equal(failState.epubPath, null)
  assert.equal(failState.reportPath, null)
  assert.equal(failState.bookJsonPath, null)
  ok('27 the real executor turns a failed conversion into a failed record, process stays up', `${failState.phase}/${failState.status}: ${failState.error}`)

  const failRead = await invoke(routeOf(STATE), trusted(`${STATE}?jobId=${encodeURIComponent(failId)}`))
  assert.equal(failRead.status, 200)
  const failBody = JSON.parse(failRead.body)
  assert.equal(failBody.phase, 'failed')
  assert.equal(failBody.status, 'failed')
  assert.equal(failBody.error, failState.error)
  assert.deepEqual(failBody.tokens, { input: null, output: null, total: 0 })
  ok('27b GET /state reports the failure with its message', JSON.stringify({ phase: failBody.phase, status: failBody.status, error: failBody.error }))

  const secondRun = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/does-not-exist-2.pdf', outputDir: '.out' })))
  const secondId = JSON.parse(secondRun.body).jobId
  assert.notEqual(secondId, jobId, 'job ids must be isolated')
  const firstState = await settled(jobId)
  const secondState = await settled(secondId)
  assert.equal(firstState.jobId, firstJobId)
  assert.equal(secondState.jobId, secondId)
  assert.equal(secondState.status, 'failed')
  assert.equal(firstState.status, 'completed', 'a later job must not touch an earlier record')
  ok('28 concurrent job state stays isolated per jobId', `${firstState.jobId} / ${secondState.jobId}`)

  /* `startConversionJob` itself, on a context with nothing injected at all: the
   * call that used to throw "no job controller serves this agent". */
  const orphan = serverModule.startConversionJob({}, CONFIG, { input: path.join(OUT, 'orphan.pdf') })
  assert.equal(typeof orphan.jobId, 'string')
  assert.match(orphan.jobId, /^pdf2epub-/)
  const orphanState = await settled(orphan.jobId)
  assert.ok(orphanState !== undefined)
  assert.equal(orphanState.phase, 'failed')
  assert.match(orphanState.error, /PDF not found/)
  ok('29 startConversionJob never needs a job controller', `{} -> ${orphanState.phase}: ${orphanState.error}`)

  /* The exact production symptom: a context that DOES carry a `jobs` service,
   * but no controller for this agent. `ctx.jobs.start` used to be called and threw
   * "no job controller serves this agent", which the route turned into a 500. A
   * run must now succeed without ever touching that service. */
  let legacyTouched = 0
  const legacyRoutes = []
  const legacyCtx = {
    llm: {},
    attachments: {},
    connection: { requestRejection },
    jobs: {
      start() {
        legacyTouched += 1
        throw new Error('background jobs unavailable: no job controller serves this agent')
      },
    },
    webServer: {
      register(route) {
        legacyRoutes.push(route)
        return () => {}
      },
    },
    effect(callback) {
      const disposer = callback()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  serverModule.registerRoutes(legacyCtx, CONFIG)
  const legacyRun = await invoke(legacyRoutes.find(route => route.path === RUN), trusted(RUN, JSON.stringify({ input: '.out/controllerless.pdf' })))
  assert.equal(legacyRun.status, 200, `POST /run answered ${legacyRun.status}: ${legacyRun.body}`)
  const legacyId = JSON.parse(legacyRun.body).jobId
  assert.match(legacyId, /^pdf2epub-/)
  const legacyState = await settled(legacyId)
  assert.equal(legacyState.phase, 'failed')
  assert.equal(legacyTouched, 0, 'ctx.jobs.start must not be called any more')
  ok('29b a "no job controller" jobs service is never reached; /run still answers 200', `${legacyRun.body} -> ${legacyState.phase}, jobs.start touched ${legacyTouched}x`)

  /* ------------------------------------------------------------------------ */
  /* State table cap (review finding S5)                                      */
  /* ------------------------------------------------------------------------ */

  /* One held run plus a flood of quick failures: the flood pushes the table past
   * the cap, the oldest settled records must fall out, and the record that is
   * still running must survive. */
  let releaseHeld
  const heldGate = new Promise((resolve) => { releaseHeld = resolve })
  serverModule.setConversionRunner(async () => {
    await heldGate
    return {
      ok: true,
      epubPath: jobEpub,
      reportPath: jobReport,
      bookJsonPath: jobBook,
      pages: 1,
      chapters: 1,
      tokens: { input: 1, output: 1, total: 2 },
      degradedPages: 0,
    }
  })
  const heldRun = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/held.pdf' })))
  assert.equal(heldRun.status, 200)
  const heldId = JSON.parse(heldRun.body).jobId
  assert.equal(serverModule.readJobState(heldId).status, 'running')
  /* The held call already captured its runner; the rest of the flood uses the
   * real one, so each of them settles on the spot. */
  serverModule.setConversionRunner(null)

  const floodIds = []
  for (let index = 0; index < 59; index += 1) {
    const flood = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: `.out/cap-job-${index}.pdf` })))
    assert.equal(flood.status, 200, `flood job ${index} answered ${flood.status}: ${flood.body}`)
    floodIds.push(JSON.parse(flood.body).jobId)
  }
  assert.equal(new Set(floodIds).size, floodIds.length, 'every job id must be unique')
  await Promise.all(floodIds.map(id => settled(id)))
  await delay(20)

  assert.ok(serverModule.stateCount() <= MAX_STATES, `state table holds ${serverModule.stateCount()} records, cap is ${MAX_STATES}`)
  const heldState = serverModule.readJobState(heldId)
  assert.ok(heldState !== undefined, 'a running record must never be evicted')
  assert.equal(heldState.status, 'running')
  assert.equal(serverModule.readJobState(firstJobId), undefined, 'the oldest settled record must be the first to go')
  const evictedRead = await invoke(routeOf(STATE), trusted(`${STATE}?jobId=${encodeURIComponent(firstJobId)}`))
  assert.equal(evictedRead.status, 404)
  ok('30 the job table stays capped at 50, dropping the oldest settled record and keeping a running one', `size ${serverModule.stateCount()}, oldest -> 404`)

  releaseHeld()
  const heldDone = await settled(heldId)
  assert.equal(heldDone.phase, 'done')
  assert.equal(heldDone.status, 'completed')
  assert.ok(serverModule.stateCount() <= MAX_STATES, `state table grew to ${serverModule.stateCount()} after the held job settled`)
  ok('30b the held job still completes after the eviction round', `${heldDone.phase}/${heldDone.status}, size ${serverModule.stateCount()}`)

  /* Registry cap: 200 entries, the oldest fall out first. */
  serverModule.recordArtifacts('pdf2epub-test-cap-seed', { epubPath: '', reportPath: '', bookJsonPath: bookFixture })
  assert.equal((await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(bookFixture)}`))).status, 200)
  for (let index = 0; index < 67; index += 1) {
    serverModule.recordArtifacts('pdf2epub-test-cap', {
      epubPath: path.join(ROOT, '.out', `cap-${index}.epub`),
      reportPath: path.join(ROOT, '.out', `cap-${index}.report.json`),
      bookJsonPath: path.join(ROOT, '.out', `cap-${index}.book.json`),
    })
  }
  const evicted = await invoke(routeOf(BOOK), trusted(`${BOOK}?path=${enc(bookFixture)}`))
  assert.equal(evicted.status, 404)
  ok('31 artifact registry stays capped, dropping the oldest entry', `${evicted.status} ${evicted.body}`)
} finally {
  serverModule.setConversionRunner(null)
  await unlink(bookFixture).catch(() => {})
  await unlink(reportFixture).catch(() => {})
  await unlink(epubFixture).catch(() => {})
  await unlink(foreignEpub).catch(() => {})
  await unlink(toolEpub).catch(() => {})
  await unlink(toolReport).catch(() => {})
  await unlink(toolBook).catch(() => {})
  await unlink(jobEpub).catch(() => {})
  await unlink(jobReport).catch(() => {})
  await unlink(jobBook).catch(() => {})
}

/* Config keys the host will validate (from the schema in index.js). */
console.log('')
console.log('=== Config keys ===')
console.log('primaryModel (required before converting, not required to load)  reviewModels  dpi  maxTokens  concurrency  splitLevel  language  outputDir')
console.log(`=== plugin module config keys in use ===`)
console.log(Object.keys(CONFIG).join('  '))
console.log('')
console.log(`ALL CHECKS PASSED (${passed} assertions)`)
