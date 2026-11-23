// Self-check for the panel's 「模型」 dropdown in client.js.
//
// The model field used to be a free-text input. It is now a `<select>` built
// from `ctx.get('remote').session.modelCatalog()` — the built-in model picker's
// own source (`notes/model-catalog.md` §1.1) — with two hard rules:
//
//   1. the catalogue only lists routes that are routable *right now* (no
//      credentials means no group), so the original text input stays as the
//      fallback, and 「自定义…」 keeps any route the catalogue does not know
//      reachable (the Host tolerates `model` values the list omits);
//   2. the option value is `${group.id}/${model.id}` — `groups[].id` is the
//      provider id (`ModelProviderGroup`), and the pipeline's `parseRoute`
//      splits on the *first* slash only (`src/host/bridge.js:145-150`), so a
//      model id that itself contains slashes has to survive as one string.
//
// This check boots the real client.js in a vm context with a recording React
// stand-in (exactly like client-check.mjs / picker-check.mjs), so the
// assertions describe what the shipped bundle renders and POSTs rather than a
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

/* --------------------------------------------------------------- fixtures */

/**
 * One `ModelCatalog` shaped exactly like the wire type:
 * `{ default, routableProviders, groups, failures }`, groups as
 * `{ id, name, models }` with models as `{ id, name, description?, reasoning?, badge? }`.
 *
 * Three models over two providers, so "options = models + 2" is not accidentally
 * satisfied by a single group; `relay` carries a slash inside the model id.
 */
const CATALOG = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  routableProviders: ['deepseek', 'relay'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-vl', name: 'DeepSeek VL', badge: { text: '预览', tone: 'info' } },
      ],
    },
    {
      id: 'relay',
      name: '中转站',
      models: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', description: 'image input' },
      ],
    },
  ],
  failures: [],
}

const TOTAL_MODELS = CATALOG.groups.reduce((sum, group) => sum + group.models.length, 0)

/* ------------------------------------------------------------ react stub */

/** Recording React stand-in: element trees, persisted hook slots, effect capture. */
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

/**
 * Load client.js in a fresh context.
 *
 * @param {{ session?: object }} [options] - the `remote.session` namespace stub;
 *   omitted means "this page has no `remote` service at all".
 */
function boot(options = {}) {
  const react = createReact()
  const loadCalls = []
  const runs = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load(spec) { loadCalls.push(spec) } },
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle() { return { getPropertyValue() { return '' } } },
    },
    document: { documentElement: {} },
    fetch: async (url, init) => {
      runs.push({ url: String(url), init })
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ jobId: 'job-model-1' }),
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    HTMLElement: class HTMLElement {},
    console: { log: console.log, info: console.info, error: console.error, warn: () => {} },
  }
  runInNewContext(SOURCE, sandbox, { filename: CLIENT })
  assert.equal(loadCalls.length, 1, 'window.__ModuleLoader__.load must be called exactly once')
  const plugin = loadCalls[0].factory((specifier) => {
    if (specifier === 'react') return react.React
    throw new Error(`client.js required a module outside the platform table: ${specifier}`)
  })

  const registrations = []
  const ctx = {
    effect(execute) {
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
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
  if (options.session !== undefined) ctx.remote = { session: options.session }
  plugin.apply(ctx)

  const Panel = registrations.find(entry => entry.options.name === 'main').component
  return { plugin, ctx, react, registrations, Panel, runs }
}

/**
 * Render the panel with a path typed and the 「高级」 block open.
 * @param {object} instance - booted instance.
 * @param {string} [input] - current path field value.
 */
function render(instance, input = 'C:\\Work\\book.pdf') {
  instance.react.begin()
  instance.react.slots[0] = input
  instance.react.slots[1] = true // advancedOpen
  return instance.Panel()
}

/**
 * Boot, run the mount-once effect (theme probe + catalogue read), and wait for
 * the Remote call to settle.
 *
 * @param {{ session?: object }} options - boot options.
 * @returns {Promise<object>} the settled instance.
 */
async function settle(options) {
  const instance = boot(options)
  render(instance)
  // Effect 1 is the mount-once one (the theme probe); the catalogue rides on
  // it so the panel keeps its six `useEffect` calls and its slot order.
  assert.equal(instance.react.effects.length, 6, 'the panel must keep exactly six effects')
  instance.react.effects[1]()
  await sleep(0)
  return instance
}

/** The `<select>` of the advanced block. */
function modelSelect(tree) {
  return elementsOf(tree, 'select')[0]
}

/** The 「自定义…」 option's value (`\u0000custom`, never a real route). */
function customOptionValue(tree) {
  const option = elementsOf(tree, 'option').find(element => textOf(element) === ZH['panel.modelCustom'])
  assert.ok(option !== undefined, 'the 「自定义…」 option must exist')
  return option.props.value
}

/** The free-text model input (`aria-label` is the model label, not the path's). */
function modelTextInput(tree) {
  return elementsOf(tree, 'input').find(
    element => element.props.type === 'text' && element.props['aria-label'] === ZH['panel.model'],
  )
}

/** The 「开始转换」 button of a rendered panel. */
function startButton(tree) {
  return elementsOf(tree, 'button').find(element => {
    const label = textOf(element)
    return label.includes(ZH['panel.start']) || label.includes(ZH['panel.rerun'])
  })
}

/** The last spec sent to POST /dsh-pdf2epub/run, parsed. */
function lastRunBody(instance) {
  const call = instance.runs.filter(entry => entry.url === '/dsh-pdf2epub/run').at(-1)
  assert.ok(call !== undefined, 'no request reached POST /dsh-pdf2epub/run')
  return JSON.parse(call.init.body)
}

/* ------------------------------------- 1. the catalogue renders a dropdown */

const ready = await settle({ session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } })
const tree = render(ready)

