/**
 * Security probe for `stripActiveMarkup` (client.js) — the B3 fix.
 *
 * Two layers of evidence, because the review's bypass was found in a real
 * browser rather than by reading the regex:
 *
 *   1. TEXT: every case is pushed through the REAL `stripActiveMarkup` (the
 *      region between the two section banners is lifted verbatim and evaluated
 *      once), and the output must not contain a live handler, a script element,
 *      a `javascript:` URL, or a reassembled tag.
 *   2. BROWSER: the same stripped strings are injected with `innerHTML` into
 *      real Chromium (Edge headless) and the resulting DOM is inspected. This is
 *      the layer that catches "the string looked clean but the parser disagreed"
 *      — exactly the class the old `\son[a-z]+` regex lost to.
 *
 * The cases include every shape the final review named, plus the neighbours a
 * whitelist rewrite is expected to hold: entity-encoded schemes, `/`-separated
 * attributes, conditional comments, mXSS joins (`<scr<script>ipt>`), and foreign
 * markup (`<svg>`, `<math>`, `<form>`).
 *
 * Usage: node test/harness/security-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(ROOT, '.out', 'preview-fixer')
const SOURCE = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

const START = '/* ------------------------------------------------------- EPUB CSS scoping */'
const END = '/* ----------------------------------------------------- EPUB payload helpers */'
const start = SOURCE.indexOf(START)
const end = SOURCE.indexOf(END)
if (start < 0 || end < 0 || end <= start) throw new Error('section banners not found')
const region = SOURCE.slice(start, end)

const { stripActiveMarkup } = new Function(`${region}
return { stripActiveMarkup }`)()

let passed = 0
const failures = []

/** @param {string} label - assertion name. @param {boolean} condition - outcome. @param {string} [detail] - evidence. */
function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}${detail === '' ? '' : `  — ${detail}`}`)
    return
  }
  failures.push(label)
  console.log(`FAIL  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

// `MARK` is the payload each case tries to run; the stripped output must not be
// able to set `document.body.dataset.mark` / attach a live handler.
const CASES = [
  // --- the shapes the final review named ------------------------------------
  ['R1  img/onerror (slash separator)', '<img/onerror="document.body.dataset.mark=\'R1\'" src=x>'],
  ['R2  img src=x onerror', '<img src=x onerror="document.body.dataset.mark=\'R2\'">'],
  ['R3  IMG ONERROR uppercase', '<IMG SRC=x ONERROR="document.body.dataset.mark=\'R3\'">'],
  ['R4  a href javascript:', '<a href="javascript:document.body.dataset.mark=\'R4\'">x</a>'],
  ['R5  a href entity-encoded scheme', '<a href="jav&#x61;script:document.body.dataset.mark=\'R5\'">x</a>'],
  ['R6  svg onload', '<svg onload="document.body.dataset.mark=\'R6\'"></svg>'],
  ['R7  style element', '<style>*{background:url(javascript:document.body.dataset.mark=1)}</style><p>after</p>'],
  ['R8  conditional comment hiding a script', '<!--[if IE]><script>document.body.dataset.mark="R8"</script><![endif]--><p>after</p>'],
  ['R9  mXSS join <scr<script>ipt>', '<scr<script>ipt>document.body.dataset.mark="R9"</script>'],
  // --- neighbours the whitelist must also hold ------------------------------
  ['R10 unquoted handler after a slash', '<img/onerror=document.body.dataset.mark="R10" src=x>'],
  ['R11 handler with spaces around =', '<img src=x onerror = "document.body.dataset.mark=\'R11\'">'],
  ['R12 tab-separated handler', '<img\tsrc=x\tonerror="document.body.dataset.mark=\'R12\'">'],
  ['R13 newline-separated handler', '<img\nsrc=x\nonerror="document.body.dataset.mark=\'R13\'">'],
  ['R14 handler on a kept element', '<p onclick="document.body.dataset.mark=\'R14\'">text</p>'],
  ['R15 onmouseover on a link', '<a href="/x" onmouseover="document.body.dataset.mark=\'R15\'">x</a>'],
  ['R16 form action javascript', '<form action="javascript:document.body.dataset.mark=\'R16\'"><input type=submit></form>'],
  ['R17 &colon; entity href', '<a href="javascript&colon;document.body.dataset.mark=\'R17\'">x</a>'],
  ['R18 data:text/html link', '<a href="data:text/html,<script>document.body.dataset.mark=1</script>">x</a>'],
  ['R19 xlink:href javascript', '<svg><a xlink:href="javascript:document.body.dataset.mark=\'R19\'"><text>x</text></a></svg>'],
  ['R20 iframe srcdoc', '<iframe srcdoc="<script>parent.document.body.dataset.mark=1</script>"></iframe>'],
  ['R21 object data javascript', '<object data="javascript:document.body.dataset.mark=\'R21\'"></object>'],
  ['R22 details ontoggle', '<details open ontoggle="document.body.dataset.mark=\'R22\'"><summary>x</summary></details>'],
  ['R23 video source onerror', '<video><source src=x onerror="document.body.dataset.mark=\'R23\'"></video>'],
  ['R24 math href', '<math><mtext><a href="javascript:document.body.dataset.mark=\'R24\'">x</a></mtext></math>'],
  ['R25 svg animate onbegin', '<svg><animate onbegin="document.body.dataset.mark=\'R25\'" attributeName=x dur=1s></animate></svg>'],
  ['R26 protocol-relative image', '<img src="//evil.example/x.png">'],
  ['R27 data:image/svg+xml source', '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'],
  ['R28 id carrying javascript', '<p id="javascript:x">t</p>'],
  ['R29 nested unclosed svg', '<svg><script>document.body.dataset.mark="R29"</script><p>after</p>'],
  ['R30 handler split by a quote', '<img src="x" title="a\\" onerror=\\"document.body.dataset.mark=\'R30\'">'],
]

