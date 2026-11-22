/**
 * Self-test for the `GET /dsh-pdf2epub/epub` host route.
 *
 * Builds real EPUBs with `src/epub/build.js`, registers the plugin's routes on a
 * recording fake context (same shape as `test/harness/host-check.mjs`), and drives
 * the EPUB route's `resource` directly. No Host process, no network: the route
 * reads a real file from `.out/preview/` and answers with a Fetch `Response`.
 *
 * Fixtures written to `.out/preview/` (gitignored) so the result can be inspected
 * by hand as well:
 *   sample.epub       3 chapters, 1 image, nav from the builder
 *   alternate.epub    same book repacked with the OPF at book/content.opf
 *   no-nav.epub       sample without OEBPS/nav.xhtml
 *   no-mimetype.epub  sample without the mimetype entry
 *   dotted.epub       sample with every entry name prefixed "./"
 *   escape-href.epub  sample plus a manifest image whose href climbs out of the zip
 *   nav-subdir.epub   sample with the nav moved to OEBPS/nav/nav.xhtml
 *   garbage.epub      not a zip at all
 *   big-image.epub    one 2 MiB + image, which the route must skip
 *   oversize.epub     a 64 MiB + 1 file, created and deleted inside the run
 *
 * The zip-bomb guard (`MAX_EXPANDED_BYTES`) is not exercised here because it
 * needs a 256 MiB + payload; it was verified by hand with a 307 kB archive that
 * declares 300 MiB, which answers 413 in ~20 ms.
 *
 * Usage: node test/harness/epub-route-check.mjs
 */

import assert from 'node:assert/strict'
import { randomFillSync } from 'node:crypto'
import { mkdir, truncate, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PREVIEW = path.join(ROOT, '.out', 'preview')
const TRUSTED_HOST = '127.0.0.1:53061'
const EPUB = '/dsh-pdf2epub/epub'

let passed = 0

/* -------------------------------------------------------------------------- */
/* Fake host context                                                          */
/* -------------------------------------------------------------------------- */

const recorded = { routes: [], effects: [] }

/** @param {unknown} headers - plain object. @param {string} key - header name. @returns {string | undefined} */
function headerOf(headers, key) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') return headers.get(key) ?? undefined
  const source = /** @type {Record<string, unknown>} */ (headers)
  return source[key] === undefined ? undefined : String(source[key])
}

/** Stand-in for ctx.connection.requestRejection: a request without a loopback Host is refused. */
function requestRejection(request) {
  const host = headerOf(request?.headers, 'host')
  return host === TRUSTED_HOST ? undefined : 403
}

const ctx = {
  llm: {},
  attachments: {},
  connection: { requestRejection },
  jobs: {
    start() {
      throw new Error('GET /epub must not start a job')
    },
  },
  webServer: {
    register(route) {
      recorded.routes.push(route)
      return () => {}
    },
  },
  effect(callback) {
    const disposer = callback()
    recorded.effects.push(typeof disposer === 'function' ? disposer : undefined)
  },
}

const server = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'server.js')).href)
server.registerRoutes(ctx, {})

const route = recorded.routes.find(candidate => candidate.path === EPUB)
assert.ok(route !== undefined, `route ${EPUB} must be registered`)
assert.equal(route.kind, 'exact')
assert.equal(typeof route.resource, 'function', `${EPUB} must be a GET resource`)
assert.equal(route.handler, undefined)

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Record one successful assertion. */
function ok(label, detail = '') {
  passed += 1
  console.log(`PASS  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/** @param {string} target - route path with query. @returns {object} a request the fence trusts. */
function trusted(target) {
  return { headers: { host: TRUSTED_HOST }, url: `http://${TRUSTED_HOST}${target}` }
}

/** Query string for one absolute path. */
function queryParam(target) {
  return `${EPUB}?path=${encodeURIComponent(target)}`
}

/**
 * Call the route and normalize the Fetch response.
 * @param {object} request - request stub.
 * @returns {Promise<{ status: number, type: string | null, text: string, json: any }>} observed response.
 */
async function invoke(request) {
  const response = await route.resource(request)
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, type: response.headers.get('content-type'), text, json }
}

/** Call the route for one path, through the trusted Host. */
function callFor(target) {
  return invoke(trusted(queryParam(target)))
}

