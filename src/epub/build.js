/**
 * EPUB 3.0 assembly for dsh-pdf2epub.
 *
 * Public API:
 *   buildEpub(book)                -> Uint8Array
 *   sanitizeXmlText(value)         -> string     (XML 1.0 code-point scrubber)
 *   validateChapterHtml(html, opt) -> {scripted}
 *
 * The archive layout is fixed:
 *
 *   mimetype                     (first entry, STORED, application/epub+zip)
 *   META-INF/container.xml       (-> OEBPS/content.opf)
 *   OEBPS/content.opf            (EPUB 3 package document, nav in manifest)
 *   OEBPS/nav.xhtml              (<nav epub:type="toc">, nested by chapter level)
 *   OEBPS/styles/book.css        (DEFAULT_CSS or book.css)
 *   OEBPS/text/<id>.xhtml        (one XHTML5 document per chapter)
 *   OEBPS/<asset path>           (cover image + assets, bytes written verbatim)
 *
 * Reproducibility: `dcterms:modified` falls back to a fixed timestamp and every
 * zip entry gets one fixed, locally-constructed mtime, so two builds of the
 * same book (with an explicit `identifier`) are byte-identical — in any time
 * zone. Only the auto-generated `urn:uuid:` identifier is random, as required
 * by the contract. A caller that wants a *real* modification date (the pipeline
 * does) passes `book.modified` as a `Date` or an ISO 8601 string; the value is
 * kept to the second and normalised to `YYYY-MM-DDThh:mm:ssZ`.
 *
 * Hardening (see docs/review-epub.md):
 *   S1  ZIP_MTIME is built from local date parts, so it encodes the same DOS
 *       timestamp on every host and can never leave 1980..2099.
 *   S2  every XML text node / attribute value is passed through
 *       `sanitizeXmlText`; illegal code points are deleted, never escaped.
 *   M1  `chapter.html` is validated and a bad fragment throws; caller HTML is
 *       still inserted verbatim (no silent rewriting).
 *   M2  hrefs are validated, percent-encoded for the OPF and kept decoded for
 *       the zip entry name, so manifest and archive cannot disagree.
 *   M3  entry names are capped at 200 UTF-8 bytes and Windows device names are
 *       rejected with an explicit error.
 *   M4  `language` must look like a BCP-47 tag.
 *   M5  `coverImage.mediaType` must be an image type.
 *
 * Not written on purpose: META-INF/encryption.xml, META-INF/signatures.xml,
 * any DRM, and any font file (see ./css.js).
 */

import { strToU8, zipSync } from 'fflate';
import { DEFAULT_CSS } from './css.js';

/** Value of the uncompressed `mimetype` entry. */
export const EPUB_MIMETYPE = 'application/epub+zip';
/**
 * Fallback for `dcterms:modified` when `book.modified` is absent.
 *
 * The fixed epoch, not the wall clock: a build with an explicit `identifier` is
 * byte-reproducible only if every metadata field is, and a caller that wants the
 * real date (the EPUB pipeline passes the source file's mtime) supplies it. The
 * OPF therefore never claims the book was modified in 1970 *unless* the caller
 * asked for no date at all.
 */
export const DEFAULT_MODIFIED = '1970-01-01T00:00:00Z';
/** Fallback language when the caller omits it (Chinese-first module). */
export const DEFAULT_LANGUAGE = 'zh-CN';
/** Longest zip entry name accepted, in UTF-8 bytes. */
export const MAX_ENTRY_NAME_BYTES = 200;

/**
 * Fixed DOS-representable mtime for every entry (zip cannot store pre-1980).
 *
 * Built from LOCAL date parts on purpose. fflate encodes the DOS timestamp
 * through the local getters (`getFullYear()`, `getMonth()`, ...) and throws
 * "date not in range 1980-2099" when the local year falls outside 1980..2099:
 *
 *   - `new Date('1980-01-01T00:00:00Z')` is still 1979-12-31 on locally in
 *     every negative-offset zone (the whole Americas), so `buildEpub` threw on
 *     those hosts for every book (review S1);
 *   - `new Date(2000, 0, 1, 0, 0, 0)` reads 2000-01-01T00:00:00 locally in
 *     *every* zone, because the components are local ones, so the DOS fields —
 *     and with them the archive bytes — are identical everywhere as well.
 *
 * 2000 sits 20 years away from both ends of the DOS range, far enough that no
 * UTC offset (or historical local-mean-time offset) can push the local year
 * out of bounds.
 */
