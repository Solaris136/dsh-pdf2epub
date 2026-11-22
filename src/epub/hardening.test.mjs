/**
 * Hardening regression suite for the EPUB assembly module.
 *
 *   node src/epub/hardening.test.mjs
 *
 * One check per finding of the independent review (docs/review-epub.md):
 * S1 (zip mtime independent of the host time zone), S2 (XML 1.0 illegal code
 * points), M1 (chapter html validation), M2 (href validation + percent
 * encoding), M3 (entry-name length + Windows device names), M4 (BCP-47) and
 * M5 (cover media type), plus regressions for the clean path.
 *
 * Every generated `.xhtml` / `.opf` / `.xml` entry is parsed with `saxes`, a
 * strict XML parser (devDependency, pure JS, no native build), so a
 * "green test, unreadable book" outcome is impossible: illegal code points,
 * bare ampersands and mismatched tags all fail the parse.
 *
 * Prints "HARDENING OK (N tests)" and exits 0, or exits 1 on any failure.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { strFromU8, unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

import {
  DEFAULT_LANGUAGE,
  EPUB_MIMETYPE,
  MAX_ENTRY_NAME_BYTES,
  ZIP_MTIME,
  buildEpub,
  sanitizeXmlText,
  validateChapterHtml,
} from './build.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BUILD_URL = pathToFileURL(resolve(HERE, 'build.js')).href;

/* ------------------------------------------------------------------ *
 * tiny check harness (same shape as test.mjs)
 * ------------------------------------------------------------------ */

let checks = 0;
let failures = 0;

