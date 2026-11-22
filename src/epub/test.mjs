/**
 * Self-test for the EPUB assembly module.
 *
 *   node src/epub/test.mjs
 *
 * Builds a 3-chapter Chinese book (with a real 1x1 PNG used as both cover and
 * asset), writes .out/sample.epub and then verifies the archive by parsing the
 * zip central directory byte by byte plus unzipping every entry with fflate.
 * Prints "EPUB MODULE OK" on success, exits with code 1 on any failure.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

import { buildEpub } from './build.js';

const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.out/sample.epub');

/* ------------------------------------------------------------------ *
 * tiny check harness
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

/* ------------------------------------------------------------------ *
 * a real 1x1 RGBA PNG (generated, so it is verifiably a valid PNG)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function make1x1Png(rgba = [0x1f, 0x7a, 0x8c, 0xff]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const scanline = Buffer.from([0, ...rgba]); // filter type 0 + one RGBA pixel
  return new Uint8Array(
    Buffer.concat([
      signature,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(scanline)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * zip introspection (real byte parsing, not just unzipSync)
 * ------------------------------------------------------------------ */

function findEocd(buffer) {
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65558; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('end of central directory record not found');
}

function readCentralDirectory(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`bad central directory signature at offset ${pos}`);
    }
    const nameLength = buffer.readUInt16LE(pos + 28);
    entries.push({
      name: buffer.toString('utf8', pos + 46, pos + 46 + nameLength),
      method: buffer.readUInt16LE(pos + 10),
      compressedSize: buffer.readUInt32LE(pos + 20),
      size: buffer.readUInt32LE(pos + 24),
      localOffset: buffer.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLength + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return entries;
}

/** Read an entry's stored bytes straight out of a local file header. */
function readLocalEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`bad local file header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
  const start = offset + 30 + nameLength + extraLength;
  return {
    method: buffer.readUInt16LE(offset + 8),
    name,
    bytes: buffer.subarray(start, start + entry.compressedSize),
  };
}

/* ------------------------------------------------------------------ *
 * minimal CSS / OPF helpers
 * ------------------------------------------------------------------ */

function parseCssBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@charset[^;]*;/g, '');
  const blocks = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map();
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) {
        declarations.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim());
      }
    }
    blocks.push({ selectors: match[1].split(',').map((s) => s.trim()), declarations });
  }
  return blocks;
}

/** Union of all declarations from every rule that lists `selector`. */
function cssDeclarations(blocks, selector) {
  const merged = new Map();
  for (const block of blocks) {
    if (!block.selectors.includes(selector)) continue;
    for (const [property, value] of block.declarations) merged.set(property, value);
  }
  return merged;
}

function parseOpf(opf) {
  const items = [];
  for (const match of opf.matchAll(/<item\b([^>]*)\/>/g)) {
    const attributes = {};
    for (const attr of match[1].matchAll(/([A-Za-z:-]+)="([^"]*)"/g)) attributes[attr[1]] = attr[2];
    items.push(attributes);
  }
  const idrefs = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  return { items, idrefs };
}

/* ------------------------------------------------------------------ *
 * 1. build the sample book
 * ------------------------------------------------------------------ */

const png = make1x1Png();

const book = {
  title: '测试书目：PDF 转 EPUB',
  language: 'zh-CN',
  author: 'dsh-pdf2epub',
  publisher: 'DSH Press',
  identifier: 'urn:uuid:12345678-1234-4234-8234-123456789abc',
  coverImage: { href: 'images/cover.png', mediaType: 'image/png', data: png },
  chapters: [
    {
      id: 'ch-1',
      title: '第一章 起航',
      level: 1,
      html: '<h2>第一章 起航</h2>\n<p>这是<em>第一章</em>的正文，包含中文标点：逗号，句号。</p>\n<p>第二段，验证首行缩进由样式表控制。</p>',
    },
    {
      id: 'ch-2',
      title: '第一节 细节',
      level: 2,
      html: '<h2>第一节 细节</h2>\n<p>嵌套目录层级测试，重点是<em>排版</em>。</p>',
    },
    {
      id: 'ch-3',
      title: '第二章 归途',
      level: 1,
      html: '<h2>第二章 归途</h2>\n<p class="verse">床前明月光\n疑是地上霜</p>\n<p class="footnote">1. 脚注示例。</p>',
    },
  ],
  assets: [{ id: 'fig-1', href: 'images/figure-1.png', mediaType: 'image/png', data: png }],
};

const epub = buildEpub(book);

check('buildEpub returns a non-empty Uint8Array', () => {
  ok(epub instanceof Uint8Array, `expected Uint8Array, got ${Object.prototype.toString.call(epub)}`);
  ok(epub.length > 500, `archive too small: ${epub.length} bytes`);
});

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, epub);

check('sample.epub was written to disk', () => {
  ok(statSync(OUT_FILE).size === epub.length, `size mismatch on disk (${OUT_FILE})`);
});

const files = unzipSync(epub);
const entries = readCentralDirectory(Buffer.from(epub.buffer, epub.byteOffset, epub.length));
const names = entries.map((entry) => entry.name);
const text = (name) => {
  ok(Object.prototype.hasOwnProperty.call(files, name), `missing zip entry ${name}`);
  return strFromU8(files[name]);
};
const has = (name) => Object.prototype.hasOwnProperty.call(files, name);

/* ------------------------------------------------------------------ *
 * 2. zip-level requirements
 * ------------------------------------------------------------------ */

check('first zip entry is "mimetype" (local + central directory agree)', () => {
  eq(names[0], 'mimetype', 'first central-directory entry is not mimetype');
  eq(entries[0].localOffset, 0, 'mimetype is not the first local file header');
  const local = readLocalEntry(Buffer.from(epub), entries[0]);
  eq(local.name, 'mimetype', 'first local header name mismatch');
});

check('mimetype is STORED (level 0) and holds exactly "application/epub+zip"', () => {
  eq(entries[0].method, 0, 'mimetype compression method is not 0 (stored)');
  eq(entries[0].compressedSize, entries[0].size, 'stored entry has different compressed size');
  eq(entries[0].size, 20, 'mimetype payload length mismatch');
  const local = readLocalEntry(Buffer.from(epub), entries[0]);
  eq(local.method, 0, 'local header method is not stored');
  eq(Buffer.from(local.bytes).toString('utf8'), 'application/epub+zip', 'mimetype payload mismatch');
  eq(text('mimetype'), 'application/epub+zip', 'unzipped mimetype payload mismatch');
});

check('zip entry names are unique, relative and use forward slashes', () => {
  eq(new Set(names).size, names.length, 'duplicate zip entry names');
  for (const name of names) {
    ok(!name.startsWith('/'), `entry is absolute: ${name}`);
    ok(!name.includes('\\'), `entry contains a backslash: ${name}`);
    ok(name.split('/').every((part) => part.length > 0), `entry has an empty path segment: ${name}`);
  }
});

check('no encryption.xml / signatures.xml / DRM artefacts', () => {
  eq(has('META-INF/encryption.xml'), false, 'META-INF/encryption.xml must not be written');
  eq(has('META-INF/signatures.xml'), false, 'META-INF/signatures.xml must not be written');
});

check('no embedded fonts in the archive', () => {
  const fonts = names.filter((name) => /\.(woff2?|ttf|otf|eot)$/i.test(name));
  eq(fonts.length, 0, `unexpected font files: ${fonts.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 3. container.xml -> content.opf
 * ------------------------------------------------------------------ */

check('META-INF/container.xml points at OEBPS/content.opf', () => {
  const container = text('META-INF/container.xml');
  ok(container.includes('OEBPS/content.opf'), 'container.xml does not reference OEBPS/content.opf');
  ok(container.includes('application/oebps-package+xml'), 'rootfile media-type missing');
  ok(container.startsWith('<?xml'), 'container.xml does not start with an XML declaration');
});

/* ------------------------------------------------------------------ *
 * 4. package document
 * ------------------------------------------------------------------ */

const opf = text('OEBPS/content.opf');
const { items, idrefs } = parseOpf(opf);

check('content.opf declares EPUB 3.0 metadata', () => {
  ok(opf.includes('version="3.0"'), 'package version is not 3.0');
  ok(opf.includes('unique-identifier="pub-id"'), 'unique-identifier attribute missing');
  ok(/<dc:identifier id="pub-id">urn:uuid:/.test(opf), 'dc:identifier with urn:uuid missing');
  ok(opf.includes('<dc:title>'), 'dc:title missing');
  ok(opf.includes('<dc:language>zh-CN</dc:language>'), 'dc:language missing');
  ok(opf.includes('<dc:creator>'), 'dc:creator missing');
});

check('content.opf carries a reproducible dcterms:modified timestamp', () => {
  ok(opf.includes('dcterms:modified'), 'dcterms:modified is missing');
  ok(opf.includes('<meta property="dcterms:modified">1970-01-01T00:00:00Z</meta>'), 'unexpected default timestamp');
});

check('content.opf has a spine with one itemref per chapter', () => {
  ok(opf.includes('<spine'), 'spine element missing');
  const chapterIds = ['ch-1', 'ch-2', 'ch-3'];
  for (const id of chapterIds) ok(idrefs.includes(id), `spine is missing idref "${id}"`);
  ok(idrefs.length >= 3, `spine has only ${idrefs.length} itemref(s)`);
  for (const idref of idrefs) {
    ok(items.some((item) => item.id === idref), `spine references unknown manifest id "${idref}"`);
  }
});

check('manifest lists the nav document with properties="nav"', () => {
  const nav = items.find((item) => (item.properties || '').split(/\s+/).includes('nav'));
  ok(nav, 'no manifest item carries properties="nav"');
  eq(nav.href, 'nav.xhtml', 'nav item href mismatch');
  eq(nav['media-type'], 'application/xhtml+xml', 'nav media-type mismatch');
});

check('every manifest item resolves to a real zip entry', () => {
  ok(items.length >= 7, `expected at least 7 manifest items, got ${items.length}`);
  eq(new Set(items.map((item) => item.id)).size, items.length, 'duplicate manifest ids');
  for (const item of items) {
    ok(item.id && /^[A-Za-z_][A-Za-z0-9._-]*$/.test(item.id), `invalid manifest id "${item.id}"`);
    ok(item.href && !item.href.startsWith('/'), `invalid manifest href "${item.href}"`);
    ok(has(`OEBPS/${item.href}`), `manifest href "${item.href}" has no zip entry`);
  }
});

check('the three chapter documents are in the manifest and in the zip', () => {
  for (const [id, href] of [['ch-1', 'text/ch-1.xhtml'], ['ch-2', 'text/ch-2.xhtml'], ['ch-3', 'text/ch-3.xhtml']]) {
    const item = items.find((candidate) => candidate.id === id);
    ok(item, `manifest lacks chapter item "${id}"`);
    eq(item.href, href, `chapter "${id}" href mismatch`);
    eq(item['media-type'], 'application/xhtml+xml', `chapter "${id}" media-type mismatch`);
    ok(has(`OEBPS/${href}`), `chapter file OEBPS/${href} is missing`);
  }
});

check('cover image is declared with properties="cover-image" and shipped', () => {
  const cover = items.find((item) => (item.properties || '').split(/\s+/).includes('cover-image'));
  ok(cover, 'no manifest item carries properties="cover-image"');
  eq(cover.href, 'images/cover.png', 'cover href mismatch');
  eq(cover['media-type'], 'image/png', 'cover media-type mismatch');
  ok(has(`OEBPS/${cover.href}`), `cover image OEBPS/${cover.href} is missing`);
  ok(Buffer.from(files[`OEBPS/${cover.href}`]).equals(Buffer.from(png)), 'cover bytes differ from input');
});

check('cover page exists, links the image and opens the spine', () => {
  const coverPage = items.find((item) => item.id === 'cover-page');
  ok(coverPage, 'cover page manifest item missing');
  ok(has(`OEBPS/${coverPage.href}`), `cover page OEBPS/${coverPage.href} is missing`);
  const page = text(`OEBPS/${coverPage.href}`);
  ok(page.includes('src="../images/cover.png"'), 'cover page does not reference ../images/cover.png');
  eq(idrefs[0], 'cover-page', 'cover page is not the first spine item');
});

check('assets are shipped byte-identically', () => {
  const item = items.find((candidate) => candidate.id === 'fig-1');
  ok(item, 'asset manifest item "fig-1" missing');
  eq(item.href, 'images/figure-1.png', 'asset href mismatch');
  ok(has(`OEBPS/${item.href}`), 'asset zip entry missing');
  ok(Buffer.from(files[`OEBPS/${item.href}`]).equals(Buffer.from(png)), 'asset bytes differ from input');
});

/* ------------------------------------------------------------------ *
 * 5. nav document
 * ------------------------------------------------------------------ */

const nav = text('OEBPS/nav.xhtml');

check('nav.xhtml starts with an XML declaration and is XHTML', () => {
  ok(nav.startsWith('<?xml'), 'nav.xhtml must start with <?xml');
  ok(nav.includes('xmlns="http://www.w3.org/1999/xhtml"'), 'nav.xhtml lacks the XHTML namespace');
  ok(nav.includes('xmlns:epub="http://www.idpf.org/2007/ops"'), 'nav.xhtml lacks the epub namespace');
});

check('nav.xhtml lists every chapter title', () => {
  ok(nav.includes('<nav epub:type="toc"'), 'nav epub:type="toc" is missing');
  for (const chapter of book.chapters) {
    ok(nav.includes(chapter.title), `nav is missing the title "${chapter.title}"`);
    ok(nav.includes(`href="text/${chapter.id}.xhtml"`), `nav is missing the link to text/${chapter.id}.xhtml`);
  }
});

check('nav.xhtml nests level-2 entries inside the previous <ol>', () => {
  const olCount = (nav.match(/<ol>/g) || []).length;
  ok(olCount >= 2, `expected a nested <ol> for the level-2 entry, found ${olCount} <ol> element(s)`);
  const first = nav.indexOf('第一章 起航');
  const nested = nav.indexOf('第一节 细节');
  const third = nav.indexOf('第二章 归途');
  ok(first >= 0 && first < nested, 'level-1 entry must precede the nested level-2 entry');
  ok(nested < third, 'level-2 entry must close before the next level-1 entry');
  ok(/<\/a>\s*<ol>/.test(nav), 'level-2 entry is not nested inside the parent <li>');
});

/* ------------------------------------------------------------------ *
 * 6. chapter documents
 * ------------------------------------------------------------------ */

check('every chapter is a complete XHTML5 document', () => {
  for (const chapter of book.chapters) {
    const name = `OEBPS/text/${chapter.id}.xhtml`;
    const xhtml = text(name);
    ok(xhtml.startsWith('<?xml version="1.0" encoding="utf-8"?>'), `${name} must start with an XML declaration`);
    ok(xhtml.includes('xmlns="http://www.w3.org/1999/xhtml"'), `${name} lacks the XHTML namespace`);
    ok(xhtml.includes('xmlns:epub="http://www.idpf.org/2007/ops"'), `${name} lacks the epub namespace`);
    ok(xhtml.includes('xml:lang="zh-CN"'), `${name} lacks xml:lang`);
    ok(xhtml.includes('<meta charset="utf-8" />'), `${name} lacks a UTF-8 charset declaration`);
    ok(xhtml.includes('href="../styles/book.css"'), `${name} does not link ../styles/book.css`);
    ok(xhtml.trimEnd().endsWith('</html>'), `${name} does not end with </html>`);
  }
});

check('chapter bodies are inserted verbatim (caller HTML untouched)', () => {
  const xhtml = text('OEBPS/text/ch-1.xhtml');
  ok(xhtml.includes('<em>第一章</em>'), 'inline <em> markup was lost');
  ok(xhtml.includes('<p>这是<em>第一章</em>的正文，包含中文标点：逗号，句号。</p>'), 'chapter paragraph differs from input');
  ok(xhtml.includes('<h2>第一章 起航</h2>'), 'chapter heading differs from input');
});

check('every text/*.xhtml entry in the zip is one of the chapters or the cover', () => {
  const textDocs = names.filter((name) => name.startsWith('OEBPS/text/'));
  const expected = new Set([
    ...book.chapters.map((chapter) => `OEBPS/text/${chapter.id}.xhtml`),
    'OEBPS/text/cover.xhtml',
  ]);
  for (const name of textDocs) ok(expected.has(name), `unexpected text document ${name}`);
  eq(textDocs.length, expected.size, 'unexpected number of text documents');
});

/* ------------------------------------------------------------------ *
 * 7. stylesheet
 * ------------------------------------------------------------------ */

check('styles/book.css implements the required Chinese typography', () => {
  ok(has('OEBPS/styles/book.css'), 'OEBPS/styles/book.css is missing');
  const css = text('OEBPS/styles/book.css');
  ok(!/@font-face/.test(css), 'font embedding is not allowed');
  const blocks = parseCssBlocks(css);

  eq(cssDeclarations(blocks, 'p').get('text-indent'), '2em', 'p { text-indent: 2em } missing');
  eq(cssDeclarations(blocks, 'body').get('line-height'), '1.75', 'body { line-height: 1.75 } missing');
  eq(cssDeclarations(blocks, 'body').get('line-break'), 'strict', 'body { line-break: strict } missing');
  eq(cssDeclarations(blocks, 'h1').get('text-indent'), '0', 'heading text-indent: 0 missing');
  eq(cssDeclarations(blocks, 'h2').get('text-indent'), '0', 'h2 text-indent: 0 missing');
  eq(cssDeclarations(blocks, 'h1').get('break-before'), 'page', 'h1 { break-before: page } missing');
  eq(cssDeclarations(blocks, 'img').get('max-width'), '100%', 'img { max-width: 100% } missing');
  eq(cssDeclarations(blocks, 'th').get('border'), '1px solid #999999', 'table borders missing on th');
  eq(cssDeclarations(blocks, 'td').get('border'), '1px solid #999999', 'table borders missing on td');

  ok(css.includes('.footnote'), '.footnote rule missing');
  ok(css.includes('.verse'), '.verse rule missing');
  eq(cssDeclarations(blocks, '.verse').get('white-space'), 'pre-wrap', '.verse { white-space: pre-wrap } missing');
});

/* ------------------------------------------------------------------ *
 * 8. overrides + reproducibility
 * ------------------------------------------------------------------ */

check('book.css overrides the default stylesheet', () => {
  const custom = buildEpub({ ...book, css: 'body { color: #111; }' });
  const overridden = unzipSync(custom);
  eq(strFromU8(overridden['OEBPS/styles/book.css']), 'body { color: #111; }', 'custom css was not used');
});

check('builds are byte-identical when the identifier is fixed', () => {
  const first = buildEpub(book);
  const second = buildEpub(book);
  ok(Buffer.from(first).equals(Buffer.from(second)), 'two builds of the same book differ');
});

check('identifier defaults to a generated urn:uuid, modified is fixed', () => {
  const generated = unzipSync(buildEpub({ ...book, identifier: undefined }));
  const generatedOpf = strFromU8(generated['OEBPS/content.opf']);
  ok(/<dc:identifier id="pub-id">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/.test(generatedOpf), 'no generated urn:uuid');
  ok(generatedOpf.includes('1970-01-01T00:00:00Z'), 'default dcterms:modified is not the fixed timestamp');
});

check('works with the pipeline call shape (no cover, no assets, ch001 ids)', () => {
  const bytes = buildEpub({
    title: '集成冒烟',
    language: 'zh-CN',
    author: undefined,
    identifier: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    chapters: [
      { id: 'ch001', title: '第一章 序', level: 1, html: '<h1>第一章 序</h1><p>正文一。</p>' },
      { id: 'ch002', title: '第二章 承', level: 1, html: '<h1>第二章 承</h1><p>正文二。</p>' },
    ],
  });
  const packed = unzipSync(bytes);
  const packedNames = Object.keys(packed);
  for (const name of ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml']) ok(name in packed, `${name} missing`);
  ok(!packedNames.some((name) => name.includes('cover')), 'no cover page should be generated without coverImage');
  ok(!strFromU8(packed['OEBPS/content.opf']).includes('dc:creator'), 'dc:creator should be omitted when author is absent');
});

check('duplicate or non-ASCII chapter ids still produce unique files and ids', () => {
  const bytes = buildEpub({
    title: '边界',
    language: 'en',
    chapters: [
      { id: 'ch001', title: 'A', level: 1, html: '<p>a</p>' },
      { id: 'ch001', title: 'B', level: 3, html: '<p>b</p>' },
      { id: '第一章', title: 'C', level: 2, html: '<p>c</p>' },
      { id: '9lives', title: 'D', level: 1, html: '' },
    ],
  });
  const packed = unzipSync(bytes);
  const docs = Object.keys(packed).filter((name) => name.startsWith('OEBPS/text/'));
  eq(new Set(docs).size, 4, 'chapter documents are not unique');
  eq(docs.length, 4, 'every chapter must get exactly one document');
  const boundaryOpf = strFromU8(packed['OEBPS/content.opf']);
  const ids = [...boundaryOpf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]);
  eq(new Set(ids).size, ids.length, 'manifest ids are not unique');
  for (const id of ids) ok(/^[A-Za-z_][A-Za-z0-9._-]*$/.test(id), `manifest id "${id}" is not a valid NCName`);
  for (const item of parseOpf(boundaryOpf).items) ok(`OEBPS/${item.href}` in packed, `manifest href "${item.href}" has no entry`);
  ok(strFromU8(packed['OEBPS/nav.xhtml']).includes('Contents'), 'non-Chinese books should get an English nav heading');
});

check('invalid input is rejected', () => {
  const cases = [
    [undefined, /book must be an object/],
    [{}, /book\.title/],
    [{ title: 'x', chapters: [] }, /book\.chapters/],
    [{ title: 'x', chapters: [{ title: 'y' }], assets: [{ href: '../escape.png', mediaType: 'image/png', data: png }] }, /inside OEBPS/],
  ];
  for (const [input, pattern] of cases) {
    let message = null;
    try {
      buildEpub(input);
    } catch (error) {
      message = error.message;
    }
    ok(message !== null, `expected a thrown error for ${JSON.stringify(input && Object.keys(input))}`);
    ok(pattern.test(message), `error message does not match ${pattern}: ${message}`);
  }
});

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log('');
console.log(`sample: ${OUT_FILE}`);
console.log(`entries: ${names.length} | bytes: ${epub.length} | checks: ${checks} | failures: ${failures}`);

if (failures > 0) {
  console.error(`EPUB MODULE FAILED (${failures}/${checks} checks failed)`);
  process.exit(1);
}

console.log('EPUB MODULE OK');
