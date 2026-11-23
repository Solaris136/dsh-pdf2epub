/**
 * dsh-pdf2epub — client half (Web platform).
 *
 * Two registrations for the panel, one id (contract §8): the sidebar icon in the
 * list slot `sidebar.panellist` (option `id`) and the panel body in the keyed
 * slot `main` (option `key`). `layout.selectPanel(id)` throws unless both carry
 * the very same string, so `PANEL_ID` is the single source for both.
 *
 * A second pair registers the `.epub` document preview (see the contract block
 * further down): the metadata in `ctx.documentPreviews` and the body in the
 * keyed slot `sidebar.right.tab.document`, both under `EPUB_PREVIEW_ID`.
 *
 * Everything the browser asks the Host for is plain same-origin HTTP, because a
 * hand-written client cannot mount a `ctx.remote` namespace without Typert
 * codegen (contract §9). The five routes match `src/host/server.js`:
 *   POST /dsh-pdf2epub/run             { input, model?, reviewModels?, dpi?, concurrency? } -> { jobId }
 *   GET  /dsh-pdf2epub/state?jobId=... -> { jobId, phase, page, total, tokens, bookJsonPath, error }
 *   GET  /dsh-pdf2epub/models          -> { default, groups: [{ id, name, models }], failures }
 *   GET  /dsh-pdf2epub/book?path=...   -> { title, author, language, chapters: [{ id, title, level, html }] }
 *   GET  /dsh-pdf2epub/epub?sessionId=<sid>&path=<path>
 *                                      -> { ok, title, author, language, toc, chapters, css, images }
 *
 * `GET /models` is what feeds the 「模型」 dropdown: it is the built-in model
 * picker's own catalogue, served by the Host because that namespace is not
 * mountable here.
 *
 * `sessionId` is what makes the preview work: the address the body receives
 * carries the *workspace-relative* tail of a file the reader clicked, and the
 * Host roots that tail at the Session's own working directory.
 *
 * Self-contained by design: only the platform module table is required (here
 * `react` alone), no relative imports, and no second React root — the slot
 * renderer owns the tree, this file only supplies components.
 *
 * 「浏览…」 picks the PDF instead of typing it, and there is no Host route behind
 * it, because no such surface exists: the Host process runs in Electron's Node
 * mode (`dsh-desktop-host` is spawned with `ELECTRON_RUN_AS_NODE=1`), so it has
 * no `dialog` module, and `ctx.directoryPicker` serves **folders** — one
 * capability per boot, `pick` (OS folder chooser) or `list` (folder-only
 * levels), never files. Two mechanisms are therefore used, in order:
 *   1. the Desktop preload's `__DSH_HOST_PATHS__.pathFor(file)` bridge driven by
 *      an `<input type="file" accept=".pdf">`: the real OS "Open" dialog, with a
 *      PDF filter, returning the absolute host path. Desktop windows only.
 *   2. `ctx.remote.directoryPicker.list(path)`: an in-app browser overlay for
 *      every other deployment (a plain browser tab can never read a path off a
 *      `File`, so this is the only fallback there is).
 */

const PANEL_ID = 'pdf2epub'
const LOCALE_NS = 'pdf2epub'

const RUN_PATH = '/dsh-pdf2epub/run'
const STATE_PATH = '/dsh-pdf2epub/state'
const MODELS_PATH = '/dsh-pdf2epub/models'
const BOOK_PATH = '/dsh-pdf2epub/book'
const EPUB_PATH = '/dsh-pdf2epub/epub'

/** Poll cadence required by the panel contract. */
const POLL_MS = 1000

/** Phases after which the Host will not change the job again. */
const TERMINAL_PHASES = new Set(['done', 'failed'])

/**
 * Suffix a browsed entry must carry to be offered as a PDF, matched
 * case-insensitively (`.PDF` is the same file as `.pdf` on both platforms).
 */
const PDF_SUFFIX_RE = /\.pdf$/i

/** `accept` value of the file input the Desktop chooser opens behind. */
const PDF_ACCEPT = 'application/pdf,.pdf'

/**
 * Pipeline phases (`src/host/server.js`) mapped onto the shipped `status.*`
 * copy. Unlisted values are tried as `status.<phase>` before being shown raw.
 */
const PHASE_COPY = Object.freeze({
  queued: 'status.queued',
  start: 'status.rendering',
  page: 'status.transcribing',
  assemble: 'status.assembling',
  done: 'status.done',
  failed: 'status.failed',
  cancelled: 'status.failed',
})

/** Renderer id shared by the `.epub` document metadata and its body slot. */
const EPUB_PREVIEW_ID = 'dsh-pdf2epub/epub'

/** Container class every scoped `book.css` rule is prefixed with. */
const EPUB_BOOK_CLASS = 'p2e-book'

/**
 * Locale key of the document-preview title.
 *
 * Deliberately *not* added to the shipped `pdf2epub` dictionaries: the browser
 * bundle and `locale/*.json` are asserted to be identical key-for-key, and this
 * key is not part of that resource set. A miss falls back to `EPUB`, which is
 * what the title shows today.
 */
const PREVIEW_TITLE_KEY = 'preview.title'

/** Copy the document-preview title falls back to when the locale key misses. */
const PREVIEW_TITLE_FALLBACK = 'EPUB'

/** Prefix of the addresses a document body receives (`dsh-resource://file/…`). */
const RESOURCE_FILE_PREFIX = 'dsh-resource://file/'

/**
 * `.epub` document preview — the contract this half rides on.
 *
 * Registration API (installed `dsh-client-ui-sidebar-documentpreview`: README
 * §“Document implementations register metadata”, `document/registry.ts`; see
 * also `docs/epub-in-dsh.md` §3.1 and §4.3.1 / checklist C3–C4):
 *
 *     ctx.documentPreviews.register({
 *       id,                 // renderer identity, also the body slot key
 *       extensions,         // ['epub'] — claim the suffix
 *       binaryExtensions,   // must be a SUBSET of extensions (registry throws otherwise)
 *       priority,           // 'extension' = product-external type, highest tier
 *       title,              // () => string
 *       loading,            // 'renderer' = the body fetches its own content
 *       wrap,               // owner no longer adds the padding shell
 *     })
 *
 * and the body in the keyed, Session-scoped slot `sidebar.right.tab.document`
 * under the very SAME id (`{ name, key: id, locale }`). `loading: 'renderer'`
 * makes the owner hand over `{ kind: 'renderer', revision, loaded(version),
 * failed(), reload() }`, and the body is expected to call those.
 *
 * What the research doc could not prove (§6, items 1–3): that a third-party
 * bundle can reach `documentPreviews` at all, and that a body receives an
 * absolute path. So this file:
 *   - probes the service at apply time — `typeof ctx.get === 'function'` first
 *     (Cordis' own lookup), then a descriptor read that cannot run a getter —
 *     and, when it is missing, keeps the panel working and only skips this
 *     registration. Nothing in that block may throw: an escaping throw rolls
 *     back every effect `apply` already registered, panel included (`probe-cordis`
 *     §F: `["panel effect registered","panel effect DISPOSED"]`);
 *   - resolves the file twice and sends BOTH answers. `props.useResource` is a
 *     slot standard prop (not a module, so no require is involved) and its
 *     `value.absolutePath` is preferred when the owner passes it. Independently
 *     of that hook, `resourceAddress` is split into the Session id and the path
 *     it names, and both are sent: the Host resolves a relative `path` against
 *     the Session's working directory. A workspace file therefore reads with or
 *     without a usable hook, which is the whole point — the address alone used
 *     to produce a `404` on every real click.
 *
 * The body renders inline instead of in a `sandbox=""` iframe: the Host's
 * `book.css` is scoped onto `EPUB_BOOK_CLASS` and chapter markup is rebuilt from
 * a tag/attribute whitelist before `dangerouslySetInnerHTML`, which is the same
 * injection path the panel uses for its chapters (both go through
 * `stripActiveMarkup`).
 */

/* ------------------------------------------------------- EPUB CSS scoping */

/** At-rules whose block holds ordinary rules: the inner sheet is scoped too. */
const CSS_GROUPING_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'document', '-moz-document'])

/** Statement at-rules that cannot appear inside a scoped `<style>` block. */
const CSS_DROPPED_AT_RULES = new Set(['charset', 'import', 'namespace'])

/**
 * Normalise a container scope into a selector: `p2e-book` and `.p2e-book` both
 * yield `.p2e-book`; an empty scope yields an empty string (nothing is scoped).
 *
 * @param {unknown} scope - container class name, with or without the dot.
 * @returns {string} the scope selector, or `''`.
 */
function normalizeScopeSelector(scope) {
  const text = typeof scope === 'string' ? scope.trim() : ''
  if (text === '') return ''
  if (text.startsWith('.') || text.startsWith('#') || text.startsWith('[')) return text
  return `.${text}`
}

/**
 * Find the next top-level `{` or `;` of a stylesheet, skipping quoted strings
 * and `url(...)`-style parentheses (`url(data:…;base64,…)` contains a `;`).
 *
 * @param {string} text - stylesheet text (comments already removed).
 * @param {number} from - index to start at.
 * @returns {{ open: number, semi: number }} delimiter indexes; `-1` when absent.
 */
function nextSheetDelimiter(text, from) {
  let depth = 0
  let quote = ''
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && character === '{') {
      return { open: index, semi: -1 }
    } else if (depth === 0 && character === ';') {
      return { open: -1, semi: index }
    }
  }
  return { open: -1, semi: -1 }
}

/**
 * Index of the `}` closing the block opened at `open`.
 *
 * Braces inside parentheses are not block delimiters: an unquoted `url(a}b.png)`
 * is one token, so counting its `}` as a rule end would close the block early
 * and leave the rest of the sheet as a fake selector (`probe-pure`'s
 * `p{background:url(a}b.png)} q{a:1}` case). Quotes are still skipped first,
 * because a `(` inside `content:"…"` is not a function call.
 *
 * @param {string} text - stylesheet text.
 * @param {number} open - index of the opening brace.
 * @returns {number} closing index, or `-1` when the block is unterminated.
 */
function matchingCssBrace(text, open) {
  let depth = 0
  let parens = 0
  let quote = ''
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(') {
      parens += 1
    } else if (character === ')') {
      parens = Math.max(0, parens - 1)
    } else if (parens === 0 && character === '{') {
      depth += 1
    } else if (parens === 0 && character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Split a selector list on the commas outside `()`/`[]`/quotes.
 * @param {string} text - selector list (`h1, h2 > a`).
 * @returns {string[]} trimmed, non-empty selectors.
 */
function splitCssSelectors(text) {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/**
 * Prefix one selector with the container scope.
 *
 * A leading `:root` / `html` / `body` names the document itself, so it is
 * replaced by the scope element instead of being nested below it (`body { … }`
 * becomes `.p2e-book { … }`, which is what makes the book's base typography
 * reach the reading column). Already-scoped selectors are returned untouched,
 * so a stylesheet that was scoped twice is still valid.
 *
 * @param {string} selector - one selector from a list.
 * @param {string} prefix - normalised scope selector (`.p2e-book`).
 * @returns {string} scoped selector, or `''` when there is nothing to scope.
 */
function scopeCssSelector(selector, prefix) {
  const text = selector.trim()
  if (text === '') return ''
  if (text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}.`) || text.startsWith(`${prefix}:`) || text.startsWith(`${prefix}[`)) return text
  let rest = text
  let rootish = false
  for (;;) {
    const match = /^(?::root|html|body)(?![\w-])([\s\S]*)$/i.exec(rest)
    if (match === null) break
    rootish = true
    rest = match[1].trim().replace(/^>\s*/, '')
  }
  if (!rootish) return `${prefix} ${text}`
  if (rest === '') return prefix
  if (/^[.#:[*]/.test(rest)) return `${prefix}${rest}`
  return `${prefix} ${rest}`
}

/**
 * Scope one stylesheet level: every rule's selector list gets the prefix,
 * grouping at-rules (`@media`, `@supports`, …) recurse, and descriptor at-rules
 * (`@font-face`, `@page`, `@keyframes`, …) are copied verbatim.
 *
 * @param {string} css - stylesheet level, comments already removed.
 * @param {string} prefix - normalised scope selector.
 * @returns {string} scoped stylesheet.
 */
function scopeCssBlock(css, prefix) {
  let out = ''
  let index = 0
  while (index < css.length) {
    const delimiter = nextSheetDelimiter(css, index)
    if (delimiter.semi !== -1 && (delimiter.open === -1 || delimiter.semi < delimiter.open)) {
      const statement = css.slice(index, delimiter.semi + 1).trim()
      const nameMatch = /^@([\w-]+)/.exec(statement)
      const name = nameMatch === null ? '' : nameMatch[1].toLowerCase()
      if (statement !== '' && !CSS_DROPPED_AT_RULES.has(name)) out += `${statement}\n`
      index = delimiter.semi + 1
      continue
    }
    if (delimiter.open === -1) break
    const prelude = css.slice(index, delimiter.open).trim()
    const close = matchingCssBrace(css, delimiter.open)
    const inner = css.slice(delimiter.open + 1, close === -1 ? css.length : close)
    if (prelude.startsWith('@')) {
      const nameMatch = /^@([\w-]+)/.exec(prelude)
      const name = nameMatch === null ? '' : nameMatch[1].toLowerCase()
      out += CSS_GROUPING_AT_RULES.has(name)
        ? `${prelude} {\n${scopeCssBlock(inner, prefix)}}\n`
        : `${prelude} {${inner}}\n`
    } else {
      const selectors = splitCssSelectors(prelude)
        .map(selector => scopeCssSelector(selector, prefix))
        .filter(selector => selector !== '')
      if (selectors.length > 0) out += `${selectors.join(', ')} {${inner}}\n`
    }
    index = close === -1 ? css.length : close + 1
  }
  return out
}

/**
 * Rewrite a `}` that sits inside `()` outside quotes into its CSS hex escape.
 *
 * `url(a}b.png)` is one token to a CSS tokenizer but a bare `}` to anything that
 * counts braces — the naive balance every consumer of this output may run, and
 * the block scanner itself before {@link matchingCssBrace} learned about
 * parentheses. `\7d ` is the same character to the CSS parser (the space is the
 * escape terminator), so the declaration still works and the emitted stylesheet
 * stays structurally balanced without a raw brace appearing mid-declaration.
 *
 * @param {string} css - stylesheet text (comments already removed).
 * @returns {string} the stylesheet with parenthesised braces escaped.
 */
function escapeParenBraces(css) {
  let out = ''
  let parens = 0
  let quote = ''
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]
    if (quote !== '') {
      out += character
      if (character === '\\') {
        index += 1
        out += index < css.length ? css[index] : ''
      } else if (character === quote) {
        quote = ''
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      out += character
    } else if (character === '(') {
      parens += 1
      out += character
    } else if (character === ')') {
      parens = Math.max(0, parens - 1)
      out += character
    } else if (character === '}' && parens > 0) {
      out += '\\7d '
    } else {
      out += character
    }
  }
  return out
}

/**
 * Scope an EPUB stylesheet so its bare selectors (`h1`, `p`, `.verse`) only
 * reach the reading column.
 *
 * Comments are stripped first (a `}` inside one would derail the block scan),
 * `@charset` / `@import` / `@namespace` are dropped (they are meaningless, or
 * would fetch, inside an inline `<style>`), grouping at-rules recurse, and
 * `@font-face` / `@page` / `@keyframes` are kept as they are: their inner
 * `from` / `50%` blocks are not selectors and must never be prefixed.
 *
 * @param {unknown} css - stylesheet text from the Host.
 * @param {unknown} scope - container class (`p2e-book`) or `.p2e-book`.
 * @returns {string} scoped stylesheet (`''` when there is nothing to scope).
 */
function scopeCss(css, scope) {
  if (typeof css !== 'string' || css.trim() === '') return ''
  const prefix = normalizeScopeSelector(scope)
  if (prefix === '') return ''
  const source = escapeParenBraces(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  return scopeCssBlock(source, prefix).trim()
}

/* ------------------------------------------------------ EPUB image inlining */

/** Elements that never carry content of their own. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements removed together with everything inside them. */
const PURGED_ELEMENTS = new Set([
  'applet', 'audio', 'base', 'basefont', 'button', 'canvas', 'datalist', 'embed', 'form', 'frame', 'frameset',
  'head', 'iframe', 'input', 'keygen', 'link', 'map', 'marquee', 'math', 'meta', 'noembed', 'noframes',
  'noscript', 'object', 'optgroup', 'option', 'output', 'param', 'plaintext', 'script', 'select', 'source',
  'style', 'svg', 'template', 'textarea', 'title', 'track', 'video', 'xmp',
])

/**
 * Elements a chapter body may keep.
 *
 * A whitelist, not a blacklist: an element nobody listed (`<svg>`, `<math>`,
 * `<video>`, an unknown tag from a future EPUB) is dropped while its text is
 * kept, so a hostile book cannot reach an element this file never considered.
 */
const KEEP_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite',
  'code', 'col', 'colgroup', 'dd', 'del', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol',
  'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
])

/**
 * Attributes a chapter body may keep.
 *
 * Deliberately no `style` (an inline `position:fixed` sheet can float over the
 * whole app), no `srcset` (every candidate is a real request), no `target`, and
 * no `data-*`. `epub:type` is kept because the book's own CSS may target it.
 */
const KEEP_ATTRIBUTES = new Set(['alt', 'class', 'colspan', 'epub:type', 'href', 'id', 'rowspan', 'src', 'title'])

/** Schemes `href` may name; anything else has to be a relative reference. */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * Media types a `data:` image source may carry.
 *
 * `image/svg+xml` is excluded: XML processing in an `<img>` is inert today, but
 * it is the one image type that can carry script and no book needs it.
 */
const DATA_IMAGE_RE = /^image\/(?:png|jpe?g|gif|webp|bmp|avif|ico|vnd\.microsoft\.icon|x-icon)$/i

/** Named entities a browser decodes inside an attribute value. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&', apos: "'", bsol: '\\', colon: ':', gt: '>', lpar: '(', lt: '<', nbsp: '\u00a0', newline: '\n',
  quot: '"', rpar: ')', sol: '/', tab: '\t',
})

/** Characters a browser drops when it reads a URL scheme. */
const SCHEME_NOISE_RE = /[\u0000-\u0020\u007f-\u009f]+/g

/**
 * Replace the entities an attribute value can hide a scheme behind.
 *
 * `href="jav&#x61;script:…"` and `href="javascript&colon;…"` are `javascript:`
 * after the browser decodes them, so a scheme test has to decode first.
 *
 * @param {unknown} value - raw attribute text.
 * @returns {string} text with character references resolved.
 */
function decodeEntities(value) {
  const text = typeof value === 'string' ? value : ''
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));?/gi, (whole, hex, decimal, name) => {
    if (hex !== undefined) return codePointText(Number.parseInt(hex, 16))
    if (decimal !== undefined) return codePointText(Number.parseInt(decimal, 10))
    const key = String(name).toLowerCase()
    return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : whole
  })
}

/**
 * One code point as text.
 * @param {number} code - code point.
 * @returns {string} the character, or `''` when the code is not one.
 */
function codePointText(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * The scheme of a URL-ish attribute value, read the way a browser reads it.
 * @param {unknown} value - attribute value.
 * @returns {string} lower-case scheme, or `''` for a relative reference.
 */
function urlScheme(value) {
  const cleaned = decodeEntities(value).replace(SCHEME_NOISE_RE, '')
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * Classify one URL-ish attribute value.
 *
 * `relative` is a reference the archive itself answers (and which the image
 * rewriter turns into a `data:` URL); `link` is an http(s)/mailto target on an
 * `<a>`; `image` is an inlined raster `data:` URL; `rejected` is everything
 * else — `javascript:`, `vbscript:`, `file:`, a `data:` document, or a
 * protocol-relative `//host/…` that would leave the app.
 *
 * @param {unknown} value - attribute value.
 * @returns {'relative' | 'link' | 'image' | 'rejected'}
 */
function urlKind(value) {
  const cleaned = decodeEntities(value).replace(SCHEME_NOISE_RE, '')
  if (cleaned === '') return 'relative'
  const scheme = urlScheme(cleaned)
  if (scheme === '') return cleaned.startsWith('//') ? 'rejected' : 'relative'
  if (scheme === 'data') {
    // `data:<media-type>[;param=…],<payload>`: only the media type is judged,
    // and only the raster types a book actually carries.
    const comma = cleaned.indexOf(',')
    if (comma <= 5) return 'rejected'
    const mediaType = cleaned.slice(5, comma).split(';')[0].trim()
    return DATA_IMAGE_RE.test(mediaType) ? 'image' : 'rejected'
  }
  return LINK_SCHEMES.has(scheme) ? 'link' : 'rejected'
}

/**
 * Read one tag starting at its `<`.
 *
 * Hand-written because the shapes that matter are exactly the ones a regular
 * expression gets wrong: `/` separates attributes (`<img/onerror=…>`), a quoted
 * value may contain `>` (`alt="a > b"`), an unquoted value may contain `/`, and
 * a malformed `<scr<script>` must never be re-read as a tag.
 *
 * @param {string} html - source markup.
 * @param {number} start - index of the `<`.
 * @returns {{ token: object, end: number } | null} the tag and the index after it, or `null` when no tag starts here.
 */
function readMarkupTag(html, start) {
  let index = start + 1
  const closing = html[index] === '/'
  if (closing) index += 1
  const nameStart = index
  while (index < html.length && !/[\s/>]/.test(html[index])) index += 1
  const name = html.slice(nameStart, index).toLowerCase()
  if (!/^[a-z][a-z0-9:-]*$/.test(name)) return null
  if (closing) {
    const end = html.indexOf('>', index)
    return { token: { kind: 'close', name }, end: end === -1 ? html.length : end + 1 }
  }
  const attributes = []
  for (;;) {
    while (index < html.length && /[\s/]/.test(html[index])) index += 1
    if (index >= html.length) break
    const character = html[index]
    if (character === '>') {
      index += 1
      break
    }
    // A `<` before the `>` is malformed input: end the tag here so the next
    // token starts at it instead of being glued onto this tag's last attribute.
    if (character === '<') break
    const attributeStart = index
    while (index < html.length && !/[\s/>=]/.test(html[index])) index += 1
    const attributeName = html.slice(attributeStart, index).toLowerCase()
    if (attributeName === '') {
      index += 1
      continue
    }
    while (index < html.length && /\s/.test(html[index])) index += 1
    let value = ''
    let quote = ''
    if (html[index] === '=') {
      index += 1
      while (index < html.length && /\s/.test(html[index])) index += 1
      const marker = index < html.length ? html[index] : ''
      if (marker === '"' || marker === "'") {
        quote = marker
        const close = html.indexOf(marker, index + 1)
        value = close === -1 ? html.slice(index + 1) : html.slice(index + 1, close)
        index = close === -1 ? html.length : close + 1
      } else {
        const valueStart = index
        while (index < html.length && !/[\s>]/.test(html[index])) index += 1
        value = html.slice(valueStart, index)
      }
    }
    attributes.push({ name: attributeName, value, quote })
  }
  return { token: { kind: 'open', name, attributes }, end: index }
}

/**
 * Scan markup into tags and text runs.
 *
 * Comments, doctypes and processing instructions are dropped here, and a bare
 * `<` that opens no tag is re-emitted as `&lt;`, so nothing downstream can
 * concatenate two harmless pieces into a tag.
 *
 * @param {string} html - markup to scan.
 * @returns {Array<object>} tokens in source order.
 */
function scanMarkup(html) {
  const tokens = []
  let text = ''
  let index = 0
  const flush = () => {
    if (text === '') return
    tokens.push({ kind: 'text', text })
    text = ''
  }
  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) {
      text += html.slice(index)
      break
    }
    text += html.slice(index, open)
    if (html.startsWith('<!--', open)) {
      // A conditional comment (`<!--[if IE]><script>…`) is a comment to every
      // browser that matters; dropping to `-->` drops what it hides.
      flush()
      const end = html.indexOf('-->', open + 4)
      index = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', open)) {
      flush()
      const end = html.indexOf(']]>', open + 9)
      const body = end === -1 ? html.slice(open + 9) : html.slice(open + 9, end)
      if (body !== '') tokens.push({ kind: 'text', text: body })
      index = end === -1 ? html.length : end + 3
      continue
    }
    const next = open + 1 < html.length ? html[open + 1] : ''
    if (next === '!' || next === '?') {
      flush()
      const end = html.indexOf('>', open + 2)
      index = end === -1 ? html.length : end + 1
      continue
    }
    const scanned = readMarkupTag(html, open)
    if (scanned === null) {
      text += '&lt;'
      index = open + 1
      continue
    }
    flush()
    tokens.push(scanned.token)
    index = scanned.end
  }
  flush()
  return tokens
}