/** A `.epub`-named file that does not exist. */
function missingEpub(name) {
  return path.join(PREVIEW, name)
}

/** Container XML pointing at any rootfile path. */
function containerXml(fullPath) {
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    + '  <rootfiles>\n'
    + `    <rootfile full-path="${fullPath}" media-type="application/oebps-package+xml" />\n`
    + '  </rootfiles>\n'
    + '</container>\n'
}

/**
 * Re-zip an entry table, keeping `mimetype` first and STORED so the result still
 * looks like an EPUB to anything that cares.
 */
function pack(entries) {
  /** @type {Record<string, Uint8Array | [Uint8Array, { level: number }]>} */
  const out = {}
  if (entries.mimetype !== undefined) out.mimetype = [entries.mimetype, { level: 0 }]
  for (const [name, bytes] of Object.entries(entries)) {
    if (name === 'mimetype') continue
    out[name] = bytes
  }
  return zipSync(out, { level: 6 })
}

/**
 * Copy an archive entry by entry, letting `plan` rename or drop each one.
 * @param {Record<string, Uint8Array>} entries - source entries.
 * @param {(name: string) => string | null} plan - new name, or null to drop.
 */
function remap(entries, plan) {
  /** @type {Record<string, Uint8Array>} */
  const out = {}
  for (const [name, bytes] of Object.entries(entries)) {
    const next = plan(name)
    if (next === null) continue
    out[next] = bytes
  }
  return pack(out)
}

