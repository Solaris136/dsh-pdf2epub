// Self-check for the panel's 「浏览…」 flow in client.js.
//
// The panel has to let the operator pick a PDF instead of typing its path, and
// there are exactly two mechanisms it may use:
//
//   1. the Desktop preload's `__DSH_HOST_PATHS__.pathFor(file)` bridge, driven
//      by an `<input type="file" accept=".pdf">` — the real OS "Open" dialog,
//      which also hands back the absolute path. Only a Desktop window has it.
//   2. `ctx.remote.directoryPicker.list(path)` — the in-app browser, the only
//      mechanism a plain browser page can use, because no page may read a path
//      off a picked `File` on its own.
//
// This check boots the real client.js in a vm context with a recording React
// stand-in (exactly like client-check.mjs) plus a recording `document`, so the
// assertions describe what the shipped bundle does on a click rather than a
// paraphrase of it.
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Recording React stand-in: element trees, persisted hook slots, setter log. */
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

/** Every element of one tag, depth first. */
function elementsOf(tree, tag) {
  const found = []
  walk(tree, (element) => { if (element.type === tag) found.push(element) })
  return found
}

/** The 「浏览…」 button of a rendered panel. */
function browseButton(tree) {
  return elementsOf(tree, 'button').find(element => textOf(element).includes(ZH['panel.browse']))
}

/** The path text input of a rendered panel. */
function pathInput(tree) {
  return elementsOf(tree, 'input').find(element => element.props.placeholder === ZH['panel.inputPath'])
}

/**
 * A recording `<input>` factory: what a real DOM would hand back, minus layout.
 * `fire()` replays one listener, which is how a click on the OS dialog's OK /
 * Cancel reaches the component.
 */
function createDocument() {
  const created = []
  const documentStub = {
    documentElement: { isDocumentElement: true },
    createElement(tag) {
      const node = {
        tagName: String(tag).toUpperCase(),
        listeners: new Map(),
        style: {},
        files: null,
        parentNode: null,
        clickCount: 0,
        addEventListener(type, listener) {
          const list = this.listeners.get(type) ?? []
          list.push(listener)
          this.listeners.set(type, list)
        },
        removeEventListener(type, listener) {
          const list = this.listeners.get(type) ?? []
          this.listeners.set(type, list.filter(entry => entry !== listener))
        },
        click() { this.clickCount += 1 },
        appendChild(child) { child.parentNode = this },
        removeChild(child) { child.parentNode = null },
        fire(type) {
          for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type })
        },
        listenerCount(type) {
          return (this.listeners.get(type) ?? []).length
        },
      }
      created.push(node)
      return node
    },
  }
  return { documentStub, created }
}

/**
 * Load client.js in a fresh context.
 *
 * @param {{ bridge?: object, picker?: object }} options - Desktop path bridge and/or `directoryPicker` namespace stub.
 */
function boot(options = {}) {
  const react = createReact()
  const { documentStub, created } = createDocument()
  const loadCalls = []
  const windowStub = {
    __ModuleLoader__: { load(spec) { loadCalls.push(spec) } },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return { getPropertyValue() { return '' } } },
  }
  if (options.bridge !== undefined) windowStub.__DSH_HOST_PATHS__ = options.bridge
  const sandbox = {
    window: windowStub,
    document: documentStub,
    fetch: async () => { throw new Error('the picker check does not reach the network') },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    HTMLElement: class HTMLElement {},
    console: { log: console.log, info: console.info, error: console.error, warn: (...args) => warnings.push(args) },
  }
  const warnings = []
  runInNewContext(SOURCE, sandbox, { filename: CLIENT })
  assert.equal(loadCalls.length, 1, 'window.__ModuleLoader__.load must be called exactly once')
  const plugin = loadCalls[0].factory((specifier) => {
    if (specifier === 'react') return react.React
    throw new Error(`client.js required a module outside the platform table: ${specifier}`)
  })

  const registrations = []
  const remote = options.picker === undefined ? undefined : { directoryPicker: options.picker }
  const ctx = {
    effect(execute) {
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      bound: [],
      register() { return () => {} },
      bind() { return (key) => ZH[key] ?? key },
    },
    slots: {
      inject(name, callback) { return callback() },
      register(slotOptions, component) {
        registrations.push({ options: slotOptions, component })
        return () => {}
      },
    },
  }
  if (remote !== undefined) ctx.remote = remote
  plugin.apply(ctx)

  const Panel = registrations.find(entry => entry.options.name === 'main').component
  return { plugin, ctx, react, created, registrations, Panel, windowStub, nodes: [] }
}