function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}\n       ${error && error.message ? error.message : error}`);
  }
}

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/** Run `fn`, expect a `[pdf2epub/epub]` error whose message matches `pattern`. */
function throws(fn, pattern, message) {
  let captured = null;
  try {
    fn();
  } catch (error) {
    captured = error;
  }
  ok(captured !== null, `${message}: expected buildEpub to throw, it did not`);
  ok(
    /^\[pdf2epub\/epub\]/.test(captured.message),
    `${message}: error lacks the [pdf2epub/epub] prefix: ${captured.message}`,
  );
  ok(
    pattern.test(captured.message),
    `${message}: message ${JSON.stringify(captured.message)} does not match ${pattern}`,
  );
  return captured;
}

/* ------------------------------------------------------------------ *
 * fixtures + helpers
 * ------------------------------------------------------------------ */

// No reader ever looks inside these bytes in this suite; a PNG signature plus a
// couple of bytes is enough to prove "the archive ships exactly what it was given".
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

const ID = 'urn:uuid:12345678-1234-4234-8234-123456789abc';

function book(overrides = {}) {
  return {
    title: '测试书目',
    language: 'zh-CN',
    author: 'dsh-pdf2epub',
    identifier: ID,
    chapters: [{ id: 'ch-1', title: '第一章', level: 1, html: '<p>正文</p>' }],
    ...overrides,
  };
}

const XML_ILLEGAL_SCAN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** Strict-parse one XML document; returns a list of problems (empty = valid). */
function xmlProblems(name, xml) {
  const problems = [];
  try {
    const parser = new SaxesParser({ fileName: name });
    parser.on('error', (error) => problems.push(`${name}: ${error.message}`));
    parser.write(xml).close();
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
  }
  return problems;
}

/**
 * Unpack `bytes` and strict-parse every XML document in it.
 * Returns the unpacked entries plus the number of documents that were parsed.
 */
function packAndParse(bytes, label) {
  const files = unzipSync(bytes);
  const problems = [];
  let parsed = 0;
  for (const name of Object.keys(files)) {
    if (!/\.(?:xhtml|opf|xml)$/.test(name)) continue;
    problems.push(...xmlProblems(`${label}/${name}`, strFromU8(files[name])));
    parsed += 1;
  }
  ok(parsed > 0, `${label}: no XML entry was found in the archive`);
  ok(problems.length === 0, `${label}: strict XML parse failed -> ${problems.join(' | ')}`);
  return { files, parsed };
}

/**
 * Read the central directory the way a reader does: entry name plus the DOS
 * date/time fields fflate derived from `mtime`. `test.mjs` already proves the
 * rest of the zip structure; here we only need the timestamps.
 */
function zipTimestamps(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65558; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  ok(eocd >= 0, 'end of central directory record not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const records = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`bad central directory signature at offset ${pos}`);
    }
    const nameLength = buffer.readUInt16LE(pos + 28);
    records.push({
      name: buffer.toString('utf8', pos + 46, pos + 46 + nameLength),
      time: buffer.readUInt16LE(pos + 12),
      date: buffer.readUInt16LE(pos + 14),
    });
    pos += 46 + nameLength + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return records;
}

function decodeDos({ date, time }) {
  return {
    year: 1980 + ((date >> 9) & 0x7f),
    month: (date >> 5) & 0x0f,
    day: date & 0x1f,
    hour: (time >> 11) & 0x1f,
    minute: (time >> 5) & 0x3f,
    second: (time & 0x1f) * 2,
  };
}

/** A manifest href is a URL: the zip entry name is its percent-decoded path. */
function decodeHref(href) {
  return href.split('/').map((segment) => decodeURIComponent(segment)).join('/');
}

/** Read `<item>` / `<itemref>` / metadata text out of the package document. */
function readOpf(xml) {
  const items = [];
  const idrefs = [];
  const texts = new Map();
  let capture = null;

  const parser = new SaxesParser({ fileName: 'content.opf' });
  parser.on('error', (error) => {
    throw new Error(`content.opf: ${error.message}`);
  });
  parser.on('opentag', (tag) => {
    if (tag.name === 'item') {
      items.push({ ...tag.attributes });
      return;
    }
    if (tag.name === 'itemref') {
      idrefs.push(tag.attributes.idref);
      return;
    }
    if (tag.name === 'meta') {
      capture = `meta:${tag.attributes.property ?? tag.attributes.name ?? ''}`;
      texts.set(capture, '');
      return;
    }
    if (tag.name.startsWith('dc:')) {
      capture = tag.name;
      texts.set(capture, '');
    }
  });
  parser.on('text', (chunk) => {
    if (capture !== null) texts.set(capture, texts.get(capture) + chunk);
  });
  parser.on('closetag', () => {
    capture = null;
  });
  parser.write(xml).close();
  return { items, idrefs, texts };
}

function readOpfOf(files) {
  return readOpf(strFromU8(files['OEBPS/content.opf']));
}

/** First element with that name, as decoded text (null when absent). */
function elementText(xml, name) {
  let depth = 0;
  let text = null;
  const parser = new SaxesParser();
  parser.on('error', (error) => {
    throw new Error(error.message);
  });
  parser.on('opentag', (tag) => {
    if (tag.name === name && depth === 0) {
      depth = 1;
      text = '';
    } else if (depth > 0) {
      depth += 1;
    }
  });
  parser.on('text', (chunk) => {
    if (depth > 0) text += chunk;
  });
  parser.on('closetag', () => {
    if (depth > 0) depth -= 1;
  });
  parser.write(xml).close();
  return text;
}

/** manifest hrefs that have no zip entry. */
function missingEntries(files, items) {
  return items.map((item) => item.href).filter((href) => !(`OEBPS/${decodeHref(href)}` in files));
}

/** zip entries that no manifest item points at (mimetype/container/opf excepted). */
function orphanEntries(files, items) {
  const always = new Set(['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf']);
  const referenced = new Set(items.map((item) => `OEBPS/${decodeHref(item.href)}`));
  return Object.keys(files).filter((name) => !always.has(name) && !referenced.has(name));
}

/** The single illegal code point in `text`, as U+XXXX (test helper). */
function codePointName(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * S1 - zip mtime must survive any host time zone
 * ------------------------------------------------------------------ */

check('S1: ZIP_MTIME is a locally built date well inside the DOS range', () => {
  ok(ZIP_MTIME instanceof Date, 'ZIP_MTIME is not a Date');
  const year = ZIP_MTIME.getFullYear();
  ok(year >= 1981, `ZIP_MTIME local year ${year} is too close to 1980 (fflate rejects 1979)`);
  ok(year <= 2099, `ZIP_MTIME local year ${year} is above the 2099 ceiling`);
  // Built from local components, so these are the values fflate's DOS encoder
  // reads on every host, whatever the UTC offset is.
  eq(ZIP_MTIME.getFullYear(), 2000, 'ZIP_MTIME local year is not the fixed 2000');
  eq(ZIP_MTIME.getMonth(), 0, 'ZIP_MTIME local month is not January');
  eq(ZIP_MTIME.getDate(), 1, 'ZIP_MTIME local day is not the 1st');
  eq(ZIP_MTIME.getHours(), 0, 'ZIP_MTIME local hour is not 00');
  eq(ZIP_MTIME.getMinutes(), 0, 'ZIP_MTIME local minute is not 00');
  eq(ZIP_MTIME.getSeconds(), 0, 'ZIP_MTIME local second is not 00');
});

check('S1: every zip entry stores the fixed 2000-01-01T00:00:00 DOS timestamp', () => {
  const bytes = buildEpub(book());
  const records = zipTimestamps(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  ok(records.length >= 5, `expected several entries, got ${records.length}`);
  for (const record of records) {
    const stamp = decodeDos(record);
    eq(
      `${stamp.year}-${stamp.month}-${stamp.day}T${stamp.hour}:${stamp.minute}:${stamp.second}`,
      '2000-1-1T0:0:0',
      `entry ${record.name} has an unexpected DOS timestamp`,
    );
  }
});

/**
 * Run the same build in a child process with a different `TZ`. Windows Node
 * honours `TZ`, but a host that ignores it would silently make this check
 * meaningless, so the child reports its own offset and we skip instead of
 * pretending to have proven anything. The primary S1 guarantee is the local
 * year assertion above, which needs no environment variable at all.
 */
function buildInZone(zone) {
  const script = `