/**
 * Escape the quote that delimits an attribute value.
 * @param {unknown} value - attribute value.
 * @param {string} quote - `"` or `'`.
 * @returns {string} escaped value.
 */
function escapeAttributeValue(value, quote) {
  const text = typeof value === 'string' ? value : ''
  return quote === "'" ? text.replace(/'/g, '&#39;') : text.replace(/"/g, '&#34;')
}

/**
 * Emit one tag from a name and an attribute list.
 *
 * The tag is always rebuilt: no source character is copied through, so an
 * attribute the scanner mis-grouped still cannot reach the DOM. The recorded
 * quote style is kept because both are common in XHTML and a rewritten `src`
 * should not churn the rest of the tag.
 *
 * @param {string} name - lower-case tag name.
 * @param {ReadonlyArray<{ name: string, value: unknown, quote?: string }>} attributes - attributes to emit.
 * @returns {string} the tag.
 */
function formatMarkupTag(name, attributes) {
  let out = `<${name}`
  for (const attribute of attributes) {
    const quote = attribute.quote === "'" ? "'" : '"'
    out += ` ${attribute.name}=${quote}${escapeAttributeValue(attribute.value, quote)}${quote}`
  }
  return `${out}>`
}

/**
 * Keep only the attributes a chapter body may carry.
 *
 * Every `on…` attribute is dropped wherever it appears and whatever separated
 * it, because the scanner has already grouped `<img/onerror=…>` into an
 * attribute named `onerror` — the `/` is a separator here, not whitespace.
 *
 * @param {ReadonlyArray<{ name: string, value: unknown, quote?: string }>} attributes - scanned attributes.
 * @returns {Array<{ name: string, value: unknown, quote: string }>} the survivors, double-quoted.
 */
function sanitizeAttributes(attributes) {
  const kept = []
  const seen = new Set()
  for (const attribute of attributes) {
    const name = attribute.name
    if (name === '' || seen.has(name) || !KEEP_ATTRIBUTES.has(name)) continue
    if (name.startsWith('on')) continue
    const value = typeof attribute.value === 'string' ? attribute.value : ''
    if (name === 'href' && urlKind(value) === 'rejected') continue
    if (name === 'src' && urlKind(value) === 'rejected') continue
    if (name === 'id' && /javascript/i.test(decodeEntities(value))) continue
    seen.add(name)
    kept.push({ name, value, quote: '"' })
  }
  return kept
}

/**
 * Normalise an archive href / `src` for comparison: forward slashes, no leading
 * `./`, no leading `/`, percent-decoded.
 *
 * @param {unknown} href - href from the manifest or from a chapter body.
 * @returns {string} comparable form, or `''`.
 */
function normalizeHref(href) {
  const raw = href === undefined || href === null ? '' : String(href).trim()
  if (raw === '') return ''
  let text = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
  try {
    text = decodeURIComponent(text)
  } catch {
    // A literal `%` is not an escape; the raw spelling is still comparable.
  }
  return text
}

/**
 * Build the lookup the chapter rewriter resolves `src` values against.
 *
 * `basename` records an empty string for a name two different files share, so
 * the fallback in {@link lookupImageData} can refuse to guess instead of
 * pasting whichever illustration happened to be listed first.
 *
 * @param {unknown} images - `images[]` of the Host payload.
 * @returns {{ exact: Map<string, string>, basename: Map<string, string> }} lookup.
 */
function imageSourceLookup(images) {
  const exact = new Map()
  const basename = new Map()
  if (!Array.isArray(images)) return { exact, basename }
  for (const image of images) {
    if (image === null || typeof image !== 'object') continue
    const data = typeof image.data === 'string' ? image.data : ''
    if (data === '') continue
    const href = normalizeHref(image.href)
    if (href === '') continue
    if (!exact.has(href)) exact.set(href, data)
    const name = href.slice(href.lastIndexOf('/') + 1)
    if (name === '') continue
    const known = basename.get(name)
    if (known === undefined) basename.set(name, data)
    else if (known !== data) basename.set(name, '')
  }
  return { exact, basename }
}

/**
 * Resolve a chapter-relative reference against the chapter's archive path.
 *
 * The Host speaks canonical zip paths (`chapters[].href` = `OEBPS/text/ch-one.xhtml`,
 * `images[].href` = `OEBPS/images/fig1.png`), while a chapter body references
 * images relative to its own file (`../images/fig1.png`, `./fig1.png`). Joining
 * the directory of `basePath` with the reference and folding `./` / `../` gives
 * the canonical path the image list can be matched against. A reference that
 * starts with `/` is an archive-root reference, so the base directory is
 * ignored.
 *
 * @param {unknown} basePath - canonical path of the referencing document.
 * @param {unknown} src - reference from the document.
 * @returns {string} canonical path (`''` when there is nothing to resolve).
 */
function resolveRelative(basePath, src) {
  const raw = src === undefined || src === null ? '' : String(src).trim()
  if (raw === '') return ''
  const rootReference = raw.startsWith('/')
  const source = normalizeHref(raw.split('#')[0].split('?')[0])
  if (source === '') return ''
  const base = normalizeHref(String(basePath === undefined || basePath === null ? '' : basePath).split('#')[0].split('?')[0])
  const directory = rootReference || !base.includes('/') ? '' : base.slice(0, base.lastIndexOf('/'))
  const segments = []
  for (const segment of `${directory}/${source}`.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Resolve one `src` against the inlined images.
 *
 * The base-relative canonical path is tried first (the contract's shape), then
 * the raw reference, then the basename, then a suffix match — a payload that
 * only carries `images/fig1.png` must still resolve, and a chapter that
 * references its neighbour by bare file name is common enough.
 *
 * Every fallback is required to be unambiguous: two different files named
 * `same.png` in different directories must not let a guess put the wrong
 * illustration in the book, so a basename (or a suffix) that matches more than
 * one image resolves to nothing.
 *
 * @param {{ exact: Map<string, string>, basename: Map<string, string> }} lookup - built lookup.
 * @param {string} src - `src` value from the chapter.
 * @param {string} [basePath] - canonical path of the chapter.
 * @returns {string} the data URL, or `''` when the image is not inlined.
 */
function lookupImageData(lookup, src, basePath) {
  const candidates = []
  const resolved = resolveRelative(basePath, src)
  if (resolved !== '') candidates.push(resolved)
  const raw = normalizeHref(String(src === undefined || src === null ? '' : src).split('#')[0].split('?')[0])
  if (raw !== '' && raw !== resolved) candidates.push(raw)
  if (candidates.length === 0) return ''
  for (const candidate of candidates) {
    const direct = lookup.exact.get(candidate)
    if (direct !== undefined) return direct
  }
  for (const candidate of candidates) {
    const name = candidate.slice(candidate.lastIndexOf('/') + 1)
    if (name === '') continue
    const byName = lookup.basename.get(name)
    if (typeof byName === 'string' && byName !== '') return byName
  }
  const suffixes = new Set()
  for (const candidate of candidates) {
    for (const [key, data] of lookup.exact) {
      if (key.endsWith(`/${candidate}`) || candidate.endsWith(`/${key}`)) suffixes.add(data)
    }
  }
  return suffixes.size === 1 ? [...suffixes][0] : ''
}

/**
 * Rewrite one scanned `<img>` token.
 *
 * A resolvable `src` becomes its `data:` URL (byte-identical to the inlined
 * image, so no request is issued); an unresolvable one loses `src` and gets an
 * empty `alt`; a tag that carried no `src` at all is dropped, because an image
 * the archive never resolved has nothing to show. `srcset` never survives: every
 * candidate in it is a real request.
 *
 * @param {{ name: string, attributes: Array<{ name: string, value: string, quote: string }> }} token - scanned tag.
 * @param {{ exact: Map<string, string>, basename: Map<string, string> }} lookup - built lookup.
 * @param {string} [basePath] - canonical path of the chapter the tag is in.
 * @returns {string} rewritten tag, or `''` when it should not render.
 */
function rewriteImageToken(token, lookup, basePath) {
  const attributes = token.attributes.filter(attribute => attribute.name !== 'srcset')
  const source = attributes.find(attribute => attribute.name === 'src')
  if (source === undefined) return ''
  // An image the chapter already inlined needs no resolution and no request.
  if (/^\s*data:/i.test(source.value)) return formatMarkupTag('img', attributes)
  const data = lookupImageData(lookup, source.value, basePath)
  if (data === '') {
    const withoutSource = attributes.filter(attribute => attribute.name !== 'src')
    if (!withoutSource.some(attribute => attribute.name === 'alt')) {
      withoutSource.push({ name: 'alt', value: '', quote: '"' })
    }
    return formatMarkupTag('img', withoutSource)
  }
  return formatMarkupTag('img', attributes.map(attribute => (
    attribute.name === 'src' ? { name: 'src', value: data, quote: attribute.quote } : attribute
  )))
}

/**
 * Point every chapter image at its inlined `data:` URL.
 *
 * Runs over the scanned tokens rather than a `<img …>` regular expression: a
 * quoted value may contain `>` (`alt="a > b"`), `data-src` is not `src`, and
 * `<img/onerror=…>` separates its attributes with `/`. `basePath` is the
 * chapter's own canonical path (`chapters[].href`), which is what makes
 * `../images/x.png` resolvable at all.
 *
 * @param {unknown} html - chapter body.
 * @param {unknown} images - `images[]` of the Host payload.
 * @param {unknown} [basePath] - canonical path of the chapter.
 * @returns {string} chapter body with inlined images.
 */
function rewriteImages(html, images, basePath) {
  if (typeof html !== 'string' || html === '') return ''
  const lookup = imageSourceLookup(images)
  const base = typeof basePath === 'string' ? basePath : ''
  let out = ''
  for (const token of scanMarkup(html)) {
    if (token.kind === 'text') {
      out += token.text
    } else if (token.kind === 'close') {
      out += `</${token.name}>`
    } else if (token.name === 'img') {
      out += rewriteImageToken(token, lookup, base)
    } else {
      out += formatMarkupTag(token.name, token.attributes.filter(attribute => attribute.name !== 'srcset'))
    }
  }
  return out
}

/**
 * Rebuild one chapter body from a tag/attribute whitelist.
 *
 * This is the only defence on the client: the Host never sanitizes, the body
 * renders inline (not in a `sandbox=""` iframe) and `dangerouslySetInnerHTML`
 * is the single injection point — shared by the panel and the preview. A
 * negative filter is not enough: `<img/onerror=…>` needs no click, and the old
 * `\son[a-z]+` pattern missed it because `/` is not whitespace. So the markup is
 * parsed into tags and re-emitted from the whitelist; nothing is copied through
 * verbatim, so a rejected fragment can never be reassembled into a live one.
 *
 * Two reasons, both about rendering inline: a chapter-local `<style>`/`<link>`
 * would escape the `.p2e-book` scope entirely (its selectors are bare), and an
 * EPUB opened from disk is untrusted input.
 *
 * @param {unknown} html - chapter body.
 * @returns {string} the body without script, styles, frames, handlers or foreign markup.
 */
function stripActiveMarkup(html) {
  if (typeof html !== 'string' || html === '') return ''
  const tokens = scanMarkup(html)
  let out = ''
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind === 'text') {
      out += token.text
      continue
    }
    const name = token.name
    // `svg:script` and friends: classify on the local name, and never keep a
    // namespaced element (no entry in KEEP_ELEMENTS carries a colon).
    const local = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
    if (token.kind === 'close') {
      if (KEEP_ELEMENTS.has(name) && !VOID_ELEMENTS.has(name)) out += `</${name}>`
      continue
    }
    if (PURGED_ELEMENTS.has(local)) {
      // A void element has no content to skip; a container is skipped up to its
      // matching close tag. An unmatched open tag only loses the tag itself, so
      // a stray `<svg>` cannot swallow the rest of the chapter.
      if (VOID_ELEMENTS.has(local)) continue
      let depth = 1
      let cursor = index + 1
      for (; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor]
        if (candidate.kind === 'text') continue
        const candidateLocal = candidate.name.includes(':')
          ? candidate.name.slice(candidate.name.lastIndexOf(':') + 1)
          : candidate.name
        if (candidateLocal !== local) continue
        depth += candidate.kind === 'open' ? 1 : -1
        if (depth === 0) break
      }
      if (cursor < tokens.length) index = cursor
      continue
    }
    if (!KEEP_ELEMENTS.has(name)) continue
    out += formatMarkupTag(name, sanitizeAttributes(token.attributes))
  }
  return out
}

/* ----------------------------------------------------- EPUB payload helpers */

/**
 * Coerce a payload field to a string.
 * @param {unknown} value - candidate.
 * @param {string} fallback - used for anything that is not a non-empty string.
 * @returns {string} the string.
 */
function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Normalise the Host's unpacked-book payload.
 *
 * The route answers `{ ok: true, title, author, language, toc, chapters, css,
 * images }`, where every `href` is a canonical zip path (`OEBPS/text/…`,
 * `OEBPS/images/…`). The optional `warnings`, `skippedImages` and
 * `imagesTruncated` diagnostics are kept rather than dropped, and an unknown
 * extra field is ignored — no field is required beyond `chapters` being an
 * array.
 *
 * @param {unknown} raw - parsed JSON body.
 * @returns {object} book model (`chapters` always an array).
 * @throws {Error} when the payload is not an object, or reports `ok: false`.
 */
function normalizeEpub(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('epub response was not an object')
  if (raw.ok === false) throw new Error(messageOf(raw.error) === '' ? 'epub request failed' : messageOf(raw.error))
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.map((chapter, index) => ({
      id: stringOr(chapter?.id, String(index + 1)),
      title: stringOr(chapter?.title, ''),
      href: stringOr(chapter?.href, ''),
      html: stringOr(chapter?.html, ''),
    }))
    : []
  const toc = Array.isArray(raw.toc)
    ? raw.toc
      .filter(entry => entry !== null && typeof entry === 'object')
      .map((entry, index) => ({
        id: stringOr(entry.id, ''),
        title: stringOr(entry.title, ''),
        level: numberOrNull(entry.level) ?? 1,
        href: stringOr(entry.href, ''),
        order: index,
      }))
    : []
  const images = Array.isArray(raw.images)
    ? raw.images
      .filter(image => image !== null && typeof image === 'object' && typeof image.data === 'string' && image.data !== '')
      .map(image => ({
        href: stringOr(image.href, ''),
        mediaType: stringOr(image.mediaType, ''),
        data: image.data,
      }))
    : []
  return {
    title: stringOr(raw.title, ''),
    author: stringOr(raw.author, ''),
    language: stringOr(raw.language, ''),
    toc,
    chapters,
    css: stringOr(raw.css, ''),
    images,
    // Optional diagnostics the route adds when it skipped or truncated images.
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(warning => typeof warning === 'string') : [],
    skippedImages: numberOrNull(raw.skippedImages) ?? 0,
    imagesTruncated: raw.imagesTruncated === true,
  }
}

/**
 * Index of the chapter a TOC entry (or a link) points at.
 *
 * The Host already resolves nav anchors onto spine chapters and sends the
 * chapter id, so the id is authoritative; `href` is the fallback for a payload
 * that only carries paths.
 *
 * @param {readonly object[]} chapters - normalised chapters.
 * @param {unknown} id - chapter id.
 * @param {unknown} href - archive href (possibly with a `#fragment`).
 * @returns {number} chapter index, or `-1`.
 */
function chapterIndexOf(chapters, id, href) {
  if (!Array.isArray(chapters)) return -1
  if (typeof id === 'string' && id !== '') {
    const byId = chapters.findIndex(chapter => chapter.id === id)
    if (byId >= 0) return byId
  }
  const wanted = normalizeHref(href).split('#')[0]
  if (wanted === '') return -1
  const byHref = chapters.findIndex(chapter => chapter.href !== '' && normalizeHref(chapter.href) === wanted)
  if (byHref >= 0) return byHref
  const name = wanted.slice(wanted.lastIndexOf('/') + 1)
  if (name === '') return -1
  return chapters.findIndex(chapter => chapter.href !== '' && normalizeHref(chapter.href).endsWith(`/${name}`))
}

/**
 * TOC rows for the reading area: one per chapter, ordered by spine position.
 *
 * The nav may nest (`level`) or skip a chapter; the reader is chapter driven,
 * so every chapter gets a row and the nav only supplies labels and depth.
 *
 * @param {object | null} book - normalised book.
 * @returns {Array<{ key: string, title: string, index: number, level: number }>} rows.
 */
function buildTocItems(book) {
  const chapters = book !== null && Array.isArray(book.chapters) ? book.chapters : []
  const entries = book !== null && Array.isArray(book.toc) ? book.toc : []
  const byIndex = new Map()
  for (const entry of entries) {
    const index = chapterIndexOf(chapters, entry.id, entry.href)
    if (index < 0 || byIndex.has(index)) continue
    byIndex.set(index, {
      key: `${entry.id === '' ? `toc:${entry.order}` : entry.id}`,
      title: entry.title === '' ? chapters[index].title : entry.title,
      index,
      level: Math.min(6, Math.max(1, Math.round(entry.level))),
    })
  }
  for (let index = 0; index < chapters.length; index += 1) {
    if (byIndex.has(index)) continue
    byIndex.set(index, { key: `spine:${index}`, title: chapters[index].title, index, level: 1 })
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index)
}

/**
 * Move a chapter index by `delta`, clamped to the chapter list.
 * @param {unknown} index - current index.
 * @param {number} length - chapter count.
 * @returns {number} a valid index (0 for an empty list).
 */
function clampChapter(index, length) {
  const last = (Number.isFinite(length) ? Math.round(length) : 0) - 1
  if (last < 0) return 0
  const value = Number.isFinite(index) ? Math.round(index) : 0
  return Math.min(Math.max(value, 0), last)
}

/**
 * The chapter step a keyboard event asks for.
 *
 * Shared by the panel and the preview so ← / → behave the same in both, and so
 * neither steals the key while the reader is typing or a handler already ran.
 *
 * @param {unknown} event - keydown event.
 * @returns {number} `-1`, `0` or `1`.
 */
function chapterKeyDelta(event) {
  if (event === null || typeof event !== 'object') return 0
  if (event.defaultPrevented === true || event.metaKey === true || event.ctrlKey === true || event.altKey === true) return 0
  const target = event.target
  if (target !== null && typeof target === 'object') {
    const tag = typeof target.tagName === 'string' ? target.tagName : ''
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true) return 0
  }
  if (event.key === 'ArrowLeft') return -1
  if (event.key === 'ArrowRight') return 1
  return 0
}