/**
 * A recording element: enough of a DOM node for the mount and focus paths.
 * @returns {object} the node, with its append/remove/focus counters.
 */
function createNode() {
  return {
    children: [],
    focusCount: 0,
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
    },
    removeChild(child) {
      this.children = this.children.filter(entry => entry !== child)
      child.parentNode = null
    },
    focus() { this.focusCount += 1 },
  }
}

/**
 * Render the panel with one path in slot 0.
 * @param {{ react: object, Panel: Function, nodes: object[] }} instance - booted instance.
 * @param {string} current - the path field's current value.
 */
function render(instance, current) {
  instance.react.begin()
  instance.react.slots[0] = current
  const tree = instance.Panel()
  // Hand every ref a real node so the Desktop chooser mounts on the panel root
  // and the focus hand-back lands on the path input, rather than vanishing into
  // a `null` guard.
  walk(tree, (element) => {
    const ref = element.props.ref
    if (ref !== null && typeof ref === 'object' && 'current' in ref && ref.current === null) {
      const node = createNode()
      ref.current = node
      instance.nodes.push(node)
    }
  })
  return tree
}

/* ------------------------------------------------------------------ 1. copy */

const copy = boot({})
const emptyTree = render(copy, '')

check('1. the panel renders a 浏览… button, enabled while the path is empty', () => {
  const button = browseButton(emptyTree)
  assert.ok(button !== undefined, 'the panel must render a button labelled panel.browse')
  assert.equal(button.props.type, 'button')
  assert.ok(button.props['aria-label'] === ZH['panel.browse'], 'the button must be labelled from panel.browse')
  assert.notEqual(button.props.disabled, true, 'picking the first file is exactly when the field is empty')
  // Both dictionaries carry the key, and they are not the same string: a
  // missing one would silently fall back to the Chinese copy.
  assert.equal(EN['panel.browse'], 'Browse…')
  for (const key of ['panel.browse', 'picker.title', 'picker.up', 'picker.empty', 'picker.cancel', 'picker.loading']) {
    assert.ok(key in ZH && key in EN, `locale key ${key} must ship in both dictionaries`)
  }
})

/* ------------------------------------------- 2/3/4. Desktop native chooser */

const bridge = {
  calls: [],
  answer: 'C:\\Work\\dsh-pdf2epub\\docs\\book.pdf',
  pathFor(file) { this.calls.push(file) ; return this.answer },
}
const desktop = boot({ bridge })
const filledTree = render(desktop, 'C:\\Work\\old.pdf')
const desktopButton = browseButton(filledTree)
assert.ok(desktopButton !== undefined, 'the Desktop panel must render the browse button')

desktopButton.props.onClick()
await sleep(0)

check('2a. a click opens a hidden file input filtered to PDFs', () => {
  assert.equal(desktop.created.length, 1, 'exactly one file input must be created for one click')
  const input = desktop.created[0]
  assert.equal(input.tagName, 'INPUT')
  assert.equal(input.type, 'file', 'the input must be a file chooser')
  assert.equal(input.accept, 'application/pdf,.pdf', 'the chooser must filter to PDFs')
  assert.equal(input.multiple, false, 'one PDF per pick')
  assert.equal(input.style.display, 'none', 'the input itself must stay invisible')
  assert.equal(input.clickCount, 1, 'the input must be clicked inside the user gesture')
  assert.equal(input.parentNode !== null, true, 'the input must be mounted while the chooser is open')
  // Nothing was typed or accepted yet: the chooser is still waiting.
  assert.equal(desktop.react.setters.find(entry => entry.index === 0), undefined, 'the path must not change before a file is picked')
})