import { createHash } from 'node:crypto';
const { buildEpub, ZIP_MTIME } = await import(${JSON.stringify(BUILD_URL)});
const bytes = buildEpub(${JSON.stringify(book())});
console.log(JSON.stringify({
  offset: new Date(2000, 0, 1).getTimezoneOffset(),
  mtimeYear: ZIP_MTIME.getFullYear(),
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}));
`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TZ: zone },
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

check('S1: negative and far-east time zones build byte-identical archives', () => {
  const bytes = buildEpub(book());
  const localSha = createHash('sha256').update(bytes).digest('hex');
  const localOffset = new Date(2000, 0, 1).getTimezoneOffset();

  for (const zone of ['America/New_York', 'Pacific/Kiritimati']) {
    const result = buildInZone(zone);
    ok(result.mtimeYear >= 1981 && result.mtimeYear <= 2099, `${zone}: mtime year ${result.mtimeYear} is out of range`);
    if (result.offset === localOffset) {
      console.log(`     (skipped ${zone}: this host ignores TZ, offset stayed ${localOffset})`);
      continue;
    }
    eq(result.bytes, bytes.length, `${zone}: archive length differs`);
    eq(result.sha256, localSha, `${zone}: archive bytes differ from the local build`);
  }
});

/* ------------------------------------------------------------------ *
 * S2 - XML 1.0 illegal code points
 * ------------------------------------------------------------------ */

check('S2: sanitizeXmlText deletes XML 1.0 illegal code points, keeps legal ones', () => {
  const ctl = (code) => String.fromCharCode(code);
  eq(sanitizeXmlText(`A${ctl(0)}B${ctl(1)}C${ctl(8)}D`), 'ABCD', 'C0 controls were not deleted');
  eq(sanitizeXmlText(`A${ctl(0x0b)}B${ctl(0x0c)}C${ctl(0x1f)}D`), 'ABCD', 'VT/FF/US were not deleted');
  eq(sanitizeXmlText(`A${ctl(0xfffe)}B${ctl(0xffff)}C`), 'ABC', 'U+FFFE/U+FFFF were not deleted');
  eq(sanitizeXmlText('\t\n\r'), '\t\n\r', 'tab/LF/CR are legal XML and must survive');
  eq(sanitizeXmlText('中文😀\uFFFD'), '中文😀\uFFFD', 'legal non-ASCII text was modified');
  eq(sanitizeXmlText(`x${ctl(0xd800)}y`), 'xy', 'a lone high surrogate was not deleted');
  eq(sanitizeXmlText(`x${ctl(0xdc00)}y`), 'xy', 'a lone low surrogate was not deleted');
  eq(sanitizeXmlText('x😀y'), 'x😀y', 'a valid surrogate pair must be preserved');
  eq(sanitizeXmlText(undefined), '', 'undefined should sanitize to the empty string');
  eq(sanitizeXmlText(null), '', 'null should sanitize to the empty string');
});

check('S2: control characters are stripped from dc:title / creator / publisher / identifier', () => {
  const ctl = (code) => String.fromCharCode(code);
  const bytes = buildEpub(book({
    title: `A${ctl(1)}B`,
    author: `Author${ctl(0x0b)}`,
    publisher: `Press${ctl(0xfffe)}`,
    identifier: `urn:x${ctl(0x1f)}-y`,
    chapters: [{ id: 'ch-1', title: `Ch${ctl(8)}1`, level: 1, html: '<p>正文</p>' }],
  }));
  const { files } = packAndParse(bytes, 'ctrl-metadata');
  const opf = readOpfOf(files);
  eq(opf.texts.get('dc:title'), 'AB', 'dc:title was not cleaned');
  eq(opf.texts.get('dc:creator'), 'Author', 'dc:creator was not cleaned');
  eq(opf.texts.get('dc:publisher'), 'Press', 'dc:publisher was not cleaned');
  eq(opf.texts.get('dc:identifier'), 'urn:x-y', 'dc:identifier was not cleaned');
  const nav = strFromU8(files['OEBPS/nav.xhtml']);
  ok(nav.includes('Ch1'), 'the chapter title was not cleaned in nav.xhtml');
  eq(elementText(strFromU8(files['OEBPS/text/ch-1.xhtml']), 'title'), 'Ch1', 'the <title> of the chapter was not cleaned');
});

check('S2: a control character inside chapter html is rejected, never written', () => {
  for (const code of [0x00, 0x0b, 0x0c, 0xfffe]) {
    const char = String.fromCharCode(code);
    const error = throws(
      () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html: `<p>a${char}b</p>` }] })),
      /book\.chapters\[0\]\.html/,
      `${codePointName(char)} in chapter html`,
    );
    ok(
      error.message.includes(codePointName(char)),
      `${codePointName(char)}: the error should name the code point: ${error.message}`,
    );
  }
});

check('S2: caller-side sanitizeXmlText makes the same html buildable and valid', () => {
  const dirty = `<p>a${String.fromCharCode(0)}b${String.fromCharCode(0x0b)}c${String.fromCharCode(0xfffe)}d</p>`;
  const bytes = buildEpub(book({
    chapters: [{ id: 'ch-1', title: 'A', level: 1, html: sanitizeXmlText(dirty) }],
  }));
  const { files } = packAndParse(bytes, 'ctrl-html-cleaned');
  const doc = strFromU8(files['OEBPS/text/ch-1.xhtml']);
  ok(doc.includes('<p>abcd</p>'), `the cleaned fragment is wrong: ${doc.split('\n').slice(8, 11).join(' / ')}`);
});

check('S2: no XML-illegal code point survives anywhere in the archive', () => {
  const ctl = (code) => String.fromCharCode(code);
  const bytes = buildEpub(book({
    title: `T${ctl(1)}`,
    author: `A${ctl(2)}`,
    publisher: `P${ctl(3)}`,
    identifier: `I${ctl(4)}`,
    chapters: [
      { id: 'ch-1', title: `C${ctl(5)}1`, level: 1, html: `<p>${ctl(9)}ok</p>` },
      { id: 'ch-2', title: `C${ctl(6)}2`, level: 2, html: '<p>two</p>' },
    ],
  }));
  const { files } = packAndParse(bytes, 'ctrl-all');
  for (const [name, data] of Object.entries(files)) {
    if (!/\.(?:xhtml|opf|xml)$/.test(name)) continue;
    const text = strFromU8(data);
    const hit = XML_ILLEGAL_SCAN.exec(text);
    ok(hit === null, `${name} still contains ${hit === null ? '' : codePointName(hit[0])}`);
  }
});

/* ------------------------------------------------------------------ *
 * M1 - chapter html validation
 * ------------------------------------------------------------------ */

check('M1: script / iframe / object / embed are rejected by default', () => {
  for (const tag of ['script', 'iframe', 'object', 'embed']) {
    throws(
      () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html: `<p><${tag}>x</${tag}></p>` }] })),
      new RegExp(`<${tag}>`),
      `<${tag}> in chapter html`,
    );
  }
});

check('M1: inline event handlers and javascript: URLs are rejected', () => {
  throws(
    () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html: '<p onclick="x()">y</p>' }] })),
    /inline event handler/,
    'onclick handler',
  );
  throws(
    () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html: '<p><a href="javascript:alert(1)">x</a></p>' }] })),
    /javascript: URL/,
    'javascript: URL',
  );
});

check('M1: a bare "&" and an undefined entity are rejected, real references pass', () => {
  throws(
    () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html: '<p>5 & 6</p>' }] })),
    /bare "&"/,
    'bare ampersand',
  );
  // An XHTML content document is XML: `&nbsp;` is undefined without a DTD, so
  // a fragment using it would produce a book that no strict parser accepts.
  throws(
    () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html: '<p>a&nbsp;b</p>' }] })),
    /does not predefine/,
    'undefined entity &nbsp;',
  );
  const bytes = buildEpub(book({
    chapters: [{ id: 'ch-1', title: 'A', level: 1, html: '<p>5 &amp; 6 &#65; &#x41; &lt; &gt;</p>' }],
  }));
  const { files } = packAndParse(bytes, 'entity-ok');
  ok(strFromU8(files['OEBPS/text/ch-1.xhtml']).includes('5 &amp; 6'), 'the escaped ampersand was rewritten');
});

check('M1: prose that mentions handler syntax is still ordinary text', () => {
  // Attribute checks must be scoped to element tags, or a book that documents
  // HTML would be impossible to convert.
  const html = '<p>the onload = 3 trick, an onclick = handler, and an href="javascript:x" mention</p>';
  const verdict = validateChapterHtml(html);
  eq(verdict.scripted, false, 'prose mentioning handler syntax must not be reported as active content');
  const bytes = buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html }] }));
  const { files } = packAndParse(bytes, 'm1-prose');
  ok(strFromU8(files['OEBPS/text/ch-1.xhtml']).includes('the onload = 3 trick'), 'the prose was not written');
});

check('M1: ordinary inline markup passes and is written verbatim', () => {
  const html = '<h2>标题</h2>\n<p>a<em>b</em><strong>c</strong><br/></p>';
  const verdict = validateChapterHtml(html);
  eq(verdict.scripted, false, 'plain markup must not be reported as scripted');
  const bytes = buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html }] }));
  const { files } = packAndParse(bytes, 'markup-ok');
  ok(strFromU8(files['OEBPS/text/ch-1.xhtml']).includes(html), 'the fragment was not inserted verbatim');
});

check('M1: allowScripts:true accepts scripts and marks the manifest item scripted', () => {
  const html = '<p><script>alert(1)</script></p>';
  throws(
    () => buildEpub(book({ chapters: [{ id: 'ch-1', title: 'A', level: 1, html }] })),
    /<script>/,
    'script without allowScripts',
  );
  const bytes = buildEpub(book({
    allowScripts: true,
    chapters: [{ id: 'ch-1', title: 'A', level: 1, html }],
  }));
  const { files } = packAndParse(bytes, 'scripted');
  const { items } = readOpfOf(files);
  const chapter = items.find((item) => item.href === 'text/ch-1.xhtml');
  ok(chapter !== undefined, 'chapter manifest item is missing');
  ok(
    (chapter.properties ?? '').split(/\s+/).includes('scripted'),
    `the scripted chapter lacks properties="scripted": ${JSON.stringify(chapter)}`,
  );
  eq(validateChapterHtml(html, { allowScripts: true }).scripted, true, 'validateChapterHtml should report scripted content');
});

check('M1: tag balance is deliberately not checked (documented limitation)', () => {
  // A regexp cannot judge nesting; the module documents that the caller owns
  // well-formedness (src/model/assemble.js escapes every text node). This
  // asserts the limitation is explicit instead of pretending to check it.
  const verdict = validateChapterHtml('<p><em>unbalanced</p>');
  eq(verdict.scripted, false, 'unbalanced-but-harmless markup must not be reported as scripted');
});

/* ------------------------------------------------------------------ *
 * M2 - href validation + encoding
 * ------------------------------------------------------------------ */

check('M2: "#" and "?" inside an href are rejected', () => {
  const asset = (href) => book({ assets: [{ href, mediaType: 'image/png', data: PNG }] });
  throws(() => buildEpub(asset('images/a#b.png')), /must not contain "#" or "\?"/, 'fragment href');
  throws(() => buildEpub(asset('images/a?b.png')), /must not contain "#" or "\?"/, 'query href');
  throws(
    () => buildEpub(book({ coverImage: { href: 'images/c#b.png', mediaType: 'image/png', data: PNG } })),
    /must not contain "#" or "\?"/,
    'fragment in coverImage.href',
  );
});

check('M2: hrefs escaping OEBPS or using a scheme are rejected', () => {
  const asset = (href) => book({ assets: [{ href, mediaType: 'image/png', data: PNG }] });
  for (const href of ['../escape.png', 'images/../../etc/passwd', '/abs.png', 'https://x/y.png', 'data:image/png;base64,AA']) {
    throws(() => buildEpub(asset(href)), /must stay inside OEBPS|must be relative to OEBPS/, `href "${href}"`);
  }
  throws(() => buildEpub(asset('a/..')), /must stay inside OEBPS/, 'href "a/.."');
});

check('M2: a plain href keeps manifest and zip in sync in both directions', () => {
  const bytes = buildEpub(book({
    assets: [{ id: 'fig-1', href: 'images/a.png', mediaType: 'image/png', data: PNG }],
  }));
  const { files } = packAndParse(bytes, 'href-plain');
  const { items } = readOpfOf(files);
  const asset = items.find((item) => item.id === 'fig-1');
  eq(asset.href, 'images/a.png', 'asset href changed');
  ok('OEBPS/images/a.png' in files, 'the asset zip entry is missing');
  eq(missingEntries(files, items).join(', '), '', 'manifest href(s) without a zip entry');
  eq(orphanEntries(files, items).join(', '), '', 'zip entry/entries no manifest item points at');
  ok(Buffer.from(files['OEBPS/images/a.png']).equals(Buffer.from(PNG)), 'asset bytes differ from the input');
});

check('M2: hrefs are percent-encoded while zip entry names stay decoded', () => {
  const bytes = buildEpub(book({
    assets: [
      { id: 'space', href: 'images/my cover.png', mediaType: 'image/png', data: PNG },
      { id: 'cjk', href: 'images/封面.png', mediaType: 'image/png', data: PNG },
    ],
  }));
  const { files } = packAndParse(bytes, 'href-encoded');
  const { items } = readOpfOf(files);
  const space = items.find((item) => item.id === 'space');
  const cjk = items.find((item) => item.id === 'cjk');
  eq(space.href, 'images/my%20cover.png', 'the space was not percent-encoded in the manifest');
  eq(cjk.href, 'images/%E5%B0%81%E9%9D%A2.png', 'non-ASCII was not percent-encoded in the manifest');
  ok('OEBPS/images/my cover.png' in files, 'the decoded space entry is missing');
  ok('OEBPS/images/封面.png' in files, 'the decoded non-ASCII entry is missing');
  eq(missingEntries(files, items).join(', '), '', 'encoded href does not decode to the zip entry');
  eq(orphanEntries(files, items).join(', '), '', 'the archive carries an unreferenced entry');
  ok(!Object.keys(files).some((name) => name.includes('%')), 'no zip entry name may be percent-encoded');
});

check('M2: duplicate hrefs are de-duplicated, conflicting ones rejected', () => {
  const bytes = buildEpub(book({
    assets: [
      { id: 'one', href: 'images/dup.png', mediaType: 'image/png', data: PNG },
      { id: 'two', href: 'images/dup.png', mediaType: 'image/png', data: PNG },
    ],
  }));
  const { files } = packAndParse(bytes, 'href-dup-identical');
  const { items } = readOpfOf(files);
  eq(items.filter((item) => item.href === 'images/dup.png').length, 1, 'the duplicate asset was not collapsed');
  eq(Object.keys(files).filter((name) => name === 'OEBPS/images/dup.png').length, 1, 'the duplicate entry was written twice');
  eq(orphanEntries(files, items).join(', '), '', 'the archive carries an unreferenced entry');

  const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
  throws(
    () => buildEpub(book({
      assets: [
        { id: 'one', href: 'images/dup.png', mediaType: 'image/png', data: PNG },
        { id: 'two', href: 'images/dup.png', mediaType: 'image/png', data: other },
      ],
    })),
    /repeats "images\/dup\.png".*different content/,
    'conflicting duplicate href',
  );
});

/* ------------------------------------------------------------------ *
 * M3 - entry names: length + Windows device names
 * ------------------------------------------------------------------ */

check('M3: Windows reserved device names are rejected', () => {
  for (const id of ['CON', 'con', 'nul', 'AUX', 'COM1', 'com9', 'LPT1', 'lpt9', 'PRN']) {
    throws(
      () => buildEpub(book({ chapters: [{ id, title: 'A', level: 1, html: '<p>x</p>' }] })),
      /Windows reserved device name/,
      `chapter id "${id}"`,
    );
  }
  throws(
    () => buildEpub(book({ assets: [{ href: 'images/NUL.png', mediaType: 'image/png', data: PNG }] })),
    /Windows reserved device name/,
    'asset href with a device name segment',
  );
});

check('M3: entry names above 200 UTF-8 bytes are rejected', () => {
  const error = throws(
    () => buildEpub(book({ chapters: [{ id: 'x'.repeat(300), title: 'A', level: 1, html: '<p>x</p>' }] })),
    /above the 200-byte limit/,
    '300-char chapter id',
  );
  ok(/is \d+ bytes/.test(error.message), `the error should report the byte count: ${error.message}`);
  throws(
    () => buildEpub(book({ assets: [{ href: `images/${'y'.repeat(220)}.png`, mediaType: 'image/png', data: PNG }] })),
    /above the 200-byte limit/,
    'over-long asset href',
  );
  // UTF-8 bytes, not characters: 60 CJK characters are 180 bytes, and the
  // chapter stem is ASCII-folded, so this stays under the cap.
  eq(MAX_ENTRY_NAME_BYTES, 200, 'the documented entry-name limit changed');
});

check('M3: a long but legal entry name still builds', () => {
  const id = 'x'.repeat(120); // OEBPS/text/<120>.xhtml = 137 bytes
  const bytes = buildEpub(book({ chapters: [{ id, title: 'A', level: 1, html: '<p>x</p>' }] }));
  const { files } = packAndParse(bytes, 'long-name-ok');
  ok(`OEBPS/text/${id}.xhtml` in files, 'the long-but-legal entry name was not written');
});

/* ------------------------------------------------------------------ *
 * M4 - BCP-47 language tag
 * ------------------------------------------------------------------ */

check('M4: language must look like a BCP-47 tag', () => {
  for (const language of ['zh_CN', 'Chinese', 'zh cn', 'en_US', 'zh-cn', 'english', 'z h-CN']) {
    throws(
      () => buildEpub(book({ language })),
      /BCP-47/,
      `language "${language}"`,
    );
  }
});

check('M4: valid tags reach dc:language / xml:lang unchanged, absent falls back', () => {
  for (const language of ['zh-CN', 'en', 'zh-Hant', 'zh-Hant-TW', 'en-US', 'pt-BR', 'de-CH']) {
    const bytes = buildEpub(book({ language }));
    const { files } = packAndParse(bytes, `lang-${language}`);
    eq(readOpfOf(files).texts.get('dc:language'), language, `dc:language for "${language}"`);
    ok(
      strFromU8(files['OEBPS/text/ch-1.xhtml']).includes(`xml:lang="${language}"`),
      `xml:lang for "${language}" is missing from the chapter document`,
    );
  }
  const fallback = packAndParse(buildEpub(book({ language: undefined })), 'lang-default').files;
  eq(readOpfOf(fallback).texts.get('dc:language'), DEFAULT_LANGUAGE, 'the default language is wrong');
});

/* ------------------------------------------------------------------ *
 * M5 - cover-image must be an image
 * ------------------------------------------------------------------ */

check('M5: a non-image coverImage.mediaType is rejected', () => {
  throws(
    () => buildEpub(book({ coverImage: { href: 'c.bin', mediaType: 'text/plain', data: PNG } })),
    /image media type/,
    'coverImage mediaType text/plain',
  );
  throws(
    () => buildEpub(book({ coverImage: { href: 'c.pdf', mediaType: 'application/pdf', data: PNG } })),
    /image media type/,
    'coverImage mediaType application/pdf',
  );
  const { files } = packAndParse(
    buildEpub(book({ coverImage: { href: 'images/cover.png', mediaType: 'image/png', data: PNG } })),
    'cover-image-ok',
  );
  const cover = readOpfOf(files).items.find((item) => (item.properties ?? '').includes('cover-image'));
  eq(cover['media-type'], 'image/png', 'the cover media type changed');
});

check('M5: a cover sharing an asset with a non-image media type is rejected', () => {
  throws(
    () => buildEpub(book({
      coverImage: { href: 'c.bin', mediaType: 'image/png', data: PNG },
      assets: [{ href: 'c.bin', mediaType: 'text/plain', data: PNG }],
    })),
    /non-image media type/,
    'shared cover asset with text/plain',
  );
});

check('M2/M5: a cover shared with an image asset produces exactly one cover-image item', () => {
  const bytes = buildEpub(book({
    coverImage: { href: 'images/cover.png', mediaType: 'image/png', data: PNG },
    assets: [{ id: 'the-cover', href: 'images/cover.png', mediaType: 'image/png', data: PNG }],
  }));
  const { files } = packAndParse(bytes, 'cover-shared');
  const { items, idrefs } = readOpfOf(files);
  const covers = items.filter((item) => (item.properties ?? '').split(/\s+/).includes('cover-image'));
  eq(covers.length, 1, 'exactly one manifest item may carry cover-image');
  eq(covers[0].href, 'images/cover.png', 'the shared cover href changed');
  eq(covers[0]['media-type'], 'image/png', 'the shared cover media type changed');
  const coverPage = items.find((item) => item.id === 'cover-page');
  eq(idrefs[0], coverPage.id, 'the cover page must still open the spine');
  ok(
    strFromU8(files[`OEBPS/${coverPage.href}`]).includes('src="../images/cover.png"'),
    'the cover page does not point at the shared cover asset',
  );
  eq(missingEntries(files, items).join(', '), '', 'manifest href without a zip entry');
  eq(orphanEntries(files, items).join(', '), '', 'orphan zip entry');
});

/* ------------------------------------------------------------------ *
 * regression - the clean path still behaves
 * ------------------------------------------------------------------ */

check('regression: the documented book shape builds, parses and stays consistent', () => {
  const bytes = buildEpub(book({
    publisher: 'DSH Press',
    coverImage: { href: 'images/cover.png', mediaType: 'image/png', data: PNG },
    chapters: [
      { id: 'ch-1', title: '第一章 起航', level: 1, html: '<h2>第一章</h2>\n<p>正文一。</p>' },
      { id: 'ch-2', title: '第一节 细节', level: 2, html: '<p>正文二。</p>' },
      { id: 'ch-3', title: '第二章 归途', level: 1, html: '' },
    ],
    assets: [{ id: 'fig-1', href: 'images/figure-1.png', mediaType: 'image/png', data: PNG }],
  }));
  const { files, parsed } = packAndParse(bytes, 'regression');

  eq(strFromU8(files.mimetype), EPUB_MIMETYPE, 'the mimetype payload changed');
  const records = zipTimestamps(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  eq(records[0].name, 'mimetype', 'mimetype is not the first zip entry');

  const { items, idrefs, texts } = readOpfOf(files);
  eq(texts.get('meta:dcterms:modified'), '1970-01-01T00:00:00Z', 'the reproducible timestamp changed');
  eq(new Set(items.map((item) => item.id)).size, items.length, 'manifest ids are not unique');
  for (const item of items) {
    ok(/^[A-Za-z_][A-Za-z0-9._-]*$/.test(item.id), `manifest id "${item.id}" is not an NCName`);
  }
  eq(missingEntries(files, items).join(', '), '', 'manifest href(s) without a zip entry');
  eq(orphanEntries(files, items).join(', '), '', 'zip entry/entries no manifest item points at');
  for (const idref of idrefs) ok(items.some((item) => item.id === idref), `spine idref "${idref}" is not in the manifest`);

  const nav = strFromU8(files['OEBPS/nav.xhtml']);
  for (const chapter of ['第一章 起航', '第一节 细节', '第二章 归途']) {
    ok(nav.includes(chapter), `nav.xhtml is missing "${chapter}"`);
  }
  ok(parsed >= 5, `expected the chapter documents to be parsed too, got ${parsed} XML documents`);

  const coverPage = items.find((item) => item.id === 'cover-page');
  ok(coverPage !== undefined, 'the cover page is missing');
  eq(idrefs[0], coverPage.id, 'the cover page is not the first spine item');
  ok(
    strFromU8(files[`OEBPS/${coverPage.href}`]).includes('src="../images/cover.png"'),
    'the cover page does not point at the cover image',
  );
});

check('regression: node src/epub/test.mjs still passes 30/30', () => {
  const output = execFileSync(process.execPath, [resolve(HERE, 'test.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  ok(output.includes('EPUB MODULE OK'), 'test.mjs did not print EPUB MODULE OK');
  const summary = /checks: (\d+) \| failures: (\d+)/.exec(output);
  ok(summary !== null, `could not read the test.mjs summary: ${output.trim().split('\n').at(-1)}`);
  eq(summary[2], '0', 'test.mjs reported at least one failure');
  ok(Number(summary[1]) >= 30, `test.mjs ran only ${summary[1]} checks`);
});

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log('');
console.log(`checks: ${checks} | failures: ${failures}`);

if (failures > 0) {
  console.error(`HARDENING FAILED (${failures}/${checks} checks failed)`);
  process.exit(1);
}

console.log(`HARDENING OK (${checks} tests)`);