/* -------------------------------------------- EPUB addresses and transport */

/**
 * Split a `dsh-resource://file/…` address into its scope and file path.
 *
 * Hand-written on purpose: the address helper DSH uses internally
 * (`dsh-util-workspace-path`) is not in the platform module table, so a
 * self-contained bundle cannot import it (checklist C5).
 *
 * @param {unknown} address - the body's `resourceAddress`.
 * @returns {{ sessionId: string, path: string } | null} parts, or `null`.
 */
function splitResourceAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(RESOURCE_FILE_PREFIX)) return null
  const rest = address.slice(RESOURCE_FILE_PREFIX.length)
  const cut = rest.indexOf('/')
  if (cut <= 0) return null
  const scope = rest.slice(0, cut).toLowerCase()
  let body = rest.slice(cut + 1)
  const delimiter = body.search(/[?#]/)
  if (delimiter >= 0) body = body.slice(0, delimiter)
  try {
    body = decodeURIComponent(body)
  } catch {
    // Keep the raw spelling when the address is not percent-encoded cleanly.
  }
  if (scope !== 'session') return { sessionId: '', path: body }
  const slash = body.indexOf('/')
  if (slash <= 0) return null
  return { sessionId: body.slice(0, slash), path: body.slice(slash + 1) }
}

/**
 * What the preview body asks the Host to open.
 *
 * The document body contract (`document/contract.ts`) carries no path field —
 * only `resourceAddress` — and that address names a file *the way the caller
 * holds it*: `fileAddressFor` strips the Session's workspace root, so a file the
 * reader clicked in the Sidebar arrives as the workspace-relative tail
 * `books/novel.epub`, not as an absolute path. The address still identifies the
 * Session, and that is what makes the request resolvable: the Session id and the
 * path are sent together and the Host roots the path at that Session's working
 * directory.
 *
 * Three sources are tried in order, and the Session comes from whichever they
 * imply:
 *   1. `absolutePath` — what the standard `useResource` hook reports (see
 *      {@link useDocumentAbsolutePath}). The most direct answer, when the owner
 *      supplies the hook.
 *   2. `props.path` / `filePath` / `uri` / `absolutePath` — kept as a
 *      compatibility fallback for an owner that does carry one.
 *   3. the tail of `resourceAddress`, which is what the shipped owner really
 *      provides.
 *
 * @param {object | null | undefined} props - document body props.
 * @param {string} [absolutePath] - path resolved through the `useResource` hook.
 * @returns {{ path: string, sessionId: string }} the request target; `path === ''` means "no usable path".
 */
function documentTarget(props, absolutePath) {
  const hooked = typeof absolutePath === 'string' ? absolutePath.trim() : ''
  if (props === null || typeof props !== 'object') return { path: hooked, sessionId: '' }
  const parts = splitResourceAddress(props.resourceAddress)
  const addressPath = parts === null ? '' : parts.path
  const addressSession = parts === null ? '' : parts.sessionId
  const propSession = typeof props.sessionId === 'string' ? props.sessionId.trim() : ''
  const direct = firstValue([
    hooked === '' ? undefined : hooked,
    typeof props.path === 'string' ? props.path : undefined,
    typeof props.filePath === 'string' ? props.filePath : undefined,
    typeof props.uri === 'string' ? props.uri : undefined,
    typeof props.absolutePath === 'string' ? props.absolutePath : undefined,
  ])
  const filePath = typeof direct === 'string' ? direct.trim() : addressPath
  // A path taken from the address is relative to the Session the address names;
  // a path the caller supplied directly belongs to the tab's own Session. In
  // the shipped runtime both carry the same id, so this only matters if they
  // ever disagree — and then the root has to follow the path, not the tab.
  const preferred = filePath === addressPath && addressPath !== ''
    ? [addressSession, propSession]
    : [propSession, addressSession]
  const sessionId = firstValue(preferred)
  return { path: filePath, sessionId: typeof sessionId === 'string' ? sessionId : '' }
}

/**
 * File path of the document a preview body is showing, without the Session.
 *
 * The pair is what the request needs ({@link documentTarget}); this is the bare
 * string for the places that only ask "is there a path at all".
 *
 * @param {object | null | undefined} props - document body props.
 * @returns {string} the path, or `''`.
 */
function documentFilePath(props) {
  return documentTarget(props, '').path
}

/**
 * The absolute path the standard `useResource` hook knows for this document.
 *
 * `useResource` is a *slot standard prop*, not a module: every slot component
 * receives it, so nothing has to be added to the platform require table
 * (`slot-catalog` `standardProps`, and `MarkdownBody.tsx:35` is the shipped
 * precedent). It is a hook, so the call below is unconditional at the top of the
 * body; only its result is tested. The prop is fixed for the lifetime of one
 * mounted body, so the inner `typeof` guard cannot change the hook order.
 *
 * @param {object | null | undefined} props - document body props.
 * @returns {string} absolute path, or `''` when the owner passes no hook / no value.
 */
function useDocumentAbsolutePath(props) {
  const hook = props !== null && typeof props === 'object' && typeof props.useResource === 'function'
    ? props.useResource
    : null
  const address = props !== null && typeof props === 'object' && typeof props.resourceAddress === 'string'
    ? props.resourceAddress
    : ''
  if (hook === null || address === '') return ''
  let snapshot
  try {
    // `useResource<P>(address)`: the protocol is a type argument, not an
    // argument, and an address with no provider comes back as `status: 'none'`
    // rather than throwing.
    snapshot = hook(address)
  } catch {
    return ''
  }
  const value = snapshot !== null && typeof snapshot === 'object' ? snapshot.value : undefined
  const absolute = value !== null && typeof value === 'object' ? value.absolutePath : undefined
  return typeof absolute === 'string' ? absolute : ''
}

/**
 * Resolve one of the client services the panel/preview need, without an
 * `inject` entry.
 *
 * `documentPreviews` is provided with `ctx.reflect.provide`, and whether a
 * third-party bundle may declare it in `inject` is unproven (research §6.3), so
 * the service is probed instead. Two rules make the probe safe:
 *
 *   - `ctx.get(name)` first: Cordis' own lookup, allowed by the plugin facade,
 *     and the only one that can see a `reflect.provide`d service.
 *   - never a plain `ctx[name]` read. On a Cordis context that is a getter that
 *     *throws* for a name this plugin did not declare in `inject`
 *     (`reflect.ts:152-180`: `cannot get property "…" without inject`), and an
 *     escaping throw during `apply` rolls back every effect already registered —
 *     the sidebar panel included. The own-property descriptor is read instead, so
 *     a getter is never invoked.
 *
 * `undefined` means "not installed here"; callers must degrade instead of
 * throwing.
 *
 * @param {object | null | undefined} ctx - Cordis client context.
 * @param {string} name - service name.
 * @returns {unknown} the service, or `undefined`.
 */
function clientService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // An accessor that refuses unknown names is the documented "absent" case.
    }
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(ctx, name)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(ctx, name)
    if (descriptor === undefined || !('value' in descriptor)) return undefined
    const direct = descriptor.value
    return direct === undefined || direct === null ? undefined : direct
  } catch {
    // A proxy-backed context may refuse even this read.
    return undefined
  }
}

/* ------------------------------------------------- choosing a local file */

/**
 * The Desktop preload's file-path bridge, when this page is the Desktop app.
 *
 * `preload-app.cjs` exposes `__DSH_HOST_PATHS__` to `dsh-app://app` pages and
 * nothing else, so a plain browser tab never has it. It is the only surface in
 * the whole application that turns a picked `File` back into an **absolute host
 * path** (`electron.webUtils.getPathForFile`, which replaced the removed
 * `File.path`); a page cannot read a path off a `File` by itself, by design.
 *
 * @returns {{ pathFor: (file: unknown) => string } | null} the bridge, or `null` outside Desktop.
 */
function desktopPathBridge() {
  if (typeof window !== 'object' || window === null) return null
  let bridge
  try {
    bridge = window.__DSH_HOST_PATHS__
  } catch {
    // A locked-down window may refuse the property read.
    return null
  }
  if (bridge === null || typeof bridge !== 'object') return null
  return typeof bridge.pathFor === 'function' ? bridge : null
}

/**
 * Open the operating system's file chooser and resolve the chosen PDF's path.
 *
 * The chooser is the browser's own: an `<input type="file">` clicked inside the
 * user's gesture makes Chromium show the platform "Open" dialog with the
 * `accept` filter applied, which is exactly the native picker with a `.pdf`
 * filter that a Web page is allowed to have. The preload bridge then maps the
 * selected `File` onto its absolute path.
 *
 * Cancellation is not an error: Chromium fires `cancel` on the input (and, on
 * older builds, nothing at all — the promise then simply stays pending until
 * the input is used again). A reported cancel resolves `{ ok: false }` so the
 * caller leaves the typed path untouched.
 *
 * @param {{ pathFor: (file: unknown) => string }} bridge - the Desktop path bridge.
 * @param {object | null} mount - element the input is attached to, if any.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: 'cancelled' | 'unavailable' }> | null} the outcome, or `null` when no chooser can be built.
 */
function choosePdfWithDesktopBridge(bridge, mount) {
  if (typeof document !== 'object' || document === null) return null
  if (typeof document.createElement !== 'function') return null
  let input
  try {
    input = document.createElement('input')
  } catch {
    return null
  }
  if (input === null || typeof input !== 'object') return null

  return new Promise((resolve) => {
    let settled = false
    /** Report one outcome once, removing the input and its listeners. */
    const finish = (outcome) => {
      if (settled) return
      settled = true
      detachListener(input, 'change', onChange)
      detachListener(input, 'cancel', onCancel)
      const parent = input.parentNode
      if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') {
        try {
          parent.removeChild(input)
        } catch {
          // Already detached: nothing left to clean up.
        }
      }
      resolve(outcome)
    }
    const onChange = () => {
      const files = input.files
      const file = files !== null && files !== undefined && files.length > 0 ? files[0] : null
      if (file === null || file === undefined) {
        finish({ ok: false, reason: 'cancelled' })
        return
      }
      let absolute = ''
      try {
        absolute = bridge.pathFor(file)
      } catch {
        absolute = ''
      }
      // `getPathForFile` answers '' for a value it cannot map: the caller then
      // falls back to the in-app picker instead of storing a broken path.
      finish(typeof absolute === 'string' && absolute !== '' ? { ok: true, path: absolute } : { ok: false, reason: 'unavailable' })
    }
    const onCancel = () => finish({ ok: false, reason: 'cancelled' })

    input.type = 'file'
    input.accept = PDF_ACCEPT
    input.multiple = false
    if (input.style !== null && typeof input.style === 'object') input.style.display = 'none'
    if (typeof input.addEventListener === 'function') {
      input.addEventListener('change', onChange)
      input.addEventListener('cancel', onCancel)
    }
    if (mount !== null && mount !== undefined && typeof mount.appendChild === 'function') {
      try {
        mount.appendChild(input)
      } catch {
        // A detached input still opens the chooser in Chromium.
      }
    }
    if (typeof input.click === 'function') input.click()
    else finish({ ok: false, reason: 'unavailable' })
  })
}

/** Remove one listener from a node that may be a stub. */
function detachListener(node, type, listener) {
  if (node === null || node === undefined || typeof node.removeEventListener !== 'function') return
  try {
    node.removeEventListener(type, listener)
  } catch {
    // Nothing to detach from.
  }
}

/**
 * The Client `directoryPicker` Remote namespace, when this page has it.
 *
 * A hand-written client reaches it as a plain service: `ctx.remote` is mounted
 * by the API assembly, and the namespace's two verbs are mutually exclusive by
 * construction — the Host composes **one** backend, and
 * `DirectoryPickerController.requireCapability` refuses the verb the other kind
 * owns (`directory-picker/unavailable`). A Desktop Host resolves `native`
 * (`pick`), a remote one `browse` (`list`).
 *
 * @param {object} ctx - Cordis client context.
 * @returns {{ list: Function } | null} the namespace, or `null` when absent.
 */
function directoryPickerRemote(ctx) {
  const remote = clientService(ctx, 'remote')
  if (remote === null || typeof remote !== 'object') return null
  let picker
  try {
    picker = remote.directoryPicker
  } catch {
    return null
  }
  if (picker === null || typeof picker !== 'object') return null
  return typeof picker.list === 'function' ? picker : null
}

/**
 * Unwrap one Remote answer.
 *
 * Generated Remote methods resolve `RemoteResult` (`{ ok, value }` /
 * `{ ok, error }`) instead of rejecting, so a refusal has to be raised here
 * before the value is read.
 *
 * @param {unknown} result - what the Remote call resolved.
 * @param {string} fallback - message for a refusal that carries none.
 * @returns {unknown} the success value.
 * @throws {Error & { code?: string }} when the Host refused the call.
 */