const file = { name: 'book.pdf', type: 'application/pdf' }
desktop.created[0].files = [file]
desktop.created[0].fire('change')
await sleep(0)

check('3a. the picked file becomes the absolute path in the field', () => {
  assert.equal(bridge.calls.length, 1, 'the preload bridge must map the picked File to its path')
  assert.equal(bridge.calls[0], file, 'the very File the chooser returned is what the bridge maps')
  const written = desktop.react.setters.filter(entry => entry.index === 0).at(-1)
  assert.ok(written !== undefined, 'the chosen path must be written to panel state')
  assert.equal(written.value, 'C:\\Work\\dsh-pdf2epub\\docs\\book.pdf')
  assert.equal(desktop.created[0].listenerCount('change'), 0, 'the settled input must drop its listeners')
  assert.equal(desktop.created[0].parentNode, null, 'the settled input must be unmounted')
  assert.ok(desktop.nodes.some(node => node.focusCount > 0), 'focus must return to the path field after a pick')
  // Re-render with the adopted path: the visible field shows it.
  const adopted = render(desktop, 'C:\\Work\\dsh-pdf2epub\\docs\\book.pdf')
  assert.equal(pathInput(adopted).props.value, 'C:\\Work\\dsh-pdf2epub\\docs\\book.pdf')
})

const cancelled = boot({ bridge: { calls: [], pathFor() { return '' } } })
const cancelledTree = render(cancelled, 'C:\\Work\\keep.pdf')
browseButton(cancelledTree).props.onClick()
await sleep(0)
cancelled.created[0].fire('cancel')
await sleep(0)

check('4a. a cancelled chooser changes nothing and reports nothing', () => {
  assert.equal(cancelled.react.setters.filter(entry => entry.index === 0).length, 0, 'a cancel must not touch the path')
  assert.equal(cancelled.created[0].parentNode, null, 'a cancelled chooser must still unmount its input')
  assert.ok(cancelled.nodes.some(node => node.focusCount > 0), 'focus must return to the path field after a cancel')
  const tree = render(cancelled, 'C:\\Work\\keep.pdf')
  assert.equal(pathInput(tree).props.value, 'C:\\Work\\keep.pdf', 'the typed path must survive a cancel')
  assert.ok(!textOf(tree).includes(ZH['picker.unavailable']), 'a cancel is not an error')
})

/* --------------------------------------------- 2/3/4. in-app directory browser */

/** The `directoryPicker` namespace stub: records calls, answers scripted listings. */
function createPicker(listings = {}) {
  return {
    calls: [],
    list(target, signal) {
      this.calls.push({ target, hasSignal: signal !== undefined })
      const key = target === undefined ? '' : target
      const answer = listings[key]
      if (answer === undefined) return { ok: true, value: { path: key, home: 'C:\\Users\\zhang', crumbs: [], entries: [], truncated: false } }
      return { ok: true, value: answer }
    },
  }
}

const docsListing = {
  path: 'C:\\docs',
  home: 'C:\\Users\\zhang',
  crumbs: [
    { name: 'C:\\', path: 'C:\\', hidden: false },
    { name: 'docs', path: 'C:\\docs', hidden: false },
  ],
  entries: [
    // The browse backend reports directories only, so a real row carries no
    // kind at all: this one must render as a folder.
    { name: 'sub', path: 'C:\\docs\\sub', hidden: false },
    // A backend that reports files: the `.pdf` one is offered, the rest dropped.
    { name: 'book.pdf', path: 'C:\\docs\\book.pdf', hidden: false, type: 'file' },
    { name: 'notes.txt', path: 'C:\\docs\\notes.txt', hidden: false, type: 'file' },
    { name: 'LOUD.PDF', path: 'C:\\docs\\LOUD.PDF', hidden: false, type: 'file' },
  ],
  truncated: false,
}