export const ZIP_MTIME = createZipMtime();

const OEBPS = 'OEBPS';
const XHTML_TYPE = 'application/xhtml+xml';
const CSS_TYPE = 'text/css';
const TEXT_DIR = `${OEBPS}/text/`;
const STYLESHEET_HREF = 'styles/book.css';
const XHTML_STYLESHEET_HREF = '../styles/book.css';

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const EPUB_NS = 'http://www.idpf.org/2007/ops';
const OPF_NS = 'http://www.idpf.org/2007/opf';
const DC_NS = 'http://purl.org/dc/elements/1.1/';

/* ------------------------------------------------------------------ *
 * XML 1.0 character classes
 * ------------------------------------------------------------------ */

// XML 1.0 §2.2:  Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD]
//                       | [#x10000-#x10FFFF]
// Everything else — the C0 controls except tab/LF/CR, U+FFFE/U+FFFF and lone
// surrogates — cannot appear in a document at all, not even as a character
// reference, so it has to be deleted before serialization (review S2).
const XML_ILLEGAL_BMP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const XML_ILLEGAL_BMP_ALL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
// A valid surrogate pair matches as a pair; a stray surrogate matches alone.
const XML_SURROGATE_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

const BCP47_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/;
const WINDOWS_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const HREF_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HREF_CONTROL_RE = /[\u0000-\u001F\u007F]/;
// Chapter fragments: active content and bare ampersands (review M1).
const ACTIVE_TAG_RE = /<\s*(script|iframe|object|embed)\b/i;
const INLINE_HANDLER_RE = /[\s"'/]on[a-z0-9_-]+\s*=/i;
const SCRIPT_URL_RE = /(?:href|src)\s*=\s*["']?\s*javascript:/i;
// Attribute checks are scoped to element tags: prose that merely *mentions*
// `onload =` inside a paragraph is text, not an inline handler.
const TAG_SCAN_RE = /<[^>]*>/g;
// A character reference (or a predefined entity) matches as a whole; a bare "&"
// matches alone, and so does an entity XML does not predefine (`&nbsp;`), which
// an XHTML content document cannot resolve without a DTD.
const AMP_SCAN_RE = /&(?:(?:amp|lt|gt|quot|apos)|#(?:[0-9]+|x[0-9A-Fa-f]+));|&/g;
const NAMED_ENTITY_RE = /^&([A-Za-z][A-Za-z0-9._-]*);/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EPUB_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const MEDIA_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.css', 'text/css'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'video/mp4'],
]);

/* ------------------------------------------------------------------ *
 * public entry point
 * ------------------------------------------------------------------ */

/**
 * Assemble a complete EPUB 3 archive in memory.
 *
 * @param {object} book see ../docs/epub-module.md for the full shape
 * @returns {Uint8Array} the zip bytes
 */
export function buildEpub(book) {
  const model = normalizeBook(book);

  // Paths that are always generated; assets may not shadow them.
  const reserved = new Set([
    'mimetype',
    'META-INF/container.xml',
    `${OEBPS}/content.opf`,
    `${OEBPS}/nav.xhtml`,
    `${OEBPS}/${STYLESHEET_HREF}`,
  ]);
  const usedIds = new Set(['nav', 'style']);

  // --- chapters: manifest id + text/<stem>.xhtml (verbatim id when safe) ---
  // Ids are claimed after the cover items so that cover-page / cover-image stay
  // stable instead of being bumped by a chapter that happens to want them.
  const chapterPlans = model.chapters.map((chapter) => {
    const stem = safeFileStem(chapter.idHint, `chapter-${chapter.index + 1}`);
    const path = claimPath(reserved, `${TEXT_DIR}${stem}.xhtml`);
    assertEntryName(path, `book.chapters[${chapter.index}].id`);
    return {
      chapter,
      id: null,
      path,
      href: path.slice(OEBPS.length + 1),
      title: chapter.title,
      level: chapter.level,
      scripted: chapter.scripted,
    };
  });

  // --- cover image (reuses an asset with the same href, if any) ---
  const coverSource = model.cover
    ? model.assets.find((asset) => asset.entry === model.cover.entry) ?? model.cover
    : null;
  let coverImage = null;

  if (coverSource) {
    const sharedAsset = coverSource !== model.cover;
    // M5: a `cover-image` manifest item must be an image. The shared-asset
    // branch takes its media type from the asset list, so check it there too.
    if (sharedAsset && !isImageMediaType(coverSource.mediaType)) {
      throw new Error(
        `[pdf2epub/epub] book.coverImage.href "${coverSource.href}" is also listed in book.assets `
          + `with the non-image media type "${coverSource.mediaType}"`,
      );
    }
    coverImage = {
      id: null,
      entry: coverSource.entry,
      href: coverSource.href,
      mediaType: coverSource.mediaType,
      data: coverSource.data,
      sharedAsset,
      path: `${OEBPS}/${coverSource.entry}`,
    };
    if (!sharedAsset) {
      if (reserved.has(coverImage.path)) {
        throw new Error(
          `[pdf2epub/epub] coverImage.href collides with a generated file: ${coverSource.href}`,
        );
      }
      reserved.add(coverImage.path);
    }
    coverImage.id = sharedAsset
      ? null // filled in once the asset plan exists
      : claimId(usedIds, 'cover-image');
  }

  // --- optional dedicated cover page ---
  let coverPage = null;
  if (coverImage) {
    const path = claimPath(reserved, `${TEXT_DIR}cover.xhtml`);
    coverPage = {
      id: claimId(usedIds, 'cover-page'),
      path,
      href: path.slice(OEBPS.length + 1),
    };
  }

  // --- chapter manifest ids ---
  for (const plan of chapterPlans) {
    plan.id = claimId(
      usedIds,
      safeXmlId(plan.chapter.idHint, `chapter-${plan.chapter.index + 1}`),
    );
  }

  // --- assets ---
  const assetItems = model.assets.map((asset) => {
    const path = `${OEBPS}/${asset.entry}`;
    if (reserved.has(path)) {
      throw new Error(
        `[pdf2epub/epub] asset href collides with another generated file: ${asset.href}`,
      );
    }
    reserved.add(path);
    const isCover = coverImage !== null && coverImage.sharedAsset && asset.entry === coverImage.entry;
    const item = {
      id: isCover
        ? claimId(usedIds, 'cover-image')
        : claimId(usedIds, safeXmlId(asset.idHint, `asset-${asset.index + 1}`)),
      href: asset.href,
      mediaType: asset.mediaType,
      data: asset.data,
      path,
      properties: isCover ? 'cover-image' : '',
      isCover,
    };
    if (isCover) coverImage.id = item.id;
    return item;
  });

  // --- manifest / spine ---
  const manifest = [
    { id: 'nav', href: 'nav.xhtml', mediaType: XHTML_TYPE, properties: 'nav' },
    { id: 'style', href: STYLESHEET_HREF, mediaType: CSS_TYPE, properties: '' },
  ];

  if (coverImage && !coverImage.sharedAsset) {
    manifest.push({
      id: coverImage.id,
      href: coverImage.href,
      mediaType: coverImage.mediaType,
      properties: 'cover-image',
    });
  }
  if (coverPage) {
    manifest.push({
      id: coverPage.id,
      href: coverPage.href,
      mediaType: XHTML_TYPE,
      properties: '',
    });
  }
  for (const plan of chapterPlans) {
    // EPUB 3.3 requires scripted documents to say so in the manifest.
    manifest.push({
      id: plan.id,
      href: plan.href,
      mediaType: XHTML_TYPE,
      properties: plan.scripted ? 'scripted' : '',
    });
  }
  for (const asset of assetItems) {
    manifest.push({
      id: asset.id,
      href: asset.href,
      mediaType: asset.mediaType,
      properties: asset.properties,
    });
  }

  const spine = [];
  if (coverPage) spine.push({ idref: coverPage.id });
  for (const plan of chapterPlans) spine.push({ idref: plan.id });

  // --- documents ---
  const tocTree = buildTocTree(chapterPlans);
  const containerXml = buildContainerXml();
  const contentOpf = buildContentOpf(model, manifest, spine);
  const navXhtml = buildNavXhtml(model, tocTree);

  // --- zip: insertion order is write order, mimetype must come first ---
  const entries = {};
  const written = new Set();

  entries.mimetype = [strToU8(EPUB_MIMETYPE), { level: 0 }];
  written.add('mimetype');

  const write = (path, bytes) => {
    if (written.has(path)) {
      throw new Error(`[pdf2epub/epub] duplicate zip entry: ${path}`);
    }
    if (path.startsWith('/')) {
      throw new Error(`[pdf2epub/epub] zip entry must not be absolute: ${path}`);
    }
    assertEntryName(path, 'buildEpub');
    written.add(path);
    entries[path] = bytes;
  };

  write('META-INF/container.xml', strToU8(containerXml));
  write(`${OEBPS}/content.opf`, strToU8(contentOpf));
  write(`${OEBPS}/nav.xhtml`, strToU8(navXhtml));
  write(`${OEBPS}/${STYLESHEET_HREF}`, strToU8(model.css));

  if (coverPage) write(coverPage.path, strToU8(buildCoverXhtml(model, coverImage)));

  for (const plan of chapterPlans) {
    write(plan.path, strToU8(buildChapterXhtml(model, plan.chapter)));
  }

  if (coverImage && !coverImage.sharedAsset) write(coverImage.path, coverImage.data);
  for (const asset of assetItems) write(asset.path, asset.data);

  return zipSync(entries, { level: 6, mtime: ZIP_MTIME });
}

/* ------------------------------------------------------------------ *
 * XML sanitizing + chapter fragment validation
 * ------------------------------------------------------------------ */

/** `U+0000` style label for a single character. */
function describeCodePoint(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** First XML-1.0-illegal code point in `text`, or null. */
function findIllegalXmlChar(text) {
  const bmp = XML_ILLEGAL_BMP_RE.exec(text);
  if (bmp !== null) return bmp[0];
  for (const match of text.matchAll(XML_SURROGATE_RE)) {
    if (match[0].length === 1) return match[0];
  }
  return null;
}

/**
 * Delete the code points XML 1.0 forbids (review S2).
 *
 * Deleted, not replaced: `?` or U+FFFD would silently change a book title, and
 * a control character carries no reading value anyway. Exported so the
 * pipeline can clean inputs (PDF metadata, model replies) with the same rules.
 *
 * @param {unknown} value - anything; non-strings are stringified, null/undefined
 *   become the empty string.
 * @returns {string} `value` without XML 1.0 illegal code points.
 */
export function sanitizeXmlText(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  return text
    .replace(XML_SURROGATE_RE, (match) => (match.length === 2 ? match : ''))
    .replace(XML_ILLEGAL_BMP_ALL_RE, '');
}

/**
 * Validate a caller-supplied XHTML body fragment (review M1).
 *
 * This is a fail-fast check, never a sanitizer: a bad fragment throws instead
 * of being silently rewritten. It rejects what would either break the XML
 * document or become live active content inside the EPUB:
 *
 *   - XML 1.0 illegal code points (the .xhtml would be unparseable);
 *   - a bare `&`, or a named entity XML does not predefine (`&nbsp;`): neither
 *     is resolvable in an XHTML content document, which is XML, not HTML;
 *   - `<script>`, `<iframe>`, `<object>`, `<embed>` and inline `on*=` handlers;
 *   - `javascript:` URLs in `href`/`src`.
 *
 * Attribute checks are scoped to element tags, so prose that merely mentions
 * `onclick =` stays legal (it is text, not a handler).
 *
 * It does NOT check tag balance or nesting: doing that reliably needs a real
 * parser, and a regexp pretending to would reject valid fragments. The caller
 * that generates the markup still owns its well-formedness (see
 * ../src/model/assemble.js, which escapes every text node).
 *
 * @param {string} html - XHTML body fragment.
 * @param {{allowScripts?: boolean, label?: string}} [options]
 *   `allowScripts: true` accepts active content; the returned `scripted` flag
 *   is then used to add `properties="scripted"` to the manifest item.
 * @returns {{scripted: boolean}} whether the fragment carries active content.
 */
export function validateChapterHtml(html, options = {}) {
  const label = options.label ?? 'chapter.html';
  const allowScripts = options.allowScripts === true;
  const text = typeof html === 'string' ? html : '';

  const illegal = findIllegalXmlChar(text);
  if (illegal !== null) {
    throw new Error(
      `[pdf2epub/epub] ${label} contains ${describeCodePoint(illegal)}, which XML 1.0 forbids; `
        + 'remove it before calling buildEpub (it cannot be represented, not even as an entity)',
    );
  }

  for (const match of text.matchAll(AMP_SCAN_RE)) {
    if (match[0].length > 1) continue; // a well-formed reference
    const named = NAMED_ENTITY_RE.exec(text.slice(match.index, match.index + 40));
    if (named !== null) {
      throw new Error(
        `[pdf2epub/epub] ${label} uses ${JSON.stringify(`&${named[1]};`)} at offset ${match.index}, which XML does `
          + 'not predefine: an XHTML content document is XML, so only &amp; &lt; &gt; &quot; &apos; and numeric '
          + 'character references survive a strict parse (use e.g. "&#160;" for a non-breaking space)',
      );
    }
    throw new Error(
      `[pdf2epub/epub] ${label} has a bare "&" at offset ${match.index}: `
        + 'write "&amp;" for a literal ampersand, the fragment must be well-formed XML',
    );
  }

  const tag = ACTIVE_TAG_RE.exec(text);
  const active = findActiveAttribute(text);
  const scripted = tag !== null || active !== null;

  if (scripted && !allowScripts) {
    if (tag !== null) {
      throw new Error(
        `[pdf2epub/epub] ${label} embeds <${tag[1].toLowerCase()}> at offset ${tag.index}, which EPUB treats `
          + 'as scripted content; pass allowScripts: true if the reader is meant to run scripts',
      );
    }
    if (active.kind === 'handler') {
      throw new Error(
        `[pdf2epub/epub] ${label} uses an inline event handler at offset ${active.index} `
          + '(<tag on...="...">), which is scripted content; pass allowScripts: true if this is intended',
      );
    }
    throw new Error(
      `[pdf2epub/epub] ${label} points at a javascript: URL at offset ${active.index}; `
        + 'pass allowScripts: true if this is intended',
    );
  }

  return { scripted };
}

/* ------------------------------------------------------------------ *
 * input validation
 * ------------------------------------------------------------------ */

/**
 * Attribute-level active content inside element tags (review M1).
 *
 * Scoped per tag on purpose: a chapter that *talks about* `onclick = 3` inside
 * a paragraph carries ordinary text, not a handler. A tag's own attributes are
 * what the reader would execute.
 *
 * @param {string} text - XHTML fragment.
 * @returns {{kind: 'handler'|'url', index: number}|null}
 */
function findActiveAttribute(text) {
  for (const tag of text.matchAll(TAG_SCAN_RE)) {
    const handler = INLINE_HANDLER_RE.exec(tag[0]);
    if (handler !== null) return { kind: 'handler', index: tag.index + handler.index };
    const url = SCRIPT_URL_RE.exec(tag[0]);
    if (url !== null) return { kind: 'url', index: tag.index + url.index };
  }
  return null;
}

function normalizeBook(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('[pdf2epub/epub] buildEpub(book): book must be an object');
  }

  const allowScripts = input.allowScripts === true;
  const title = requireCleanText(input.title, 'book.title');
  const language = normalizeLanguage(input.language);
  const css = typeof input.css === 'string' && input.css.trim() ? input.css : DEFAULT_CSS;

  return {
    title,
    language,
    author: optionalCleanText(input.author),
    publisher: optionalCleanText(input.publisher),
    identifier: normalizeIdentifier(input.identifier),
    modified: normalizeModified(input.modified),
    allowScripts,
    css,
    chapters: normalizeChapters(input.chapters, allowScripts),
    assets: normalizeAssets(input.assets),
    cover: normalizeCover(input.coverImage),
  };
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new TypeError(`[pdf2epub/epub] ${label} must be a non-empty string`);
  }
  return text;
}

