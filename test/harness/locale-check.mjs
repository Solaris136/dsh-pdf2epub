// Locale wiring check for client.js: the `pdf2epub` namespace really reaches
// the Client locale registry, the inlined dictionaries match the shipped JSON
// resources, and a duplicate registration cannot take the panel down.
//
// The dictionaries are captured from the real `ctx.locale.register(...)` call
// the plugin makes, so these assertions describe what the browser bundle
// registers, not a copy of it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = 'client.js'
const SOURCE = readFileSync(path.join(ROOT, CLIENT), 'utf8')
const ZH_FILE = JSON.parse(readFileSync(path.join(ROOT, 'locale/zh-CN.json'), 'utf8'))
const EN_FILE = JSON.parse(readFileSync(path.join(ROOT, 'locale/en-US.json'), 'utf8'))

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

/** Host-realm copy of a dictionary captured inside the vm context. */
const plain = value => JSON.parse(JSON.stringify(value))

/** `{name}` placeholders of one template, sorted. */
const placeholders = template => [...String(template).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

/** Minimal recording React stand-in: element trees and first-render hooks. */
function createReact() {
  const slots = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], () => {}]
    },
    useEffect() {},
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial === undefined ? null : initial }
      return slots[index]
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    Fragment: 'Fragment',
  }
  return { React, begin() { cursor = 0 } }
}

/** Text content of a recorded element tree. */
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  const own = node.children.filter(child => typeof child === 'string').join('')
  return own + node.children.map(textOf).join('')
}

/**
 * The parts of `LocaleRuntime` this check depends on: typed dictionary
 * registration with the single-occupant rule, and a bound translator that
 * reads the active locale's dictionary chain at call time.
 */
class FakeLocale {
  constructor(active = 'zh') {
    this.active = active
    this.dicts = new Map()
    this.bound = []
    this.registered = []
  }

  register(namespace, dicts) {
    this.registered.push({ namespace, dicts })
    let locales = this.dicts.get(namespace)
    if (locales === undefined) {
      locales = new Map()
      this.dicts.set(namespace, locales)
    }
    for (const id of Object.keys(dicts)) {
      if (locales.has(id.toLowerCase())) {
        throw new Error(`locale namespace "${namespace}" already has locale "${id}"`)
      }
    }
    for (const [id, dict] of Object.entries(dicts)) locales.set(id.toLowerCase(), dict)
    const pairs = Object.entries(dicts)
    return () => {
      for (const [id, dict] of pairs) {
        const key = id.toLowerCase()
        if (locales.get(key) === dict) locales.delete(key)
      }
    }
  }

  bind(namespace) {
    this.bound.push(namespace)
    return (key, params) => {
      const locales = this.dicts.get(namespace)
      let template = key
      if (locales !== undefined) {
        const chain = this.active === 'zh' ? ['zh', 'en'] : ['en', 'zh']
        for (const id of chain) {
          const value = locales.get(id)?.[key]
          if (value !== undefined) {
            template = value
            break
          }
        }
      }
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }
  }
}

/**
 * Load client.js in a fresh vm context and return one plugin instance with a
 * recording Client context.
 *
 * @param {{ active?: string }} [options] - active locale for the fake registry.
 */
function boot(options = {}) {
  const react = createReact()
  const warnings = []
  const loadCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load(spec) { loadCalls.push(spec) } },
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle() { return { getPropertyValue() { return '' } } },
    },
    document: { documentElement: {} },
    console: {
      log: console.log,
      info: console.info,
      error: console.error,
      warn: (...args) => warnings.push(args),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    HTMLElement: class HTMLElement {},
    fetch: async () => { throw new Error('the locale check does not reach the network') },
  }
  runInNewContext(SOURCE, sandbox, { filename: CLIENT })
  assert.equal(loadCalls.length, 1, 'window.__ModuleLoader__.load must be called exactly once')
  const plugin = loadCalls[0].factory((specifier) => {
    if (specifier === 'react') return react.React
    throw new Error(`client.js required a module outside the platform table: ${specifier}`)
  })
  const locale = new FakeLocale(options.active ?? 'zh')
  const registrations = []
  const ctx = {
    effect(execute) {
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(name, callback) { return callback() },
      register(slotOptions, component) {
        registrations.push({ options: slotOptions, component })
        return () => {}
      },
    },
    locale,
  }
  return { plugin, ctx, locale, warnings, react, registrations }
}

/* -------------------------------------------------- 1. registration contract */

const main = boot()
main.plugin.apply(main.ctx)
const dicts = main.locale.registered[0]?.dicts