const browser = boot({ picker: createPicker({ 'C:\\docs': docsListing }) })
const browserTree = render(browser, 'C:\\docs\\typed.pdf')
browseButton(browserTree).props.onClick()
await sleep(0)

check('2b. without the Desktop bridge the click lists the typed path\'s folder', () => {
  const picker = browser.ctx.remote.directoryPicker
  assert.equal(picker.calls.length, 1, 'the in-app browser must ask the Host for one level')
  assert.equal(picker.calls[0].target, 'C:\\docs', 'the picker must start in the typed file\'s own folder')
  assert.equal(picker.calls[0].hasSignal, true, 'the listing must carry a cancellation signal')
  assert.equal(browser.created.length, 0, 'no file input may be built without the Desktop bridge')
})

check('3b. the listing renders folders, the .pdf rows, an up row and a cancel', () => {
  const tree = render(browser, 'C:\\docs\\typed.pdf')
  const rows = elementsOf(tree, 'button').map(element => textOf(element))
  assert.ok(rows.includes('sub/'), 'a directory row must be drawn with its folder marker')
  assert.ok(rows.includes('book.pdf'), 'a .pdf row must be selectable')
  assert.ok(rows.includes('LOUD.PDF'), 'the .pdf filter must be case-insensitive')
  assert.ok(!rows.includes('notes.txt'), 'a non-PDF file must never be offered')
  assert.ok(rows.includes(`↑ ${ZH['picker.up']}`), 'the up row must come from picker.up')
  assert.ok(rows.includes(ZH['picker.cancel']), 'the cancel button must come from picker.cancel')
  const dialog = []
  walk(tree, (element) => { if (element.props.role === 'dialog') dialog.push(element) })
  assert.equal(dialog.length, 1, 'the picker must be one dialog')
  assert.equal(dialog[0].props['aria-modal'], true)
  const overlay = dialog[0].props
  // The overlay lives inside the panel root: absolutely positioned, no portal.
  const positioned = []
  walk(tree, (element) => {
    if (element.props.style !== undefined && element.props.style !== null && element.props.style.position === 'absolute') positioned.push(element)
  })
  assert.equal(positioned.length >= 1, true, 'the picker must be absolutely positioned inside the panel')
  assert.equal(overlay['aria-label'], ZH['picker.title'], 'the dialog must be labelled from picker.title')
})

const fileRow = elementsOf(render(browser, 'C:\\docs\\typed.pdf'), 'button').find(element => textOf(element) === 'book.pdf')
fileRow.props.onClick()
await sleep(0)

check('3c. clicking a .pdf row fills the field with its absolute path', () => {
  const written = browser.react.setters.filter(entry => entry.index === 0).at(-1)
  assert.ok(written !== undefined, 'the clicked file\'s path must be written to panel state')
  assert.equal(written.value, 'C:\\docs\\book.pdf')
  const closed = render(browser, 'C:\\docs\\book.pdf')
  assert.equal(pathInput(closed).props.value, 'C:\\docs\\book.pdf')
  const dialogs = []
  walk(closed, (element) => { if (element.props.role === 'dialog') dialogs.push(element) })
  assert.equal(dialogs.length, 0, 'picking a file must close the picker')
})

// A cancel is closing the overlay: no path write, no error.
const cancelBoot = boot({ picker: createPicker({ 'C:\\docs': docsListing }) })
browseButton(render(cancelBoot, 'C:\\docs\\typed.pdf')).props.onClick()
await sleep(0)
const cancelRow = elementsOf(render(cancelBoot, 'C:\\docs\\typed.pdf'), 'button')
  .find(element => textOf(element) === ZH['picker.cancel'])
cancelRow.props.onClick()
await sleep(0)