/** Required text, with XML 1.0 illegal code points removed (review S2). */
function requireCleanText(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`[pdf2epub/epub] ${label} must be a non-empty string`);
  }
  return requireText(sanitizeXmlText(value), label);
}

function optionalText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

/** Optional text, cleaned and re-trimmed; null when nothing readable is left. */
function optionalCleanText(value) {
  const text = optionalText(value);
  if (text === null) return null;
  const cleaned = sanitizeXmlText(text).trim();
  return cleaned ? cleaned : null;
}

/**
 * `language` must be a BCP-47 tag (review M4): `dc:language` and `xml:lang` are
 * both checked by epubcheck, and `zh_CN` / `Chinese` pass every reader silently
 * while being invalid. No fallback: a wrong tag is the caller's bug.
 */
function normalizeLanguage(value) {
  const text = optionalCleanText(value);
  if (text === null) return DEFAULT_LANGUAGE;
  if (!BCP47_RE.test(text)) {
    throw new TypeError(
      `[pdf2epub/epub] book.language must be a BCP-47 language tag such as "zh-CN", "en" or `
        + `"zh-Hant" (got "${text}")`,
    );
  }
  return text;
}

function normalizeIdentifier(value) {
  const text = optionalCleanText(value);
  if (!text) return `urn:uuid:${randomUuid()}`;
  return UUID_RE.test(text) ? `urn:uuid:${text}` : text;
}