function remoteValue(result, fallback) {
  if (result === null || typeof result !== 'object') return result
  if (typeof result.ok !== 'boolean') return result
  if (result.ok === true) return result.value
  const failure = result.error
  const described = failure !== null && typeof failure === 'object' && typeof failure.message === 'string'
    ? failure.message
    : ''
  const error = new Error(described === '' ? fallback : described)
  if (failure !== null && typeof failure === 'object' && typeof failure.code === 'string') error.code = failure.code
  throw error
}

/* ------------------------------------------------------ model catalogue */

/**
 * Sentinel value of the 「自定义…」 row.
 *
 * A legal route always contains a slash (`parseRoute` rejects anything else,
 * `src/host/bridge.js:145-150`), so a slash-free string can never collide with
 * a real `provider/model` — the route itself is never parsed back out of this.
 */
const CUSTOM_MODEL_OPTION = '__custom__'

/** View of the catalogue before the first answer: the panel stays usable. */
const MODEL_CATALOG_LOADING = Object.freeze({ phase: 'loading', groups: [], defaultRoute: '' })

/** In-flight / settled `session.modelCatalog()` read, shared by every mount. */
let modelCatalogCache = null

/** Last settled view, so a remount renders the list instead of the spinner. */
let modelCatalogView = null

/**
 * The `session` namespace of the Client `remote` service, or `null`.
 *
 * `modelCatalog()` is the built-in model picker's own source: a zero-argument
 * `direct` Remote (`dsh-api-session-controller/src/index.ts:343-346`, wire
 * descriptor `lib/typert.host.js:2201`), so no host route and no `inject`
 * declaration is needed (research: `notes/model-catalog.md` §1.1, §3).
 *
 * Probed through `clientService()` for the reason documented there: a plain
 * `ctx.session` read throws for an undeclared name and would roll the panel
 * back. `remote.session` itself is a plain namespace object.
 *
 * @param {object | null | undefined} ctx - Cordis client context.
 * @returns {{ modelCatalog: Function } | null} the namespace, or `null`.
 */
function modelCatalogRemote(ctx) {
  const remote = clientService(ctx, 'remote')
  if (remote === null || typeof remote !== 'object') return null
  let session
  try {
    session = remote.session
  } catch {
    return null
  }
  if (session === null || typeof session !== 'object') return null
  return typeof session.modelCatalog === 'function' ? session : null
}

/**
 * Localised text of an `LlmModelBadge`.
 *
 * The wire type is `{ text: string | localized map, tone }`. The platform's
 * built-in picker resolves the map through its own translator; this bundle has
 * no such binding, so a plain string wins and a map falls back to zh then en.
 *
 * @param {unknown} badge - `ModelCatalogModel.badge`.
 * @returns {string} the badge text, or `''`.
 */
function modelBadgeText(badge) {
  if (badge === null || typeof badge !== 'object') return ''
  const text = badge.text
  if (typeof text === 'string') return text.trim()
  if (text === null || typeof text !== 'object') return ''
  for (const locale of ['zh', 'en']) {
    const entry = text[locale]
    if (typeof entry === 'string' && entry.trim() !== '') return entry.trim()
  }
  return ''
}

/**
 * Flatten a `ModelCatalog` into the panel's option groups.
 *
 * `ModelProviderGroup` is `{ id, name, models }` (`dsh-api-session-controller/
 * src/types.ts:120-132`): **`groups[].id` is the provider id**, which is why the
 * option value is `${group.providerId ?? group.id}/${model.id}`. The route is
 * joined once and handed to the Host whole — the pipeline's `parseRoute` splits
 * on the *first* slash (`src/host/bridge.js:145-150`), so a model id that itself
 * contains slashes survives intact.
 *
 * @param {unknown} value - `ModelCatalog` from the Remote.
 * @returns {{ groups: object[], defaultRoute: string } | null} view, or null.
 */
function readModelCatalog(value) {
  if (value === null || typeof value !== 'object') return null
  const rawGroups = Array.isArray(value.groups) ? value.groups : []
  const groups = []
  for (const group of rawGroups) {
    if (group === null || typeof group !== 'object') continue
    const provider = typeof group.providerId === 'string' && group.providerId !== ''
      ? group.providerId
      : (typeof group.id === 'string' ? group.id : '')
    if (provider === '') continue
    const rawModels = Array.isArray(group.models) ? group.models : []
    const models = []
    for (const model of rawModels) {
      if (model === null || typeof model !== 'object') continue
      const id = typeof model.id === 'string' ? model.id : ''
      if (id === '') continue
      const name = typeof model.name === 'string' && model.name.trim() !== '' ? model.name : id
      const badge = modelBadgeText(model.badge)
      models.push({
        id,
        route: `${provider}/${id}`,
        // `model.name` first, then the id; the badge is an annotation on it.
        label: badge === '' ? name : `${name} · ${badge}`,
        description: typeof model.description === 'string' ? model.description : '',
      })
    }
    // The host drops empty groups too (`catalog.ts:65-66`); keep that invariant.
    if (models.length === 0) continue
    groups.push({
      id: provider,
      name: typeof group.name === 'string' && group.name.trim() !== '' ? group.name : provider,
      models,
    })
  }
  const fallback = value.default
  const defaultRoute = fallback !== null && typeof fallback === 'object'
    && typeof fallback.provider === 'string' && fallback.provider !== ''
    && typeof fallback.model === 'string' && fallback.model !== ''
    ? `${fallback.provider}/${fallback.model}`
    : ''
  return { groups, defaultRoute }
}

/**
 * One `session.modelCatalog()` read, normalised for the panel.
 *
 * Every failure mode collapses into a view instead of a rejection: the catalogue
 * is only routable providers, so "no credentials" is an ordinary state, and the
 * panel must fall back to the text input rather than lose the advanced block.
 *
 * @param {object | null | undefined} ctx - Cordis client context.
 * @returns {Promise<{ phase: string, groups: object[], defaultRoute: string }>} view.
 */
async function fetchModelCatalog(ctx) {
  const served = await fetchServedCatalog()
  if (served.phase !== 'failed') return served
  const api = modelCatalogRemote(ctx)
  if (api === null) return served
  try {
    // RemoteResult: `{ ok: true, value }` / `{ ok: false, error }`.
    const catalog = readModelCatalog(remoteValue(await api.modelCatalog(), 'model catalog unavailable'))
    if (catalog === null || catalog.groups.length === 0) {
      return { phase: 'empty', groups: [], defaultRoute: '' }
    }
    return { phase: 'ready', groups: catalog.groups, defaultRoute: catalog.defaultRoute }
  } catch (error) {
    const reason = typeof served.reason === 'string' && served.reason !== '' ? served.reason : messageOf(error)
    return { phase: 'failed', groups: [], defaultRoute: '', reason }
  }
}

/**
 * Read the catalogue from this plugin's own Host route.
 *
 * The generated `ctx.remote.session.modelCatalog()` namespace only exists for a
 * bundle that declares the API dependency; a hand-written client cannot, so the
 * Host serves the same wire `ModelCatalog` under {@link MODELS_PATH} and that
 * route is read first. The Remote probe above stays as the fallback for a Host
 * that predates the route.
 *
 * @returns {Promise<{ phase: string, groups: object[], defaultRoute: string, reason?: string }>}
 *   the view; `phase: 'failed'` means "ask the Remote next", and carries why the
 *   route refused so the panel can say it if nothing else answers.
 */
async function fetchServedCatalog() {
  try {
    const catalog = readModelCatalog(await requestJson(MODELS_PATH, { cache: 'no-store' }))
    if (catalog === null || catalog.groups.length === 0) {
      return { phase: 'empty', groups: [], defaultRoute: '', reason: '' }
    }
    return { phase: 'ready', groups: catalog.groups, defaultRoute: catalog.defaultRoute }
  } catch (error) {
    return { phase: 'failed', groups: [], defaultRoute: '', reason: messageOf(error) }
  }
}

/**
 * Read the catalogue at most once per page, and never twice concurrently.
 *
 * Only a settled answer is cached: a failure is forgotten so the next panel
 * mount retries (credentials may have been configured in between).
 *
 * @param {object | null | undefined} ctx - Cordis client context.
 * @returns {Promise<{ phase: string, groups: object[], defaultRoute: string }>} view.
 */
function loadModelCatalog(ctx) {
  if (modelCatalogCache !== null) return modelCatalogCache
  modelCatalogCache = fetchModelCatalog(ctx).then((view) => {
    if (view.phase === 'failed') modelCatalogCache = null
    else modelCatalogView = view
    return view
  })
  return modelCatalogCache
}

/** Strip trailing path separators, keeping a root (`/`, `C:\`) whole. */
function trimTrailingSeparators(text) {
  let end = text.length
  while (end > 1 && (text[end - 1] === '\\' || text[end - 1] === '/')) end -= 1
  // 'C:\' must not collapse to 'C:', which names the drive's current directory.
  if (end === 2 && /^[A-Za-z]:$/.test(text.slice(0, 2))) return text.slice(0, 3)
  return text.slice(0, end)
}

/**
 * Parent of a path, using whichever separator the platform wrote.
 *
 * @param {string} text - a path with or without trailing separators.
 * @returns {string} the parent, or `''` when there is none to name.
 */
function parentDirectory(text) {
  const trimmed = trimTrailingSeparators(text)
  if (trimmed === '') return ''
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut < 0) return ''
  if (cut === 0) return trimmed.slice(0, 1)
  // 'C:\x' has the drive root as its parent, not 'C:'.
  if (cut === 2 && /^[A-Za-z]:$/.test(trimmed.slice(0, 2))) return trimmed.slice(0, 3)
  return trimmed.slice(0, cut)
}

/**
 * Directory the in-app picker starts in for one typed path.
 *
 * @param {string} input - the panel's current path field.
 * @returns {string} a directory, or `''` to let the Host list the home directory.
 */
function startDirectoryOf(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return ''
  if (/[\\/]$/.test(text)) return trimTrailingSeparators(text)
  return parentDirectory(text)
}

/**
 * Whether one listing row names a file rather than a directory.
 *
 * The `browse` backend reports **directories only** (its `list` skips every
 * dirent that is neither a directory nor a symlink to one), so no row it sends
 * carries a kind. Rows are therefore directories unless the wire says
 * otherwise; a backend that ever reports files is honoured through `type` /
 * `isDirectory`, and the caller then keeps just the `.pdf` ones.
 *
 * @param {object} entry - one `DirectoryEntry` from a listing.
 * @returns {boolean} true for a file row.
 */
function entryIsFile(entry) {
  if (typeof entry.type === 'string') return entry.type === 'file'
  if (typeof entry.isDirectory === 'boolean') return entry.isDirectory === false
  return false
}

/**
 * Normalise one listing into picker rows: directories, then `.pdf` files.
 *
 * @param {unknown} listing - the `DirectoryListing` the Host answered.
 * @returns {{ path: string, up: string, entries: Array<{ name: string, path: string, isFile: boolean }> }} rows plus the parent target.
 */
function listingView(listing) {
  const source = listing !== null && typeof listing === 'object' ? listing : {}
  const path = typeof source.path === 'string' ? source.path : ''
  const directories = []
  const files = []
  const rows = Array.isArray(source.entries) ? source.entries : []
  for (const entry of rows) {
    if (entry === null || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name : ''
    const target = typeof entry.path === 'string' ? entry.path : ''
    if (name === '' || target === '') continue
    if (entryIsFile(entry)) {
      if (!PDF_SUFFIX_RE.test(name)) continue
      files.push({ name, path: target, isFile: true })
      continue
    }
    directories.push({ name, path: target, isFile: false })
  }
  const byName = (left, right) => left.name.localeCompare(right.name)
  directories.sort(byName)
  files.sort(byName)
  // The ancestry the Host ships is the reliable "up": it is rooted at the real
  // filesystem root, which no string operation on the listed path can be sure of.
  const crumbs = Array.isArray(source.crumbs) ? source.crumbs : []
  const above = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : null
  const parent = above !== null && typeof above === 'object' && typeof above.path === 'string' && above.path !== ''
    ? above.path
    : parentDirectory(path)
  // A filesystem root has no parent to offer: the Host's chain stops there, and
  // a computed parent of the root is the root itself.
  const up = parent === path ? '' : parent
  return { path, up, entries: directories.concat(files) }
}

/**
 * Fetch and prepare one `.epub` for the reading area.
 *
 * Same-origin HTTP, like every other Host call in this bundle. The Host always
 * answers JSON: `{ ok: true, … }` for a book and `{ ok: false, error }` with a
 * 400/404/413/415/500 status otherwise, which `requestJson` turns into a thrown
 * error carrying that status (so the error state can tell a permanent refusal
 * from a transient one). The payload carries no file version, so the renderer
 * handshake below reports the unknown revision as `0`.
 *
 * `sessionId` is always sent when one is known: it is what lets the Host resolve
 * a workspace-relative `path`, and it costs nothing when `path` is already
 * absolute.
 *
 * @param {{ path: string, sessionId: string }} target - what to open.
 * @param {AbortSignal} signal - cancellation for unmount.
 * @returns {Promise<object>} prepared book model (chapters already inlined).
 */
async function fetchEpubBook(target, signal) {
  const parameters = []
  if (target.sessionId !== '') parameters.push(`sessionId=${encodeURIComponent(target.sessionId)}`)
  parameters.push(`path=${encodeURIComponent(target.path)}`)
  const query = `${EPUB_PATH}?${parameters.join('&')}`
  const book = normalizeEpub(await requestJson(query, { signal, cache: 'no-store' }))
  return {
    ...book,
    chapters: book.chapters.map(chapter => ({
      ...chapter,
      // `chapter.href` is the canonical zip path, i.e. exactly the base a
      // chapter-relative `src` has to be resolved against.
      html: rewriteImages(stripActiveMarkup(chapter.html), book.images, chapter.href),
    })),
  }
}

/* ---------------------------------------------------------- locale helpers */

/**
 * Fill the `{name}` placeholders of one template.
 *
 * The registry translates and fills in one call, but the degraded path below
 * replays the same substitution over the inlined dictionary.
 *
 * @param {string} template - copy carrying `{name}` placeholders.
 * @param {Record<string, unknown>} [params] - substitution values.
 * @returns {string} filled copy; placeholders without a value stay verbatim.
 */
function fillParams(template, params) {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/**
 * Whether a `locale.register` throw is the "this namespace already owns that
 * locale" conflict — the one registration error a repeated `apply` may ignore.
 *
 * `LocaleRuntime.register` rejects duplicates with
 * `locale namespace "<ns>" already has locale "<id>"`; the shipped dictionaries
 * are identical every time, so the first registration already holds the copy.
 *
 * @param {unknown} error - thrown value.
 * @returns {boolean} true for an already-registered conflict.
 */
function isDuplicateLocaleError(error) {
  return /already/i.test(messageOf(error))
}

/* ------------------------------------------------------------------ helpers */

/**
 * Read a nested property without throwing on a missing intermediate object.
 * @param {unknown} root - value to walk.
 * @param {readonly string[]} keys - path segments.
 * @returns {unknown} the value, or undefined.
 */
function readPath(root, keys) {
  let node = root
  for (const key of keys) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

/**
 * First non-empty value of a candidate list (0 and false are kept).
 * @param {readonly unknown[]} values - candidates in priority order.
 * @returns {unknown} the value, or undefined.
 */
function firstValue(values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    return value
  }
  return undefined
}

/**
 * Coerce to a finite number.
 * @param {unknown} value - candidate.
 * @returns {number | null} finite number or null.
 */
function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Plain text of an arbitrary error-ish value.
 * @param {unknown} value - thrown value or Host payload.
 * @returns {string} message text (may be empty).
 */
function messageOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    for (const key of ['message', 'detail', 'reason']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    const nested = value.error
    if (nested !== undefined && nested !== value && nested !== null) return messageOf(nested)
    if (typeof value.code === 'string') return value.code
    return ''
  }
  return String(value)
}

/**
 * Normalise a Host error field into `{ code, message }`.
 * @param {unknown} value - Host error payload.
 * @returns {{ code: string, message: string } | null} normalised error.
 */
function describeError(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'object') {
    const code = typeof value.code === 'string' ? value.code : ''
    const message = messageOf(value)
    if (code === '' && message === '') return { code: '', message: 'unrecognised error' }
    return { code, message }
  }
  return { code: '', message: String(value) }
}

/**
 * An error that carries a locale key so the panel can localise it.
 * @param {string} localeKey - key in the `pdf2epub` namespace.
 * @param {string} message - untranslated fallback text.
 * @returns {Error} the decorated error.
 */
function localError(localeKey, message) {
  const error = new Error(message)
  error.localeKey = localeKey
  return error
}

/**
 * `PDF_NOT_FOUND` -> `pdfNotFound`, the shape of the `error.*` locale keys.
 * @param {string} code - Host error code.
 * @returns {string} camel-cased code.
 */
function camelize(code) {
  const parts = String(code).toLowerCase().split(/[^a-z0-9]+/).filter(part => part !== '')
  if (parts.length === 0) return ''
  return parts[0] + parts.slice(1).map(part => part[0].toUpperCase() + part.slice(1)).join('')
}

/**
 * Parse a comma separated model list.
 * @param {string} text - raw input.
 * @returns {string[]} trimmed non-empty entries.
 */