check('1a. two groups render one <select> with models + 2 options', () => {
  const selects = elementsOf(tree, 'select')
  assert.equal(selects.length, 1, 'the model field must be a <select> once the catalogue loads')
  const options = elementsOf(tree, 'option')
  assert.equal(
    options.length,
    TOTAL_MODELS + 2,
    'one option per model plus the empty placeholder and 「自定义…」',
  )
  const groups = elementsOf(tree, 'optgroup')
  assert.equal(groups.length, CATALOG.groups.length, 'one <optgroup> per provider group')
  assert.deepEqual(groups.map(group => group.props.label), ['DeepSeek', '中转站'])
  // The empty option is "no per-call model", i.e. the plugin configuration.
  assert.equal(options[0].props.value, '')
  assert.equal(textOf(options[0]), ZH['panel.modelHint'])
  const custom = options.at(-1)
  assert.equal(textOf(custom), ZH['panel.modelCustom'])
  assert.equal(custom.props.value, '__custom__', 'the sentinel must never be a legal route')
})

check('1b. option text is model.name, with the badge appended, and routes are provider/model', () => {
  const options = elementsOf(tree, 'option')
  const byText = new Map(options.map(option => [textOf(option), option.props.value]))
  assert.equal(byText.get('DeepSeek Chat'), 'deepseek/deepseek-chat')
  assert.equal(byText.get('DeepSeek VL · 预览'), 'deepseek/deepseek-vl', 'the badge is appended to the name')
  assert.equal(
    byText.get('Claude Sonnet 4'),
    'relay/anthropic/claude-sonnet-4',
    'provider/model is joined once: the pipeline splits on the first slash',
  )
  // `model.description` becomes the option tooltip rather than a second label.
  assert.equal(options.find(option => textOf(option) === 'Claude Sonnet 4').props.title, 'image input')
  // `catalog.default` is the initial selection.
  assert.equal(modelSelect(tree).props.value, 'deepseek/deepseek-chat', 'catalog.default must pre-select')
})

/* -------------------------------- 2. a picked model becomes the POST route */

modelSelect(tree).props.onChange({ target: { value: 'relay/anthropic/claude-sonnet-4' } })
const pickedTree = render(ready)
startButton(pickedTree).props.onClick()
await sleep(0)

check('2. the picked model reaches the Host as provider/model', () => {
  assert.equal(
    modelSelect(pickedTree).props.value,
    'relay/anthropic/claude-sonnet-4',
    'the dropdown must follow the selection',
  )
  const body = lastRunBody(ready)
  assert.equal(body.model, 'relay/anthropic/claude-sonnet-4')
  assert.equal(body.input, 'C:\\Work\\book.pdf')
  // The removed field must not be sent at all: the pipeline defaults to [].
  assert.equal('reviewModels' in body, false, 'the request body must not carry reviewModels')
})

/* ----------------------------------- 3. a throwing Remote keeps the panel */

const broken = await settle({
  session: {
    modelCatalog() { throw new Error('model catalog bridge is not reachable') },
  },
})
const brokenTree = render(broken)