function normalizeModified(value) {
  if (value == null || value === '') return DEFAULT_MODIFIED;
  if (typeof value === 'string') {
    const text = value.trim();
    if (EPUB_DATE_RE.test(text)) return text;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      '[pdf2epub/epub] book.modified must be a Date or a "YYYY-MM-DDThh:mm:ssZ" string',
    );
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeChapters(list, allowScripts) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('[pdf2epub/epub] book.chapters must be a non-empty array');
  }
  return list.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`[pdf2epub/epub] book.chapters[${index}] must be an object`);
    }
    const title = requireCleanText(raw.title, `book.chapters[${index}].title`);
    const number = Number(raw.level);
    const html = typeof raw.html === 'string' ? raw.html : '';
    const { scripted } = validateChapterHtml(html, {
      allowScripts,
      label: `book.chapters[${index}].html`,
    });
    return {
      index,
      key: `book.chapters[${index}]`,
      idHint: optionalText(raw.id) ?? `chapter-${index + 1}`,
      title,
      html,
      scripted,
      level: Number.isFinite(number) ? Math.max(1, Math.trunc(number)) : 1,
    };
  });
}

/**
 * Assets are validated, then de-duplicated by zip entry name (review M2):
 * byte-identical duplicates collapse to one item, and two different payloads
 * claiming the same href are an explicit error instead of a misleading
 * "collides with a generated file".
 */
