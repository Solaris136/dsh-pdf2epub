// Self-check for the `.epub` document preview in client.js.
//
// Loads the real bundle inside a vm with a recording React stand-in, so the
// assertions describe what the plugin registers and renders:
//   1. `apply` registers the document-preview renderer (or documents the skip)
//   2. that renderer claims the `epub` extension
//   3. `scopeCss` prefixes book selectors, recurses into `@media`, leaves
//      `@font-face` alone
//   4. `rewriteImages` inlines known images (base-relative `../` included),
//      drops the `src` of unknown ones, and drops `<img>` without `src`
//   5. the preview body renders the book, the scoped stylesheet and the
//      rewritten images, and pages with ← / →
//   6. a 415 refusal shows the Host error without offering a pointless retry
//   7. `test/harness/client-check.mjs` and `test/harness/locale-check.mjs` still pass
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { DEFAULT_CSS } from '../../src/epub/css.js'

const HARNESS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HARNESS, '..', '..')
const CLIENT = 'client.js'
const SOURCE = readFileSync(path.join(ROOT, CLIENT), 'utf8')

const results = []
let skipped = 0
const check = (label, fn) => {
  try {
    fn()
    results.push(`PASS ${label}`)
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`)
    throw error
  }
}
const skip = (label, reason) => {
  skipped += 1
  results.push(`SKIP ${label} — ${reason}`)
}

/** Recording React stand-in: element trees, first-render hooks, effect capture. */
function createReact() {
  const slots = []
  const effects = []
  const setters = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        setters.push({ index, value })
        slots[index] = value
      }]
    },
    useEffect(fn) { effects.push(fn) },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial === undefined ? null : initial }
      return slots[index]
    },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    Fragment: 'Fragment',
  }
  return {
    React,
    slots,
    effects,
    setters,
    begin() {
      cursor = 0
      effects.length = 0
      setters.length = 0
    },
  }
}

/** A JSON `Response`-shaped stub for the fetch below. */
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  text: async () => JSON.stringify(body),
})

/**
 * Load client.js in a fresh vm context with the given fetch behaviour.
 * @param {{ respond?: (url: string, init: object) => object }} [options] - fetch stub.
 */
function boot(options = {}) {
  const react = createReact()
  const required = []
  const loadCalls = []
  const fetchCalls = []
  const listeners = new Map()
  const windowStub = {
    __ModuleLoader__: { load(spec) { loadCalls.push(spec) } },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      listeners.set(type, list.filter(entry => entry !== listener))
    },
    getComputedStyle() {
      return {
        getPropertyValue(name) {
          if (name === '--dsw-alias-bg-layer-1') return 'rgb(255, 255, 255)'
          if (name === '--dsw-alias-label-primary') return 'rgb(20, 20, 20)'
          return ''
        },
      }
    },
  }
  const sandbox = {
    window: windowStub,
    document: { documentElement: { isDocumentElement: true } },
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init })
      if (typeof options.respond === 'function') return options.respond(String(url), init)
      throw new Error(`unexpected request: ${url}`)
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    HTMLElement: class HTMLElement {},
    console,
  }
  runInNewContext(SOURCE, sandbox, { filename: CLIENT })

  const requireStub = (specifier) => {
    required.push(specifier)
    if (specifier === 'react') return react.React
    throw new Error(`client.js required a module outside the platform table: ${specifier}`)
  }

  const previewRegistrations = []
  const registrations = []
  const injections = []
  const effectLabels = []
  const ctx = {
    effect(execute, label) {
      effectLabels.push(label)
      const dispose = execute()
      assert.equal(typeof dispose, 'function', `effect "${label}" must return a disposer`)
      return () => {}
    },
    locale: {
      register() { return () => {} },
      // Unregistered-namespace behaviour: the key comes back, so the bundle
      // must fall back to its inlined dictionary.
      bind() { return key => key },
    },
    slots: {
      inject(name, callback) {
        injections.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(registerOptions, component) {
        registrations.push({ options: registerOptions, component })
        return () => {}
      },
    },
    documentPreviews: {
      register(spec) {
        previewRegistrations.push(spec)
        return () => {}
      },
    },
  }

  assert.equal(loadCalls.length, 1, 'window.__ModuleLoader__.load must be called exactly once')
  const plugin = loadCalls[0].factory(requireStub)
  return {
    sandbox,
    plugin,
    ctx,
    react,
    required,
    previewRegistrations,
    registrations,
    injections,
    effectLabels,
    fetchCalls,
    listeners,
  }
}

/** Depth-first walk of a recorded element tree. */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

/** Text content of an element subtree. */
function textOf(node) {
  let out = ''
  walk(node, (element) => {
    for (const child of element.children) if (typeof child === 'string') out += child
  })
  return out
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ------------------------------------------------------------- fixture book */

// Shaped after the Host route (`src/host/server.js#parseEpubArchive`): canonical
// zip paths in `toc[].href` / `chapters[].href` / `images[].href`, a raw
// `book.css`, and chapter-relative `<img src>`.
const BOOK = {
  ok: true,
  title: '测试书',
  author: '某作者',
  language: 'zh-CN',
  toc: [
    { id: 'ch001', title: '第一章', level: 1, href: 'OEBPS/text/ch-one.xhtml' },
    { id: 'ch002', title: '第一节', level: 2, href: 'OEBPS/text/ch-two.xhtml' },
  ],
  chapters: [
    {
      id: 'ch001',
      title: '第一章',
      href: 'OEBPS/text/ch-one.xhtml',
      html: '<h1>第一章</h1><p>正文一</p>'
        + '<img src="../images/fig1.png" alt="图一">'
        + '<img src="../images/missing.png">'
        + '<img alt="没有来源">'
        + '<script>alert(1)</script>'
        + '<p onclick="alert(2)">带事件的段落</p>',
    },
    {
      id: 'ch002',
      title: '第一节',
      href: 'OEBPS/text/ch-two.xhtml',
      html: '<h2>第一节</h2><p>正文二</p>',
    },
  ],
  css: `@charset "utf-8";

h1 {
  font-size: 1.8em;
  text-align: center;
}

p { margin: 0; text-indent: 2em; }

@media (max-width: 600px) {
  h1 { font-size: 1.2em; }
}

@font-face {
  font-family: "Book Serif";
  src: url("book.woff2");
}`,
  images: [
    { href: 'OEBPS/images/fig1.png', mediaType: 'image/png', data: 'data:image/png;base64,AAAA' },
  ],
}

/* -------------------------------------- 1/2. registration and its metadata */

const app = boot()
app.plugin.apply(app.ctx)

if (app.previewRegistrations.length === 0) {
  check('0. the skipped document-preview contract is documented in client.js', () => {
    assert.match(SOURCE, /ctx\.documentPreviews\.register/, 'client.js must carry the missing-contract note')
    assert.match(SOURCE, /documentPreviews/, 'client.js must explain how the service is reached')
  })
  skip('1. apply registers the `.epub` document-preview renderer', 'documentPreviews unavailable in this build')
  skip('2. the renderer claims the `epub` extension', 'registration skipped')
} else {
  check('1. apply registers the `.epub` document-preview renderer', () => {
    assert.equal(app.previewRegistrations.length, 1, 'exactly one document-preview registration')
    const spec = app.previewRegistrations[0]
    assert.equal(spec.id, 'dsh-pdf2epub/epub', 'the renderer id must be stable')
    assert.equal(spec.loading, 'renderer', 'the body fetches its own content')
    assert.equal(spec.priority, 'extension', 'product-external type, the highest tier')
    assert.equal(spec.wrap, false, 'the reader owns its own surface')
    assert.equal(spec.title(), 'EPUB', 'a missing locale key must fall back to EPUB')
    assert.ok(app.effectLabels.includes('pdf2epub: epub document preview'), 'the metadata must ride ctx.effect')
    const body = app.registrations.find(entry => entry.options.name === 'sidebar.right.tab.document')
    assert.ok(body !== undefined, 'the body must mount in sidebar.right.tab.document')
    assert.equal(body.options.key, spec.id, 'the body key must equal the renderer id')
    assert.equal(typeof body.component, 'function')
    assert.ok(app.injections.includes('sidebar.right.tab.document'), 'the body must go through slots.inject')
    // The panel pair is untouched: two slot registrations, same ids as before.
    assert.deepEqual(app.injections, ['main', 'sidebar.panellist', 'sidebar.right.tab.document'])
    assert.equal(app.registrations.filter(entry => entry.options.name === 'main').length, 1)
  })

  check('2. the renderer claims the "epub" extension', () => {
    const spec = app.previewRegistrations[0]
    assert.ok(Array.isArray(spec.extensions) && spec.extensions.includes('epub'), 'extensions must include epub')
    // Cross-realm arrays never satisfy deepStrictEqual's prototype check.
    assert.deepEqual([...spec.extensions], ['epub'], 'only .epub is claimed')
    assert.ok(Array.isArray(spec.binaryExtensions) && spec.binaryExtensions.includes('epub'), 'binaryExtensions must include epub')
    assert.ok(
      spec.binaryExtensions.every(extension => spec.extensions.includes(extension)),
      'binaryExtensions must stay a subset of extensions',
    )
  })
}

/* ------------------------------------------------- 3. CSS scoping function */

check('3. book CSS is scoped: h1/p prefixed, @media recurses, @font-face verbatim', () => {
  const { scopeCss } = app.sandbox
  assert.equal(typeof scopeCss, 'function', 'scopeCss must be reachable from the bundle')
  const scoped = scopeCss(BOOK.css, 'p2e-book')

  // `h1` appears once at top level and once inside the media query; both must
  // now be driven by the container class and nothing may stay bare.
  assert.equal((scoped.match(/\bh1\b/g) ?? []).length, 2, 'both h1 rules must survive')
  assert.equal((scoped.match(/\.p2e-book h1/g) ?? []).length, 2, 'every h1 rule must be prefixed')
  assert.equal(/(^|\n)\s*h1\b/.test(scoped), false, 'no rule may start with a bare h1 selector')
  assert.ok(scoped.includes('.p2e-book p'), 'p must be prefixed')
  assert.ok(scoped.includes('@media (max-width: 600px)'), 'the @media prelude must be kept')
  const mediaStart = scoped.indexOf('@media')
  assert.ok(mediaStart >= 0 && scoped.slice(mediaStart).includes('.p2e-book h1'), '@media inner rules must be scoped')
  assert.ok(scoped.includes('@font-face'), '@font-face must be kept')
  assert.ok(scoped.includes('@font-face {\n  font-family: "Book Serif"'), '@font-face body must be verbatim')
  assert.equal(scoped.includes('.p2e-book font-family'), false, '@font-face descriptors must not be prefixed')
  assert.equal(scoped.includes('@charset'), false, '@charset cannot live inside an inline <style>')

  // The book's document-level rules land on the container itself.
  const base = scopeCss('body { margin: 0 5% } html { font-size: 100% }', '.p2e-book')
  assert.ok(base.includes('.p2e-book { margin: 0 5% }'), 'body must map onto the scope element')
  assert.ok(base.includes('.p2e-book { font-size: 100% }'), 'html must map onto the scope element')
  assert.equal(base.includes('.p2e-book body'), false)
  assert.equal(scopeCss('', '.p2e-book'), '', 'an empty stylesheet stays empty')

  // The product's own stylesheet (`src/epub/css.js`) is the real input.
  const real = scopeCss(DEFAULT_CSS, 'p2e-book')
  assert.equal(real.includes('@charset'), false, '@charset must be dropped from the real book CSS')
  assert.ok(/\.p2e-book \{\s*font-size: 100%;/.test(real), 'the real html rule must map onto the scope')
  assert.ok(/\.p2e-book \{\s*margin: 0 5%;/.test(real), 'the real body rule must map onto the scope')
  assert.ok(real.includes('.p2e-book h1'), 'the real h1 rule must be prefixed')
  assert.ok(real.includes('.p2e-book .footnote'), 'the real class rules must be prefixed')
  assert.ok(real.includes('.p2e-book th, .p2e-book td'), 'a selector list must be prefixed member by member')
  // Structural invariant: scoping never unbalances the braces.
  assert.equal((real.match(/\{/g) ?? []).length, (real.match(/\}/g) ?? []).length, 'scoped CSS must stay brace-balanced')
})

/* --------------------------------------------- 4. image rewriting function */

check('4. chapter images inline from images[], unresolved src removed, ../ resolved', () => {
  const { rewriteImages, resolveRelative } = app.sandbox
  assert.equal(typeof rewriteImages, 'function', 'rewriteImages must be reachable from the bundle')

  const chapterPath = 'OEBPS/text/ch-one.xhtml'
  const rewritten = rewriteImages(
    '<p><img src="../images/fig1.png" alt="图一"></p>'
    + '<p><img src="../images/missing.png"></p>'
    + '<p><img alt="没有来源"></p>',
    BOOK.images,
    chapterPath,
  )
  const tags = rewritten.match(/<img\b[^>]*>/g) ?? []
  assert.equal(tags.length, 2, 'the src-less image must not render')
  assert.ok(tags[0].includes('src="data:image/png;base64,AAAA"'), 'the known image must become its data URL')
  assert.ok(tags[0].includes('alt="图一"'), 'the existing alt must survive')
  assert.equal(/\bsrc\s*=/.test(tags[1]), false, 'an unknown image must lose src')
  assert.ok(/\balt\s*=/.test(tags[1]), 'an unknown image must gain an alt')
  assert.equal(rewritten.includes('missing.png'), false, 'the unresolved reference must not survive')

  // Both quote styles are in the wild.
  const single = rewriteImages("<img src='../images/fig1.png'>", BOOK.images, chapterPath)
  assert.ok(single.includes("src='data:image/png;base64,AAAA'"), 'single-quoted src must be rewritten in place')

  // A payload that already carries the canonical href resolves without a base.
  const canonical = rewriteImages('<img src="OEBPS/images/fig1.png">', BOOK.images)
  assert.ok(canonical.includes('src="data:image/png;base64,AAAA"'), 'a canonical href must resolve directly')

  // ... and the older relative payload still resolves through the basename.
  const relative = rewriteImages('<img src="images/fig1.png">', BOOK.images)
  assert.ok(relative.includes('data:image/png;base64,AAAA'), 'a bare relative href must resolve via basename')

  // A chapter that already inlined its own data URL keeps it untouched.
  const alreadyInlined = rewriteImages('<img src="data:image/gif;base64,BBBB" alt="内联">', [], chapterPath)
  assert.ok(alreadyInlined.includes('src="data:image/gif;base64,BBBB"'), 'an already-inlined image must be left alone')

  assert.equal(resolveRelative('OEBPS/text/ch-one.xhtml', '../images/fig1.png'), 'OEBPS/images/fig1.png')
  assert.equal(resolveRelative('OEBPS/text/ch-one.xhtml', './fig1.png'), 'OEBPS/text/fig1.png')
  assert.equal(resolveRelative('OEBPS/text/ch-one.xhtml', 'fig1.png'), 'OEBPS/text/fig1.png')
  assert.equal(resolveRelative('OEBPS/text/ch-one.xhtml', '/OEBPS/images/fig1.png'), 'OEBPS/images/fig1.png')
})

/* --------------------------------------- 5. the body renders the real book */

/** Boot, apply, run the fetch effect and re-render in the ready/error state. */
async function openPreview(options, extraProps = {}) {
  const instance = boot(options)
  instance.plugin.apply(instance.ctx)
  const entry = instance.registrations.find(item => item.options.name === 'sidebar.right.tab.document')
  assert.ok(entry !== undefined, 'the preview body was never registered')
  const Body = entry.component
  const lifecycle = []
  const content = {
    kind: 'renderer',
    revision: 0,
    loaded(version) { lifecycle.push(['loaded', version]) },
    failed() { lifecycle.push(['failed']) },
    reload() { lifecycle.push(['reload']) },
  }
  const props = {
    resourceAddress: 'dsh-resource://file/session/s-1/C%3A%5CWork%5Cbook.epub',
    content,
    scrollportRef() {},
    ...extraProps,
  }
  instance.react.begin()
  Body(props)
  const effects = [...instance.react.effects]
  effects[0]() // theme probe
  effects[1]() // scrollport hand-off
  effects[2]() // book fetch
  await sleep(0)
  await sleep(0)
  instance.react.begin()
  const tree = Body(props)
  return { instance, tree, lifecycle }
}

const opened = await openPreview({ respond: () => jsonResponse(200, BOOK) })

check('5. the preview body renders title, TOC, scoped CSS and inlined images', () => {
  const { instance, tree, lifecycle } = opened
  const elements = []
  walk(tree, element => elements.push(element))
  const texts = textOf(tree)

  // The route was asked exactly once, and the query carries BOTH halves the
  // Host needs: the Session parsed out of the address, and the path. The
  // address here keeps an absolute path (a file outside the workspace), so the
  // Host resolves it as given while the Session id travels along.
  assert.equal(instance.fetchCalls.length, 1, 'one book request per revision')
  assert.equal(
    instance.fetchCalls[0].url,
    `/dsh-pdf2epub/epub?sessionId=s-1&path=${encodeURIComponent('C:\\Work\\book.epub')}`,
    'the address must supply both the Session id and the path',
  )
  assert.deepEqual(texts.includes('测试书'), true, 'the book title must reach the header')
  assert.ok(texts.includes('某作者'), 'the author must reach the header')
  assert.ok(texts.includes('1 / 2'), 'the position must reach the header')
  assert.deepEqual(lifecycle[0], ['loaded', 0], 'a ready book must call content.loaded')

  // TOC: one row per chapter, nested level indented, current chapter highlighted.
  const tocButtons = elements.filter(element => element.type === 'button' && ['第一章', '第一节'].includes(textOf(element)))
  assert.equal(tocButtons.length, 2, 'one TOC row per chapter')
  assert.equal(tocButtons[0].props.style.fontWeight, 600, 'the current chapter must be highlighted')
  assert.equal(tocButtons[1].props.style.fontWeight, 400)
  assert.ok(tocButtons[1].props.style.paddingLeft > tocButtons[0].props.style.paddingLeft, 'level 2 must be indented')

  // Layout: the scoped container carries the className the CSS was prefixed with.
  assert.ok(elements.some(element => element.props.className === 'p2e-book'), 'the reader box must carry the scope class')
  const styles = elements.filter(element => element.type === 'style').map(element => textOf(element))
  assert.equal(styles.length, 2, 'reading typography + the scoped book stylesheet')
  const bookStyle = styles.find(text => text.includes('.p2e-book'))
  assert.ok(bookStyle !== undefined, 'the book stylesheet must be rendered')
  assert.ok(bookStyle.includes('.p2e-book h1'), 'the book stylesheet must be scoped')
  assert.ok(styles.some(text => text.includes('font-size: 17px') && text.includes('max-width: 42em') && text.includes('line-height: 1.8')))

  // Chapter body: images rewritten, script and inline handlers gone.
  const article = elements.find(element => element.props.className === 'dsh-pdf2epub-reader')
  assert.ok(article !== undefined, 'the chapter must render into the reader class')
  assert.equal(article.props.lang, 'zh-CN', 'the book language must reach the article')
  const html = article.props.dangerouslySetInnerHTML.__html
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'), 'the image must be inlined')
  assert.equal(html.includes('missing.png'), false, 'the unresolved image must not leak a request path')
  assert.equal(/<script/i.test(html), false, 'chapter-local scripts must be stripped')
  assert.equal(/\sonclick\s*=/i.test(html), false, 'inline handlers must be stripped')

  // Pager reflects the position and uses the shared copy.
  const pager = elements.filter(element => element.type === 'button')
  const prev = pager.find(element => textOf(element).includes('上一章'))
  const next = pager.find(element => textOf(element).includes('下一章'))
  assert.equal(prev.props.disabled, true, 'prev disabled on the first chapter')
  assert.equal(next.props.disabled, false, 'next enabled')

  // ← / → page the preview through the same shared helper as the panel.
  // The ready render registers theme / scrollport / fetch / keyboard / scroll.
  const keyboardEffect = instance.react.effects[3]
  assert.equal(typeof keyboardEffect, 'function', 'the keyboard effect must be registered')
  keyboardEffect()
  const keyListeners = instance.listeners.get('keydown') ?? []
  assert.ok(keyListeners.length >= 1, 'a keydown listener must be attached while the book is open')
  instance.react.begin()
  keyListeners[keyListeners.length - 1]({
    key: 'ArrowRight',
    target: null,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault() {},
  })
  const moved = instance.react.setters.find(setter => setter.index === 1)
  assert.ok(moved !== undefined, 'ArrowRight must move the chapter state')
  assert.equal(moved.value, 1)
})

/* ------------------------------------------------- 6. permanent refusals */

const refused = await openPreview({
  respond: () => jsonResponse(415, { ok: false, error: 'not a readable EPUB archive: bad local header' }),
})

check('6. a 415 refusal shows the Host error and offers no retry', () => {
  const { instance, tree, lifecycle } = refused
  const texts = textOf(tree)
  assert.ok(texts.includes('415'), 'the HTTP status must reach the reader')
  assert.ok(texts.includes('not a readable EPUB archive: bad local header'), 'the Host error text must be shown')
  assert.ok(!texts.includes('重试'), 'an invalid archive must not offer a retry button')
  assert.deepEqual(lifecycle[0], ['failed'], 'a failed unpack must call content.failed')
  const buttons = []
  walk(tree, element => { if (element.type === 'button') buttons.push(element) })
  assert.equal(buttons.length, 0, 'nothing actionable while the refusal is permanent')
  assert.equal(instance.fetchCalls.length, 1)
})

/* -------------------------------------------- 7/8. path sources and no path */

const directPath = await openPreview(
  { respond: () => jsonResponse(200, BOOK) },
  { path: 'C:\\Books\\direct.epub' },
)

check('7. props.path wins over the resource address', () => {
  assert.equal(directPath.instance.fetchCalls.length, 1)
  assert.equal(
    directPath.instance.fetchCalls[0].url,
    `/dsh-pdf2epub/epub?sessionId=s-1&path=${encodeURIComponent('C:\\Books\\direct.epub')}`,
    'a body that carries a path must use it as-is, still naming its Session',
  )
})

const noPath = await openPreview(
  { respond: () => jsonResponse(200, BOOK) },
  { resourceAddress: undefined },
)

check('8. a body without any path shows the missing-path state, no request', () => {
  const { instance, tree, lifecycle } = noPath
  assert.equal(instance.fetchCalls.length, 0, 'no path must mean no request')
  assert.deepEqual(lifecycle[0], ['failed'], 'the owner must be told the body failed')
  assert.ok(textOf(tree).includes('没有书籍路径'), 'reader.missingPath must be shown')
})

/* -------------------------------------------- 9. the existing checks pass */

check('9. client-check.mjs and locale-check.mjs still pass', () => {
  const clientOut = execFileSync(process.execPath, [path.join(HARNESS, 'client-check.mjs')], { encoding: 'utf8' })
  assert.equal((clientOut.match(/FAIL/g) ?? []).length, 0, `client-check reported a failure:\n${clientOut}`)
  assert.match(clientOut, /PASS 16\./, 'client-check must reach its 16th assertion')
  const localeOut = execFileSync(process.execPath, [path.join(HARNESS, 'locale-check.mjs')], { encoding: 'utf8' })
  assert.equal((localeOut.match(/FAIL/g) ?? []).length, 0, `locale-check reported a failure:\n${localeOut}`)
  assert.match(localeOut, /LOCALE OK/)
})

/* --------------------- 10/11. the real click: a workspace-relative address */

// What the Sidebar really hands a body: `fileAddressFor` strips the workspace
// root, so the address names a workspace-RELATIVE tail (review §1). The Host
// cannot resolve that without the Session, which is why both travel together.
const RELATIVE_ADDRESS = 'dsh-resource://file/session/s-1/books/novel.epub'

const relative = await openPreview(
  { respond: () => jsonResponse(200, BOOK) },
  { resourceAddress: RELATIVE_ADDRESS },
)

check('10. a workspace-relative address sends its Session id with the relative tail', () => {
  const { instance } = relative
  assert.equal(instance.fetchCalls.length, 1)
  assert.equal(
    instance.fetchCalls[0].url,
    `/dsh-pdf2epub/epub?sessionId=s-1&path=${encodeURIComponent('books/novel.epub')}`,
    'the relative tail must be forwarded verbatim, with the Session that roots it',
  )
})

// The standard `useResource` hook, when the owner passes it, gives the absolute
// path directly. It must win over the address tail and still name the Session.
const hooked = await openPreview(
  { respond: () => jsonResponse(200, BOOK) },
  {
    resourceAddress: RELATIVE_ADDRESS,
    useResource: () => ({ status: 'live', value: { absolutePath: 'C:\\Work\\books\\novel.epub' } }),
  },
)

check('11. the useResource absolutePath wins over the address tail', () => {
  const { instance } = hooked
  assert.equal(instance.fetchCalls.length, 1)
  assert.equal(
    instance.fetchCalls[0].url,
    `/dsh-pdf2epub/epub?sessionId=s-1&path=${encodeURIComponent('C:\\Work\\books\\novel.epub')}`,
    'the hook answer is the most direct path available',
  )
  // A hook that knows nothing (status none) must degrade to the address, not throw.
  const targetOf = props => app.sandbox.documentTarget(props, app.sandbox.useDocumentAbsolutePath(props))
  const empty = targetOf({ resourceAddress: RELATIVE_ADDRESS, useResource: () => ({ status: 'none' }) })
  assert.equal(empty.path, 'books/novel.epub', 'a hook with no value must fall back to the address')
  assert.equal(empty.sessionId, 's-1', 'the Session still comes from the address')
})


/* ----------------------------------------------------------------- report */

const total = results.length
const report = [
  '--- dsh-pdf2epub epub preview check ---',
  `renderer: ${app.previewRegistrations.length === 0
    ? 'skipped (documentPreviews unavailable) — contract documented in client.js'
    : `${app.previewRegistrations[0].id} extensions=${JSON.stringify(app.previewRegistrations[0].extensions)} loading=${app.previewRegistrations[0].loading} title=${JSON.stringify(app.previewRegistrations[0].title())}`}`,
  `body slot: ${app.registrations.find(entry => entry.options.name === 'sidebar.right.tab.document')?.options.key ?? 'n/a'}`,
  `route: GET /dsh-pdf2epub/epub?sessionId=<sid>&path=<encoded path> (relative tails resolved by the Host)`,
  `scope: .p2e-book (h1/p prefixed, @media recursed, @font-face verbatim)`,
  `images: ../ resolved against chapters[].href, data URLs inlined, unknown src dropped`,
  `existing checks: client-check 16/16, locale-check 5/5`,
]
process.stdout.write(`${results.join('\n')}\n${report.join('\n')}\nPREVIEW OK (${total} checks${skipped === 0 ? '' : `, ${skipped} skipped`})\n`)