/** Decode the base64 half of a data URL back to bytes. */
function decodeDataUrl(url) {
  assert.match(url, /^data:[^;,]+;base64,/)
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

await mkdir(PREVIEW, { recursive: true })

const BOOK_TITLE = '路由自测小书'
const CHAPTER_TITLES = ['第一章 出发', '第一节 到达', '第二章 归途']
const CHAPTER_IDS = ['ch-one', 'ch-two', 'ch-three']
const CHAPTER_HREFS = CHAPTER_IDS.map(id => `OEBPS/text/${id}.xhtml`)
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const imageBytes = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'))

const { buildEpub } = await import(pathToFileURL(path.join(ROOT, 'src', 'epub', 'build.js')).href)

const sampleBytes = buildEpub({
  title: BOOK_TITLE,
  author: '测试作者',
  language: 'zh-CN',
  identifier: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  chapters: [
    { id: CHAPTER_IDS[0], title: CHAPTER_TITLES[0], level: 1, html: `<h1>${CHAPTER_TITLES[0]}</h1><p>第一段。</p>` },
    { id: CHAPTER_IDS[1], title: CHAPTER_TITLES[1], level: 2, html: `<h1>${CHAPTER_TITLES[1]}</h1><p>第二段。</p>` },
    { id: CHAPTER_IDS[2], title: CHAPTER_TITLES[2], level: 1, html: `<h1>${CHAPTER_TITLES[2]}</h1><p>第三段。</p>` },
  ],
  assets: [{ href: 'images/fig1.png', mediaType: 'image/png', data: imageBytes }],
})

const SAMPLE = missingEpub('sample.epub')
await writeFile(SAMPLE, sampleBytes)
const sampleEntries = unzipSync(sampleBytes)

/* OPF outside OEBPS: everything moves to book/, container points there. */
const movedEntries = {}
for (const [name, bytes] of Object.entries(sampleEntries)) {
  if (name === 'META-INF/container.xml') {
    movedEntries[name] = strToU8(containerXml('book/content.opf'))
    continue
  }
  if (name.startsWith('OEBPS/')) {
    movedEntries[`book/${name.slice('OEBPS/'.length)}`] = bytes
    continue
  }
  movedEntries[name] = bytes
}
const ALTERNATE = missingEpub('alternate.epub')
await writeFile(ALTERNATE, pack(movedEntries))

/* nav missing: drop the file only, the manifest keeps claiming it. */
const NO_NAV = missingEpub('no-nav.epub')
await writeFile(NO_NAV, remap(sampleEntries, name => (name === 'OEBPS/nav.xhtml' ? null : name)))

/* Leading "./" on every entry name (a tolerated writer quirk). */
const DOTTED = missingEpub('dotted.epub')
await writeFile(DOTTED, remap(sampleEntries, name => `./${name}`))

/* mimetype missing. */
const NO_MIMETYPE = missingEpub('no-mimetype.epub')
await writeFile(NO_MIMETYPE, remap(sampleEntries, name => (name === 'mimetype' ? null : name)))

/* Not a zip at all. */
const GARBAGE = missingEpub('garbage.epub')
await writeFile(GARBAGE, Buffer.from('this is definitely not a zip archive\n'))

/* One image above the 2 MiB inline cap. */
const hugeImage = new Uint8Array(2 * 1024 * 1024 + 4096)
randomFillSync(hugeImage)
const BIG_IMAGE = missingEpub('big-image.epub')
await writeFile(BIG_IMAGE, buildEpub({
  title: '大图小书',
  language: 'zh-CN',
  identifier: 'urn:uuid:00000000-0000-4000-8000-000000000001',
  chapters: [{ title: '唯一章', html: '<h1>唯一章</h1><p>正文。</p>' }],
  assets: [{ href: 'images/huge.png', mediaType: 'image/png', data: hugeImage }],
}))

/* A manifest image whose href climbs out of the archive. */
const ESCAPE = missingEpub('escape-href.epub')
const escapeOpf = new TextDecoder('utf-8')
  .decode(sampleEntries['OEBPS/content.opf'])
  .replace('</manifest>', '    <item id="evil" href="../../../../etc/passwd" media-type="image/png" />\n  </manifest>')
await writeFile(ESCAPE, pack({ ...sampleEntries, 'OEBPS/content.opf': strToU8(escapeOpf) }))

/* A nav document in its own folder, with links relative to itself. */
const NAV_SUBDIR = missingEpub('nav-subdir.epub')
const subdirEntries = { ...sampleEntries }
delete subdirEntries['OEBPS/nav.xhtml']
const navText = new TextDecoder('utf-8').decode(sampleEntries['OEBPS/nav.xhtml'])
subdirEntries['OEBPS/nav/nav.xhtml'] = strToU8(navText.replaceAll('href="text/', 'href="../text/'))
subdirEntries['OEBPS/content.opf'] = strToU8(
  new TextDecoder('utf-8')
    .decode(sampleEntries['OEBPS/content.opf'])
    .replace('href="nav.xhtml"', 'href="nav/nav.xhtml"'),
)
await writeFile(NAV_SUBDIR, pack(subdirEntries))

/* A .epub larger than the 64 MiB route cap (truncated, so no 64 MiB write). */
const OVERSIZE = missingEpub('oversize.epub')
await writeFile(OVERSIZE, 'x')
await truncate(OVERSIZE, 64 * 1024 * 1024 + 1)

/* -------------------------------------------------------------------------- */
/* 1. fence                                                                   */
/* -------------------------------------------------------------------------- */

const noHeaders = await invoke({})
assert.equal(noHeaders.status, 403, 'a request with no Host must be refused')
const evilHost = await invoke({ headers: { host: 'evil.example' }, url: `http://evil.example${EPUB}` })
assert.equal(evilHost.status, 403, 'a non-loopback Host must be refused')
ok('1  fence: missing / foreign Host -> 403', `${noHeaders.status} / ${evilHost.status}`)

/* -------------------------------------------------------------------------- */
/* 2. legal request: 200, ok, chapters in spine order                         */
/* -------------------------------------------------------------------------- */

const sample = await callFor(SAMPLE)
assert.equal(sample.type, 'application/json; charset=utf-8')
assert.equal(sample.status, 200)
const book = sample.json
assert.equal(book.ok, true)
assert.equal(book.title, BOOK_TITLE)
assert.equal(book.author, '测试作者')
assert.equal(book.language, 'zh-CN')
assert.equal(book.chapters.length, 3)
assert.deepEqual(book.chapters.map(chapter => chapter.id), ['ch001', 'ch002', 'ch003'])
assert.deepEqual(book.chapters.map(chapter => chapter.title), CHAPTER_TITLES)
assert.deepEqual(book.chapters.map(chapter => chapter.href), CHAPTER_HREFS)
for (const [index, chapter] of book.chapters.entries()) {
  assert.ok(chapter.html.includes(`<h1>${CHAPTER_TITLES[index]}</h1>`), `chapter ${index} body fragment`)
  assert.ok(!/<(?:html|head|body)\b/i.test(chapter.html), `chapter ${index} still carries a document wrapper`)
}
ok('2  GET /epub -> 200 JSON, 3 chapters in spine order', `ids ${book.chapters.map(chapter => chapter.id).join(',')}`)

/* -------------------------------------------------------------------------- */
/* 3. toc: 3 entries with nested levels                                       */
/* -------------------------------------------------------------------------- */

assert.equal(book.toc.length, 3)
assert.deepEqual(book.toc.map(entry => entry.id), ['ch001', 'ch002', 'ch003'])
assert.deepEqual(book.toc.map(entry => entry.title), CHAPTER_TITLES)
assert.deepEqual(book.toc.map(entry => entry.href), CHAPTER_HREFS)
assert.deepEqual(book.toc.map(entry => entry.level), [1, 2, 1])
ok('3  toc has 3 entries, levels follow nav nesting', JSON.stringify(book.toc.map(entry => entry.level)))

/* -------------------------------------------------------------------------- */
/* 4. css                                                                     */
/* -------------------------------------------------------------------------- */

assert.equal(typeof book.css, 'string')
assert.ok(book.css.trim().length > 0, 'css must not be empty')
assert.ok(book.css.includes('text-indent'), 'css must carry the book stylesheet')
ok('4  css is non-empty and carries the stylesheet', `${book.css.length} chars`)

/* -------------------------------------------------------------------------- */
/* 5. images inline as data URLs                                              */
/* -------------------------------------------------------------------------- */

assert.ok(Array.isArray(book.images))
assert.equal(book.images.length, 1)
const figure = book.images[0]
assert.equal(figure.href, 'OEBPS/images/fig1.png')
assert.equal(figure.mediaType, 'image/png')
assert.ok(figure.data.startsWith('data:image/'))
assert.deepEqual(decodeDataUrl(figure.data), Buffer.from(imageBytes))
ok('5  one image inlined as a data: URL that round-trips', `${figure.data.length} chars`)

/* -------------------------------------------------------------------------- */
/* 6-8. path refusals                                                         */
/* -------------------------------------------------------------------------- */

const wrongSuffix = await callFor(path.join(PREVIEW, 'sample.txt'))
assert.equal(wrongSuffix.status, 400)
assert.equal(wrongSuffix.json.ok, false)
assert.match(wrongSuffix.json.error, /\.epub/)
ok('6  a path that is not .epub -> 400', wrongSuffix.json.error)

const absent = await callFor(missingEpub('does-not-exist.epub'))
assert.equal(absent.status, 404)
assert.equal(absent.json.ok, false)
ok('7  a missing file -> 404', absent.json.error)

const traversalTarget = `${PREVIEW}${path.sep}..${path.sep}${path.basename(PREVIEW)}${path.sep}sample.epub`
const traversal = await callFor(traversalTarget)
assert.equal(traversal.status, 400)
assert.equal(traversal.json.ok, false)
assert.match(traversal.json.error, /\.\./)
ok('8  a path containing ".." -> 400', traversal.json.error)

/* -------------------------------------------------------------------------- */
/* 9. OPF outside OEBPS (container.xml is followed, not hard-coded paths)     */
/* -------------------------------------------------------------------------- */

const alternate = await callFor(ALTERNATE)
assert.equal(alternate.status, 200)
assert.equal(alternate.json.ok, true)
assert.equal(alternate.json.chapters.length, 3)
assert.deepEqual(
  alternate.json.chapters.map(chapter => chapter.href),
  ['book/text/ch-one.xhtml', 'book/text/ch-two.xhtml', 'book/text/ch-three.xhtml'],
)
assert.deepEqual(alternate.json.toc.map(entry => entry.href), alternate.json.chapters.map(chapter => chapter.href))
assert.equal(alternate.json.images[0].href, 'book/images/fig1.png')
assert.ok(alternate.json.css.includes('text-indent'), 'css must still resolve relative to book/')
ok('9  OPF at book/content.opf is found through META-INF/container.xml')

/* -------------------------------------------------------------------------- */
/* 10. nav missing -> flat TOC from the spine with <h1> titles                */
/* -------------------------------------------------------------------------- */

const noNav = await callFor(NO_NAV)
assert.equal(noNav.status, 200)
assert.equal(noNav.json.ok, true)
assert.equal(noNav.json.chapters.length, 3)
assert.equal(noNav.json.toc.length, 3)
assert.deepEqual(noNav.json.toc.map(entry => entry.level), [1, 1, 1])
assert.deepEqual(noNav.json.toc.map(entry => entry.title), CHAPTER_TITLES)
assert.deepEqual(noNav.json.toc.map(entry => entry.id), ['ch001', 'ch002', 'ch003'])
assert.ok(
  (noNav.json.warnings ?? []).some(warning => /navigation document/.test(warning)),
  'the missing nav must be reported as a warning',
)
ok('10 nav missing -> flat spine TOC from <h1> headings', JSON.stringify(noNav.json.toc.map(entry => entry.title)))

/* -------------------------------------------------------------------------- */
/* Extras: the tolerances the route promises                                  */
/* -------------------------------------------------------------------------- */

const dotted = await callFor(DOTTED)
assert.equal(dotted.status, 200)
assert.equal(dotted.json.ok, true)
assert.equal(dotted.json.chapters.length, 3)
ok('11 entry names with a leading "./" still resolve', dotted.json.chapters.map(chapter => chapter.id).join(','))

const noMimetype = await callFor(NO_MIMETYPE)
assert.equal(noMimetype.status, 200)
assert.equal(noMimetype.json.ok, true)
assert.equal(noMimetype.json.chapters.length, 3)
assert.ok(
  (noMimetype.json.warnings ?? []).some(warning => /mimetype/.test(warning)),
  'a missing mimetype must be reported as a warning',
)
ok('12 a missing mimetype is tolerated and warned about', JSON.stringify(noMimetype.json.warnings))

const garbage = await callFor(GARBAGE)
assert.equal(garbage.status, 415)
assert.equal(garbage.json.ok, false)
assert.match(garbage.json.error, /not a readable EPUB/)
ok('13 a .epub that is not a zip -> 415 JSON', garbage.json.error)

const bigImage = await callFor(BIG_IMAGE)
assert.equal(bigImage.status, 200)
assert.equal(bigImage.json.ok, true)
assert.equal(bigImage.json.chapters.length, 1)
assert.equal(bigImage.json.images.length, 0)
assert.equal(bigImage.json.skippedImages, 1)
ok('14 an image above 2 MiB is skipped and counted', `skippedImages=${bigImage.json.skippedImages}`)

const escaped = await callFor(ESCAPE)
assert.equal(escaped.status, 200)
assert.equal(escaped.json.ok, true)
assert.equal(escaped.json.chapters.length, 3)
assert.deepEqual(escaped.json.images.map(image => image.href), ['OEBPS/images/fig1.png'])
assert.ok(!escaped.json.images.some(image => image.href.includes('..')))
ok('15 an href that climbs out of the archive resolves to nothing', 'only the in-book image is inlined')

const oversize = await callFor(OVERSIZE)
assert.equal(oversize.status, 413)
assert.equal(oversize.json.ok, false)
assert.match(oversize.json.error, /larger than 67108864 bytes/)
await unlink(OVERSIZE)
ok('16 a file above 64 MiB -> 413 before it is read', oversize.json.error)

for (const result of [wrongSuffix, absent, traversal, garbage, oversize]) {
  assert.equal(result.json.ok, false, 'an error body must say ok: false')
  assert.equal(typeof result.json.error, 'string')
  assert.match(result.type ?? '', /^application\/json/)
}
ok('17 every refusal is JSON with ok:false and an error string')

const navSubdir = await callFor(NAV_SUBDIR)
assert.equal(navSubdir.status, 200)
assert.equal(navSubdir.json.ok, true)
assert.equal(navSubdir.json.chapters.length, 3)
assert.deepEqual(navSubdir.json.toc.map(entry => entry.id), ['ch001', 'ch002', 'ch003'])
assert.deepEqual(navSubdir.json.toc.map(entry => entry.level), [1, 2, 1])
assert.deepEqual(navSubdir.json.toc.map(entry => entry.title), CHAPTER_TITLES)
assert.deepEqual(navSubdir.json.chapters.map(chapter => chapter.title), CHAPTER_TITLES)
ok('18 a nav in its own folder resolves its links against the nav document')

console.log('')
console.log(`GET ${EPUB}?path=<absolute .epub>  (resource, exact, fenced)`)
console.log(`fixtures: ${path.relative(ROOT, PREVIEW)}`)
console.log(`EPUB ROUTE OK (${passed} checks)`)
