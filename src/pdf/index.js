/**
 * PDF reader built on mupdf 1.28.6 (WASM, ESM-only package).
 *
 * Confirmed API (from node_modules/mupdf/dist/mupdf.d.ts + runtime probe):
 *   mupdf.Document.openDocument(buf|path, magic?) -> Document; doc.countPages(): number
 *   doc.getMetaData(mupdf.Document.META_INFO_TITLE | META_INFO_AUTHOR): string|null
 *   doc.loadPage(i): Page; page.getBounds(): [x0,y0,x1,y1]
 *   page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false): Pixmap
 *   page.run(mupdf.DrawDevice(matrix, pixmap), matrix): void
 *   new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x0,y0,x1,y1], alpha): Pixmap
 *   mupdf.Matrix.concat(one, two): Matrix   (applies `one` first, then `two`)
 *   pixmap.asPNG(): Uint8Array; pixmap.getWidth()/getHeight()
 *   pixmap.getStride() / getNumberOfComponents() / getAlpha() / getPixels(): Uint8ClampedArray
 *   page.toPixmap(m, mupdf.ColorSpace.DeviceGray, false): Pixmap  (1 byte per pixel)
 *   page.toStructuredText('preserve-whitespace'): StructuredText; st.asJSON(1); st.asText()
 * Note: WASM initialises synchronously on `import`, so no initWasm() call is needed.
 */

import fs from 'node:fs';
import * as mupdf from 'mupdf';

/** Hard cap on the longest rendered edge (px); larger pages are re-rendered down. */
const MAX_LONG_EDGE = 2200;
/**
 * Hard cap on the longest edge of a cropped figure (px). An illustration is
 * shown at a fraction of the page width, so full-page resolution would only
 * bloat the EPUB without adding visible detail.
 */
const MAX_CROP_LONG_EDGE = 1600;
/** Default render DPI for a cropped figure: one notch above the page render. */
const DEFAULT_FIGURE_DPI = 200;
/** Below this many non-whitespace chars a page is treated as a scan (image only). */
const MIN_TEXT_CHARS = 20;
/** Structured-text extraction options; keeps intra-line spacing intact. */
const STEXT_OPTIONS = 'preserve-whitespace';
/**
 * Render DPI for {@link pageInkRatio}.
 *
 * The question that measurement answers is only "is anything printed on this
 * page at all", so a coarse render is enough and a full-resolution one would
 * make a blank-page check cost as much as the transcription render. At 36 dpi an
 * A4 page is about 298x421 pixels (~125k), which is cheap to sample and still
 * resolves a line of body text as a visible share of the page.
 */
const INK_DPI = 36;
/**
 * A sample darker than this on any colour channel is ink, not paper.
 *
 * Slightly below pure white on purpose: anti-aliased glyph edges and a JPEG
 * scan's paper tone land between the two, and a page that is *nearly* white is
 * blank for this purpose. The caller decides how much ink makes a page non-blank
 * (see `BLANK_PAGE_INK_RATIO` in `src/pipeline.js`).
 */
const INK_WHITE_CUTOFF = 250;

const { DeviceGray, DeviceRGB } = mupdf.ColorSpace;

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
 * Validate a normalised crop box and return its four corners.
 *
 * The renderer refuses a bad box instead of rendering a guess: a silently
 * clamped region would embed the wrong slice of the page as an illustration,
 * which is worse than the caption-only fallback the pipeline takes when this
 * throws.
 *
 * @param {unknown} bbox - `[x0, y0, x1, y1]`, normalised 0..1 against the page image.
 * @returns {[number, number, number, number]} the same four numbers.
 * @throws {Error} when the box is not four finite numbers in 0..1 with a positive area.
 */
