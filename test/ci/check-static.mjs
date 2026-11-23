#!/usr/bin/env node
/**
 * Deterministic static gate for dsh-pdf2epub.
 *
 * This is the cheap half of CI: no model calls, no Host, no network. It fails
 * on things the runtime suites cannot see until it is too late —
 *
 *   1. SYNTAX   every `.js` / `.mjs` under the repo parses (`node --check`).
 *   2. JSON     `package.json` and both locale dictionaries parse.
 *   3. LOCALE   `locale/zh-CN.json` and `locale/en-US.json` carry the exact
 *               same key set and the same `{placeholder}` set per key.
 *   4. MANIFEST the four-copy identity (`package.json` name, `index.js`
 *               `export const name`, `cordis.patch.yml` plugin id, lockfile
 *               version) agrees, and every `exports` / `files` entry exists.
 *   5. PLUGIN   the DSH bundle patch and web client declaration are present.
 *
 * Usage: node test/ci/check-static.mjs
 * Exits non-zero with a `FAIL` line per broken invariant.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKIP_DIRS = new Set(['.git', '.out', '.work', 'node_modules', 'notes', 'runs'])
const SKIP_JSON = new Set(['package-lock.json'])

let passed = 0
const failures = []

/**
 * Record one assertion.
 *
 * @param {string} label - assertion name shown in the log.
 * @param {boolean} condition - outcome.
 * @param {string} [detail] - evidence printed next to the label.
 * @returns {void}
 */
function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}${detail === '' ? '' : `  — ${detail}`}`)
    return
  }
  failures.push(label)
  console.log(`FAIL  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/**
 * Every regular file under `dir`, skipping build output and vendored trees.
 *
 * @param {string} dir - absolute directory.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} absolute file paths.
 */
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    console.log(`FAIL  cannot read directory ${relative(dir)} — ${error.message}`)
    failures.push(`read ${relative(dir)}`)
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
      continue
    }
    if (entry.isFile()) out.push(full)
  }
  return out
}

/** @param {string} file - absolute path. @returns {string} path with forward slashes. */
const relative = file => path.relative(ROOT, file).split(path.sep).join('/')

/* -------------------------------------------------------------------------- */
/* 1. syntax                                                                  */
/* -------------------------------------------------------------------------- */

const allFiles = walk(ROOT)
const jsFiles = allFiles.filter(file => file.endsWith('.js') || file.endsWith('.mjs'))
const syntaxErrors = []
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    const message = String(error.stderr ?? error.message).trim().split(/\r?\n/)[0] ?? ''
    syntaxErrors.push(`${relative(file)}: ${message}`)
  }
}
ok(`node --check accepts ${jsFiles.length} JS module(s)`, syntaxErrors.length === 0, syntaxErrors.slice(0, 5).join(' | '))

/* -------------------------------------------------------------------------- */
/* 2. JSON                                                                    */
/* -------------------------------------------------------------------------- */

const jsonFiles = allFiles.filter(file => file.endsWith('.json') && !SKIP_JSON.has(path.basename(file)))
const jsonErrors = []
const jsonByPath = new Map()
for (const file of jsonFiles) {
  try {
    jsonByPath.set(file, JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    jsonErrors.push(`${relative(file)}: ${error.message}`)
  }
}
ok(`JSON parses in ${jsonFiles.length} file(s)`, jsonErrors.length === 0, jsonErrors.join(' | '))

const readJson = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'))

/* -------------------------------------------------------------------------- */
/* 3. locale parity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Flatten a nested dictionary into `dotted.key -> string` pairs.
 *
 * @param {unknown} value - dictionary node.
 * @param {string} [prefix] - dotted prefix.
 * @param {Record<string, string>} [out] - accumulator.
 * @returns {Record<string, string>} flattened pairs.
 */
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix] = String(value)
    return out
  }
  for (const [key, child] of Object.entries(value)) flatten(child, prefix === '' ? key : `${prefix}.${key}`, out)
  return out
}

/** @param {string} template - one locale string. @returns {string} sorted placeholders. */
const placeholders = template => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',')

for (const locale of ['locale/zh-CN.json', 'locale/en-US.json']) {
  const parsed = readJson(locale)
  const entries = flatten(parsed)
  const empty = Object.entries(entries).filter(([, value]) => value.trim() === '').map(([key]) => key)
  ok(`${locale} carries no empty string`, empty.length === 0, empty.slice(0, 5).join(', '))
}

const zh = flatten(readJson('locale/zh-CN.json'))
const en = flatten(readJson('locale/en-US.json'))
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
const missingInEn = zhKeys.filter(key => !(key in en))
const extraInEn = enKeys.filter(key => !(key in zh))
ok('locale/zh-CN.json and locale/en-US.json declare the same keys', missingInEn.length === 0 && extraInEn.length === 0,
  missingInEn.length === 0 && extraInEn.length === 0
    ? `${zhKeys.length} keys`
    : `missing in en: ${missingInEn.slice(0, 5).join(', ')} | extra in en: ${extraInEn.slice(0, 5).join(', ')}`)

