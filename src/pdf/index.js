/**
 * PDF reader built on mupdf 1.28.6 (WASM, ESM-only package).
 *
 * Confirmed API (from node_modules/mupdf/dist/mupdf.d.ts + runtime probe):
 *   mupdf.Document.openDocument(buf|path, magic?) -> Document; doc.countPages(): number
 *   doc.getMetaData(mupdf.Document.META_INFO_TITLE | META_INFO_AUTHOR): string|null
 *   doc.loadPage(i): Page; page.getBounds(): [x0,y0,x1,y1]
 *   page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false): Pixmap
 *   pixmap.asPNG(): Uint8Array; pixmap.getWidth()/getHeight()
 *   page.toStructuredText('preserve-whitespace'): StructuredText; st.asJSON(1); st.asText()
 * Note: WASM initialises synchronously on `import`, so no initWasm() call is needed.
 */

import fs from 'node:fs';
import * as mupdf from 'mupdf';

/** Hard cap on the longest rendered edge (px); larger pages are re-rendered down. */
const MAX_LONG_EDGE = 2200;
/** Below this many non-whitespace chars a page is treated as a scan (image only). */
const MIN_TEXT_CHARS = 20;
/** Structured-text extraction options; keeps intra-line spacing intact. */
const STEXT_OPTIONS = 'preserve-whitespace';

const { DeviceRGB } = mupdf.ColorSpace;

const CJK_RE =
  /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

/** Best-effort destroy for WASM-backed Userdata objects (never throws). */
function destroy(obj) {
  if (!obj) return;
  try {
    if (typeof obj.destroy === 'function') obj.destroy();
  } catch {
    /* ignore teardown errors: they must never mask the real failure */
  }
}

/** Copy a WASM-returned typed array into plain JS memory before the owner is freed. */
function toBytes(u8) {
  return u8 instanceof Uint8Array ? Uint8Array.from(u8) : new Uint8Array(u8 ?? []);
}

/** Rect may be [x0,y0,x1,y1] or {x0,y0,x1,y1}: normalise to numbers. */
function rectValues(rect) {
  if (!rect) return [0, 0, 0, 0];
  if (Array.isArray(rect) || ArrayBuffer.isView(rect)) {
    return [Number(rect[0]) || 0, Number(rect[1]) || 0, Number(rect[2]) || 0, Number(rect[3]) || 0];
  }
  return [
    Number(rect.x0 ?? rect.x ?? rect.left) || 0,
    Number(rect.y0 ?? rect.y ?? rect.top) || 0,
    Number(rect.x1 ?? (rect.x + rect.w) ?? rect.right) || 0,
    Number(rect.y1 ?? (rect.y + rect.h) ?? rect.bottom) || 0,
  ];
}

/** bbox from asJSON may be [x0,y0,x1,y1] or {x,y,w,h}: normalise to {x,y,w,h}. */
function bboxToBox(bbox) {
  if (!bbox) return { x: 0, y: 0, w: 0, h: 0 };
  if (Array.isArray(bbox) || ArrayBuffer.isView(bbox)) {
    const [x0, y0, x1, y1] = rectValues(bbox);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  const x = Number(bbox.x ?? bbox.left) || 0;
  const y = Number(bbox.y ?? bbox.top) || 0;
  const w = Number(bbox.w ?? bbox.width);
  const h = Number(bbox.h ?? bbox.height);
  if (Number.isFinite(w) && Number.isFinite(h)) return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
  const [x1, y1] = [Number(bbox.x1 ?? bbox.right), Number(bbox.y1 ?? bbox.bottom)];
  return { x, y, w: Math.max(0, (Number.isFinite(x1) ? x1 : x) - x), h: Math.max(0, (Number.isFinite(y1) ? y1 : y) - y) };
}

/**
 * Join two text segments taken from consecutive lines of the same block.
 * CJK adjacency: concat with no space. Everything else (Latin words, digits,
 * punctuation): one space. A trailing hyphen before a lowercase letter is a soft
 * hyphen and is removed.
 */
function joinText(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  const l = left[left.length - 1];
  const r = right[0];
  if ((l === '-' || l === '\u2010' || l === '\u00AD') && /[a-z]/.test(r)) {
    return left.slice(0, -1) + right;
  }
  if (CJK_RE.test(l) || CJK_RE.test(r)) return left + right;
  return `${left} ${right}`;
}

/** Collapse whitespace inside one line, but keep single spaces between words. */
function cleanLine(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .trim();
}

/** Extract the plain text of a JSON line/specimen node, whichever node shape it uses. */
function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string' && node.text) return node.text;
  if (Array.isArray(node.spans)) return node.spans.map(nodeText).join('');
  if (Array.isArray(node.chars)) return node.chars.map((c) => (typeof c === 'string' ? c : c?.c ?? '')).join('');
  return '';
}

/** Turn one stext JSON block into { text, box, type }. */
function blockFromJson(block) {
  const box = bboxToBox(block?.bbox);
  const type = typeof block?.type === 'string' ? block.type : 'text';
  let text = '';
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  for (const line of lines) {
    const lineText = cleanLine(nodeText(line) || nodeText(line?.spans?.[0]));
    if (!lineText) continue;
    text = joinText(text, lineText);
  }
  if (!text) text = cleanLine(nodeText(block));
  return { text, ...box, type };
}