function parseModels(text) {
  return String(text)
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * Parse an optional integer field.
 * @param {string} text - raw input.
 * @returns {number | undefined} rounded number, or undefined when blank/invalid.
 */
function parseInteger(text) {
  const trimmed = String(text).trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? Math.round(value) : undefined
}

/**
 * Format a token count for the status line.
 * @param {unknown} value - token total.
 * @returns {string} display text.
 */
function formatTokens(value) {
  const count = numberOrNull(value)
  if (count === null || count <= 0) return '0'
  return Math.round(count).toLocaleString('en-US')
}

/**
 * Format a duration in milliseconds.
 * @param {unknown} value - milliseconds.
 * @returns {string} `850 ms`, `1.8 s`, `12:03` or `—`.
 */
function formatDuration(value) {
  const ms = numberOrNull(value)
  if (ms === null || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const pad = part => String(part).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}

/**
 * Normalise the progress snapshot the Host serves.
 *
 * The fields the panel contract pins down (a phase, `page`/`total`, tokens,
 * elapsed time, a terminal error) are read directly; the remaining plausible
 * spellings are accepted because a Host/serialiser mismatch must degrade to a
 * readable panel rather than a blank one.
 *
 * @param {unknown} raw - parsed JSON body.
 * @param {number} startedAt - wall clock when the job was accepted (0 when unknown).
 * @returns {object} panel job model.
 */
function normalizeState(raw, startedAt = 0) {
  if (raw === null || typeof raw !== 'object') throw new Error('state response was not an object')
  const phaseValue = firstValue([raw.phase, raw.state, raw.status])
  let phase = typeof phaseValue === 'string' && phaseValue !== '' ? phaseValue : 'idle'
  if (phase === 'cancelled' || phase === 'canceled' || phase === 'error') phase = 'failed'
  const pages = raw.pages !== null && typeof raw.pages === 'object' ? raw.pages : undefined
  const progress = raw.progress !== null && typeof raw.progress === 'object' ? raw.progress : undefined
  const page = numberOrNull(firstValue([raw.page, progress?.page, pages?.done, raw.currentPage])) ?? 0
  const total = numberOrNull(firstValue([raw.total, raw.totalPages, progress?.total, pages?.total])) ?? 0
  const tokensField = firstValue([raw.tokens, raw.tokenUsage, raw.usage])
  let tokens = null
  if (tokensField !== null && tokensField !== undefined && typeof tokensField === 'object') {
    const input = numberOrNull(tokensField.input) ?? 0
    const output = numberOrNull(tokensField.output) ?? 0
    tokens = numberOrNull(tokensField.total) ?? (input + output)
  } else {
    tokens = numberOrNull(tokensField)
  }
  const duration = firstValue([raw.ms, raw.durationMs, raw.elapsedMs, raw.duration, raw.timing?.totalMs, raw.timing?.elapsedMs])
  const errorValue = firstValue([raw.error, raw.failure, phase === 'failed' ? raw.message : undefined])
  const bookPath = firstValue([
    typeof raw.bookJsonPath === 'string' ? raw.bookJsonPath : undefined,
    typeof raw.bookPath === 'string' ? raw.bookPath : undefined,
    typeof readPath(raw, ['outputs', 'bookJson']) === 'string' ? readPath(raw, ['outputs', 'bookJson']) : undefined,
    typeof readPath(raw, ['outputs', 'book']) === 'string' ? readPath(raw, ['outputs', 'book']) : undefined,
    typeof readPath(raw, ['report', 'outputs', 'book']) === 'string' ? readPath(raw, ['report', 'outputs', 'book']) : undefined,
    typeof readPath(raw, ['book', 'path']) === 'string' ? readPath(raw, ['book', 'path']) : undefined,
  ])
  const inlineBook = raw.book !== null && typeof raw.book === 'object' && Array.isArray(raw.book.chapters)
    ? normalizeBook(raw.book)
    : null
  // The Host state carries no elapsed time, so the panel measures it: from the
  // moment the job was accepted to the snapshot being read.
  const reportedMs = numberOrNull(duration)
  const measuredMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0
  return {
    jobId: typeof raw.jobId === 'string' ? raw.jobId : '',
    phase,
    page,
    total,
    tokens: tokens === null ? 0 : tokens,
    ms: reportedMs ?? measuredMs,
    startedAt,
    error: describeError(errorValue),
    bookPath: typeof bookPath === 'string' ? bookPath : '',
    book: inlineBook,
  }
}

/**
 * Normalise the book payload rendered in the reading area.
 *
 * The chapter bodies are sanitised here rather than at the injection point, so
 * every reader — the panel's `/book` payload, the inline `book` a `/state`
 * snapshot may carry, and the preview — shares one choke point. The panel has no
 * `images[]` to inline, so its images stay whatever the pipeline wrote into the
 * zip (data URLs survive {@link stripActiveMarkup}; a relative `src` survives it
 * too and simply resolves against the app's own origin, which is exactly what
 * the preview's image rewriter then replaces).
 *
 * @param {unknown} raw - parsed JSON body.
 * @returns {{ title: string, language: string, chapters: { id: string, title: string, html: string }[] }} book model.
 */
function normalizeBook(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('book response was not an object')
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.map((chapter, index) => ({
      id: typeof chapter?.id === 'string' ? chapter.id : String(index),
      title: typeof chapter?.title === 'string' ? chapter.title : '',
      html: stripActiveMarkup(typeof chapter?.html === 'string' ? chapter.html : ''),
    }))
    : []
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    language: typeof raw.language === 'string' ? raw.language : '',
    chapters,
  }
}

/**
 * Client statuses that are a 4xx but still worth retrying.
 *
 * `408` is a timeout and `429` is a rate limit: the same request may well work
 * in a moment. Every other 4xx is an answer about the request itself.
 */
const RETRYABLE_CLIENT_STATUS = new Set([408, 429])

/**
 * Whether a failed request can succeed if it is simply repeated.
 *
 * The Host's refusals are answers about the request itself: a 400 (a missing or
 * unusable parameter, a workspace-relative path with no Session), a 403, a 404
 * (no such file / no such Session), a 413 (archive too large) or a 415 (not a
 * readable EPUB) will answer exactly the same way on a retry, so offering a
 * retry button there is a lie. A transport failure carries no `.status` at all,
 * and a 5xx (or 408/429) is a bad moment — those are worth retrying.
 *
 * @param {unknown} error - thrown value from `requestJson`.
 * @returns {boolean} true when retrying cannot help.
 */
function isPermanentFailure(error) {
  const status = error !== null && typeof error === 'object' ? error.status : undefined
  if (typeof status !== 'number') return false
  if (status < 400 || status >= 500) return false
  return !RETRYABLE_CLIENT_STATUS.has(status)
}

/**
 * Fetch one JSON endpoint, turning non-2xx answers into thrown errors.
 *
 * The thrown error keeps the HTTP status on `.status`, which is what lets the
 * preview avoid offering a retry for a refusal that cannot change (an invalid
 * or oversized archive) while the panel keeps showing the message alone.
 *
 * @param {string} url - same-origin URL.
 * @param {RequestInit} [init] - fetch options.
 * @returns {Promise<object>} parsed JSON object.
 */
async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!response.ok) {
    const detail = body === null || typeof body !== 'object' ? '' : messageOf(body.error ?? body.message)
    const status = `${response.status} ${response.statusText}`.trim()
    const error = new Error(detail === '' ? status : `${status} — ${detail}`)
    error.status = response.status
    throw error
  }
  if (body === null || typeof body !== 'object') throw new Error('response was not a JSON object')
  return body
}

/**
 * Ask the Host to start a conversion.
 * @param {object} payload - conversion spec (`input`, optional model fields).
 * @returns {Promise<{ jobId: string, startedAt: number }>} accepted job.
 */
async function postRun(payload) {
  const startedAt = Date.now()
  const body = await requestJson(RUN_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const jobId = firstValue([
    typeof body.jobId === 'string' ? body.jobId : undefined,
    typeof body.id === 'string' ? body.id : undefined,
    typeof readPath(body, ['job', 'id']) === 'string' ? readPath(body, ['job', 'id']) : undefined,
  ])
  if (typeof jobId !== 'string' || jobId === '') throw new Error('run response carried no jobId')
  return { jobId, startedAt }
}

/**
 * Read the progress snapshot of one job.
 * @param {string} jobId - Host job id.
 * @param {AbortSignal} signal - cancellation for unmount.
 * @param {number} startedAt - wall clock when the job was accepted.
 * @returns {Promise<object>} normalised job model.
 */
async function fetchState(jobId, signal, startedAt) {
  const query = `${STATE_PATH}?jobId=${encodeURIComponent(jobId)}`
  return normalizeState(await requestJson(query, { signal, cache: 'no-store' }), startedAt)
}

/**
 * Read the generated book JSON.
 * @param {string} path - Host path of the book JSON.
 * @param {AbortSignal} signal - cancellation for unmount.
 * @returns {Promise<object>} normalised book model.
 */
async function fetchBook(path, signal) {
  const query = `${BOOK_PATH}?path=${encodeURIComponent(path)}`
  const book = normalizeBook(await requestJson(query, { signal, cache: 'no-store' }))
  if (book.chapters.length === 0) throw localError('error.noChapters', 'book response carried no chapters')
  return book
}

/* ------------------------------------------------------- module-level cache */

/**
 * Panel state that must survive a main-panel switch. The `main` slot renders
 * only the selected entry, so leaving the panel unmounts it; keeping the last
 * snapshot here is what makes coming back read from memory instead of issuing
 * fresh `/state` and `/book` requests.
 *
 * @type {{
 *   path: string,
 *   job: object | null,
 *   book: object | null,
 *   bookPath: string,
 *   bookError: Error | null,
 *   activeChapter: number,
 *   readerVisible: boolean,
 * }}
 */
const retained = {
  path: '',
  job: null,
  book: null,
  bookPath: '',
  bookError: null,
  activeChapter: 0,
  readerVisible: true,
}

/** Class that scopes the reading typography; the inline `<style>` uses it. */
const READER_CLASS = 'dsh-pdf2epub-reader'

/** Reading typography: 17px / 1.8 / 2em indent, headings flush, 42em column. */
const READER_STYLE_TEXT = `
.${READER_CLASS} {
  max-width: 42em;
  margin: 0 auto;
  padding: 4px 26px 64px;
  font-size: 17px;
  line-height: 1.8;
  text-indent: 2em;
  overflow-wrap: break-word;
  word-break: break-word;
}
.${READER_CLASS} :is(h1, h2, h3, h4, h5, h6) {
  text-indent: 0;
  line-height: 1.35;
  margin: 1.5em 0 0.7em;
  font-weight: 600;
}
.${READER_CLASS} h1 { font-size: 1.5em; }
.${READER_CLASS} h2 { font-size: 1.3em; }
.${READER_CLASS} h3 { font-size: 1.15em; }
.${READER_CLASS} h4,
.${READER_CLASS} h5,
.${READER_CLASS} h6 { font-size: 1.05em; }
.${READER_CLASS} p { margin: 0 0 0.9em; }
.${READER_CLASS} :is(ul, ol) { text-indent: 0; margin: 0 0 1em; padding-left: 1.7em; }
.${READER_CLASS} li { text-indent: 0; margin: 0.2em 0; }
.${READER_CLASS} blockquote {
  text-indent: 0;
  margin: 1.1em 0;
  padding: 0 0 0 1em;
  border-left: 2px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  color: var(--dsw-alias-label-secondary, inherit);
}
.${READER_CLASS} :is(pre, code) { text-indent: 0; font-size: 0.92em; }
.${READER_CLASS} pre {
  margin: 1em 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 6px;
  background: var(--dsw-alias-markdown-code-block, rgba(0, 0, 0, 0.04));
}
.${READER_CLASS} img { max-width: 100%; height: auto; display: block; margin: 1em auto; text-indent: 0; }
.${READER_CLASS} table { text-indent: 0; border-collapse: collapse; margin: 1em 0; font-size: 0.95em; }
.${READER_CLASS} :is(td, th) {
  text-indent: 0;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
}
.${READER_CLASS} a { color: var(--dsw-alias-link, inherit); }
.${READER_CLASS} hr {
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  margin: 2em 0;
}
`

/**
 * Pick the theme aliases the reading area borrows from the Host.
 *
 * The alias custom properties are declared on `body` in the shipped
 * `design-platform.css`, so `document.documentElement` on its own reports
 * nothing. Hence the ordered probe: documentElement first (the contract's
 * wording), then this panel's own element, whose computed style resolves the
 * inherited alias without reading or writing any other node. The returned
 * strings keep the `var(...)` form so a runtime theme switch still repaints;
 * when nothing resolves, the area simply inherits.
 *
 * @param {Element | null} probe - the panel's own root element.
 * @returns {{ bg: string, color: string }} CSS colour values.
 */
function pickThemeTokens(probe) {
  const candidates = {
    bg: ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-base', '--dsw-alias-card-fill', '--dsw-alias-bg-layer-2'],
    color: ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'],
  }
  const elements = []
  if (typeof document !== 'undefined' && document.documentElement !== null) elements.push(document.documentElement)
  if (probe !== null && probe !== undefined) elements.push(probe)
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return { bg: 'inherit', color: 'inherit' }
  }
  const isResolved = (name) => {
    for (const element of elements) {
      const value = window.getComputedStyle(element).getPropertyValue(name).trim()
      if (value !== '') return true
    }
    return false
  }
  const pick = names => names.find(name => isResolved(name))
  const bg = pick(candidates.bg)
  const color = pick(candidates.color)
  return {
    bg: bg === undefined ? 'inherit' : `var(${bg}, inherit)`,
    color: color === undefined ? 'inherit' : `var(${color}, inherit)`,
  }
}

/* ------------------------------------------------------------- plugin entry */

const loader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__
if (loader === undefined) {
  throw new Error('dsh-pdf2epub: the client bundle needs window.__ModuleLoader__ (web platform only)')
}