/** Shapes the whitelist must KEEP, so the reader still renders a book. */
const KEEP = [
  ['K1  paragraph and emphasis', '<p>hi <b>there</b></p>'],
  ['K2  heading', '<h1 id="t">Title</h1>'],
  ['K3  list', '<ul class="x"><li>one</li><li>two</li></ul>'],
  ['K4  table with spans', '<table><tr><td colspan="2" rowspan="1">c</td></tr></table>'],
  ['K5  link', '<a href="https://example.com/a?b=1">x</a>'],
  ['K6  inlined image', '<img src="data:image/png;base64,AAAA" alt="图">'],
  ['K7  relative image', '<img src="../images/fig1.png" alt="图一">'],
  ['K8  epub:type', '<section epub:type="chapter"><p>x</p></section>'],
  ['K9  br and hr', '<p>a<br>b</p><hr>'],
  ['K10 quotes inside text', '<p>a &lt; b &amp;&amp; c &gt; d</p>'],
]

/* -------------------------------------------------------------------------- */
/* 1. text layer                                                              */
/* -------------------------------------------------------------------------- */

/** Reasons a stripped string is still dangerous, as plain text. */
function textualProblems(stripped) {
  const problems = []
  if (/<script/i.test(stripped)) problems.push('script element')
  if (/<style/i.test(stripped)) problems.push('style element')
  if (/<iframe|<object|<embed/i.test(stripped)) problems.push('frame/object element')
  if (/<svg|<math|<form|<input|<video|<audio|<source|<details/i.test(stripped)) problems.push('foreign element')
  if (/\son[a-z]+\s*=/i.test(stripped)) problems.push('on* attribute')
  if (/javascript\s*:/i.test(stripped)) problems.push('javascript: scheme')
  if (/vbscript\s*:/i.test(stripped)) problems.push('vbscript: scheme')
  if (/data:text\/html/i.test(stripped)) problems.push('data:text/html')
  // A reassembled tag would show up as a `<` in text: the scanner escapes it.
  if (/<!--/.test(stripped)) problems.push('comment')
  return problems
}

console.log('== 1. text layer: stripActiveMarkup output ==\n')
for (const [label, html] of CASES) {
  const stripped = stripActiveMarkup(html)
  const problems = textualProblems(stripped)
  ok(label, problems.length === 0, problems.length === 0
    ? (stripped === '' ? '(empty)' : stripped.slice(0, 72))
    : `${problems.join(', ')} in ${JSON.stringify(stripped)}`)
}

console.log('\n== 1b. text layer: markup a book needs must survive ==\n')
for (const [label, html] of KEEP) {
  const stripped = stripActiveMarkup(html)
  const expected = label === 'K10 quotes inside text' ? html : html
  ok(label, stripped === expected || stripped.replace(/\s+/g, '') === expected.replace(/\s+/g, ''), stripped)
}

/* -------------------------------------------------------------------------- */
/* 1c. the PANEL payload goes through the same filter (M1)                    */
/* -------------------------------------------------------------------------- */

// The panel renders chapter HTML from `/book` (and from an inline `book` in a
// `/state` snapshot) through the same `dangerouslySetInnerHTML` the preview
// uses. Both producers funnel through `normalizeBook`, which is where the
// review found no filtering at all.
const normalizeStart = SOURCE.indexOf('function normalizeBook(')
const normalizeEnd = SOURCE.indexOf('/**\n * Whether a failed request can succeed')
if (normalizeStart < 0 || normalizeEnd < 0) throw new Error('normalizeBook not found')
const { normalizeBook } = new Function('stripActiveMarkup', `${SOURCE.slice(normalizeStart, normalizeEnd)}
return { normalizeBook }`)(stripActiveMarkup)