check('4b. cancelling the in-app picker changes nothing and reports nothing', () => {
  assert.equal(cancelBoot.react.setters.filter(entry => entry.index === 0).length, 0, 'a cancel must not touch the path')
  const tree = render(cancelBoot, 'C:\\docs\\typed.pdf')
  const dialogs = []
  walk(tree, (element) => { if (element.props.role === 'dialog') dialogs.push(element) })
  assert.equal(dialogs.length, 0, 'cancel must close the picker')
  assert.equal(pathInput(tree).props.value, 'C:\\docs\\typed.pdf')
  assert.ok(!textOf(tree).includes(ZH['picker.unavailable']), 'a cancel is not an error')
})

/* ------------------------------------------------- 5. graceful degradation */

const bare = boot({})
const bareTree = render(bare, '')
browseButton(bareTree).props.onClick()
await sleep(0)

check('5. with neither mechanism the button explains itself instead of throwing', () => {
  const tree = render(bare, '')
  const texts = textOf(tree)
  assert.ok(texts.includes(ZH['picker.unavailable']), 'the panel must tell the operator to type the path')
  const dialogs = []
  walk(tree, (element) => { if (element.props.role === 'dialog') dialogs.push(element) })
  assert.equal(dialogs.length, 0, 'no empty dialog may open when no picker exists')
})

/* ----------------------------------------------- 6. the empty-path start rule */
const home = boot({ picker: createPicker({}) })
browseButton(render(home, '')).props.onClick()
await sleep(0)

check('6. an empty field asks the Host for its home directory', () => {
  const picker = home.ctx.remote.directoryPicker
  assert.equal(picker.calls.length, 1)
  assert.equal(picker.calls[0].target, undefined, 'an empty path must list the host home, not a guess')
})

const failed = boot({
  picker: {
    list() { return { ok: false, error: { code: 'directory-picker/unavailable', message: 'needs the browse capability' } } },
  },
})
browseButton(render(failed, 'C:\\docs\\typed.pdf')).props.onClick()
await sleep(0)

check('7. a Host refusal is shown inside the picker, not thrown', () => {
  const tree = render(failed, 'C:\\docs\\typed.pdf')
  const texts = textOf(tree)
  assert.ok(texts.includes('needs the browse capability'), 'the refusal message must reach the dialog')
  assert.equal(failed.react.setters.filter(entry => entry.index === 0).length, 0, 'a refusal must not touch the path')
})

/* --------------------------------------- 8. a non-PDF pick is refused loudly */

const wrongKind = boot({ bridge: { calls: [], pathFor() { return 'C:\\docs\\book.docx' } } })
browseButton(render(wrongKind, '')).props.onClick()
await sleep(0)
wrongKind.created[0].files = [{ name: 'book.docx', type: 'application/msword' }]
wrongKind.created[0].fire('change')
await sleep(0)

check('8. a non-.pdf pick is refused and the field keeps its value', () => {
  assert.equal(
    wrongKind.react.setters.filter(entry => entry.index === 0).length,
    0,
    'a .docx must never become the conversion input',
  )
  const tree = render(wrongKind, '')
  assert.ok(textOf(tree).includes(ZH['picker.notPdf']), 'the operator must be told only PDFs are accepted')
})

/* ----------------------------------------------------------------- report */

const report = [
  '--- dsh-pdf2epub picker check ---',
  `button copy: ${ZH['panel.browse']} / ${EN['panel.browse']}`,
  `desktop chooser: input[type=file][accept=${desktop.created[0].accept}] -> __DSH_HOST_PATHS__.pathFor -> ${bridge.answer}`,
  `in-app browser: directoryPicker.list(C:\\docs) -> ${docsListing.entries.length} wire rows -> 1 folder row + 2 pdf rows (notes.txt dropped)`,
  `locale additions: ${['panel.browse', 'picker.title', 'picker.loading', 'picker.up', 'picker.empty', 'picker.cancel', 'picker.unavailable', 'picker.notPdf'].join(', ')}`,
]
process.stdout.write(`${results.join('\n')}\n${report.join('\n')}\nPICKER OK\n`)