function normalizeAssets(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    throw new TypeError('[pdf2epub/epub] book.assets must be an array');
  }
  const assets = [];
  const seen = new Map();

  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`[pdf2epub/epub] book.assets[${index}] must be an object`);
    }
    const { entry, href } = normalizeHref(raw.href, `book.assets[${index}].href`);
    const mediaType = resolveMediaType(raw.mediaType, entry, `book.assets[${index}].mediaType`);
    const data = toBytes(raw.data, `book.assets[${index}].data`);

    const prior = seen.get(entry);
    if (prior !== undefined) {
      if (prior.mediaType === mediaType && sameBytes(prior.data, data)) return; // exact duplicate
      throw new Error(
        `[pdf2epub/epub] book.assets[${index}].href repeats "${entry}" from an earlier asset with `
          + 'different content or media type; use one entry per href',
      );
    }
    seen.set(entry, { mediaType, data });
    assets.push({
      index,
      idHint: optionalText(raw.id) ?? `asset-${index + 1}`,
      entry,
      href,
      mediaType,
      data,
    });
  });

  return assets;
}

function normalizeCover(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    throw new TypeError('[pdf2epub/epub] book.coverImage must be an object');
  }
  const { entry, href } = normalizeHref(raw.href, 'book.coverImage.href');
  const mediaType = resolveMediaType(raw.mediaType, entry, 'book.coverImage.mediaType');
  // M5: `properties="cover-image"` is defined for images only (EPUB 3.3 D.6.1).
  if (!isImageMediaType(mediaType)) {
    throw new TypeError(
      `[pdf2epub/epub] book.coverImage.mediaType must be an image media type such as "image/png" `
        + `(got "${mediaType}")`,
    );
  }
  return { entry, href, mediaType, data: toBytes(raw.data, 'book.coverImage.data') };
}

