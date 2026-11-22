/**
 * Self-test for the pdf2epub Host entry (`index.js` + `src/host/server.js`).
 *
 * Runs the plugin's `apply` against a recording fake context, then drives every
 * registered route with a minimal request stub. No Host process and no model
 * call: the job test points at a PDF that does not exist, so the pipeline throws
 * before it ever asks for a vision model.
 *
 * Usage: node test/harness/host-check.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = path.join(ROOT, '.out')
const TRUSTED_HOST = '127.0.0.1:53061'
const RUN = '/dsh-pdf2epub/run'
const STATE = '/dsh-pdf2epub/state'
const BOOK = '/dsh-pdf2epub/book'
const FILE = '/dsh-pdf2epub/file'
const EPUB = '/dsh-pdf2epub/epub'

const recorded = { tools: [], routes: [], labels: [] }
const started = new Map()
let jobSequence = 0
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
  jobs: {
    start(spec) {
      jobSequence += 1
      const id = `pdf2epub-test-${jobSequence}`
      const hooks = spec.run({ id, append() {}, updateProgress() {} })
      started.set(id, { spec, hooks })
      return id
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
console.log(`Config     : ${plugin.Config === undefined ? 'undefined here (schemastery resolved only inside DSH; defaults merged in apply)' : 'schemastery z.object'}`)
console.log(`effects    : ${recorded.labels.length} — ${recorded.labels.join(' | ')}`)
console.log('')

/* 1. tool registration ---------------------------------------------------- */
assert.equal(recorded.tools.length, 1, 'tools.register must be called exactly once')
const tool = recorded.tools[0]
assert.equal(tool.name, 'pdf2epub')
ok('1  tools.register called once, tool name is pdf2epub')

const paramKeys = Object.keys(tool.parameters.properties)
assert.deepEqual(paramKeys, ['input', 'outputDir', 'model', 'reviewModels', 'dpi', 'maxTokens', 'concurrency', 'splitLevel', 'force'])
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
const EPUB_BYTES = Buffer.from('PK\u0003\u0004fixture-epub-bytes', 'binary')
const enc = value => encodeURIComponent(value)
await mkdir(OUT, { recursive: true })
await writeFile(bookFixture, '{"schema":"fixture","pages":1}\n')
await writeFile(reportFixture, '{"schema":"fixture-report"}\n')
await writeFile(epubFixture, EPUB_BYTES)
/* A real EPUB the plugin never produced: self-built here so the "foreign file"
 * assertion does not depend on another test having run first. */
const { buildEpub } = await import(pathToFileURL(path.join(ROOT, 'src', 'epub', 'build.js')).href)
await writeFile(foreignEpub, buildEpub({
  title: '外来书目',
  language: 'zh-CN',
  identifier: 'urn:uuid:00000000-0000-4000-8000-0000000000ff',
  chapters: [{ title: '唯一章', html: '<h1>唯一章</h1><p>正文。</p>' }],
}))

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
  const jobsBefore = started.size
  const unconfigured = await invoke(plainRoutes.find(route => route.path === RUN), trusted(RUN, JSON.stringify({ input: '.out/whatever.pdf' })))
  assert.equal(unconfigured.status, 400)
  assert.match(JSON.parse(unconfigured.body).error, /primaryModel is not configured/)
  assert.equal(started.size, jobsBefore, 'an unconfigured plugin must not start a job')
  ok('20 POST /run on an unconfigured plugin -> 400 naming the setting', unconfigured.body)

  await assert.rejects(
    () => serverModule.convertToCanonical(ctx, { primaryModel: '' }, { input: '.out/whatever.pdf' }),
    /dsh-pdf2epub: primaryModel is not configured; set it to provider\/model in the plugin settings/,
  )
  ok('21 the tool path refuses the same way before touching the pipeline')

  /* Job: a missing PDF must fail the conversion, not the process. */
  const emptyPost = await invoke(routeOf(RUN), trusted(RUN, ''))
  assert.equal(emptyPost.status, 400)
  ok('22 POST /run with an empty body -> 400', `${emptyPost.status} ${emptyPost.body}`)

  const badSpec = await invoke(routeOf(RUN), trusted(RUN, '{"dpi":150}'))
  assert.equal(badSpec.status, 400)
  assert.match(JSON.parse(badSpec.body).error, /"input"/)
  ok('23 POST /run without input -> 400 naming the field', badSpec.body)

  const accepted = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/does-not-exist.pdf' })))
  assert.equal(accepted.status, 200)
  const jobId = JSON.parse(accepted.body).jobId
  assert.equal(typeof jobId, 'string')
  ok('24 POST /run returns { jobId }', accepted.body)

  const hooks = started.get(jobId).hooks
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed', `job outcome was ${outcome.status}`)
  assert.ok(typeof outcome.detail === 'string' && outcome.detail !== '', 'failure must carry a message')
  ok('25 a failing conversion is captured, process stays up', `done -> ${outcome.status}: ${outcome.detail}`)

  const stateAfter = await invoke(routeOf(STATE), trusted(`${STATE}?jobId=${encodeURIComponent(jobId)}`))
  assert.equal(stateAfter.status, 200)
  const stateBody = JSON.parse(stateAfter.body)
  assert.equal(stateBody.phase, 'failed')
  assert.equal(stateBody.status, 'failed')
  assert.deepEqual(stateBody.tokens, { input: null, output: null, total: 0 })
  assert.equal(stateBody.error, outcome.detail)
  ok('26 GET /state reports the failure with its message', JSON.stringify({
    phase: stateBody.phase,
    status: stateBody.status,
    error: stateBody.error,
  }))

  const secondRun = await invoke(routeOf(RUN), trusted(RUN, JSON.stringify({ input: '.out/does-not-exist-2.pdf', outputDir: '.out' })))
  const secondId = JSON.parse(secondRun.body).jobId
  assert.notEqual(secondId, jobId, 'job ids must be isolated')
  await started.get(secondId).hooks.done
  const firstState = JSON.parse((await invoke(routeOf(STATE), trusted(`${STATE}?jobId=${encodeURIComponent(jobId)}`))).body)
  const secondState = JSON.parse((await invoke(routeOf(STATE), trusted(`${STATE}?jobId=${encodeURIComponent(secondId)}`))).body)
  assert.equal(firstState.jobId, jobId)
  assert.equal(secondState.jobId, secondId)
  assert.equal(firstState.status, 'failed')
  assert.equal(secondState.status, 'failed')
  ok('27 concurrent job state stays isolated per jobId', `${firstState.jobId} / ${secondState.jobId}`)

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
  ok('28 artifact registry stays capped, dropping the oldest entry', `${evicted.status} ${evicted.body}`)
} finally {
  await unlink(bookFixture).catch(() => {})
  await unlink(reportFixture).catch(() => {})
  await unlink(epubFixture).catch(() => {})
  await unlink(foreignEpub).catch(() => {})
  await unlink(toolEpub).catch(() => {})
  await unlink(toolReport).catch(() => {})
  await unlink(toolBook).catch(() => {})
}

/* Config keys the host will validate (from the schema in index.js). */
console.log('')
console.log('=== Config keys ===')
console.log('primaryModel (required before converting, not required to load)  reviewModels  dpi  maxTokens  concurrency  splitLevel  language  outputDir')
console.log(`=== plugin module config keys in use ===`)
console.log(Object.keys(CONFIG).join('  '))
console.log('')
console.log(`ALL CHECKS PASSED (${passed} assertions)`)
