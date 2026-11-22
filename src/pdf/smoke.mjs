/**
 * Smoke test for src/pdf/index.js.
 * Builds a minimal, spec-valid one-page PDF by hand (Helvetica, "Hello PDF2EPUB"),
 * then exercises openPdf / info / renderPage / extractPageText /
 * extractPageTextDetailed. Run: node src/pdf/smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPdf } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../../.out');
const PDF_PATH = path.join(OUT_DIR, 'test.pdf');
const PNG_PATH = path.join(OUT_DIR, 'page-1.png');
const LONG_PDF_PATH = path.join(OUT_DIR, 'test-long.pdf');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Build a valid single-page PDF with a correctly computed xref table. */
function buildSinglePagePdf(lines = ['Hello PDF2EPUB']) {
  const pdfString = (s) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
  const content = lines
    .map((line, i) => `BT /F1 24 Tf 72 ${700 - i * 40} Td ${pdfString(line)} Tj ET`)
    .join('\n')
    .concat('\n');
  const objects = [
    null, // object 0 is the free head, never written
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = new Array(objects.length).fill(0);

  for (let n = 1; n < objects.length; n += 1) {
    const body = Buffer.from(`${n} 0 obj\n${objects[n]}\nendobj\n`, 'latin1');
    offsets[n] = offset;
    parts.push(body);
    offset += body.length;
  }

  const xrefOffset = offset;
  // Every xref entry is exactly 20 bytes: 10 offset + space + 5 gen + space + type + CRLF.
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < objects.length; n += 1) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}

function check(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function hasPngMagic(bytes) {
  return PNG_MAGIC.every((byte, i) => bytes[i] === byte);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pdf = buildSinglePagePdf();
  fs.writeFileSync(PDF_PATH, pdf);
  console.log(`wrote ${PDF_PATH} (${pdf.length} bytes)`);

  const handle = await openPdf(PDF_PATH);
  try {
    // 1. page count
    check(handle.pageCount === 1, `pageCount should be 1, got ${handle.pageCount}`);
    console.log(`pageCount: ${handle.pageCount}`);

    const info = handle.info();
    console.log(`info: ${JSON.stringify(info)}`);
    check(info.pageWidth > 0 && info.pageHeight > 0, 'info() page size must be positive');

    // 2. render
    const rendered = handle.renderPage(0, { dpi: 150 });
    check(hasPngMagic(rendered.png), `PNG magic missing, got [${Array.from(rendered.png.slice(0, 8)).join(',')}]`);
    check(rendered.width > 100 && rendered.height > 100, `rendered size too small: ${rendered.width}x${rendered.height}`);
    fs.writeFileSync(PNG_PATH, Buffer.from(rendered.png));
    console.log(
      `renderPage(0,{dpi:150}): ${rendered.width}x${rendered.height} dpi=${rendered.dpi} `
        + `png=${rendered.png.length}B -> ${PNG_PATH}`,
    );

    // 3. plain text
    const plain = handle.extractPageText(0);
    console.log(`extractPageText(0): blockCount=${plain.blockCount} text=${JSON.stringify(plain.text)}`);

    // 4. detailed text + hasText gate
    const detailed = handle.extractPageTextDetailed(0);
    console.log(
      `extractPageTextDetailed(0): hasText=${detailed.hasText} blocks=${detailed.blocks.length} `
        + `first=${JSON.stringify(detailed.blocks[0] ?? null)}`,
    );

    if (detailed.hasText) {
      check(detailed.text.includes('Hello'), `detailed text should contain "Hello", got ${JSON.stringify(detailed.text)}`);
      check(plain.text.includes('Hello'), `text should contain "Hello", got ${JSON.stringify(plain.text)}`);
      console.log('text assertion: OK ("Hello" found)');
    } else {
      const reason = String(plain.text ?? '').replace(/\s+/g, '').length < 20
        ? `extracted only ${String(plain.text ?? '').trim().length} non-space chars — looks like a scan/no text layer`
        : 'page reported no usable text layer';
      console.log(`text assertion: SKIPPED (hasText=false) — reason: ${reason}`);
      console.log(`  raw text was: ${JSON.stringify(plain.text)}`);
    }

    // 4b. high dpi must be capped at 2200px on the long edge
    const capped = handle.renderPage(0, { dpi: 300 });
    const longEdge = Math.max(capped.width, capped.height);
    check(longEdge <= 2200, `long edge ${longEdge}px exceeds the 2200px cap`);
    check(capped.dpi < 300, `dpi should drop below 300 when capped, got ${capped.dpi}`);
    console.log(`dpi cap: requested 300 -> ${capped.dpi} (${capped.width}x${capped.height})`);

    // 4c. a page carrying a real text layer (>= 20 chars) must report hasText=true
    fs.writeFileSync(
      LONG_PDF_PATH,
      buildSinglePagePdf(['DeepSeek Harness PDF reader smoke test.', 'The quick brown fox jumps over the lazy dog.']),
    );
    const longHandle = await openPdf(LONG_PDF_PATH);
    try {
      const detailedLong = longHandle.extractPageTextDetailed(0);
      const plainLong = longHandle.extractPageText(0);
      check(detailedLong.hasText === true, `long text page must report hasText=true, got ${detailedLong.hasText}`);
      check(/quick brown fox/i.test(detailedLong.text), `long text mismatch: ${JSON.stringify(detailedLong.text)}`);
      check(detailedLong.blocks.length >= 1, 'long text page must produce at least one block');
      console.log(
        `hasText=true path: blocks=${plainLong.blockCount} text=${JSON.stringify(plainLong.text)}`,
      );
    } finally {
      longHandle.close();
    }

    // 5. error contract
    let missingThrew = false;
    try {
      await openPdf(path.join(OUT_DIR, 'does-not-exist.pdf'));
    } catch (err) {
      missingThrew = /^PDF not found: /.test(err.message);
    }
    check(missingThrew, 'missing file must throw Error("PDF not found: ...")');
    console.log('missing-file contract: OK');

    let rangeThrew = false;
    try {
      handle.renderPage(1);
    } catch (err) {
      rangeThrew = err instanceof RangeError;
    }
    check(rangeThrew, 'out-of-range page index must throw RangeError');
    console.log('range contract: OK');

    check(hasPngMagic(fs.readFileSync(PNG_PATH)), 'saved PNG on disk lost its magic bytes');
  } finally {
    handle.close();
    handle.close(); // must be idempotent
  }

  console.log('PDF MODULE OK');
}

main().catch((err) => {
  console.error(`PDF MODULE FAILED: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
