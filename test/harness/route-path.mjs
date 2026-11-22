/**
 * Route-path probe for `GET /dsh-pdf2epub/epub` — the B1 fix, end to end.
 *
 * Drives the REAL `registerRoutes()` from `src/host/server.js` (same import the
 * plugin uses, no mock of the route) against a real EPUB on disk, and asks it
 * for that one file three ways:
 *
 *   1. `?path=<absolute>`                      -> 200
 *   2. `?sessionId=<sid>&path=<relative tail>` -> 200, and the very same book
 *   3. `?path=<relative tail>` (no sessionId)  -> 400, with a readable reason
 *
 * Case 2 runs after `process.chdir()` into an unrelated directory, because the
 * original defect was exactly that `path.resolve()` was rooted at the host
 * process' cwd: only a host whose cwd happened to BE the workspace answered 200,
 * and every real click on a workspace file answered `404 not found`.
 *
 * The Session-directory lookup runs through its REAL default implementation:
 * the fake context below provides the two Host services it reads
 * (`ctx.get('sessions')` -> `ctx.get('workingDirectory')`), so what is faked is
 * the Host, not the plugin. `setSessionDirectoryLookup()` is then exercised
 * separately to prove the seam exists and that clearing it restores the default.
 *
 * Usage: node test/harness/route-path.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(ROOT, '.out', 'preview-fixer')
const TRUSTED_HOST = '127.0.0.1:53061'
const EPUB = '/dsh-pdf2epub/epub'

const server = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'server.js')).href)

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** One transparent pixel: enough for the route's image rewriter to inline. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Build the probe book in the run itself with `src/epub/build.js`, so a single
 * `node test/harness/route-path.mjs` works without another test having run first.
 */
const { buildEpub } = await import(pathToFileURL(path.join(ROOT, 'src', 'epub', 'build.js')).href)

fs.mkdirSync(WORK, { recursive: true })
const SAMPLE = path.join(WORK, 'sample.epub')
fs.writeFileSync(SAMPLE, buildEpub({
  title: '路由探针书目',
  author: '测试作者',
  language: 'zh-CN',
  identifier: 'urn:uuid:00000000-0000-4000-8000-0000000000aa',
  chapters: [
    { id: 'ch-one', title: '第一章 出发', level: 1, html: '<h1>第一章 出发</h1><p>第一段。</p>' },
    { id: 'ch-two', title: '第一节 到达', level: 2, html: '<h1>第一节 到达</h1><p>第二段。</p>' },
    { id: 'ch-three', title: '第二章 归途', level: 1, html: '<h1>第二章 归途</h1><p>第三段。</p>' },
  ],
  assets: [
    { href: 'images/fig1.png', mediaType: 'image/png', data: Uint8Array.from(Buffer.from(PNG_BASE64, 'base64')) },
  ],
}))

// The Session's *effective* directory (what `workingDirectory.get` answers) and
// the directory recorded when the Session was created (`header.cwd`). They may
// differ after a `cd`, and the effective one is what the Sidebar's file
// addresses are relative to.
const EFFECTIVE_DIRECTORY = ROOT
const MOVED_DIRECTORY = path.join(WORK, 'moved-workspace')
fs.mkdirSync(MOVED_DIRECTORY, { recursive: true })
const MOVED_BOOK = path.join(MOVED_DIRECTORY, 'moved.epub')
fs.copyFileSync(SAMPLE, MOVED_BOOK)

const SESSION_ID = 'session-probe-1'
const MOVED_SESSION_ID = 'session-probe-2'

/** The one relative tail both cases below ask for. */
const RELATIVE_TAIL = path.relative(EFFECTIVE_DIRECTORY, SAMPLE).split(path.sep).join('/')

/* -------------------------------------------------------------------------- */
/* Fake Host context (the plugin's own code is the real one)                   */
/* -------------------------------------------------------------------------- */

const recorded = { routes: [], effects: [], lookups: [] }
let cwdAtCall = ''

const ctx = {
  effect(callback) {
    const disposer = callback()
    recorded.effects.push(typeof disposer === 'function' ? disposer : undefined)
    return () => {}
  },
  webServer: {
    register(route) {
      recorded.routes.push(route)
      return () => {}
    },
  },
  connection: {
    // The fence the route checks first: only a loopback Host is trusted.
    requestRejection(request) {
      const headers = request?.headers
      const host = typeof headers?.get === 'function' ? headers.get('host') : headers?.host
      return host === TRUSTED_HOST ? undefined : 403
    },
  },
  logger: { error() {}, info() {}, warn() {} },
  /**
   * `ctx.get(name)` is how a Host plugin reaches a service it did not inject.
   * Both services are Session-shaped records, not this plugin's mocks.
   */
  get(name) {
    if (name === 'sessions') {
      return {
        get(id) {
          cwdAtCall = process.cwd()
          if (id === SESSION_ID) return { id, header: { id, cwd: ROOT } }
          // Recorded in ROOT, moved to MOVED_DIRECTORY after creation.
          if (id === MOVED_SESSION_ID) return { id, header: { id, cwd: ROOT } }
          return undefined
        },
      }
    }
    if (name === 'workingDirectory') {
      return {
        // The real contract: `get(session: Session): string`.
        get(session) {
          if (session === undefined || session === null) throw new Error('no session')
          recorded.lookups.push(session.id)
          return session.id === MOVED_SESSION_ID ? MOVED_DIRECTORY : EFFECTIVE_DIRECTORY
        },
      }
    }
    return undefined
  },
}