/** Parse stext JSON defensively; hierarchical block shapes differ between mupdf builds. */
function blocksFromStructuredText(stext) {
  let parsed = null;
  try {
    parsed = JSON.parse(stext.asJSON(1));
  } catch {
    parsed = null;
  }
  const raw = Array.isArray(parsed?.blocks) ? parsed.blocks : Array.isArray(parsed) ? parsed : [];
  const blocks = [];
  for (const block of raw) {
    const entry = blockFromJson(block);
    if (entry.text || entry.type === 'image') blocks.push(entry);
  }
  if (!blocks.length) {
    const fallback = cleanLine(String(stext.asText?.() ?? ''));
    if (fallback) blocks.push({ text: fallback, x: 0, y: 0, w: 0, h: 0, type: 'text' });
  }
  return blocks;
}

/** Join blocks in reading order into the page's plain text (one line per block). */
function joinBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.text) parts.push(b.text);
  }
  return parts.join('\n');
}

function countSignificant(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/**
 * Open a PDF file and return a handle over it.
 * @param {string} filePath absolute or relative path to a .pdf file
 */
export async function openPdf(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('openPdf: filePath must be a non-empty string');
  }
  if (!fs.existsSync(filePath)) throw new Error(`PDF not found: ${filePath}`);

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new Error(`PDF not found: ${filePath} (${err?.message ?? err})`);
  }
  if (!stat.isFile()) throw new Error(`PDF not found: ${filePath} (not a regular file)`);

  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(`PDF not readable: ${filePath} (${err?.message ?? err})`);
  }

  let doc;
  try {
    doc = mupdf.Document.openDocument(data, 'application/pdf');
  } catch (err) {
    throw new Error(`Cannot open PDF: ${filePath} (${err?.message ?? err})`);
  }

  let closed = false;

  try {
    if (typeof doc.needsPassword === 'function' && doc.needsPassword()) {
      throw new Error(`PDF is password protected: ${filePath}`);
    }
    const pageCount = Number(doc.countPages()) || 0;
    if (!pageCount) throw new Error(`PDF has no pages: ${filePath}`);

    let boundsCache = null;

    /** Page size in points from page 0 (media box). */
    function pageBox() {
      if (boundsCache) return boundsCache;
      let page;
      try {
        page = doc.loadPage(0);
        const [x0, y0, x1, y1] = rectValues(page.getBounds());
        boundsCache = {
          pageWidth: Math.abs(x1 - x0) || 0,
          pageHeight: Math.abs(y1 - y0) || 0,
        };
      } catch {
        boundsCache = { pageWidth: 0, pageHeight: 0 };
      } finally {
        destroy(page);
      }
      return boundsCache;
    }

    function meta(key) {
      try {
        const value = doc.getMetaData(key);
        return value ? String(value) : undefined;
      } catch {
        return undefined;
      }
    }

    function assertOpen() {
      if (closed) throw new Error('PDF handle is closed');
    }

    function assertIndex(index) {
      assertOpen();
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= pageCount) {
        throw new RangeError(`Page index out of range: ${index} (pageCount=${pageCount})`);
      }
      return i;
    }

    /** Load a page and run `fn(page)` with guaranteed teardown. */
    function withPage(index, fn) {
      const i = assertIndex(index);
      let page;
      try {
        page = doc.loadPage(i);
        return fn(page, i);
      } finally {
        destroy(page);
      }
    }

    function extractPageTextDetailed(index) {
      return withPage(index, (page) => {
        let stext;
        try {
          stext = page.toStructuredText(STEXT_OPTIONS);
          const blocks = blocksFromStructuredText(stext);
          const text = joinBlocks(blocks);
          return { text, blocks, hasText: countSignificant(text) >= MIN_TEXT_CHARS };
        } finally {
          destroy(stext);
        }
      });
    }

    function extractPageText(index) {
      return withPage(index, (page) => {
        let stext;
        try {
          stext = page.toStructuredText(STEXT_OPTIONS);
          const blocks = blocksFromStructuredText(stext);
          const text = joinBlocks(blocks);
          return { text, blockCount: blocks.length };
        } finally {
          destroy(stext);
        }
      });
    }

    function renderPage(index, options = {}) {
      const requested = Number(options?.dpi ?? 150);
      const dpi = Number.isFinite(requested) && requested > 0 ? requested : 150;
      return withPage(index, (page) => {
        const render = (scale) => {
          let pixmap;
          try {
            const matrix = mupdf.Matrix.scale(scale, scale);
            pixmap = page.toPixmap(matrix, DeviceRGB, false);
            const width = pixmap.getWidth();
            const height = pixmap.getHeight();
            const png = toBytes(pixmap.asPNG());
            return { png, width, height, effectiveDpi: scale * 72 };
          } finally {
            destroy(pixmap);
          }
        };

        let scale = dpi / 72;
        let out = render(scale);
        const longest = Math.max(out.width, out.height);
        if (longest > MAX_LONG_EDGE) {
          // Re-render smaller instead of downscaling the bitmap in JS.
          const shrunk = scale * (MAX_LONG_EDGE / longest);
          if (shrunk > 0 && shrunk < scale) {
            scale = shrunk;
            out = render(scale);
          }
        }
        return {
          png: out.png,
          width: out.width,
          height: out.height,
          dpi: Math.round(out.effectiveDpi * 100) / 100,
        };
      });
    }

    const handle = {
      filePath,
      pageCount,
      info() {
        assertOpen();
        const box = pageBox();
        return {
          title: meta(mupdf.Document.META_INFO_TITLE),
          author: meta(mupdf.Document.META_INFO_AUTHOR),
          pageWidth: box.pageWidth,
          pageHeight: box.pageHeight,
        };
      },
      renderPage,
      extractPageText,
      extractPageTextDetailed,
      close() {
        if (closed) return;
        closed = true;
        destroy(doc);
      },
    };

    return handle;
  } catch (err) {
    closed = true;
    destroy(doc);
    throw err;
  }
}

export default openPdf;