const placeholderDrift = zhKeys
  .filter(key => key in en && placeholders(zh[key]) !== placeholders(en[key]))
  .map(key => `${key} (${placeholders(zh[key]) || '-'} vs ${placeholders(en[key]) || '-'})`)
ok('locale placeholders agree per key', placeholderDrift.length === 0, placeholderDrift.slice(0, 5).join(' | '))

/* -------------------------------------------------------------------------- */
/* 4. manifest identity                                                       */
/* -------------------------------------------------------------------------- */

const pkg = readJson('package.json')
const indexSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const patchSource = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

const exportedName = /export const name = '([^']+)'/.exec(indexSource)?.[1] ?? ''
const patchId = /^\s*-\s*id:\s*([A-Za-z0-9@/._-]+)\s*$/m.exec(patchSource)?.[1] ?? ''
ok('plugin name agrees across package.json, index.js and cordis.patch.yml',
  pkg.name !== '' && pkg.name === exportedName && pkg.name === patchId,
  `package.json=${pkg.name || '(missing)'} index.js=${exportedName || '(missing)'} cordis.patch.yml=${patchId || '(missing)'}`)

const lock = readJson('package-lock.json')
const lockRoot = lock.packages?.['']?.version
ok('package-lock.json matches package.json version',
  lock.version === pkg.version && lockRoot === pkg.version,
  `package.json=${pkg.version} lock=${lock.version ?? '(missing)'} lock root=${lockRoot ?? '(missing)'}`)

ok('engines.node is declared', typeof pkg.engines?.node === 'string' && pkg.engines.node !== '', pkg.engines?.node ?? '(missing)')

/* -------------------------------------------------------------------------- */
/* 5. exports / files targets exist                                           */
/* -------------------------------------------------------------------------- */

/**
 * Expand a `files`-style entry (exact path or one `*` segment) to existing paths.
 *
 * @param {string} entry - relative entry from package.json.
 * @returns {string[]} absolute paths that exist, empty when the entry matches nothing.
 */
function expand(entry) {
  if (!entry.includes('*')) {
    const full = path.join(ROOT, entry)
    return fs.existsSync(full) ? [full] : []
  }
  const star = entry.indexOf('*')
  const before = entry.slice(0, star)
  const after = entry.slice(star + 1)
  const directory = path.join(ROOT, path.dirname(before) === '.' ? '' : path.dirname(before))
  if (!fs.existsSync(directory)) return []
  const suffix = after.startsWith('/') ? after.slice(1) : after
  return fs.readdirSync(directory)
    .filter(name => after === '' || name.endsWith(suffix))
    .map(name => path.join(directory, name))
    .filter(file => fs.existsSync(file))
}

const exportEntries = Object.entries(pkg.exports ?? {})
const exportMisses = []
for (const [key, target] of exportEntries) {
  const targets = typeof target === 'string' ? [target] : Object.values(target ?? {})
  for (const value of targets) {
    if (typeof value !== 'string') continue
    if (expand(value).length === 0) exportMisses.push(`${key} -> ${value}`)
  }
}
ok(`all ${exportEntries.length} exports target(s) exist`, exportMisses.length === 0, exportMisses.join(' | '))

const filesEntries = Array.isArray(pkg.files) ? pkg.files : []
const fileMisses = filesEntries.filter(entry => expand(entry).length === 0)
ok(`all ${filesEntries.length} files entry(ies) exist`, fileMisses.length === 0, fileMisses.join(', '))

const forbiddenEntries = filesEntries.filter(entry => /^(?:\.out|\.git|node_modules|notes|test)(?:\/|$)/.test(entry))
ok('files allowlist names no build output, vendored tree or test folder', forbiddenEntries.length === 0, forbiddenEntries.join(', '))

/* -------------------------------------------------------------------------- */
/* 6. DSH bundle declaration                                                  */
/* -------------------------------------------------------------------------- */

const bundlePatch = pkg.dsh?.bundle?.patch
ok('dsh.bundle.patch points at an existing file',
  typeof bundlePatch === 'string' && fs.existsSync(path.join(ROOT, bundlePatch)),
  bundlePatch ?? '(missing)')
ok('dsh.client declares the web platform and its inject targets',
  pkg.dsh?.client?.platform === 'web' && Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
  `${pkg.dsh?.client?.platform ?? '(missing)'} / ${(pkg.dsh?.client?.inject ?? []).join(', ')}`)

/* -------------------------------------------------------------------------- */
/* report                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failures:\n${failures.map(name => ` - ${name}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('STATIC OK')
}