server.registerRoutes(ctx, {})

const route = recorded.routes.find(candidate => candidate.path === EPUB)
assert.ok(route !== undefined, `route ${EPUB} must be registered`)
assert.equal(route.kind, 'exact')
assert.equal(typeof route.resource, 'function')

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

let passed = 0
/** @param {string} label - assertion name. @param {string} [detail] - evidence. */
function ok(label, detail = '') {
  passed += 1
  console.log(`PASS  ${String(passed).padStart(2)} ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/**
 * Call the route with a query string and normalize the Fetch response.
 *
 * The request stub mirrors what the webserver hands a resource (a URL and a
 * header map) — a real `Request` would not carry a `host` header at all, and the
 * route's fence reads exactly that.
 *
 * @param {string} query - query string without the leading `?`.
 * @returns {Promise<{ status: number, type: string|null, body: any, text: string }>} the answer.
 */
async function ask(query) {
  const request = { headers: { host: TRUSTED_HOST }, url: `http://${TRUSTED_HOST}${EPUB}?${query}` }
  const response = await route.resource(request)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: response.status, type: response.headers.get('content-type'), body, text }
}

const describe = body => body === null
  ? '(not JSON)'
  : body.ok === true
    ? `ok:true title=${JSON.stringify(body.title)} chapters=${Array.isArray(body.chapters) ? body.chapters.length : '?'}`
    : `ok:false error=${JSON.stringify(body.error)}`

/* -------------------------------------------------------------------------- */
/* 1. absolute path                                                           */
/* -------------------------------------------------------------------------- */

const absolute = await ask(`path=${encodeURIComponent(SAMPLE)}`)
console.log(`\n--- 1. absolute path ---\n  path   = ${SAMPLE}\n  status = ${absolute.status}  ${describe(absolute.body)}`)
assert.equal(absolute.status, 200, `an absolute .epub path must answer 200, got ${absolute.status}: ${absolute.text}`)
assert.match(String(absolute.type ?? ''), /application\/json/)
assert.equal(absolute.body.ok, true)
assert.ok(Array.isArray(absolute.body.chapters) && absolute.body.chapters.length > 0, 'the book must carry chapters')
assert.ok(typeof absolute.body.css === 'string' && absolute.body.css.length > 0, 'the book must carry its stylesheet')
ok('1 absolute path -> 200', `${describe(absolute.body)}`)

/* -------------------------------------------------------------------------- */
/* 2. sessionId + relative tail, from an unrelated cwd                        */
/* -------------------------------------------------------------------------- */

const previousCwd = process.cwd()
const unrelated = path.join(WORK, 'unrelated-cwd')
fs.mkdirSync(unrelated, { recursive: true })
process.chdir(unrelated)
try {
  const relative = await ask(`sessionId=${encodeURIComponent(SESSION_ID)}&path=${encodeURIComponent(RELATIVE_TAIL)}`)
  console.log(`\n--- 2. sessionId + relative path, host cwd = ${unrelated} ---`)
  console.log(`  sessionId = ${SESSION_ID}\n  path      = ${RELATIVE_TAIL}\n  status    = ${relative.status}  ${describe(relative.body)}`)
  assert.equal(
    relative.status,
    200,
    `a relative path with its Session must answer 200 even when the host cwd is unrelated, got ${relative.status}: ${relative.text}`,
  )
  // "Content correct": byte-for-byte the same projection the absolute request
  // produced, so the path really resolved to this file and nothing else.
  assert.equal(
    JSON.stringify(relative.body),
    JSON.stringify(absolute.body),
    'the Session-relative request must return the same book as the absolute one',
  )
  ok('2 sessionId + relative path -> 200 with identical content', 'body === absolute-path body')

  // The B1 evidence: the same relative tail with no Session is what the reader
  // used to send, and `path.resolve()` quietly rooted it at the cwd above.
  const cwdWouldResolveTo = path.resolve(process.cwd(), RELATIVE_TAIL)
  assert.notEqual(cwdWouldResolveTo, SAMPLE, 'fixture sanity: the cwd-resolved path must not be the real file')
  console.log(`  (cwd would have resolved it to ${cwdWouldResolveTo} — the file is not there)`)
  ok('2b the cwd-rooted resolution the fix replaces points at a missing file', path.basename(cwdWouldResolveTo))
} finally {
  process.chdir(previousCwd)
}

/* -------------------------------------------------------------------------- */
/* 3. relative path without a sessionId                                       */
/* -------------------------------------------------------------------------- */