check('3. a failed catalogue falls back to the text input and does not crash', () => {
  assert.equal(elementsOf(brokenTree, 'select').length, 0, 'no dropdown without a catalogue')
  const input = modelTextInput(brokenTree)
  assert.ok(input !== undefined, 'the original text input must remain the fallback')
  assert.equal(input.props.placeholder, ZH['panel.modelHint'])
  const texts = textOf(brokenTree)
  assert.ok(texts.includes(ZH['panel.modelFallback']), 'the fallback must explain itself')
  // The rest of the advanced block still renders, and the field still works.
  assert.ok(texts.includes(ZH['panel.dpi']) && texts.includes(ZH['panel.concurrency']))
  input.props.onChange({ target: { value: 'relay/manual-gpt-4o' } })
  assert.equal(broken.react.slots[2], 'relay/manual-gpt-4o', 'typing must own the value')
})

/* ------------------------- 4. 「自定义…」 keeps every route reachable */

const custom = await settle({ session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } })
const customReadyTree = render(custom)
modelSelect(customReadyTree).props.onChange({ target: { value: customOptionValue(customReadyTree) } })
const customTree = render(custom)

check('4a. choosing 「自定义…」 reveals a text box next to the dropdown', () => {
  assert.ok(elementsOf(customTree, 'select').length === 1, 'the dropdown stays, on the custom row')
  const input = modelTextInput(customTree)
  assert.ok(input !== undefined, 'the custom editor must appear')
  assert.equal(
    modelSelect(customTree).props.value,
    customOptionValue(customTree),
    'the dropdown must show the 自定义… row while the text box owns the value',
  )
})

modelTextInput(customTree).props.onChange({ target: { value: 'relay/self-hosted/vision-2' } })
const typedTree = render(custom)
startButton(typedTree).props.onClick()
await sleep(0)

check('4b. the typed route is what the Host receives, slash inside the model kept', () => {
  assert.equal(
    modelSelect(typedTree).props.value,
    customOptionValue(typedTree),
    'a route the catalogue does not list must stay on the 自定义… row',
  )
  assert.equal(modelTextInput(typedTree).props.value, 'relay/self-hosted/vision-2')
  assert.equal(lastRunBody(custom).model, 'relay/self-hosted/vision-2')
})

/* --------------------------------- 5. an empty catalogue is a known state */

const empty = await settle({
  session: { modelCatalog: async () => ({ ok: true, value: { default: null, routableProviders: [], groups: [], failures: [] } }) },
})
const emptyTree = render(empty)

check('5. an empty catalogue keeps the text input and says so', () => {
  assert.equal(elementsOf(emptyTree, 'select').length, 0, 'an empty catalogue is not a dropdown')
  assert.ok(modelTextInput(emptyTree) !== undefined, 'free text stays available')
  assert.ok(textOf(emptyTree).includes(ZH['panel.modelEmpty']), 'the empty state has its own line')
})

/* ------------------------------------------------------------------ 6. copy */

check('6. the new keys ship in both dictionaries and are not leaking keys', () => {
  for (const key of ['panel.modelCustom', 'panel.modelFallback', 'panel.modelLoading', 'panel.modelEmpty']) {
    assert.ok(key in ZH, `locale key ${key} must ship in zh-CN`)
    assert.ok(key in EN, `locale key ${key} must ship in en-US`)
    assert.notEqual(ZH[key], EN[key], `${key} must actually be translated`)
  }
  // The removed field's copy is kept for compatibility, just no longer rendered.
  assert.ok('panel.reviewModels' in ZH && 'panel.reviewModelsHint' in ZH)
  const texts = textOf(tree)
  assert.ok(!texts.includes(ZH['panel.reviewModels']), 'the review-model field must be gone from the panel')
  assert.ok(!texts.includes('panel.model'), 'no raw locale key may reach the panel')
})

/* ----------------------------------------------------------------- report */

const report = [
  '--- dsh-pdf2epub model select check ---',
  `catalogue: ${CATALOG.groups.length} groups / ${TOTAL_MODELS} models -> ${elementsOf(tree, 'option').length} options (models + placeholder + 自定义…)`,
  `options: ${CATALOG.groups.map(group => `[${group.name}] ${group.models.map(model => `${group.id}/${model.id}`).join(', ')}`).join(' | ')}`,
  `default: catalog.default (${CATALOG.default.provider}/${CATALOG.default.model}) pre-selected`,
  `fallback: throwing modelCatalog -> input[type=text] + ${ZH['panel.modelFallback']}`,
  `custom: ${customOptionValue(tree)} row -> text box -> POST model`,
  'reviewModels: state kept ([]), field removed, key absent from the request body',
]
process.stdout.write(`${results.join('\n')}\n${report.join('\n')}\nMODEL SELECT OK\n`)