function cropValues(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error(`cropRegion: bbox must be [x0,y0,x1,y1] (got ${JSON.stringify(bbox)})`);
  }
  if (!bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`cropRegion: bbox entries must be finite numbers (got ${JSON.stringify(bbox)})`);
  }
  const [x0, y0, x1, y1] = bbox;
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1) {
    throw new Error(`cropRegion: bbox must stay inside the page, 0..1 (got ${JSON.stringify(bbox)})`);
  }
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(`cropRegion: bbox has no area (got ${JSON.stringify(bbox)})`);
  }
  return [x0, y0, x1, y1];
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

    /**
     * Render one region of a page, cropped by coordinates instead of by copying
     * pixels out of a full-page bitmap.
     *
     * The model reports a figure box normalised to the page image, with the
     * origin at its top-left. `page.getBounds()` is the page box in points in
     * that same top-left orientation, so the box maps to page points as
     * `rx0 = bx0 + bbox[0] * (bx1 - bx0)` and likewise for y. The render
     * transform must send `(rx0, ry0)` to output pixel `(0, 0)` and
     * `(rx1, ry1)` to `(scale*(rx1-rx0), scale*(ry1-ry0))`, i.e. translate the
     * region origin to zero, then scale. MuPDF matrices are `[a,b,c,d,e,f]`
     * with `x' = a*x + c*y + e`, `y' = b*x + d*y + f`, and
     * `Matrix.concat(one, two)` applies `one` first and then `two` (confirmed
     * against the declared signature in `mupdf.d.ts` and probed at runtime:
     * `concat(translate(10,20), scale(2,3))` is `[2,0,0,3,20,60]`). The matrix
     * is therefore:
     *
     *     Matrix.concat(Matrix.translate(-rx0, -ry0), Matrix.scale(s, s))
     *     = [s, 0, 0, s, -s*rx0, -s*ry0]
     *
     * The pixmap is allocated at exactly the crop size and `DrawDevice` clips
     * drawing to it, so the renderer never allocates (or hands back) a full
     * page bitmap that JS would then have to slice. `DrawDevice` itself is
     * built with the identity matrix on purpose: `page.run(device, matrix)`
     * already maps page space to output pixels, and passing the same matrix to
     * the device applies it twice (a probed 100x100 region then came out at a
     * quarter of the expected fill).
     *
     * @param {number} index - 0-based page index.
     * @param {[number, number, number, number]} bbox - normalised crop box.
     * @param {{ dpi?: number }} [options] - render DPI (default 200, capped by the 1600px long edge).
     * @returns {Promise<{ png: Uint8Array, width: number, height: number }>} PNG bytes and pixel size.
     * @throws {Error} when the box is invalid, the page cannot be loaded or the render fails.
     */
    async function cropRegion(index, bbox, options = {}) {
      const [x0, y0, x1, y1] = cropValues(bbox);
      const requested = Number(options?.dpi ?? DEFAULT_FIGURE_DPI);
      const dpi = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_FIGURE_DPI;
      // Resolve the index before loading anything: an out-of-range page is a
      // RangeError from `withPage`, exactly as `renderPage` reports it.
      return withPage(index, (page) => {
        let pixmap;
        let device;
        try {
          const [bx0, by0, bx1, by1] = rectValues(page.getBounds());
          const pageWidth = bx1 - bx0;
          const pageHeight = by1 - by0;
          if (!(pageWidth > 0) || !(pageHeight > 0)) {
            throw new Error(`page ${index + 1} has no usable bounds`);
          }
          const rx0 = bx0 + x0 * pageWidth;
          const ry0 = by0 + y0 * pageHeight;
          const regionWidth = (x1 - x0) * pageWidth;
          const regionHeight = (y1 - y0) * pageHeight;

          let scale = dpi / 72;
          let width = Math.max(1, Math.round(regionWidth * scale));
          let height = Math.max(1, Math.round(regionHeight * scale));
          const longest = Math.max(width, height);
          if (longest > MAX_CROP_LONG_EDGE) {
            scale *= MAX_CROP_LONG_EDGE / longest;
            width = Math.max(1, Math.round(regionWidth * scale));
            height = Math.max(1, Math.round(regionHeight * scale));
          }

          const matrix = mupdf.Matrix.concat(
            mupdf.Matrix.translate(-rx0, -ry0),
            mupdf.Matrix.scale(scale, scale),
          );
          pixmap = new mupdf.Pixmap(DeviceRGB, [0, 0, width, height], false);
          // The page image may not cover the whole requested box (margins), so
          // start from a white sheet rather than uninitialised WASM memory.
          pixmap.clear(255);
          device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
          page.run(device, matrix);
          device.close();
          const png = toBytes(pixmap.asPNG());
          if (png.length === 0) throw new Error('renderer produced an empty PNG');
          return { png, width: pixmap.getWidth(), height: pixmap.getHeight() };
        } catch (err) {
          if (err instanceof RangeError) throw err;
          throw new Error(`Cannot crop page ${index + 1} region ${JSON.stringify(bbox)}: ${err?.message ?? err}`);
        } finally {
          destroy(device);
          destroy(pixmap);
        }
      });
    }

    /**
     * Share of one page's pixels that carry ink, in `0..1`.
     *
     * A vision model that answers a page with zero blocks is either right (the
     * page really is blank) or wrong (a scan it could not read); the pipeline
     * cannot tell the two apart from the reply alone, and treating a truly blank
     * page as a failed page makes every later run pay for it again. This method
     * supplies the missing evidence: it re-renders the page at {@link INK_DPI}
     * and counts the samples that are not paper white. A truly blank page
     * measures 0 (an empty content stream draws nothing, so the pixmap keeps the
     * white MuPDF clears it with), a page with one line of text measures a couple
     * of percent.
     *
     * The pixmap is requested as `DeviceGray`, one byte per pixel: colour is
     * irrelevant to "is there ink", and a grey target lets MuPDF expand whatever
     * the page contains into a well-defined sample. That expansion is also what
     * makes a 1-bit (black/white) image - a common plate or mask in a scanned book
     * - measure correctly: the content stream's 1-bit samples are rendered as 0
     * and 255 in the grey pixmap rather than being read back as packed bits. The
     * generic loop below then covers the one-component grey pixmap as well as the
     * RGB/RGBA shapes a different MuPDF build could hand back.
     *
     * Sampling goes through `Pixmap.getPixels()` (`Uint8ClampedArray`),
     * `getStride()` and `getNumberOfComponents()` as declared in
     * `mupdf.d.ts`; the stride is respected instead of assuming
     * `width * components`, and any alpha component is excluded so a transparent
     * sample cannot be mistaken for dark ink.
     *
     * @param {number} index - 0-based page index.
     * @returns {number} ink share in `0..1` (`0` for a page that renders to paper).
     * @throws {RangeError} for an out-of-range page index, like every other reader.
     * @throws {Error} when the page cannot be loaded or rendered.
     */
    function pageInkRatio(index) {
      return withPage(index, (page) => {
        let pixmap;
        try {
          const scale = INK_DPI / 72;
          pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), DeviceGray, false);
          const width = pixmap.getWidth();
          const height = pixmap.getHeight();
          if (!(width > 0) || !(height > 0)) return 0;
          const stride = pixmap.getStride();
          const components = Math.max(1, Number(pixmap.getNumberOfComponents()) || 1);
          const alpha = Number(pixmap.getAlpha()) > 0 ? 1 : 0;
          const channels = Math.max(1, components - alpha);
          const pixels = pixmap.getPixels();
          let ink = 0;
          for (let y = 0; y < height; y += 1) {
            const row = y * stride;
            for (let x = 0; x < width; x += 1) {
              const at = row + x * components;
              // Ink means "at least one colour channel is not paper white". With
              // the DeviceGray render that is the single sample; the loop also
              // handles the RGB(A) shape defensively.
              for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
                if (pixels[at + channel] < INK_WHITE_CUTOFF) { ink += 1; break; }
              }
            }
          }
          return ink / (width * height);
        } finally {
          destroy(pixmap);
        }
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
      pageInkRatio,
      cropRegion,
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