const orphan = await ask(`path=${encodeURIComponent(RELATIVE_TAIL)}`)
console.log(`\n--- 3. relative path, no sessionId ---\n  path   = ${RELATIVE_TAIL}\n  status = ${orphan.status}  ${describe(orphan.body)}`)
assert.equal(orphan.status, 400, `a relative path with no Session must answer 400, got ${orphan.status}`)
assert.equal(orphan.body.ok, false, 'the refusal must be ok:false so the reader shows it as an error')
assert.match(String(orphan.body.error), /sessionId/, 'the message must say that sessionId is what is missing')
assert.match(String(orphan.body.error), /relative/i, 'the message must say the path was relative')
assert.match(String(orphan.body.error), /absolute path/, 'the message must offer the absolute-path alternative')
ok('3 relative path, no sessionId -> 400 with a readable reason', JSON.stringify(orphan.body.error))

/* -------------------------------------------------------------------------- */
/* Extras: unknown Session, traversal, service plumbing, the test seam        */
/* -------------------------------------------------------------------------- */

const unknownSession = await ask(`sessionId=${encodeURIComponent('session-does-not-exist')}&path=${encodeURIComponent(RELATIVE_TAIL)}`)
console.log(`\n--- 4. unknown session ---\n  status = ${unknownSession.status}  ${describe(unknownSession.body)}`)
assert.equal(unknownSession.status, 404, 'an unknown Session must answer 404, not a guess')
assert.match(String(unknownSession.body.error), /unknown session/)
ok('4 unknown sessionId -> 404', JSON.stringify(unknownSession.body.error))

const traversal = await ask(`sessionId=${encodeURIComponent(SESSION_ID)}&path=${encodeURIComponent('../outside.epub')}`)
console.log(`\n--- 5. traversal ---\n  status = ${traversal.status}  ${describe(traversal.body)}`)
assert.equal(traversal.status, 400, '`..` must be refused before anything is read')
ok('5 ".." in a Session-relative path -> 400', JSON.stringify(traversal.body.error))

// The effective directory wins over the recorded header cwd: after a `cd`, the
// Sidebar's addresses are relative to the new directory, so the route must be too.
const moved = await ask(`sessionId=${encodeURIComponent(MOVED_SESSION_ID)}&path=moved.epub`)
console.log(`\n--- 6. a Session whose effective directory moved ---\n  status = ${moved.status}  ${describe(moved.body)}`)
assert.equal(moved.status, 200, 'the effective working directory must be used, not the recorded header cwd')
assert.ok(recorded.lookups.includes(MOVED_SESSION_ID), 'the lookup must have reached ctx.workingDirectory.get')
ok('6 effective working directory beats the recorded cwd', `moved.epub found under ${path.basename(MOVED_DIRECTORY)}`)

// ...and when the working-directory service is absent, the recorded cwd is the
// fallback rather than a hard failure.
const bare = { ...ctx, get: name => (name === 'sessions' ? ctx.get('sessions') : undefined) }
const bareRoutes = []
const bareCtx = {
  ...bare,
  webServer: { register(candidate) { bareRoutes.push(candidate); return () => {} } },
  effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
}
server.registerRoutes(bareCtx, {})
const bareRoute = bareRoutes.find(candidate => candidate.path === EPUB)
const fallbackAnswer = await bareRoute.resource({
  headers: { host: TRUSTED_HOST },
  url: `http://${TRUSTED_HOST}${EPUB}?sessionId=${encodeURIComponent(SESSION_ID)}&path=${encodeURIComponent(RELATIVE_TAIL)}`,
})
assert.equal(fallbackAnswer.status, 200, 'without workingDirectory the Session header cwd must still resolve the path')
ok('6b no workingDirectory service -> header.cwd fallback still answers 200')

// The seam: replace the lookup, observe it is used, then restore the default.
const stubCalls = []
server.setSessionDirectoryLookup((serviceCtx, sessionId) => {
  stubCalls.push(sessionId)
  return { directory: MOVED_DIRECTORY }
})
const stubbed = await ask(`sessionId=${encodeURIComponent('any-id-at-all')}&path=moved.epub`)
console.log(`\n--- 7. setSessionDirectoryLookup seam ---\n  status = ${stubbed.status}  ${describe(stubbed.body)}`)
assert.equal(stubbed.status, 200, 'the injected lookup must be the one the route uses')
assert.deepEqual(stubCalls, ['any-id-at-all'], 'the route must call the injected lookup with the request’s sessionId')
ok('7 setSessionDirectoryLookup() replaces the lookup used by the route')

server.setSessionDirectoryLookup(null)
const restored = await ask(`sessionId=${encodeURIComponent('session-does-not-exist')}&path=${encodeURIComponent(RELATIVE_TAIL)}`)
assert.equal(restored.status, 404, 'clearing the seam must restore the real Session lookup')
ok('7b clearing the seam restores the real lookup', `${restored.status} ${JSON.stringify(restored.body.error)}`)

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\nfixture: ${path.relative(ROOT, SAMPLE)}  (${fs.statSync(SAMPLE).size} bytes)`)
console.log(`session: ${SESSION_ID} -> ${EFFECTIVE_DIRECTORY}`)
console.log(`relative tail: ${RELATIVE_TAIL}`)
console.log(`ROUTE PATH OK (${passed} checks)`)