/**
 * Validate an EPUB-internal href and return its two representations:
 *
 *   entry - the zip entry name (decoded, UTF-8), used for the archive;
 *   href  - the percent-encoded relative URL, used in the OPF and in XHTML.
 *
 * OCF says the href is a URL and the container entry is its decoded path, so
 * encoding the href is what keeps `manifest href` and `zip entry` referring to
 * the same file — the review's `images/a#b.png` and `images/封面.png` cases.
 */
function normalizeHref(value, label) {
  const text = requireText(value, label).replace(/\\/g, '/');
  if (text.startsWith('/') || HREF_SCHEME_RE.test(text)) {
    throw new Error(
      `[pdf2epub/epub] ${label} must be relative to OEBPS (got "${text}")`,
    );
  }
  if (HREF_CONTROL_RE.test(text)) {
    throw new Error(
      `[pdf2epub/epub] ${label} must not contain control characters (got "${clip(text)}")`,
    );
  }
  if (text.includes('#') || text.includes('?')) {
    throw new Error(
      `[pdf2epub/epub] ${label} must not contain "#" or "?" (a manifest href is a plain relative `
        + `path, so it would be read as a fragment/query, got "${text}")`,
    );
  }

  const segments = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment.includes('..')) {
      throw new Error(
        `[pdf2epub/epub] ${label} must stay inside OEBPS and must not contain ".." (got "${text}")`,
      );
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error(`[pdf2epub/epub] ${label} must name a file inside OEBPS`);
  }

  const entry = segments.join('/');
  assertEntryName(`${OEBPS}/${entry}`, label);
  const href = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return { entry, href };
}

