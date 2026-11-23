// Self-check for client.js: loader contract, slot registrations, panel render.
// Runs the real file inside a vm context with a recording React stand-in, so the
// assertions describe what the browser plugin actually registers and renders.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = 'client.js'
const SOURCE = readFileSync(path.join(ROOT, CLIENT), 'utf8')
const ZH = JSON.parse(readFileSync(path.join(ROOT, 'locale/zh-CN.json'), 'utf8'))
const EN = JSON.parse(readFileSync(path.join(ROOT, 'locale/en-US.json'), 'utf8'))

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(`PASS ${label}`)
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`)
    throw error
  }
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
    begin() { cursor = 0; effects.length = 0; setters.length = 0 },
  }
}

/**
 * Load client.js in a fresh context with the given theme-token set.
 * @param {{ tokens: Map<string, string>, collect: string[] }} theme - token stub.
 */
function boot(theme) {
  const react = createReact()
  const required = []
  const requireStub = (specifier) => {
    required.push(specifier)
    if (specifier === 'react') return react.React
    throw new Error(`client.js required a module outside the platform table: ${specifier}`)
  }

  const loadCalls = []
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
    getComputedStyle(element) {
      theme.collect.push(element)
      return {
        getPropertyValue(name) {
          if (element?.isRootProbe === true) return theme.tokens.get(name) ?? ''
          return ''
        },
      }
    },
  }
  const documentStub = { documentElement: { isDocumentElement: true } }
  const fetched = []
  const sandbox = {
    window: windowStub,
    document: documentStub,
    fetch: async (url, init) => {
      fetched.push({ url: String(url), init })
      if (typeof theme.fetch === 'function') {
        const answer = await theme.fetch(String(url), init)
        const text = JSON.stringify(answer.body)
        return {
          ok: answer.status >= 200 && answer.status < 300,
          status: answer.status,
          statusText: '',
          text: async () => text,
        }
      }
      throw new Error('fetch is not exercised by this check')
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

  const registrations = []
  const injections = []
  const effectLabels = []
  const disposers = []
  const ctx = {
    effect(execute, label) {
      effectLabels.push(label)
      const dispose = execute()
      assert.equal(typeof dispose, 'function', `effect "${label}" must return a disposer`)
      disposers.push(dispose)
      return () => {}
    },
    locale: {
      bound: [],
      registered: [],
      register(namespace, dicts) {
        this.registered.push({ namespace, dicts })
        return () => {}
      },
      bind(namespace) {
        this.bound.push(namespace)
        // Unregistered namespace behaviour: translate() returns the key itself,
        // so the panel must fall back to its own inlined dictionary.
        return (key) => key
      },
    },
    slots: {
      inject(name, callback) {
        injections.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  assert.equal(loadCalls.length, 1, 'window.__ModuleLoader__.load must be called exactly once')
  const plugin = loadCalls[0].factory(requireStub)

  return { loadCalls, plugin, required, ctx, registrations, injections, effectLabels, disposers, react, listeners, fetched }
}

/** Depth-first walk of the recorded element tree. */
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

/** Attach the panel root ref so the theme probe has an element to read. */
function attachRefs(tree) {
  const rootProbe = { isRootProbe: true }
  walk(tree, (element) => {
    const ref = element.props.ref
    if (ref !== null && typeof ref === 'object' && 'current' in ref) ref.current = rootProbe
  })
  return rootProbe
}

/* ---------------------------------------------------------------- 1 & 2/3 */

const theme = { tokens: new Map(), collect: [] }
theme.tokens.set('--dsw-alias-bg-layer-1', 'rgb(255, 255, 255)')
theme.tokens.set('--dsw-alias-label-primary', 'rgb(20, 20, 20)')
const first = boot(theme)

check('1. __ModuleLoader__.load called once with id "dsh-pdf2epub"', () => {
  assert.equal(first.loadCalls.length, 1)
  assert.equal(first.loadCalls[0].id, 'dsh-pdf2epub')
  assert.equal(typeof first.loadCalls[0].factory, 'function')
})

check('2. factory returns { inject, apply }', () => {
  assert.ok(first.plugin !== null && typeof first.plugin === 'object')
  assert.ok(Array.isArray(first.plugin.inject))
  assert.equal(typeof first.plugin.apply, 'function')
  assert.deepEqual([...first.plugin.inject].sort(), ['locale', 'slots'])
  assert.deepEqual(first.required, ['react'], 'only platform-table modules may be required')
})

first.plugin.apply(first.ctx)

check('3. apply registers exactly two slot occupants', () => {
  assert.equal(first.registrations.length, 2, 'expected two slots.register calls')
  assert.equal(first.injections.length, 2)
  const slotLabels = first.effectLabels.filter(label => label !== 'pdf2epub: dictionaries')
  assert.equal(slotLabels.length, 2, 'both slot registrations must ride ctx.effect')
  assert.ok(first.effectLabels.includes('pdf2epub: dictionaries'), 'the dictionaries must ride ctx.effect')
  assert.ok(first.disposers.every(dispose => typeof dispose === 'function'))
})

check('4. sidebar.panellist id === main key === "pdf2epub"', () => {
  const main = first.registrations.find(entry => entry.options.name === 'main')
  const sidebar = first.registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.ok(main !== undefined, 'main slot registration missing')
  assert.ok(sidebar !== undefined, 'sidebar.panellist registration missing')
  assert.equal(main.options.key, 'pdf2epub')
  assert.equal(sidebar.options.id, 'pdf2epub')
  assert.equal(main.options.locale, 'pdf2epub')
  assert.equal(sidebar.options.locale, 'pdf2epub')
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), 'PDF 转 EPUB')
  assert.equal(typeof main.component, 'function')
  assert.equal(typeof sidebar.component, 'function')
  assert.deepEqual(first.injections, ['main', 'sidebar.panellist'], 'main must be registered first')
})

/* ------------------------------------------------------- 5. panel rendering */

const mainEntry = first.registrations.find(entry => entry.options.name === 'main')
const Panel = mainEntry.component

first.react.begin()
const tree = Panel()
attachRefs(tree)
const [retainedEffect, themeEffect] = first.react.effects
retainedEffect()
themeEffect()
// Captured before later renders clear the setter log.
const themeWrite = first.react.setters.find(entry => entry.index === 18)

check('5. empty state: intro copy, disabled start, advanced collapsed', () => {
  const texts = textOf(tree)
  assert.ok(texts.includes('逐页转录，弱页交叉复核，产出可重排 EPUB 3'), 'panel.subtitle missing')
  const input = []
  const buttons = []
  walk(tree, (element) => {
    if (element.type === 'input') input.push(element)
    if (element.type === 'button') buttons.push(element)
  })
  const pathInput = input.find(element => element.props.placeholder === '输入 PDF 路径')
  assert.ok(pathInput !== undefined, 'path input placeholder must come from panel.inputPath')
  const startButton = buttons.find(element => textOf(element).includes('开始转换'))
  assert.ok(startButton !== undefined, 'start button must be labelled panel.start')
  assert.equal(startButton.props.disabled, true, 'start must be disabled while the path is empty')
  assert.ok(!texts.includes('复核模型'), 'advanced fields must stay collapsed by default')
  assert.ok(texts.includes('转换完成后，可在这里直接阅读成书'), 'reading-area empty hint missing')
})

check('6. path filled enables start; 「高级」 reveals the three optional fields', () => {
  first.react.begin()
  first.react.slots[0] = 'C:\\Work\\book.pdf'
  const filled = Panel()
  attachRefs(filled)
  const buttons = []
  const inputs = []
  walk(filled, (element) => {
    if (element.type === 'button') buttons.push(element)
    if (element.type === 'input') inputs.push(element)
  })
  const startButton = buttons.find(element => textOf(element).includes('开始转换'))
  assert.equal(startButton.props.disabled, false, 'start must enable once a path is typed')
  assert.equal(inputs.find(element => element.props.placeholder === '输入 PDF 路径').props.value, 'C:\\Work\\book.pdf')

  first.react.begin()
  first.react.slots[0] = 'C:\\Work\\book.pdf'
  first.react.slots[1] = true // advancedOpen
  const advanced = Panel()
  attachRefs(advanced)
  const advancedInputs = []
  walk(advanced, (element) => { if (element.type === 'input') advancedInputs.push(element) })
  const placeholders = advancedInputs.map(element => element.props.placeholder)
  // No `remote` service in this context, so the model catalogue is unavailable
  // and the model field is the plain text input (the dropdown path is covered
  // by model-select-check.mjs).
  assert.ok(placeholders.includes('留空则使用插件配置的默认模型'), 'model field missing')
  assert.ok(
    !placeholders.includes('provider/model，多个用逗号分隔；留空则不做交叉复核'),
    'the review-model field must be gone from the panel',
  )
  assert.equal(advancedInputs.length, 4, 'path + three advanced inputs')
})

check('7. reading typography: 17px / 1.8 / 2em indent / 42em, headings flush', () => {
  const styleTags = []
  walk(tree, (element) => { if (element.type === 'style') styleTags.push(element) })
  assert.equal(styleTags.length, 1, 'exactly one scoped <style> element')
  const css = textOf(styleTags[0])
  for (const fragment of [
    'font-size: 17px',
    'line-height: 1.8',
    'text-indent: 2em',
    'max-width: 42em',
    'margin: 0 auto',
    'text-indent: 0',
  ]) assert.ok(css.includes(fragment), `reading CSS missing "${fragment}"`)
})

check('8. theme tokens: documentElement probed first, then the panel root', () => {
  assert.ok(theme.collect.length > 0, 'theme probe never read a computed style')
  assert.equal(theme.collect[0].isDocumentElement, true, 'documentElement must be probed first')
  assert.ok(theme.collect.some(element => element?.isRootProbe === true), 'panel root must be probed as fallback')
  assert.ok(themeWrite !== undefined, 'theme state must be set')
  // Realm-crossing object, so compare the two fields rather than the prototype.
  assert.equal(themeWrite.value.bg, 'var(--dsw-alias-bg-layer-1, inherit)')
  assert.equal(themeWrite.value.color, 'var(--dsw-alias-label-primary, inherit)')
})

const bare = { tokens: new Map(), collect: [] }
const second = boot(bare)
second.plugin.apply(second.ctx)
const BarePanel = second.registrations.find(entry => entry.options.name === 'main').component
second.react.begin()
const bareTree = BarePanel()
attachRefs(bareTree)
second.react.effects[0]()
second.react.effects[1]()

check('9. no resolvable alias falls back to inherit', () => {
  const themeWrite = second.react.setters.find(entry => entry.index === 18)
  assert.ok(themeWrite !== undefined)
  assert.equal(themeWrite.value.bg, 'inherit')
  assert.equal(themeWrite.value.color, 'inherit')
})

/* ------------------------------------------- 10. reading area with a book */

const book = {
  title: '测试书',
  language: 'zh-CN',
  chapters: [
    { id: 'c1', title: '第一章', html: '<h1>第一章</h1><p>正文一</p>' },
    { id: 'c2', title: '第二章', html: '<h1>第二章</h1><p>正文二</p>' },
  ],
}
const doneJob = {
  jobId: 'job-1', phase: 'done', page: 4, total: 4, tokens: 1200, ms: 65000, startedAt: Date.now() - 65000,
  error: null, bookPath: 'C:\\out\\book.json', book: null,
}

first.react.slots[6] = doneJob
first.react.slots[11] = book
first.react.slots[12] = doneJob.bookPath
first.react.slots[16] = 0
first.react.begin()
const readerTree = Panel()
attachRefs(readerTree)

check('10. done state renders the book: chapter html, TOC, pager, status', () => {
  const elements = []
  walk(readerTree, element => elements.push(element))
  const article = elements.find(element => element.props.className === 'dsh-pdf2epub-reader')
  assert.ok(article !== undefined, 'chapter must render into the reader class')
  assert.equal(article.props.dangerouslySetInnerHTML.__html, book.chapters[0].html)
  assert.equal(article.props.lang, 'zh-CN')
  const toc = elements.filter(element => element.type === 'button' && /^第[一二]章$/.test(textOf(element)))
  assert.equal(toc.length, 2, 'one TOC row per chapter')
  assert.equal(toc[0].props.style.fontWeight, 600, 'current chapter must be highlighted')
  assert.equal(toc[1].props.style.fontWeight, 400)
  const prev = elements.find(element => element.type === 'button' && textOf(element).includes('上一章'))
  const next = elements.find(element => element.type === 'button' && textOf(element).includes('下一章'))
  assert.equal(prev.props.disabled, true, 'prev disabled on the first chapter')
  assert.equal(next.props.disabled, false)
  const texts = textOf(readerTree)
  assert.ok(texts.includes('已完成'), 'phase must map through status.done')
  assert.ok(texts.includes('Token 用量 1,200'), 'token total must be formatted')
  assert.ok(texts.includes('耗时 1:05'), 'elapsed time must be formatted')
})

check('11. next/prev buttons and ← → keys move the reading position', () => {
  const buttons = []
  walk(readerTree, element => { if (element.type === 'button') buttons.push(element) })
  const next = buttons.find(element => textOf(element).includes('下一章'))
  first.react.begin()
  next.props.onClick()
  const advanced = first.react.setters.find(entry => entry.index === 16)
  assert.equal(advanced.value, 1, 'next must advance the chapter index')

  // Re-render at chapter two: pager flips, article follows the index.
  first.react.slots[16] = 1
  first.react.begin()
  const secondPage = Panel()
  attachRefs(secondPage)
  const secondElements = []
  walk(secondPage, element => secondElements.push(element))
  assert.equal(
    secondElements.find(element => element.props.className === 'dsh-pdf2epub-reader').props.dangerouslySetInnerHTML.__html,
    book.chapters[1].html,
  )
  const pager = secondElements.filter(element => element.type === 'button' && /章/.test(textOf(element)))
  const prev = pager.find(element => textOf(element).includes('上一章'))
  const nextAgain = pager.find(element => textOf(element).includes('下一章'))
  assert.equal(prev.props.disabled, false, 'prev enabled on the second chapter')
  assert.equal(nextAgain.props.disabled, true, 'next disabled on the last chapter')

  // Keyboard: ← from chapter two, through the keydown listener the effect adds.
  const [, , , , keyboardEffect] = first.react.effects
  assert.equal(typeof keyboardEffect, 'function', 'keyboard effect must be registered')
  keyboardEffect()
  const keyListeners = first.listeners.get('keydown') ?? []
  assert.equal(keyListeners.length, 1, 'one keydown listener while the reader is open')
  first.react.begin()
  keyListeners[0]({
    key: 'ArrowLeft', target: null, defaultPrevented: false,
    metaKey: false, ctrlKey: false, altKey: false, preventDefault() {},
  })
  const moved = first.react.setters.find(entry => entry.index === 16)
  assert.equal(moved.value, 0, 'ArrowLeft must go back one chapter')
})

check('12. hiding the reading area keeps the book and restores it without refetching', () => {
  first.react.slots[17] = false
  first.react.begin()
  const hiddenTree = Panel()
  attachRefs(hiddenTree)
  assert.ok(textOf(hiddenTree).includes('展开阅读区'), 'show button must replace the hide button')
  const hiddenArticles = []
  walk(hiddenTree, element => { if (element.props.className === 'dsh-pdf2epub-reader') hiddenArticles.push(element) })
  assert.equal(hiddenArticles.length, 0, 'chapter html must not render while collapsed')

  const buttons = []
  walk(hiddenTree, element => { if (element.type === 'button') buttons.push(element) })
  first.react.begin()
  buttons.find(element => textOf(element).includes('展开阅读区')).props.onClick()
  const flip = first.react.setters.find(entry => entry.index === 17)
  assert.equal(flip.value, true, 'the toggle must re-open the reading area')

  // Restore through the retained snapshot: the chapter index survives, and no
  // effect performs a request because the book is already in state.
  first.react.slots[17] = true
  first.react.begin()
  const restored = Panel()
  attachRefs(restored)
  for (const effect of first.react.effects) effect()
  const restoredArticles = []
  walk(restored, element => { if (element.props.className === 'dsh-pdf2epub-reader') restoredArticles.push(element) })
  assert.equal(restoredArticles.length, 1)
  assert.equal(restoredArticles[0].props.dangerouslySetInnerHTML.__html, book.chapters[0].html)
  // The catalogue is the one read a remount repeats on purpose (this Host has no
  // route for it here, so the failure is not cached); book and progress must not
  // be requested again.
  const refetched = first.fetched.map(entry => entry.url).filter(url => !url.startsWith('/dsh-pdf2epub/models'))
  assert.deepEqual(refetched, [], `the restored panel must not refetch, but requested: ${refetched.join(', ')}`)
})

/* ------------------------------------------- 13/14. HTTP contract with Host */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const wireTheme = {
  tokens: new Map(),
  collect: [],
  fetch: async (url) => {
    if (url === '/dsh-pdf2epub/run') return { status: 200, body: { jobId: 'job-9' } }
    if (url.startsWith('/dsh-pdf2epub/state')) {
      return {
        status: 200,
        body: {
          jobId: 'job-9', phase: 'page', page: 2, total: 5, status: 'running',
          tokens: { input: null, output: null, total: 42 },
          epubPath: null, reportPath: null, bookJsonPath: null, error: null,
        },
      }
    }
    return { status: 404, body: { error: 'unexpected request' } }
  },
}
const wire = boot(wireTheme)
wire.plugin.apply(wire.ctx)
const WirePanel = wire.registrations.find(entry => entry.options.name === 'main').component

wire.react.begin()
wire.react.slots[0] = 'C:\\books\\wire.pdf'
const formTree = WirePanel()
attachRefs(formTree)
const formButtons = []
walk(formTree, element => { if (element.type === 'button') formButtons.push(element) })
formButtons.find(element => textOf(element).includes('开始转换')).props.onClick()
await sleep(0)

check('13. 「开始转换」 POSTs the Host spec { input } to /dsh-pdf2epub/run', () => {
  const runCall = wire.fetched.find(entry => entry.url === '/dsh-pdf2epub/run')
  assert.ok(runCall !== undefined, 'no request reached POST /dsh-pdf2epub/run')
  assert.equal(runCall.init.method, 'POST')
  assert.equal(runCall.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(runCall.init.body), { input: 'C:\\books\\wire.pdf' })
  const jobWrite = wire.react.setters.filter(entry => entry.index === 6).at(-1)
  assert.equal(jobWrite.value.jobId, 'job-9', 'the accepted jobId must become panel state')
  assert.equal(typeof jobWrite.value.startedAt, 'number', 'the panel times the job itself')
})

wire.react.begin()
const pollingTree = WirePanel()
attachRefs(pollingTree)
assert.equal(wire.react.effects.length, 6, 'poll/book/keyboard/scroll effects expected')
const stopPolling = wire.react.effects[2]()
await sleep(5)
stopPolling()

check('14. /state polls with ?jobId= and the snapshot lands in the status line', () => {
  const stateCall = wire.fetched.find(entry => entry.url.startsWith('/dsh-pdf2epub/state'))
  assert.ok(stateCall !== undefined, 'no request reached GET /dsh-pdf2epub/state')
  assert.equal(stateCall.url, '/dsh-pdf2epub/state?jobId=job-9')
  assert.equal(stateCall.init.cache, 'no-store')
  const jobWrite = wire.react.setters.filter(entry => entry.index === 6).at(-1)
  assert.equal(jobWrite.value.phase, 'page')
  assert.equal(jobWrite.value.page, 2)
  assert.equal(jobWrite.value.total, 5)
  assert.equal(jobWrite.value.tokens, 42, 'tokens.total must be flattened onto the panel model')
  assert.ok(jobWrite.value.ms >= 0, 'the panel keeps a measured elapsed time')

  // The pipeline phase names are not the locale keys; the panel maps them.
  wire.react.begin()
  const statusTree = WirePanel()
  attachRefs(statusTree)
  const statusText = textOf(statusTree)
  assert.ok(statusText.includes('转录中'), 'phase "page" must map to status.transcribing')
  assert.ok(statusText.includes('正在处理第 2 / 5 页'), 'progress.page must carry {page}/{total}')
  assert.ok(statusText.includes('Token 用量 42'), 'token total must reach the status line')
})

/* -------------------------------------------------------- 15. locale keys */

const usedKeys = new Set()
for (const match of SOURCE.matchAll(/\b(?:text|t)\(([^)]*)\)/g)) {
  for (const literal of match[1].matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)'/g)) usedKeys.add(literal[1])
}
const fallbacks = new Set()
for (const match of SOURCE.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)':/g)) fallbacks.add(match[1])
for (const key of fallbacks) usedKeys.add(key)
const missing = [...usedKeys].filter(key => !(key in ZH) && !(key in EN)).sort()

check('15. every key used by the panel is either shipped or has a local fallback', () => {
  const shipped = new Set([...Object.keys(ZH), ...Object.keys(EN)])
  const unsupported = [...usedKeys].filter(key => !shipped.has(key) && !fallbacks.has(key))
  assert.deepEqual(unsupported, [], `keys with neither dictionary entry nor fallback: ${unsupported.join(', ')}`)
})

check('16. bundle is self-contained: no import, no relative require', () => {
  assert.ok(!/^\s*import\s/m.test(SOURCE), 'client.js must not use import statements')
  assert.ok(!/require\(\s*['"]\./.test(SOURCE), 'client.js must not require relative paths')
  assert.ok(!/require\(\s*['"](?!react['"])/.test(SOURCE), 'client.js must require nothing besides react')
})

/* ----------------------------------------------------------------- report */

const report = [
  '--- dsh-pdf2epub client check ---',
  `registered: ${first.registrations.map(entry => `${entry.options.name}(${entry.options.key ?? entry.options.id})`).join(', ')}`,
  `icon label: ${first.registrations.find(entry => entry.options.name === 'sidebar.panellist').options.label()} / locale ns: ${first.ctx.locale.bound.join(',')}`,
  `paths: POST /dsh-pdf2epub/run {input} -> GET .../state?jobId= (1000ms) -> GET .../book?path=`,
  `theme probe order: ${theme.collect.slice(0, 3).map(element => (element.isDocumentElement ? 'documentElement' : 'panel-root')).join(' -> ')}`,
  `locale keys missing from locale/*.json: ${missing.length === 0 ? 'none' : missing.join(', ')}`,
]

process.stdout.write(`${results.join('\n')}\n${report.join('\n')}\n`)