loader.load({
  id: 'dsh-pdf2epub',
  factory(require) {
    /* -------------------------------------------------------- dictionaries */

    /**
     * `pdf2epub` copy for Simplified Chinese.
     *
     * Inlined because this bundle is self-contained: the factory may only
     * `require('react')`, so it cannot import `locale/zh-CN.json`. That file is
     * generated from this object and carries exactly these keys in this order.
     *
     * Registration uses the built-in locale ids rather than browser tags:
     * `ctx.locale.register(ns, { zh, en })` is the typed form in
     * `dsh-client-locale` (`LocaleRuntime.register`), whose baseline locales
     * are `zh` and `en`; `zh-CN` / `en-US` are not selectable locale ids.
     *
     * @type {Readonly<Record<string, string>>}
     */
    const DICT_ZH = Object.freeze({
      'panel.title': 'PDF 转 EPUB',
      'panel.subtitle': '逐页转录，弱页交叉复核，产出可重排 EPUB 3',
      'panel.inputPath': '输入 PDF 路径',
      'panel.start': '开始转换',
      'panel.cancel': '取消',
      'panel.rerun': '重新转换',
      'panel.advanced': '高级',
      'panel.model': '模型',
      'panel.modelHint': '留空则使用插件配置的默认模型',
      'panel.modelCustom': '自定义…',
      'panel.modelFallback': '无法读取模型清单，请手动填写 provider/model',
      'panel.modelLoading': '正在读取模型清单…',
      'panel.modelEmpty': '没有可用模型，请手动填写 provider/model',
      'panel.reviewModels': '复核模型',
      'panel.reviewModelsHint': 'provider/model，多个用逗号分隔；留空则不做交叉复核',
      'panel.dpi': 'DPI',
      'panel.concurrency': '并发',
      'panel.retry': '重试',
      'panel.browse': '浏览…',
      'picker.title': '选择 PDF 文件',
      'picker.loading': '正在读取目录…',
      'picker.up': '上级目录',
      'picker.empty': '这个目录里没有子目录或 PDF',
      'picker.cancel': '取消',
      'picker.unavailable': '当前环境无法打开文件选择器，请手动输入绝对路径',
      'picker.notPdf': '只能选择 .pdf 文件',
      'status.idle': '等待中',
      'status.queued': '排队中',
      'status.rendering': '渲染页面',
      'status.transcribing': '转录中',
      'status.reviewing': '交叉复核',
      'status.assembling': '组装 EPUB',
      'status.done': '已完成',
      'status.failed': '失败',
      'status.degraded': '复核存疑',
      'status.cached': '缓存命中',
      'progress.page': '正在处理第 {page} / {total} 页',
      'report.title': '转换报告',
      'report.pages': '页数',
      'report.chapters': '章节数',
      'report.blocks': '文本块',
      'report.tokens': 'Token 用量',
      'report.duration': '耗时',
      'report.reviewed': '已复核页',
      'report.degraded': '存疑页',
      'reader.toc': '目录',
      'reader.prev': '上一章',
      'reader.next': '下一章',
      'reader.show': '展开阅读区',
      'reader.hide': '收起阅读区',
      'reader.loading': '正在加载书籍…',
      'reader.empty': '转换完成后，可在这里直接阅读成书',
      'reader.missingPath': '转换结果里没有书籍路径，无法加载正文',
      'error.noImageModel': '主模型不支持图片输入，请改用支持视觉的模型',
      'error.pdfNotFound': '找不到 PDF 文件，请检查输入路径',
      'error.noChapters': '没有生成任何章节：所有文本块都被判定为页眉页脚',
      'error.unknown': '未知错误',
    })

    /**
     * English half of the `pdf2epub` namespace, mirrored into
     * `locale/en-US.json` with the same keys in the same order.
     *
     * @type {Readonly<Record<string, string>>}
     */
    const DICT_EN = Object.freeze({
      'panel.title': 'PDF to EPUB',
      'panel.subtitle': 'Page-by-page transcription with cross-review of weak pages, then a reflowable EPUB 3',
      'panel.inputPath': 'Input PDF path',
      'panel.start': 'Start conversion',
      'panel.cancel': 'Cancel',
      'panel.rerun': 'Convert again',
      'panel.advanced': 'Advanced',
      'panel.model': 'Model',
      'panel.modelHint': 'Leave empty to use the default model from the plugin configuration',
      'panel.modelCustom': 'Custom…',
      'panel.modelFallback': 'The model catalog is unavailable; type provider/model',
      'panel.modelLoading': 'Loading models…',
      'panel.modelEmpty': 'No models available; type provider/model',
      'panel.reviewModels': 'Review models',
      'panel.reviewModelsHint': 'provider/model ids separated by commas; leave empty to skip cross-review',
      'panel.dpi': 'DPI',
      'panel.concurrency': 'Concurrency',
      'panel.retry': 'Retry',
      'panel.browse': 'Browse…',
      'picker.title': 'Choose a PDF',
      'picker.loading': 'Reading the folder…',
      'picker.up': 'Parent folder',
      'picker.empty': 'No subfolders or PDFs here',
      'picker.cancel': 'Cancel',
      'picker.unavailable': 'This environment cannot open a file chooser; type the absolute path instead',
      'picker.notPdf': 'Only .pdf files can be chosen',
      'status.idle': 'Idle',
      'status.queued': 'Queued',
      'status.rendering': 'Rendering page',
      'status.transcribing': 'Transcribing',
      'status.reviewing': 'Cross-reviewing',
      'status.assembling': 'Assembling EPUB',
      'status.done': 'Done',
      'status.failed': 'Failed',
      'status.degraded': 'Uncertain after review',
      'status.cached': 'From cache',
      'progress.page': 'Processing page {page} of {total}',
      'report.title': 'Conversion report',
      'report.pages': 'Pages',
      'report.chapters': 'Chapters',
      'report.blocks': 'Blocks',
      'report.tokens': 'Tokens',
      'report.duration': 'Duration',
      'report.reviewed': 'Reviewed pages',
      'report.degraded': 'Degraded pages',
      'reader.toc': 'Contents',
      'reader.prev': 'Previous chapter',
      'reader.next': 'Next chapter',
      'reader.show': 'Show reader',
      'reader.hide': 'Hide reader',
      'reader.loading': 'Loading the book…',
      'reader.empty': 'Once the conversion finishes, the book can be read here',
      'reader.missingPath': 'The conversion result has no book path, so the text cannot be loaded',
      'error.noImageModel': 'The primary model does not accept image input; choose a vision-capable model',
      'error.pdfNotFound': 'PDF not found; check the input path',
      'error.noChapters': 'No chapters were produced: every block was treated as page furniture',
      'error.unknown': 'Unknown error',
    })

    /** Set once so a repeated `apply` warns about the duplicate, not every mount. */
    let warnedDuplicateLocale = false

    /**
     * Set once so a document-preview problem is reported exactly once.
     *
     * The review's rule for this block is "`console.warn` once, never rethrow",
     * so every fence below shares one flag rather than one per failure site.
     */
    let warnedPreviewProblem = false

    /**
     * Report a document-preview problem once and swallow it.
     *
     * Swallowed on purpose: a registration failure inside `ctx.effect` is
     * rethrown by Cordis, which then disposes every effect `apply` registered —
     * including the sidebar panel. Losing the preview is acceptable; losing the
     * panel is not.
     *
     * @param {string} message - what could not be done.
     * @param {unknown} error - the thrown value.
     * @returns {void}
     */
    function warnPreviewOnce(message, error) {
      if (warnedPreviewProblem) return
      warnedPreviewProblem = true
      console.warn(message, error)
    }

    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------ UI primitives */

    /** Shared button look. @param {boolean} disabled - dim a disabled button. */
    const buttonStyle = (disabled) => ({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '6px 14px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: 1.4,
      cursor: disabled === true ? 'not-allowed' : 'pointer',
      opacity: disabled === true ? 0.5 : 1,
    })

    /** Filled variant. @param {boolean} disabled - dim a disabled button. */
    const primaryButtonStyle = (disabled) => ({
      ...buttonStyle(disabled),
      border: '1px solid transparent',
      background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #247bbf))',
      color: 'var(--dsw-alias-label-on-color, #ffffff)',
      fontWeight: 500,
      opacity: disabled === true ? 0.55 : 1,
    })

    /** Text/ghost button look. @param {boolean} disabled - dim a disabled button. */
    const ghostButtonStyle = (disabled) => ({
      ...buttonStyle(disabled),
      border: '1px solid transparent',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      padding: '2px 6px',
      fontSize: 12,
    })

    /** Text input look. */
    const inputStyle = {
      boxSizing: 'border-box',
      flex: 1,
      minWidth: 0,
      padding: '7px 10px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14))',
      background: 'var(--dsw-alias-bg-base, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: 1.4,
    }

    /** One row of the in-app picker: full width, left aligned, name folded. */
    const browserRowStyle = {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid transparent',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: 1.5,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    /** Loading / empty / error copy inside the picker. */
    const browserMessageStyle = {
      padding: '14px 10px',
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary, inherit)',
    }

    /**
     * Sidebar entry glyph: red page, arrow, blue page — the package icon as
     * inline SVG in `currentColor`, so it follows the sidebar theme. The list
     * slot only ever passes `{ size, active }` (contract §8).
     *
     * @param {{ size?: number, active?: boolean }} props - sidebar icon props.
     * @returns {object} React element.
     */
    function PanelIcon(props) {
      const size = numberOrNull(props?.size) ?? 20
      const active = props?.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', color: 'currentColor', opacity: active ? 1 : 0.7 },
        },
        h('rect', { key: 'page', x: 3, y: 5, width: 8, height: 14, rx: 1.2, fill: 'currentColor', opacity: 0.22 }),
        h('rect', {
          key: 'page-outline', x: 3, y: 5, width: 8, height: 14, rx: 1.2,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', {
          key: 'arrow',
          d: 'M12.4 12h3.8m0 0-1.6-1.7m1.6 1.7-1.6 1.7',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('rect', { key: 'book', x: 17.2, y: 5, width: 3.8, height: 14, rx: 1.2, fill: 'currentColor', opacity: 0.45 }),
      )
    }

    /**
     * Register one slot occupant and hand back the disposer `ctx.effect` wants.
     *
     * `slots.inject` defers the registration until the slot exists (the shipped
     * pattern); it is used when present, with a direct registration otherwise so
     * a Host whose slot service lacks that gate still mounts the panel.
     *
     * @param {object} ctx - Cordis client context.
     * @param {string} slotName - slot to occupy.
     * @param {object} options - registration options (`id` or `key`, plus locale/order/label).
     * @param {Function} component - slot component.
     * @returns {() => void} disposer.
     */
    function registerSlot(ctx, slotName, options, component) {
      const register = () => ctx.slots.register({ name: slotName, ...options }, component)
      if (ctx.slots !== undefined && ctx.slots !== null && typeof ctx.slots.inject === 'function') {
        const disposed = ctx.slots.inject(slotName, register)
        return typeof disposed === 'function' ? disposed : () => {}
      }
      const disposed = register()
      return typeof disposed === 'function' ? disposed : () => {}
    }

    /**
     * Localised text of a thrown error or a Host error payload.
     *
     * Shared by the panel and the document preview so a failure reads the same
     * in both: an error carrying a locale key first, then the Host error code
     * (`error.<code>`), then the raw message.
     *
     * @param {(key: string, params?: Record<string, unknown>) => string} t - localised copy.
     * @returns {(error: unknown) => string} label function.
     */
    function createErrorLabel(t) {
      return (error) => {
        if (error === null || error === undefined) return ''
        if (typeof error === 'string') return error
        if (error.localeKey !== undefined) {
          const localised = t(error.localeKey)
          if (localised !== error.localeKey) return localised
        }
        const code = typeof error.code === 'string' ? error.code : ''
        if (code !== '') {
          const camelKey = `error.${camelize(code)}`
          const camelised = t(camelKey)
          if (camelised !== camelKey) return camelised
          const rawKey = `error.${code}`
          const raw = t(rawKey)
          if (raw !== rawKey) return raw
        }
        const message = messageOf(error)
        return message === '' ? t('error.unknown') : message
      }
    }

    /**
     * The reading area both entries render: themed column, scoped book
     * stylesheet, table of contents, chapter body and pager.
     *
     * Hooks-free on purpose. The panel and the `.epub` preview own their chapter
     * index, theme and effects (their slots hand them different hooks), so the
     * shared piece is the markup plus the navigation contract: both call this
     * function with the same model, which also keeps the panel's element tree
     * flat. The only differences are the props themselves — `header`,
     * `showRow`, `showPager`, `chapterFallback`, `tocCollapsed`, `cssText` — so
     * the TOC, the chapter swap, the pager and the theme cannot drift apart.
     *
     * @param {object} reader - reading-area model:
     *   `{ theme, header, chapters, activeIndex, onSelect, chapter, contentRef,
     *      chapterFallback, showRow, showPager, tocItems, tocCollapsed,
     *      tocLabel, prevLabel, nextLabel, cssText, articleLang, boxStyle,
     *      onContentClick }`.
     * @returns {object} React element.
     */
    function BookReader(reader) {
      const chapters = Array.isArray(reader.chapters) ? reader.chapters : []
      const activeIndex = reader.activeIndex ?? 0
      const tocItems = Array.isArray(reader.tocItems) ? reader.tocItems : []
      const tocCollapsed = reader.tocCollapsed === true
      const theme = reader.theme ?? { bg: 'inherit', color: 'inherit' }
      const chapter = reader.chapter ?? null
      const canGoPrev = activeIndex > 0
      const canGoNext = activeIndex < chapters.length - 1
      return h(
        'div',
        {
          // The scope every `book.css` selector was prefixed with.
          className: EPUB_BOOK_CLASS,
          style: {
            display: 'flex',
            flex: '1 1 auto',
            flexDirection: 'column',
            minHeight: 0,
            margin: '0 20px 18px',
            overflow: 'hidden',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
            background: theme.bg,
            color: theme.color,
            ...(reader.boxStyle ?? null),
          },
        },
        h('style', null, READER_STYLE_TEXT),
        reader.cssText ? h('style', null, reader.cssText) : null,
        reader.header ?? null,
        reader.showRow === true
          ? h(
            'div',
            { style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
            tocItems.length > 0
              ? h(
                'nav',
                {
                  'aria-label': reader.tocLabel,
                  style: {
                    flex: tocCollapsed ? '0 0 0px' : '0 0 210px',
                    minHeight: 0,
                    overflow: 'auto',
                    padding: tocCollapsed ? 0 : '8px 6px',
                    borderRight: tocCollapsed ? 'none' : '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
                  },
                },
                tocItems.map(item => h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    onClick: () => reader.onSelect(item.index),
                    'aria-current': item.index === activeIndex ? 'true' : undefined,
                    style: {
                      display: 'block',
                      width: '100%',
                      boxSizing: 'border-box',
                      margin: '1px 0',
                      padding: '6px 9px',
                      paddingLeft: 9 + (Math.max(1, item.level ?? 1) - 1) * 10,
                      border: 'none',
                      borderRadius: 6,
                      textAlign: 'left',
                      font: 'inherit',
                      fontSize: 12.5,
                      lineHeight: 1.45,
                      cursor: 'pointer',
                      background: item.index === activeIndex
                        ? 'var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.07))'
                        : 'transparent',
                      color: item.index === activeIndex
                        ? 'var(--dsw-alias-label-primary, inherit)'
                        : 'var(--dsw-alias-label-secondary, inherit)',
                      fontWeight: item.index === activeIndex ? 600 : 400,
                    },
                  },
                  item.title === '' ? `${item.index + 1}` : item.title,
                )),
              )
              : null,
            h(
              'div',
              {
                ref: reader.contentRef,
                onClick: typeof reader.onContentClick === 'function' ? reader.onContentClick : undefined,
                style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto' },
              },
              chapter === null
                ? reader.chapterFallback ?? null
                : h('article', {
                  className: READER_CLASS,
                  lang: reader.articleLang,
                  dangerouslySetInnerHTML: { __html: chapter.html },
                }),
            ),
          )
          : null,
        reader.showPager === true
          ? h(
            'div',
            {
              style: {
                display: 'flex',
                flex: '0 0 auto',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '8px 12px',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
              },
            },
            h(
              'button',
              { type: 'button', onClick: () => reader.onSelect(activeIndex - 1), disabled: !canGoPrev, style: buttonStyle(!canGoPrev) },
              `← ${reader.prevLabel}`,
            ),
            h(
              'button',
              { type: 'button', onClick: () => reader.onSelect(activeIndex + 1), disabled: !canGoNext, style: buttonStyle(!canGoNext) },
              `${reader.nextLabel} →`,
            ),
          )
          : null,
      )
    }

    /**
     * Build the panel component bound to one translate function.
     *
     * A factory (rather than a prop) keeps the component identity stable for a
     * plugin apply while `t` still follows the active locale, because the bound
     * translate function reads the locale at call time.
     *
     * @param {(key: string, params?: Record<string, unknown>) => string} t - localised copy.
     * @param {object} ctx - Cordis client context (the browse flow reads `ctx.remote`).
     * @returns {Function} the panel component.
     */
    function createPanel(t, ctx) {
      /** Status text for a phase, falling back to the raw phase name. */
      const phaseLabel = (phase) => {
        const key = PHASE_COPY[phase] ?? `status.${phase}`
        const label = t(key)
        return label === key ? phase : label
      }

      /** Localised text of a thrown error or a Host error payload. */
      const errorLabel = createErrorLabel(t)

      /**
       * The PDF → EPUB panel: input form, progress, and the generated book.
       * @returns {object} React element.
       */
      function Pdf2EpubPanel() {
        const [path, setPath] = React.useState(() => retained.path)
        const [advancedOpen, setAdvancedOpen] = React.useState(false)
        const [model, setModel] = React.useState('')
        // The 「复核模型」 field was removed from the panel, but the hook stays so
        // every slot below keeps its index (the harness reads them by number).
        // The value is the pipeline's own default: cross-review off.
        const [reviewModels] = React.useState(() => [])
        const [dpi, setDpi] = React.useState('')
        const [concurrency, setConcurrency] = React.useState('')
        const [job, setJob] = React.useState(() => retained.job)
        const [pollError, setPollError] = React.useState(null)
        const [pollNonce, setPollNonce] = React.useState(0)
        const [submitError, setSubmitError] = React.useState(null)
        const [submitting, setSubmitting] = React.useState(false)
        const [book, setBook] = React.useState(() => retained.book)
        const [bookPath, setBookPath] = React.useState(() => retained.bookPath)
        const [bookError, setBookError] = React.useState(() => retained.bookError)
        const [bookLoading, setBookLoading] = React.useState(false)
        const [bookNonce, setBookNonce] = React.useState(0)
        const [activeChapter, setActiveChapter] = React.useState(() => retained.activeChapter)
        const [readerVisible, setReaderVisible] = React.useState(() => retained.readerVisible)
        const [theme, setTheme] = React.useState(() => ({ bg: 'inherit', color: 'inherit' }))
        const rootRef = React.useRef(null)
        const contentRef = React.useRef(null)
        const bookLoadRef = React.useRef('')
        // Browsing hooks stay below every pre-existing slot: the recorded
        // useState/useRef order is the panel's public seam for the harness
        // checks (path is slot 0, theme 18), so new hooks are only ever appended.
        const pathInputRef = React.useRef(null)
        const browseLoadRef = React.useRef(null)
        const [browse, setBrowse] = React.useState(null)
        const [browseError, setBrowseError] = React.useState(null)
        // Model-catalogue hooks are appended for the same reason: a new slot is
        // only ever added after every existing one.
        const [modelSource, setModelSource] = React.useState('catalog')
        const [modelCatalog, setModelCatalog] = React.useState(() => modelCatalogView ?? MODEL_CATALOG_LOADING)

        // Keep the retained snapshot in sync so a panel switch loses nothing.
        React.useEffect(() => {
          retained.path = path
          retained.job = job
          retained.book = book
          retained.bookPath = bookPath
          retained.bookError = bookError
          retained.activeChapter = activeChapter
          retained.readerVisible = readerVisible
        }, [path, job, book, bookPath, bookError, activeChapter, readerVisible])

        // Theme aliases are probed once; the var() form keeps them live.
        //
        // The model catalogue rides on this mount-once effect instead of a
        // seventh `useEffect`: `client-check.mjs` asserts the panel's effect
        // count and the slot order behind it, and the catalogue is read once per
        // mount anyway (the module-level cache dedupes a remount).
        React.useEffect(() => {
          setTheme(pickThemeTokens(rootRef.current))
          let cancelled = false
          void loadModelCatalog(ctx).then((view) => {
            if (cancelled) return
            setModelCatalog(view)
            // The catalogue's own default is the dropdown's initial selection;
            // a route the operator already typed or picked always wins.
            if (view.defaultRoute !== '') {
              setModel((current) => (current === '' ? view.defaultRoute : current))
            }
          })
          return () => {
            cancelled = true
          }
        }, [])

        const phase = job === null ? 'idle' : job.phase
        const jobId = job === null ? '' : job.jobId
        const jobPhase = job === null ? '' : job.phase
        const jobStartedAt = job !== null && typeof job.startedAt === 'number' ? job.startedAt : 0
        const running = jobId !== '' && !TERMINAL_PHASES.has(phase)
        const page = job === null ? 0 : job.page
        const total = job === null ? 0 : job.total
        const tokens = job === null ? 0 : job.tokens
        const elapsed = job === null ? 0 : job.ms
        const jobError = job === null ? null : job.error

        // Progress polling: one interval per job, cleared on unmount or on the
        // terminal snapshot. A failed request stops the loop and offers a retry.
        React.useEffect(() => {
          // A settled job normally ends the loop, except for the short window
          // where `done` is visible before the Host stored the book path.
          const awaitingBook = phase === 'done' && bookPath === '' && book === null
          if (jobId === '' || (TERMINAL_PHASES.has(phase) && !awaitingBook)) return undefined
          const controller = new AbortController()
          let stopped = false
          let timer = null
          // `done` is observable a beat before the Host stores `bookJsonPath`
          // (the pipeline's last event lands first), so a terminal snapshot
          // without the path gets a few more reads before it is called missing.
          let graceTicks = 0
          const stop = () => {
            if (timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
          const tick = async () => {
            try {
              const next = await fetchState(jobId, controller.signal, jobStartedAt)
              if (stopped) return
              setPollError(null)
              setJob(next)
              if (next.bookPath !== '') setBookPath(next.bookPath)
              if (next.book !== null) setBook(next.book)
              if (TERMINAL_PHASES.has(next.phase)) {
                const noBook = next.book === null && next.bookPath === ''
                if (next.phase === 'done' && noBook && graceTicks < 3) {
                  graceTicks += 1
                  return
                }
                stop()
                if (noBook) {
                  // Two different outcomes used to share one message: a `done`
                  // job that forgot its book path, and a failed conversion that
                  // never had one. Reporting "finished without a book path" for
                  // a failure hid the reason the reader cares about.
                  if (next.phase === 'failed') {
                    const reason = next.error === null ? '' : errorLabel(next.error)
                    setBookError(new Error(
                      `${t('status.failed')}: ${reason === '' ? t('error.unknown') : reason}`,
                    ))
                  } else {
                    setBookError(localError('reader.missingPath', 'conversion finished without a book path'))
                  }
                }
              }
            } catch (error) {
              if (stopped || error?.name === 'AbortError') return
              stop()
              const message = messageOf(error)
              setPollError(message === '' ? t('error.unknown') : message)
            }
          }
          timer = setInterval(() => { void tick() }, POLL_MS)
          void tick()
          return () => {
            stopped = true
            stop()
            controller.abort()
          }
        }, [jobId, jobStartedAt, pollNonce])

        // Book loading: only once the job is finished (the JSON does not exist
        // before that), and skipped entirely when the retained snapshot already
        // holds the parsed book.
        React.useEffect(() => {
          if (jobPhase !== 'done') return undefined
          if (bookPath === '' || book !== null) return undefined
          if (bookLoadRef.current === bookPath) return undefined
          bookLoadRef.current = bookPath
          const controller = new AbortController()
          let cancelled = false
          setBookLoading(true)
          void fetchBook(bookPath, controller.signal)
            .then(
              (next) => {
                if (cancelled) return
                setBook(next)
                setBookError(null)
                setActiveChapter(0)
              },
              (error) => {
                if (cancelled || error?.name === 'AbortError') return
                if (error?.localeKey !== undefined) setBookError(error)
                else {
                  const message = messageOf(error)
                  setBookError(new Error(message === '' ? t('error.unknown') : message))
                }
              },
            )
            .finally(() => {
              if (cancelled) return
              setBookLoading(false)
              if (bookLoadRef.current === bookPath) bookLoadRef.current = ''
            })
          return () => {
            cancelled = true
            controller.abort()
          }
        }, [bookPath, book, bookNonce, jobPhase])

        const chapters = book === null ? [] : book.chapters
        const activeIndex = chapters.length === 0 ? 0 : Math.min(activeChapter, chapters.length - 1)
        const chapter = chapters.length === 0 ? null : chapters[activeIndex]

        /** Jump to one chapter, clamped to the list (shared by TOC and pager). */
        const selectChapter = (index) => {
          if (chapters.length === 0) return
          setActiveChapter((current) => {
            const next = clampChapter(index, chapters.length)
            return next === current ? current : next
          })
        }

        /** Move the reading position, clamped to the chapter list. */
        const move = (delta) => {
          if (chapters.length === 0) return
          setActiveChapter((current) => {
            const next = clampChapter(current + delta, chapters.length)
            return next === current ? current : next
          })
        }

        // Keyboard paging: ← / → while the reading area is open, and never while
        // the reader is typing into a field. `chapterKeyDelta` is shared with
        // the document preview so both entries page identically.
        React.useEffect(() => {
          if (readerVisible !== true || chapters.length === 0) return undefined
          const onKeyDown = (event) => {
            const delta = chapterKeyDelta(event)
            if (delta === 0) return
            event.preventDefault()
            move(delta)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [readerVisible, chapters.length])

        // A chapter swap starts at the top of the column.
        React.useEffect(() => {
          const node = contentRef.current
          if (node !== null) node.scrollTop = 0
        }, [activeIndex, book])

        /** Start (or restart) a conversion with the current form values. */
        const start = async () => {
          const input = path.trim()
          if (input === '' || submitting) return
          setSubmitting(true)
          setSubmitError(null)
          setPollError(null)
          setBook(null)
          setBookPath('')
          setBookError(null)
          setActiveChapter(0)
          setJob(null)
          try {
            // `input` is the Host's field name (`src/host/server.js#parseSpec`);
            // omitted optional keys fall back to the plugin configuration.
            // `reviewModels` is deliberately absent: the panel no longer edits
            // it, and the pipeline's own default is the empty array.
            const payload = { input }
            if (model.trim() !== '') payload.model = model.trim()
            const dpiValue = parseInteger(dpi)
            if (dpiValue !== undefined) payload.dpi = dpiValue
            const concurrencyValue = parseInteger(concurrency)
            if (concurrencyValue !== undefined) payload.concurrency = concurrencyValue
            const accepted = await postRun(payload)
            setJob({
              jobId: accepted.jobId,
              phase: 'queued',
              page: 0,
              total: 0,
              tokens: 0,
              ms: 0,
              startedAt: accepted.startedAt,
              error: null,
              bookPath: '',
              book: null,
            })
            setPollNonce(current => current + 1)
          } catch (error) {
            const message = messageOf(error)
            setSubmitError(new Error(message === '' ? t('error.unknown') : message))
          } finally {
            setSubmitting(false)
          }
        }

        /** Retry whatever request failed last. */
        const retry = () => {
          if (pollError !== null) {
            setPollError(null)
            setPollNonce(current => current + 1)
            return
          }
          if (bookError !== null) {
            setBookError(null)
            // Without a path there is nothing to re-fetch: ask the Host again.
            if (bookPath === '') setPollNonce(current => current + 1)
            else setBookNonce(current => current + 1)
            return
          }
          if (jobError !== null && !running) void start()
        }

        /* ------------------------------------------------- browsing for a PDF */

        /** Put the caret back in the path field once a chooser closed. */
        const focusPathInput = () => {
          const node = pathInputRef.current
          if (node === null || node === undefined) return
          if (typeof node.focus !== 'function') return
          try {
            node.focus()
          } catch {
            // A detached node cannot take focus; the path is still correct.
          }
        }

        /** Adopt one absolute path chosen by either flow. */
        const applyChosenPath = (chosen) => {
          setPath(chosen)
          setBrowseError(null)
          focusPathInput()
        }

        /** Close the in-app picker, abandoning a listing still in flight. */
        const closeBrowser = () => {
          const controller = browseLoadRef.current
          browseLoadRef.current = null
          if (controller !== null && controller !== undefined && typeof controller.abort === 'function') controller.abort()
          setBrowse(null)
          focusPathInput()
        }

        /**
         * Read one directory level into the picker.
         *
         * A path of `''` asks the Host for its home directory: the browse
         * backend documents "absent lists the home directory", so an empty
         * field still opens somewhere real instead of at a guessed location.
         *
         * @param {string} target - absolute directory, or `''` for the host's home.
         */
        const loadDirectory = async (target) => {
          const previous = browseLoadRef.current
          browseLoadRef.current = null
          if (previous !== null && previous !== undefined && typeof previous.abort === 'function') previous.abort()
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const signal = controller === null ? undefined : controller.signal
          browseLoadRef.current = controller
          setBrowse({ phase: 'loading', path: target, up: '', entries: [], error: null })
          const picker = directoryPickerRemote(ctx)
          if (picker === null) {
            browseLoadRef.current = null
            setBrowse({ phase: 'error', path: target, up: '', entries: [], error: new Error(t('picker.unavailable')) })
            return
          }
          try {
            const answer = target === '' ? picker.list(undefined, signal) : picker.list(target, signal)
            const listing = remoteValue(await answer, t('picker.unavailable'))
            if (browseLoadRef.current !== controller) return
            const view = listingView(listing)
            setBrowse({
              phase: 'ready',
              path: view.path === '' ? target : view.path,
              up: view.up,
              entries: view.entries,
              error: null,
            })
          } catch (error) {
            if (browseLoadRef.current !== controller) return
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return
            setBrowse({ phase: 'error', path: target, up: '', entries: [], error })
          } finally {
            if (browseLoadRef.current === controller) browseLoadRef.current = null
          }
        }

        /**
         * 「浏览…」: the platform's file chooser first, the in-app picker after.
         *
         * The Desktop chooser is preferred because it is the real OS "Open"
         * dialog with a `.pdf` filter and it returns the absolute path directly.
         * Everything else — a plain browser tab, a Host whose bridge cannot map
         * the picked file — falls through to the in-app browser, which needs no
         * Desktop at all.
         */
        const handleBrowse = async () => {
          setBrowseError(null)
          const bridge = desktopPathBridge()
          if (bridge !== null) {
            const chooser = choosePdfWithDesktopBridge(bridge, rootRef.current)
            if (chooser !== null) {
              const outcome = await chooser
              if (outcome !== null && outcome.ok === true) {
                // The filter is a hint the dialog lets the operator override
                // ("All files"), so the suffix is checked here as well.
                if (!PDF_SUFFIX_RE.test(outcome.path)) {
                  setBrowseError(new Error(t('picker.notPdf')))
                  focusPathInput()
                  return
                }
                applyChosenPath(outcome.path)
                return
              }
              // A cancel is the operator's decision, never an error: the typed
              // path stays exactly as it was and the caret comes back.
              if (outcome !== null && outcome.reason === 'cancelled') {
                focusPathInput()
                return
              }
            }
          }
          if (directoryPickerRemote(ctx) === null) {
            setBrowseError(new Error(t('picker.unavailable')))
            return
          }
          await loadDirectory(startDirectoryOf(path))
        }

        const retryLabel = t('panel.retry')
        const startDisabled = path.trim() === '' || submitting || running
        const startLabel = job !== null && !running ? 'panel.rerun' : 'panel.start'
        const progressPercent = total > 0
          ? Math.min(100, Math.max(0, (page / total) * 100))
          : (phase === 'done' ? 100 : 0)
        const showStatus = job !== null || submitError !== null || pollError !== null
        const showReader = book !== null || bookLoading || bookError !== null
        const readerTitle = book !== null && book.title !== '' ? book.title : t('reader.toc')

        /** One labelled form field. */
        const field = (labelText, control) => h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } }, labelText),
          control,
        )

        /** One text input of the advanced block. */
        const advancedField = (labelText, value, onChange, hint) => field(
          labelText,
          h('input', {
            type: 'text',
            value,
            placeholder: hint,
            spellCheck: false,
            autoComplete: 'off',
            onChange: event => onChange(event.target.value),
            style: { ...inputStyle, flex: 'initial', width: '100%' },
          }),
        )

        /**
         * The 「模型」 control of the advanced block.
         *
         * A `<select>` built from `session.modelCatalog()` whenever that list can
         * be read, and the original text input whenever it cannot. The catalogue
         * only holds routes that are routable *right now* (no credentials means
         * no group at all), so it is never a closed list: 「自定义…」 — and any
         * value the catalogue does not know — falls back to free text, which is
         * what the Host's `model` field tolerates.
         *
         * `model` stays the single source of truth: whichever control was
         * touched last owns it, and `modelSource` only records which one that
         * was, so the dropdown and the text box can never disagree.
         *
         * @returns {object} React element.
         */
        const modelField = () => {
          const ready = modelCatalog.phase === 'ready' && modelCatalog.groups.length > 0
          const routes = new Set()
          if (ready) {
            for (const group of modelCatalog.groups) {
              for (const entry of group.models) routes.add(entry.route)
            }
          }
          // A value the catalogue does not list (typed by hand, or restored from
          // a stale selection) lands on 「自定义…」 rather than on a `select` that
          // has no matching option.
          const customActive = ready && (modelSource === 'custom' || (model !== '' && !routes.has(model)))
          // Why the catalogue is unavailable is worth a line: free text is the
          // only other control there, and a bare "unavailable" cannot be acted
          // on. The reason is clipped, because a Host may refuse with a sentence.
          const reason = typeof modelCatalog.reason === 'string' ? modelCatalog.reason.trim() : ''
          const detail = reason === '' ? '' : ` — ${reason.length > 160 ? `${reason.slice(0, 157)}…` : reason}`
          const note = ready
            ? ''
            : modelCatalog.phase === 'loading'
              ? t('panel.modelLoading')
              : modelCatalog.phase === 'empty'
                ? t('panel.modelEmpty')
                : `${t('panel.modelFallback')}${detail}`

          /** Free-text route input: the fallback, and the 「自定义…」 editor. */
          const routeInput = () => h('input', {
            key: 'route',
            type: 'text',
            value: model,
            placeholder: t('panel.modelHint'),
            spellCheck: false,
            autoComplete: 'off',
            'aria-label': t('panel.model'),
            onChange: (event) => {
              // Typing always wins: this control now owns the value.
              setModelSource('custom')
              setModel(event.target.value)
            },
            style: { ...inputStyle, flex: 'initial', width: '100%' },
          })

          const control = ready
            ? h(
              'select',
              {
                key: 'select',
                value: customActive ? CUSTOM_MODEL_OPTION : model,
                'aria-label': t('panel.model'),
                onChange: (event) => {
                  const value = String(event.target.value)
                  if (value === CUSTOM_MODEL_OPTION) {
                    // Keep the current text so it stays editable.
                    setModelSource('custom')
                    return
                  }
                  setModelSource('catalog')
                  setModel(value)
                },
                style: { ...inputStyle, flex: 'initial', width: '100%' },
              },
              // Empty value: no per-call model, i.e. the plugin configuration.
              h('option', { key: 'catalog-default', value: '' }, t('panel.modelHint')),
              modelCatalog.groups.map(group => h(
                'optgroup',
                { key: group.id, label: group.name },
                group.models.map(entry => h(
                  'option',
                  {
                    key: entry.route,
                    value: entry.route,
                    title: entry.description === '' ? undefined : entry.description,
                  },
                  entry.label,
                )),
              )),
              h('option', { key: 'catalog-custom', value: CUSTOM_MODEL_OPTION }, t('panel.modelCustom')),
            )
            : routeInput()

          const children = [
            h('span', {
              key: 'label',
              style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
            }, t('panel.model')),
            control,
          ]
          if (ready && customActive) children.push(routeInput())
          if (note !== '') {
            children.push(h('span', {
              key: 'note',
              style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)' },
            }, note))
          }
          return h(
            'label',
            { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
            children,
          )
        }

        /**
         * The in-app picker overlay, or `null` while it is closed.
         *
         * Built from `browse` alone, so the loading, error, empty and ready
         * states are one render path. Rows are `button`s: a directory row
         * descends, a `.pdf` row picks the file and closes the overlay.
         *
         * @returns {object | null} React element, or `null` when closed.
         */
        const browseOverlay = () => {
          if (browse === null) return null
          const rows = []
          if (typeof browse.up === 'string' && browse.up !== '') {
            rows.push(h(
              'button',
              {
                key: 'up',
                type: 'button',
                onClick: () => { void loadDirectory(browse.up) },
                style: { ...browserRowStyle, color: 'var(--dsw-alias-label-secondary, inherit)' },
              },
              `↑ ${t('picker.up')}`,
            ))
          }
          for (const entry of browse.entries) {
            rows.push(h(
              'button',
              {
                key: entry.path,
                type: 'button',
                title: entry.path,
                onClick: () => {
                  // A picked file ends the whole flow: close first (which also
                  // returns focus), then adopt the path.
                  if (entry.isFile) {
                    closeBrowser()
                    applyChosenPath(entry.path)
                    return
                  }
                  void loadDirectory(entry.path)
                },
                style: browserRowStyle,
              },
              // A trailing separator reads as "this is a folder" without an icon.
              entry.isFile ? entry.name : `${entry.name}/`,
            ))
          }
          const body = browse.phase === 'loading'
            ? h('div', { style: browserMessageStyle }, t('picker.loading'))
            : browse.phase === 'error'
              ? h('div', { style: { ...browserMessageStyle, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } }, messageOf(browse.error))
              : rows.length === 0
                ? h('div', { style: browserMessageStyle }, t('picker.empty'))
                : rows
          return h(
            'div',
            {
              style: {
                position: 'absolute',
                inset: 0,
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
                background: 'var(--dsw-alias-bg-mask, rgba(0, 0, 0, 0.32))',
              },
            },
            h(
              'div',
              {
                role: 'dialog',
                'aria-modal': true,
                'aria-label': t('picker.title'),
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  maxWidth: 520,
                  maxHeight: '100%',
                  borderRadius: 10,
                  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
                  background: 'var(--dsw-alias-bg-base, inherit)',
                  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
                  overflow: 'hidden',
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))',
                  },
                },
                h('div', { style: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 } }, t('picker.title')),
                h('button', { type: 'button', onClick: closeBrowser, style: ghostButtonStyle(false) }, t('picker.cancel')),
              ),
              h(
                'div',
                {
                  title: browse.path,
                  style: {
                    padding: '6px 12px',
                    fontSize: 11,
                    color: 'var(--dsw-alias-label-tertiary, inherit)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                browse.path === '' ? '~' : browse.path,
              ),
              h(
                'div',
                { style: { flex: '1 1 auto', minHeight: 96, overflowY: 'auto', padding: '2px 6px 10px' } },
                body,
              ),
            ),
          )
        }

        return h(
          'div',
          {
            ref: rootRef,
            style: {
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              minHeight: 0,
              overflow: 'hidden',
              // The in-app picker is absolutely positioned inside this box, so
              // it can never escape the panel or need a document-level portal.
              position: 'relative',
              color: 'var(--dsw-alias-label-primary, inherit)',
              background: 'var(--dsw-alias-bg-base, inherit)',
              fontSize: 14,
              lineHeight: 1.6,
            },
          },

          /* ---- header ------------------------------------------------- */
          h(
            'div',
            { style: { flex: '0 0 auto', padding: '18px 20px 10px' } },
            h('div', { style: { fontSize: 16, fontWeight: 600 } }, t('panel.title')),
            h(
              'div',
              { style: { marginTop: 2, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } },
              t('panel.subtitle'),
            ),
          ),

          /* ---- A. form ------------------------------------------------ */
          h(
            'div',
            { style: { flex: '0 0 auto', padding: '0 20px 12px' } },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', {
                type: 'text',
                ref: pathInputRef,
                value: path,
                placeholder: t('panel.inputPath'),
                spellCheck: false,
                autoComplete: 'off',
                'aria-label': t('panel.inputPath'),
                onChange: event => setPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !startDisabled) {
                    event.preventDefault()
                    void start()
                  }
                },
                style: inputStyle,
              }),
              h(
                'button',
                {
                  type: 'button',
                  // Never disabled: picking the first file is exactly when the
                  // field is still empty.
                  onClick: () => { void handleBrowse() },
                  title: t('panel.browse'),
                  'aria-label': t('panel.browse'),
                  style: { ...buttonStyle(false), flex: '0 0 auto' },
                },
                t('panel.browse'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => { void start() },
                  disabled: startDisabled,
                  style: primaryButtonStyle(startDisabled),
                },
                t(startLabel),
              ),
            ),
            browseError === null
              ? null
              : h(
                'div',
                {
                  role: 'alert',
                  style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
                },
                messageOf(browseError),
              ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => setAdvancedOpen(open => !open),
                'aria-expanded': advancedOpen,
                style: { ...ghostButtonStyle(false), marginTop: 8 },
              },
              `${advancedOpen ? '▾' : '▸'} ${t('panel.advanced')}`,
            ),
            advancedOpen
              ? h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 8 } },
                modelField(),
                advancedField(t('panel.dpi'), dpi, setDpi, '150'),
                advancedField(t('panel.concurrency'), concurrency, setConcurrency, '4'),
              )
              : null,
          ),

          /* ---- B. status ---------------------------------------------- */
          showStatus
            ? h(
              'div',
              { style: { flex: '0 0 auto', padding: '0 20px 12px' } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
                    background: 'var(--dsw-alias-bg-layer-2, transparent)',
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                  },
                },
                h(
                  'span',
                  {
                    style: {
                      padding: '1px 8px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 500,
                      color: phase === 'failed'
                        ? 'var(--dsw-alias-state-error-primary, #c0392b)'
                        : 'var(--dsw-alias-label-primary, inherit)',
                      background: phase === 'failed'
                        ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(192, 57, 43, 0.12))'
                        : 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))',
                    },
                  },
                  phaseLabel(phase),
                ),
                total > 0 ? h('span', null, t('progress.page', { page, total })) : null,
                h('span', null, `${t('report.tokens')} ${formatTokens(tokens)}`),
                h('span', null, `${t('report.duration')} ${formatDuration(elapsed)}`),
              ),
              total > 0
                ? h(
                  'div',
                  {
                    style: {
                      marginTop: 8,
                      height: 4,
                      borderRadius: 999,
                      overflow: 'hidden',
                      background: 'var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.06))',
                    },
                  },
                  h('div', {
                    style: {
                      width: `${progressPercent}%`,
                      height: '100%',
                      borderRadius: 999,
                      background: 'var(--dsw-alias-state-business-primary, #247bbf)',
                      transition: 'width 200ms ease',
                    },
                  }),
                )
                : null,
              submitError !== null
                ? h(
                  'div',
                  { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } },
                  h('span', null, messageOf(submitError)),
                  h(
                    'button',
                    { type: 'button', onClick: () => { void start() }, disabled: startDisabled, style: { ...ghostButtonStyle(startDisabled), marginLeft: 8 } },
                    retryLabel,
                  ),
                )
                : null,
              pollError !== null
                ? h(
                  'div',
                  { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } },
                  h('span', null, pollError),
                  h('button', { type: 'button', onClick: retry, style: { ...ghostButtonStyle(false), marginLeft: 8 } }, retryLabel),
                )
                : null,
              jobError !== null
                ? h(
                  'div',
                  { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } },
                  h('span', null, errorLabel(jobError)),
                  !running
                    ? h(
                      'button',
                      { type: 'button', onClick: retry, disabled: startDisabled, style: { ...ghostButtonStyle(startDisabled), marginLeft: 8 } },
                      retryLabel,
                    )
                    : null,
                )
                : null,
            )
            : null,

          /* ---- C. reading area ---------------------------------------- */
          // One shared reader for both entry points. The panel only supplies its
          // own header, the pager visibility, and the loading/error body; the
          // TOC, the chapter swap and the theme come from `BookReader`.
          BookReader({
            theme,
            chapters,
            activeIndex,
            onSelect: selectChapter,
            chapter,
            contentRef,
            header: showReader
              ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flex: '0 0 auto',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px 12px',
                    borderBottom: readerVisible
                      ? '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))'
                      : 'none',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
                  h(
                    'span',
                    {
                      style: {
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--dsw-alias-label-primary, inherit)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      },
                    },
                    readerTitle,
                  ),
                  chapters.length > 0
                    ? h(
                      'span',
                      { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' } },
                      `${activeIndex + 1} / ${chapters.length}`,
                    )
                    : null,
                ),
                h(
                  'button',
                  { type: 'button', onClick: () => setReaderVisible(visible => !visible), style: ghostButtonStyle(false) },
                  t(readerVisible ? 'reader.hide' : 'reader.show'),
                ),
              )
              : h(
                'div',
                { style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
                h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('reader.empty')),
              ),
            showRow: showReader && readerVisible,
            showPager: showReader && readerVisible && chapters.length > 0,
            tocItems: chapters.map((entry, index) => ({ key: `${entry.id}:${index}`, title: entry.title, index, level: 1 })),
            tocLabel: t('reader.toc'),
            prevLabel: t('reader.prev'),
            nextLabel: t('reader.next'),
            articleLang: book !== null && book.language !== '' ? book.language : undefined,
            chapterFallback: h(
              'div',
              {
                style: {
                  padding: 18,
                  fontSize: 13,
                  color: bookError !== null
                    ? 'var(--dsw-alias-state-error-primary, #c0392b)'
                    : 'var(--dsw-alias-label-tertiary, inherit)',
                },
              },
              bookLoading
                ? t('reader.loading')
                : bookError !== null
                  ? errorLabel(bookError)
                  : t('reader.empty'),
              bookError !== null && !bookLoading
                // A refusal the same request cannot change (400/403/404/413/415)
                // gets no retry button: it would fail identically forever and
                // hides that the Host already explained what is wrong.
                ? (isPermanentFailure(bookError)
                  ? null
                  : h(
                    'button',
                    { type: 'button', onClick: retry, style: { ...ghostButtonStyle(false), marginLeft: 8 } },
                    retryLabel,
                  ))
                : null,
            ),
          }),

          /* ---- D. in-app file picker ----------------------------------- */
          // Absolutely positioned inside the panel root: no portal, no
          // document-level node, so the picker dies with the panel.
          browseOverlay(),
        )
      }

      Pdf2EpubPanel.displayName = 'Pdf2EpubPanel'
      return Pdf2EpubPanel
    }

    /**
     * Build the `.epub` document-preview body bound to one translate function.
     *
     * The body is mounted in the keyed slot `sidebar.right.tab.document` under
     * `EPUB_PREVIEW_ID`, so the owner hands it `DocumentBodyOwner` props and a
     * `{ kind: 'renderer' }` content handle. It fetches the unpacked book itself
     * (that is what `loading: 'renderer'` means) and then drives the handshake:
     * `content.loaded(...)` on success, `content.failed()` on failure, and
     * `content.reload()` from the error state. The reading area is the very same
     * `BookReader` the panel renders.
     *
     * @param {(key: string, params?: Record<string, unknown>) => string} t - localised copy.
     * @returns {Function} the preview body component.
     */
    function createPreview(t) {
      const errorLabel = createErrorLabel(t)

      /**
       * One `.epub` opened from the file tree, a chat link or a `present` card.
       * @param {object} props - `DocumentBodyOwner` props (+ the standard `useResource` hook).
       * @returns {object} React element.
       */
      function EpubPreviewBody(props) {
        const safeProps = props === null || typeof props !== 'object' ? {} : props
        const content = safeProps.content
        const renderer = content !== null && typeof content === 'object' && content.kind === 'renderer'
        const revision = renderer && typeof content.revision === 'number' ? content.revision : 0
        const resourceAddress = typeof safeProps.resourceAddress === 'string' ? safeProps.resourceAddress : ''
        // Hook first, unconditionally: `useResource` is a slot standard prop, and
        // its `absolutePath` is the most direct answer when the owner has one.
        const absolutePath = useDocumentAbsolutePath(safeProps)
        const target = documentTarget(safeProps, absolutePath)
        const filePath = target.path
        const sessionId = target.sessionId

        const [state, setState] = React.useState({ phase: 'loading', book: null, error: null })
        const [activeChapter, setActiveChapter] = React.useState(0)
        const [tocCollapsed, setTocCollapsed] = React.useState(false)
        const [nonce, setNonce] = React.useState(0)
        const [theme, setTheme] = React.useState({ bg: 'inherit', color: 'inherit' })
        const rootRef = React.useRef(null)
        const contentRef = React.useRef(null)

        // Theme aliases are probed once; the var() form keeps them live.
        React.useEffect(() => {
          setTheme(pickThemeTokens(rootRef.current))
        }, [])

        // The owner restores scroll positions through this ref: hand it the
        // scroller and give it back on unmount or when the body is replaced.
        const scrollportRef = safeProps.scrollportRef
        React.useEffect(() => {
          if (typeof scrollportRef !== 'function') return undefined
          scrollportRef(contentRef.current === undefined ? null : contentRef.current)
          return () => { scrollportRef(null) }
        }, [state.phase, state.book])

        // One request per revision: `content.revision` is the owner's reload
        // counter, so a toolbar reload refetches without remounting the body.
        React.useEffect(() => {
          const controller = new AbortController()
          let cancelled = false
          if (filePath === '') {
            setState({ phase: 'failed', book: null, error: localError('reader.missingPath', 'the document address carries no file path') })
            if (renderer && typeof content.failed === 'function') content.failed()
            return () => {
              cancelled = true
              controller.abort()
            }
          }
          setState({ phase: 'loading', book: null, error: null })
          void fetchEpubBook({ path: filePath, sessionId }, controller.signal).then(
            (book) => {
              if (cancelled) return
              setState({ phase: book.chapters.length === 0 ? 'empty' : 'ready', book, error: null })
              setActiveChapter(0)
              // The unpacked payload carries no file version, so the unknown
              // revision is reported as 0 (the owner's auto-refresh then simply
              // never fires for this renderer).
              if (renderer && typeof content.loaded === 'function') content.loaded(0)
            },
            (error) => {
              if (cancelled || error?.name === 'AbortError') return
              setState({
                phase: 'failed',
                book: null,
                error: error instanceof Error ? error : new Error(messageOf(error)),
              })
              if (renderer && typeof content.failed === 'function') content.failed()
            },
          )
          return () => {
            cancelled = true
            controller.abort()
          }
        }, [filePath, sessionId, resourceAddress, revision, nonce])

        const book = state.book
        const chapters = book === null ? [] : book.chapters
        const activeIndex = chapters.length === 0 ? 0 : clampChapter(activeChapter, chapters.length)
        const chapter = chapters.length === 0 ? null : chapters[activeIndex]
        const tocItems = buildTocItems(book)

        /** Jump to one chapter, clamped to the list (shared by TOC and pager). */
        const selectChapter = (index) => {
          if (chapters.length === 0) return
          setActiveChapter((current) => {
            const next = clampChapter(index, chapters.length)
            return next === current ? current : next
          })
        }

        /** Move the reading position, clamped to the chapter list. */
        const move = (delta) => {
          if (chapters.length === 0) return
          setActiveChapter((current) => {
            const next = clampChapter(current + delta, chapters.length)
            return next === current ? current : next
          })
        }

        // ← / → page the preview exactly like the panel does.
        React.useEffect(() => {
          if (chapters.length === 0) return undefined
          const onKeyDown = (event) => {
            const delta = chapterKeyDelta(event)
            if (delta === 0) return
            event.preventDefault()
            move(delta)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [chapters.length, state.phase])

        // A chapter swap starts at the top of the column.
        React.useEffect(() => {
          const node = contentRef.current
          if (node !== null && node !== undefined) node.scrollTop = 0
        }, [activeIndex, book])

        /** Retry through the owner, so the toolbar and this button agree. */
        const reload = () => {
          if (renderer && typeof content.reload === 'function') {
            content.reload()
            return
          }
          setNonce(value => value + 1)
        }

        /**
         * In-book links stay inside the reader: a chapter cross-reference moves
         * the reading position instead of navigating the whole app away from
         * the tab. Anything else is swallowed rather than followed.
         */
        const onContentClick = (event) => {
          const target = event === null || typeof event !== 'object' ? null : event.target
          if (target === null || typeof target.closest !== 'function') return
          const anchor = target.closest('a[href]')
          if (anchor === null) return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          const href = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('href') : ''
          if (href === '') return
          const index = chapterIndexOf(chapters, '', href)
          if (index >= 0) selectChapter(index)
        }

        const failed = state.phase === 'failed'
        // A 4xx is the Host refusing this exact request (a workspace-relative
        // path with no Session, an unknown Session, a missing or oversized
        // archive, an archive that is not an EPUB): retrying it cannot help, so
        // no retry is offered and the Host's own explanation stands alone. A
        // transport failure or a 5xx is worth retrying, and the two are no
        // longer reported the same way.
        const permanent = failed && isPermanentFailure(state.error)
        const statusText = state.phase === 'loading'
          ? t('reader.loading')
          : failed
            ? errorLabel(state.error)
            : t('reader.empty')

        const header = h(
          'div',
          {
            style: {
              display: 'flex',
              flex: '0 0 auto',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              padding: '8px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => setTocCollapsed(value => !value),
                'aria-expanded': tocCollapsed !== true,
                title: t('reader.toc'),
                style: ghostButtonStyle(false),
              },
              `${tocCollapsed ? '▸' : '▾'} ${t('reader.toc')}`,
            ),
            h(
              'span',
              {
                style: {
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              book !== null && book.title !== '' ? book.title : t('reader.toc'),
            ),
            book !== null && book.author !== ''
              ? h(
                'span',
                {
                  style: {
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-tertiary, inherit)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                book.author,
              )
              : null,
          ),
          chapters.length > 0
            ? h(
              'span',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', whiteSpace: 'nowrap' } },
              `${activeIndex + 1} / ${chapters.length}`,
            )
            : null,
        )

        const inner = state.phase === 'ready' || state.phase === 'empty'
          ? BookReader({
            theme,
            chapters,
            activeIndex,
            onSelect: selectChapter,
            chapter,
            contentRef,
            onContentClick,
            boxStyle: { margin: 0, border: 'none', borderRadius: 0 },
            header,
            showRow: true,
            showPager: chapters.length > 1,
            tocItems,
            tocCollapsed,
            tocLabel: t('reader.toc'),
            prevLabel: t('reader.prev'),
            nextLabel: t('reader.next'),
            cssText: scopeCss(book === null ? '' : book.css, EPUB_BOOK_CLASS),
            articleLang: book !== null && book.language !== '' ? book.language : undefined,
            chapterFallback: h(
              'div',
              { style: { padding: 18, fontSize: 13, color: 'var(--dsw-alias-label-tertiary, inherit)' } },
              t('reader.empty'),
            ),
          })
          : h(
            'div',
            {
              style: {
                flex: '1 1 auto',
                padding: 24,
                fontSize: 13,
                color: failed
                  ? 'var(--dsw-alias-state-error-primary, #c0392b)'
                  : 'var(--dsw-alias-label-tertiary, inherit)',
              },
            },
            statusText,
            failed && permanent !== true
              ? h(
                'button',
                { type: 'button', onClick: reload, style: { ...ghostButtonStyle(false), marginLeft: 8 } },
                t('panel.retry'),
              )
              : null,
          )

        return h(
          'div',
          {
            ref: rootRef,
            style: {
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              minHeight: 0,
              overflow: 'hidden',
              color: theme.color,
              background: theme.bg,
              fontSize: 14,
              lineHeight: 1.6,
            },
          },
          inner,
        )
      }

      EpubPreviewBody.displayName = 'EpubPreviewBody'
      return EpubPreviewBody
    }

    /**
     * Plugin body: registers the `pdf2epub` dictionaries, wires the translator,
     * then registers the sidebar entry and the main panel under the same id
     * (contract §8 hard constraint), plus the `.epub` document preview when the
     * document-preview service is present.
     *
     * Dictionaries go first: the registry is read at render time, so a panel
     * that mounted before `locale.register` would only know keys.
     *
     * @param {object} ctx - Cordis client context carrying `slots` and `locale`.
     */
    function apply(ctx) {
      const locale = ctx.locale
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        try {
          // Typed form of `LocaleRuntime.register`: complete dictionaries for
          // both baseline locale ids (`zh`, `en`), which the API requires.
          ctx.effect(
            () => locale.register(LOCALE_NS, { zh: DICT_ZH, en: DICT_EN }),
            'pdf2epub: dictionaries',
          )
        } catch (error) {
          // A second `apply` on one page (HMR, a duplicated loader entry) meets
          // the single-occupant rule. The dictionaries are identical every
          // time, so the first registration already holds the copy; losing the
          // whole panel over it is not acceptable.
          if (!isDuplicateLocaleError(error)) throw error
          if (!warnedDuplicateLocale) {
            warnedDuplicateLocale = true
            console.warn(
              `dsh-pdf2epub: the "${LOCALE_NS}" locale dictionaries were already registered; keeping the first registration.`,
              error,
            )
          }
        }
      }

      // The service is declared in `inject`, so it is present; the guard only
      // keeps the panel readable if a build ever ships a locale service without
      // the namespace binder.
      const bound = locale !== undefined && locale !== null && typeof locale.bind === 'function'
        ? locale.bind(LOCALE_NS)
        : null

      /**
       * Localised copy for one `pdf2epub` key.
       *
       * The registry answers first. A key no dictionary resolves comes back
       * unchanged — the contract's own signal for a miss — so it degrades to
       * the inlined Chinese dictionary instead of printing `panel.title` to
       * the reader.
       *
       * @param {string} key - key of this file's dictionaries.
       * @param {Record<string, unknown>} [params] - values for `{name}` placeholders.
       * @returns {string} localised copy, or the key when nothing resolves it.
       */
      const t = (key, params) => {
        const translated = bound === null ? key : bound(key, params)
        if (translated !== key) return translated
        const fallback = DICT_ZH[key]
        return fallback === undefined ? key : fillParams(fallback, params)
      }

      const Panel = createPanel(t, ctx)

      // `main` first: clicking the sidebar entry runs `layout.selectPanel(id)`,
      // which throws while no main entry carries that key.
      ctx.effect(() => registerSlot(ctx, 'main', { key: PANEL_ID, locale: LOCALE_NS }, Panel), 'pdf2epub: main panel')
      ctx.effect(
        () => registerSlot(
          ctx,
          'sidebar.panellist',
          { id: PANEL_ID, order: 20, locale: LOCALE_NS, label: () => t('panel.title') },
          PanelIcon,
        ),
        'pdf2epub: sidebar entry',
      )

      // ---- `.epub` document preview (contract block at the top of this file).
      //
      // Two independent fences, on purpose. Cordis rolls back every effect
      // `apply` already registered when `apply` throws (`fiber.ts:527-543`), so
      // the sidebar panel registered just above would disappear with it — the
      // review measured exactly that (`probe-cordis` §F:
      // `["panel effect registered","panel effect DISPOSED"]`, after
      // `ctx.documentPreviews` threw `cannot get property … without inject`).
      // The outer fence catches the probe itself, the inner one catches each
      // registration, and neither rethrows: a broken preview costs the preview,
      // never the panel.
      try {
        const previews = clientService(ctx, 'documentPreviews')
        if (previews !== undefined && typeof previews === 'object' && typeof previews.register === 'function') {
          const Preview = createPreview(t)
          // Metadata first: the body is keyed by the renderer id, so mounting the
          // body before the id exists would only produce an orphan occupant.
          ctx.effect(() => {
            try {
              const dispose = previews.register({
                id: EPUB_PREVIEW_ID,
                extensions: ['epub'],
                // Subset of `extensions` (the registry throws otherwise); it also
                // keeps `.epub` out of the plain-text fallback's candidate list.
                binaryExtensions: ['epub'],
                // Product-external type: the highest tier, ahead of every built-in.
                priority: 'extension',
                title: () => {
                  const label = t(PREVIEW_TITLE_KEY)
                  return label === PREVIEW_TITLE_KEY ? PREVIEW_TITLE_FALLBACK : label
                },
                // The body fetches the unpacked book itself and drives loaded/failed.
                loading: 'renderer',
                // `wrap` is "does this implementation consume the document's wrap
                // preference" (`registry.ts`): the reader applies its own
                // typography, so it does not.
                wrap: false,
              })
              return typeof dispose === 'function' ? dispose : () => {}
            } catch (error) {
              // A second `apply` on one page (HMR, a duplicated loader entry)
              // meets the registry's single-occupant rule. The first
              // registration still owns `.epub`.
              warnPreviewOnce(
                'dsh-pdf2epub: the ".epub" document preview could not be registered; keeping the panel and any existing registration.',
                error,
              )
              return () => {}
            }
          }, 'pdf2epub: epub document preview')
          ctx.effect(() => {
            try {
              return registerSlot(ctx, 'sidebar.right.tab.document', { key: EPUB_PREVIEW_ID, locale: LOCALE_NS }, Preview)
            } catch (error) {
              warnPreviewOnce(
                'dsh-pdf2epub: the ".epub" reading body could not be registered; keeping the panel.',
                error,
              )
              return () => {}
            }
          }, 'pdf2epub: epub reader body')
        }
      } catch (error) {
        warnPreviewOnce(
          'dsh-pdf2epub: the document-preview service could not be used; keeping the panel.',
          error,
        )
      }
    }

    return {
      name: 'pdf2epub-ui',
      // `documentPreviews` is probed at apply time rather than declared here: the
      // registration is optional, and declaring a service that an install does
      // not serve would keep the whole plugin (panel included) from starting.
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