function resolveMediaType(mediaType, entryName, label) {
  const text = optionalText(mediaType);
  if (text) return text;
  const dot = entryName.lastIndexOf('.');
  const guess = dot >= 0 ? MEDIA_BY_EXT.get(entryName.slice(dot).toLowerCase()) : undefined;
  if (guess) return guess;
  throw new TypeError(`[pdf2epub/epub] ${label} is required for "${entryName}"`);
}

function isImageMediaType(mediaType) {
  return /^image\/[a-z0-9.+-]+$/i.test(mediaType);
}

function toBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`[pdf2epub/epub] ${label} must be a Uint8Array`);
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * identifiers, paths
 * ------------------------------------------------------------------ */

function safeXmlId(value, fallback) {
  let id = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  if (!id) id = fallback;
  if (!/^[A-Za-z_]/.test(id)) id = `x-${id}`;
  return id;
}

function safeFileStem(value, fallback) {
  let stem = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  if (!stem) stem = fallback;
  if (!/^[A-Za-z0-9_]/.test(stem)) stem = `f-${stem}`;
  return stem;
}

/**
 * Reject entry names the target platforms cannot unpack (review M3): names
 * longer than 200 UTF-8 bytes break `NAME_MAX`-limited unpackers on extract,
 * and a Windows device name (CON, NUL, COM1, ...) cannot be created at all.
 */
function assertEntryName(name, label) {
  const bytes = strToU8(name).length;
  if (bytes > MAX_ENTRY_NAME_BYTES) {
    throw new Error(
      `[pdf2epub/epub] ${label}: zip entry name is ${bytes} bytes, above the `
        + `${MAX_ENTRY_NAME_BYTES}-byte limit (${clip(name)})`,
    );
  }
  for (const segment of name.split('/')) {
    if (WINDOWS_DEVICE_RE.test(segment)) {
      throw new Error(
        `[pdf2epub/epub] ${label}: zip entry name uses the Windows reserved device name `
          + `"${segment}", which cannot be unpacked on Windows (${clip(name)})`,
      );
    }
  }
}