const hostileChapter = '<p onclick="document.body.dataset.mark=1">a</p>'
  + '<img/onerror="document.body.dataset.mark=1" src=x>'
  + '<script>document.body.dataset.mark=1</script>'
  + '<a href="javascript:document.body.dataset.mark=1">x</a>'
const panelBook = normalizeBook({ title: 'T', language: 'zh', chapters: [{ id: 'c1', title: 'S', html: hostileChapter }] })
const panelHtml = panelBook.chapters[0].html
ok(
  '1c normalizeBook (the panel path) sanitizes chapter html',
  !/\son[a-z]+\s*=/i.test(panelHtml) && !/<script/i.test(panelHtml) && !/javascript\s*:/i.test(panelHtml),
  panelHtml,
)

// Only the JSX property form counts; the other mentions are documentation.
const injections = SOURCE.match(/dangerouslySetInnerHTML\s*:/g) ?? []
ok('1d client.js has exactly one injection point', injections.length === 1, `${injections.length} property occurrence(s)`)
ok(
  '1e the preview rewrites images AFTER stripping (relative src must survive the filter)',
  /rewriteImages\(stripActiveMarkup\(chapter\.html\), book\.images, chapter\.href\)/.test(SOURCE),
  'rewriteImages(stripActiveMarkup(...))',
)

/* -------------------------------------------------------------------------- */
/* 1f. a REAL book must survive the filter                                    */
/* -------------------------------------------------------------------------- */

// A whitelist that eats the book is its own failure mode, so a sample EPUB is
// unpacked through the real Host route and every chapter is compared before/after:
// the visible text has to be identical and nothing but markup may be lost.
//
// The book is built here with `src/epub/build.js` rather than picked up from
// `.out/sample.epub`, so `node test/harness/security-check.mjs` proves the same
// thing on a fresh clone as it does after another test has already run.
const { registerRoutes } = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'server.js')).href)
const { buildEpub } = await import(pathToFileURL(path.join(ROOT, 'src', 'epub', 'build.js')).href)

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

fs.mkdirSync(WORK, { recursive: true })
const SAMPLE_FILE = path.join(WORK, 'security-sample.epub')
fs.writeFileSync(SAMPLE_FILE, buildEpub({
  title: '安全探针书目',
  author: '测试作者',
  language: 'zh-CN',
  identifier: 'urn:uuid:00000000-0000-4000-8000-0000000000bb',
  chapters: [
    { id: 'ch-one', title: '第一章 出发', level: 1, html: '<h1>第一章 出发</h1><p>第一段。</p>' },
    { id: 'ch-two', title: '第一节 到达', level: 2, html: '<h1>第一节 到达</h1><p>第二段 <b>加粗</b> <a href="https://example.com/a?b=1">链接</a>。</p>' },
    { id: 'ch-three', title: '第二章 归途', level: 1, html: '<h1>第二章 归途</h1><p>第三段。</p><p><img src="images/fig1.png" alt="图一"></p>' },
  ],
  assets: [
    { href: 'images/fig1.png', mediaType: 'image/png', data: Uint8Array.from(Buffer.from(PNG_BASE64, 'base64')) },
  ],
}))

/** Unpack one real EPUB through the plugin's own route. */
async function unpackSample() {
  const candidate = SAMPLE_FILE
  if (!fs.existsSync(candidate)) return undefined
  const routes = []
  const fake = {
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
  }
  registerRoutes(fake, {})
  const route = routes.find(item => item.path === '/dsh-pdf2epub/epub')
  const response = await route.resource({
    headers: { host: '127.0.0.1:1' },
    url: `http://127.0.0.1/dsh-pdf2epub/epub?path=${encodeURIComponent(candidate)}`,
  })
  return { file: candidate, book: await response.json() }
}

/** Visible text of a markup string, for a before/after comparison. */
const visibleText = html => html
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  .replace(/<[^>]*>/g, '')
  .replace(/\s+/g, '')
  .trim()

