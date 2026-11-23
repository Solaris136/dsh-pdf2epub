#!/usr/bin/env node
/**
 * Packaging gate for dsh-pdf2epub.
 *
 * `npm pack` is the one command that decides what a user actually installs, and
 * `files` is an allowlist that silently loses entries when a directory moves.
 * This check asks npm for the real tarball listing (`--dry-run --json`, nothing
 * is written) and asserts three things about it:
 *
 *   1. REQUIRED  every runtime entry a DSH bundle needs is in the tarball.
 *   2. FORBIDDEN no review notes, tests, CI config, build output or conversion
 *                artifacts leak into the published package.
 *   3. COUNT     the tarball is not suspiciously small (a moved `src/` would
 *                otherwise show up as a successful, tiny package).
 *
 * Usage: node test/ci/check-package.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

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

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/* -------------------------------------------------------------------------- */
/* Real tarball listing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run `npm pack --dry-run --json` and return its stdout.
 *
 * When this script is reached through an npm script, `npm_execpath` points at
 * `npm-cli.js`; running that file with the current Node avoids the Windows
 * `.cmd` shim (and the `shell: true` deprecation that comes with spawning it).
 * A direct `node test/ci/check-package.mjs` falls back to the npm CLI bundled
 * next to the running Node, then to the platform shim.
 *
 * @returns {string} stdout of a successful `npm pack --dry-run --json`.
 */
function packListing() {
  const args = ['pack', '--dry-run', '--json']
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
  }
  const cli = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(candidate => typeof candidate === 'string' && candidate.endsWith('.js') && fs.existsSync(candidate))
  if (cli !== undefined) return execFileSync(process.execPath, [cli, ...args], options)
  return execFileSync(NPM, args, { ...options, shell: process.platform === 'win32' })
}

let listing = ''
try {
  listing = packListing()
} catch (error) {
  console.log(`FAIL  npm pack --dry-run --json failed — ${String(error.stderr ?? error.message).trim().split(/\r?\n/)[0] ?? ''}`)
  process.exit(1)
}

let pack
try {
  const parsed = JSON.parse(listing)
  pack = Array.isArray(parsed) ? parsed[0] : parsed
} catch (error) {
  console.log(`FAIL  npm pack --json did not print JSON — ${error.message}`)
  process.exit(1)
}

const paths = (pack.files ?? []).map(file => file.path)
ok('npm pack produced a tarball listing', paths.length > 0, `${paths.length} file(s), ${pack.size} bytes packed`)

/* -------------------------------------------------------------------------- */
/* Required entries                                                           */
/* -------------------------------------------------------------------------- */

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'src/pipeline.js',
  'src/pdf/index.js',
  'src/model/assemble.js',
  'src/model/prompt.js',
  'src/epub/build.js',
  'src/host/server.js',
  'src/host/bridge.js',
  'locale/zh-CN.json',
  'locale/en-US.json',
]
const missing = REQUIRED.filter(entry => !paths.includes(entry))
ok(`all ${REQUIRED.length} runtime entries are packed`, missing.length === 0, missing.join(', '))

/* -------------------------------------------------------------------------- */
/* Forbidden entries                                                          */
/* -------------------------------------------------------------------------- */

const FORBIDDEN = [
  [/^notes\//, 'internal review notes'],
  [/^test\//, 'test suites'],
  [/^\.github\//, 'CI configuration'],
  [/^\.out\//, 'build output'],
  [/^node_modules\//, 'vendored dependencies'],
  [/^package-lock\.json$/, 'lockfile'],
  [/\.pdf$/i, 'conversion input'],
  [/\.epub$/i, 'conversion output'],
  [/\.(?:report|book)\.json$/i, 'conversion sidecar'],
  [/\.tgz$/i, 'packed tarball'],
]
const leaked = []
for (const [pattern, label] of FORBIDDEN) {
  for (const file of paths) if (pattern.test(file)) leaked.push(`${file} (${label})`)
}
ok('no forbidden file is packed', leaked.length === 0, leaked.slice(0, 8).join(', '))

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

ok(`tarball name and version come from package.json`,
  pack.name === pkg.name && pack.version === pkg.version,
  `${pack.name}@${pack.version}`)
ok('tarball carries the runtime source tree', paths.filter(file => file.startsWith('src/')).length >= 10,
  `${paths.filter(file => file.startsWith('src/')).length} src file(s)`)

const absentOnDisk = paths.filter(file => !fs.existsSync(path.join(ROOT, file)))
ok('every packed path exists in the working tree', absentOnDisk.length === 0, absentOnDisk.slice(0, 5).join(', '))

/* -------------------------------------------------------------------------- */
/* report                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failures:\n${failures.map(name => ` - ${name}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('PACKAGE OK')
}