function clip(text, limit = 80) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function claimId(used, candidate) {
  let id = candidate;
  let suffix = 2;
  while (used.has(id)) {
    id = `${candidate}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

/** Reserve `candidate`, or `stem-2.ext` / `stem-3.ext` ... when already taken. */
function claimPath(reserved, candidate) {
  const slash = candidate.lastIndexOf('/');
  const dot = candidate.lastIndexOf('.');
  const hasExt = dot > slash;
  const dir = candidate.slice(0, slash + 1);
  const ext = hasExt ? candidate.slice(dot) : '';
  const stem = candidate.slice(dir.length, hasExt ? dot : candidate.length);

  let path = candidate;
  let suffix = 2;
  while (reserved.has(path)) {
    path = `${dir}${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  reserved.add(path);
  return path;
}

function createZipMtime() {
  const mtime = new Date(2000, 0, 1, 0, 0, 0);
  // Belt and braces: a zone that skipped 2000-01-01T00:00 (there is none) can
  // only shift the hour, never the year, but never hand fflate a date its DOS
  // encoder rejects.
  const year = mtime.getFullYear();
  if (year < 1980 || year > 2099) return new Date(2000, 5, 15, 12, 0, 0);
  return mtime;
}

function randomUuid() {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ *
 * documents
 * ------------------------------------------------------------------ */

/**
 * Escape text for an XML text node or attribute value.
 *
 * Illegal code points are removed *first* and only then are the five XML
 * entities applied, so a control character can never reach the document (review
 * S2) and an already-escaped `&amp;` still round-trips exactly once.
 */
function escapeXml(value) {
  return sanitizeXmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildContainerXml() {
  return [
    XML_DECL,
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    `    <rootfile full-path="${OEBPS}/content.opf" media-type="application/oebps-package+xml" />`,
    '  </rootfiles>',
    '</container>',
    '',
  ].join('\n');
}

function buildContentOpf(model, manifest, spine) {
  const lines = [
    XML_DECL,
    `<package xmlns="${OPF_NS}" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXml(model.language)}">`,
    `  <metadata xmlns:dc="${DC_NS}">`,
    `    <dc:identifier id="pub-id">${escapeXml(model.identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(model.title)}</dc:title>`,
    `    <dc:language>${escapeXml(model.language)}</dc:language>`,
  ];
  if (model.author) lines.push(`    <dc:creator>${escapeXml(model.author)}</dc:creator>`);
  if (model.publisher) {
    lines.push(`    <dc:publisher>${escapeXml(model.publisher)}</dc:publisher>`);
  }
  lines.push(`    <meta property="dcterms:modified">${model.modified}</meta>`);
  lines.push('  </metadata>', '  <manifest>');

  for (const item of manifest) {
    const properties = item.properties
      ? ` properties="${escapeXml(item.properties)}"`
      : '';
    lines.push(
      `    <item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}"${properties} />`,
    );
  }

  lines.push('  </manifest>', '  <spine>');
  for (const ref of spine) lines.push(`    <itemref idref="${escapeXml(ref.idref)}" />`);
  lines.push('  </spine>', '</package>', '');
  return lines.join('\n');
}

function buildTocTree(chapterPlans) {
  const roots = [];
  const stack = [];

  for (const plan of chapterPlans) {
    const node = { href: plan.href, title: plan.title, level: plan.level, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
}

function renderToc(nodes, depth) {
  const pad = '  '.repeat(depth);
  const lines = [`${pad}<ol>`];
  for (const node of nodes) {
    const head = `${pad}  <li><a href="${escapeXml(node.href)}">${escapeXml(node.title)}</a>`;
    if (node.children.length > 0) {
      lines.push(head);
      lines.push(renderToc(node.children, depth + 2));
      lines.push(`${pad}  </li>`);
    } else {
      lines.push(`${head}</li>`);
    }
  }
  lines.push(`${pad}</ol>`);
  return lines.join('\n');
}

function buildNavXhtml(model, tocTree) {
  const label = /^zh/i.test(model.language) ? '目录' : 'Contents';
  const body = [
    `    <nav epub:type="toc" id="toc">`,
    `      <h1>${escapeXml(label)}</h1>`,
    renderToc(tocTree, 3),
    '    </nav>',
  ];
  return wrapXhtml(model, label, STYLESHEET_HREF, body);
}

function buildChapterXhtml(model, chapter) {
  const body = chapter.html.trim() ? [chapter.html] : [];
  return wrapXhtml(model, chapter.title, XHTML_STYLESHEET_HREF, body);
}

function buildCoverXhtml(model, coverImage) {
  return wrapXhtml(model, model.title, XHTML_STYLESHEET_HREF, [
    '    <div class="cover" epub:type="cover">',
    `      <img src="../${escapeXml(coverImage.href)}" alt="${escapeXml(model.title)}" />`,
    '    </div>',
  ]);
}

function wrapXhtml(model, title, stylesheetHref, bodyLines) {
  const lang = escapeXml(model.language);
  return [
    XML_DECL,
    '<!DOCTYPE html>',
    `<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}" xml:lang="${lang}" lang="${lang}">`,
    '  <head>',
    '    <meta charset="utf-8" />',
    `    <title>${escapeXml(title)}</title>`,
    `    <link rel="stylesheet" type="text/css" href="${escapeXml(stylesheetHref)}" />`,
    '  </head>',
    '  <body>',
    ...bodyLines,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}