const sample = await unpackSample()
if (sample === undefined) {
  console.log('\n== 1f SKIPPED: no sample EPUB on disk ==')
} else {
  const book = sample.book
  const chapters = Array.isArray(book.chapters) ? book.chapters : []
  ok('1f the sample book unpacks', book.ok === true && chapters.length > 0, `${chapters.length} chapters`)
  let lost = ''
  for (const chapter of chapters) {
    const before = visibleText(String(chapter.html))
    const after = visibleText(stripActiveMarkup(String(chapter.html)))
    if (before !== after) {
      lost = `${chapter.id}: ${before.length} -> ${after.length} chars`
      break
    }
  }
  ok('1g no visible text is lost from any chapter', lost === '', lost === '' ? `${chapters.length} chapters identical` : lost)
  const withImages = chapters.filter(chapter => /<img\b/i.test(String(chapter.html))).length
  console.log(`      (${withImages} chapter(s) carry images; the image rewriter runs after the filter)`)
}

/* -------------------------------------------------------------------------- */
/* 2. browser layer                                                           */
/* -------------------------------------------------------------------------- */

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const browser = EDGE_CANDIDATES.find(candidate => fs.existsSync(candidate))

if (browser === undefined) {
  console.log('\n== 2. browser layer SKIPPED: no Edge/Chrome found ==')
} else {
  const strippedCases = CASES.map(([label, html]) => ({ label: label.slice(0, 4).trim(), html: stripActiveMarkup(html) }))
  const page = `<!doctype html><meta charset="utf-8"><body><div id="root"></div>
<script>
const cases = ${JSON.stringify(strippedCases)};
const root = document.getElementById('root');
for (const item of cases) {
  const box = document.createElement('div');
  box.setAttribute('data-case', item.label);
  box.setAttribute('data-stripped', item.html.replaceAll('"', '~') || '(empty)');
  try { box.innerHTML = item.html; } catch (error) { box.setAttribute('data-threw', '1'); }
  root.appendChild(box);
}
// Any surviving handler that fires sets document.body.dataset.mark. Attribute it
// to the case that caused it, and flag a live javascript: URL even without a click.
function inspect() {
  const mark = document.body.dataset.mark;
  for (const box of root.querySelectorAll('[data-case]')) {
    if (typeof mark === 'string' && mark.startsWith(box.dataset.case.slice(0, 2))) box.setAttribute('data-fired', '1');
    for (const element of box.querySelectorAll('*')) {
      for (const attribute of element.attributes ?? []) {
        if (/^on/i.test(attribute.name)) box.setAttribute('data-handler', attribute.name);
        if (/(?:href|src|action|data)$/i.test(attribute.name) && /^\\s*(javascript|vbscript|data:text\\/html)/i.test(attribute.value)) {
          box.setAttribute('data-url', attribute.name);
        }
      }
      const tag = element.tagName.toLowerCase();
      if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'form' || tag === 'svg' || tag === 'math') {
        box.setAttribute('data-element', tag);
      }
    }
  }
}
inspect();
window.addEventListener('load', () => setTimeout(inspect, 250));
setTimeout(inspect, 1500);
</script>`

  const pagePath = path.join(WORK, 'security-harness.html')
  fs.writeFileSync(pagePath, page, 'utf8')
  const dump = execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--virtual-time-budget=4000',
    '--dump-dom',
    `file:///${pagePath.replaceAll('\\', '/')}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  const rows = []
  for (const chunk of dump.split(/<div /).slice(1)) {
    const caseId = /data-case="([^"]*)"/.exec(chunk)
    if (caseId === null) continue
    rows.push({
      id: caseId[1],
      fired: /data-fired="1"/.test(chunk),
      handler: /data-handler="([^"]*)"/.exec(chunk)?.[1] ?? '',
      url: /data-url="([^"]*)"/.exec(chunk)?.[1] ?? '',
      element: /data-element="([^"]*)"/.exec(chunk)?.[1] ?? '',
      stripped: (/data-stripped="([^"]*)"/.exec(chunk)?.[1] ?? '').replaceAll('~', '"'),
    })
  }

  console.log(`\n== 2. browser layer: real Chromium (${path.basename(browser)}) parsed the stripped output ==\n`)
  ok('browser harness produced one row per case', rows.length === CASES.length, `${rows.length}/${CASES.length} rows`)
  for (const row of rows) {
    const label = CASES.find(([name]) => name.startsWith(row.id))?.[0] ?? row.id
    const alive = row.fired || row.handler !== '' || row.url !== '' || row.element !== ''
    ok(`browser: ${label}`, !alive, alive
      ? `${row.fired ? 'handler fired' : ''}${row.handler === '' ? '' : ` handler=${row.handler}`}${row.url === '' ? '' : ` url=${row.url}`}${row.element === '' ? '' : ` element=${row.element}`}`
      : (row.stripped === '(empty)' ? '(empty)' : row.stripped.slice(0, 72)))
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failures:\n${failures.map(name => ` - ${name}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('SECURITY OK')
}