check('1. apply registers the "pdf2epub" namespace exactly once', () => {
  assert.equal(main.locale.registered.length, 1, 'ctx.locale.register must be called exactly once')
  assert.equal(main.locale.registered[0].namespace, 'pdf2epub', 'the namespace must be "pdf2epub"')
  assert.deepEqual(
    Object.keys(dicts),
    ['zh', 'en'],
    'the typed form takes the built-in baseline locale ids, not browser region tags',
  )
  assert.deepEqual(main.locale.bound, ['pdf2epub'], 'the panel must bind the registered namespace')
  assert.ok(main.registrations.some(entry => entry.options.name === 'main'), 'the panel still mounts')
})

/* --------------------------------------- 2. inlined dictionaries vs JSON */

check('2. inline dictionaries match locale/zh-CN.json and locale/en-US.json', () => {
  const inlineZh = plain(dicts.zh)
  const inlineEn = plain(dicts.en)
  assert.deepEqual(Object.keys(inlineZh), Object.keys(ZH_FILE), 'zh key order differs from locale/zh-CN.json')
  assert.deepEqual(Object.keys(inlineEn), Object.keys(EN_FILE), 'en key order differs from locale/en-US.json')
  assert.deepEqual(inlineZh, ZH_FILE, 'zh values drifted from locale/zh-CN.json')
  assert.deepEqual(inlineEn, EN_FILE, 'en values drifted from locale/en-US.json')
})

/* ------------------------------------------- 3. both dictionaries in step */

check('3. the zh and en dictionaries carry the same keys', () => {
  const inlineZh = plain(dicts.zh)
  const inlineEn = plain(dicts.en)
  assert.deepEqual(Object.keys(inlineEn), Object.keys(inlineZh), 'zh/en key order differs')
  assert.deepEqual(
    Object.keys(inlineZh).sort(),
    Object.keys(ZH_FILE).sort(),
    'the inline dictionary and the JSON resource must be the same key set',
  )
  for (const key of Object.keys(inlineZh)) {
    assert.deepEqual(
      placeholders(inlineEn[key]),
      placeholders(inlineZh[key]),
      `{placeholder} mismatch between zh and en for "${key}"`,
    )
  }
})

/* --------------------------------- 4. a duplicate registration is survivable */

check('4. a second registration is swallowed by try/catch and warns once', () => {
  const duplicate = boot()
  duplicate.plugin.apply(duplicate.ctx)
  assert.doesNotThrow(
    () => duplicate.plugin.apply(duplicate.ctx),
    'a duplicate locale registration must not throw out of apply',
  )
  assert.equal(duplicate.locale.registered.length, 2, 'both applies must have reached ctx.locale.register')
  assert.equal(duplicate.warnings.length, 1, 'the duplicate must warn exactly once')
  assert.match(
    String(duplicate.warnings[0][0]),
    /already registered/i,
    'the warning must name the duplicate registration',
  )
  assert.equal(
    duplicate.registrations.filter(entry => entry.options.name === 'main').length,
    2,
    'the panel must still register after the swallowed duplicate',
  )
})

/* ------------------------- 5. the panel renders the active dictionary, not keys */

check('5. the panel renders through the registered English dictionary', () => {
  const english = boot({ active: 'en' })
  english.plugin.apply(english.ctx)
  const Panel = english.registrations.find(entry => entry.options.name === 'main').component
  english.react.begin()
  const tree = Panel()
  const texts = textOf(tree)
  assert.ok(texts.includes('PDF to EPUB'), 'panel.title must come from the en dictionary')
  assert.ok(texts.includes('Start conversion'), 'panel.start must come from the en dictionary')
  assert.ok(texts.includes('Advanced'), 'panel.advanced must come from the en dictionary')
  assert.ok(!texts.includes('开始转换'), 'no hard-coded Chinese copy may survive an en render')
})

/* ------------------------------------------------------------------ report */

const report = [
  '--- dsh-pdf2epub locale check ---',
  `namespace: pdf2epub | locale ids: ${Object.keys(dicts).join(', ')} | ${Object.keys(dicts.zh).length} keys`,
  `inline zh === locale/zh-CN.json: ${Object.keys(dicts.zh).length}/${Object.keys(ZH_FILE).length} keys, values identical`,
  `inline en === locale/en-US.json: ${Object.keys(dicts.en).length}/${Object.keys(EN_FILE).length} keys, values identical`,
  'duplicate registration: caught, one console.warn, panel still registered',
]
process.stdout.write(`${results.join('\n')}\n${report.join('\n')}\nLOCALE OK\n`)
