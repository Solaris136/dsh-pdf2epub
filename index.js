/**
 * Host entry for dsh-pdf2epub: the plugin contract, the `pdf2epub` model tool,
 * and the hand-off to the HTTP/job layer in `src/host/server.js`.
 *
 * Nothing heavy lives here. A conversion is fully automatic and runs for
 * minutes on a real book, so it goes through `runConversion` (src/pipeline.js)
 * with the Host services the pipeline needs, and every surface — tool call,
 * `POST /run`, `GET /state` — reads and writes the same state table.
 */

import { convertToCanonical, parseSpec, recordArtifacts, registerRoutes } from './src/host/server.js'

/**
 * Cordis plugin name. Also the id this package registers itself under in
 * `cordis.patch.yml`.
 * @type {string}
 */
export const name = 'dsh-pdf2epub'

/**
 * Host services this plugin cannot work without: the pipeline needs `llm` and
 * `attachments`, jobs and the web server carry long runs and progress, and
 * `connection` is the request fence every route uses.
 * @type {string[]}
 */
export const inject = ['llm', 'attachments', 'tools', 'webServer', 'connection']

/** Values used when the host resolves no configuration at all. */
const CONFIG_DEFAULTS = Object.freeze({
  primaryModel: '',
  reviewModels: Object.freeze([]),
  dpi: 150,
  maxTokens: 4000,
  concurrency: 4,
  splitLevel: 2,
  language: 'zh-CN',
  footnotePlacement: 'chapter',
  footnoteLinks: true,
})

/** Field ranges, restated here for the fallback path below. */
const CONFIG_RANGES = Object.freeze({
  dpi: [72, 300],
  maxTokens: [512, 16000],
  concurrency: [1, 16],
  splitLevel: [1, 6],
})

/**
 * Where a page-bottom footnote goes in the finished book.
 *
 * `chapter` is the default because it is what a reflowable page needs: the note
 * is printed under the last line of a printed page, so leaving it in the flow
 * puts it in the middle of a sentence the next page continues. `inline` keeps the
 * note where it was printed, for a reader whose footnote popup wants it in the
 * flow.
 *
 * @type {string[]}
 */
const FOOTNOTE_PLACEMENTS = Object.freeze(['chapter', 'inline'])

/**
 * Resolve the host's schemastery.
 *
 * The library ships with the DSH runtime, not with this package, and the name
 * it is published under differs between releases (`@deepseek-ai/schemastery`
 * in DSH 0.3, the unscoped package elsewhere), so both are tried and a miss
 * simply means "no schema". Without a schema the host hands the raw config to
 * `apply`, which merges the defaults itself — the pipeline clamps the numbers
 * again either way.
 *
 * @returns {Promise<object | null>} the `z` factory, or `null` when neither name resolves.
 */
async function loadSchemastery() {
  for (const specifier of ['@deepseek-ai/schemastery', 'schemastery']) {
    try {
      const loaded = await import(specifier)
      const factory = loaded?.default ?? loaded
      if (typeof factory?.object === 'function' && typeof factory?.string === 'function') return factory
    } catch {
      // Not published under this name here; try the other one.
    }
  }
  return null
}

const z = await loadSchemastery()

/**
 * The schema of one enumerated setting.
 *
 * A union of constants renders as a real choice in the settings page; the
 * fallback (`z` unavailable, or a schemastery release without `const`/`union`)
 * is a plain string, and {@link normalizeConfig} clamps the value to the same
 * list either way - a settings page that offers no menu must still not be able to
 * put a typo into the book.
 *
 * @param {string[]} values - allowed values, in display order.
 * @returns {object} schema for one value.
 */
function enumSchema(values) {
  if (typeof z.union === 'function' && typeof z.const === 'function') {
    return z.union(values.map(value => z.const(value)))
  }
  return z.string()
}

/**
 * Plugin configuration.
 *
 * Keys and defaults mirror what `runConversion` actually reads: a per-call
 * argument always wins over the value here, and a value here wins over the
 * pipeline's own default.
 *
 * `primaryModel` has no `.default()` value that could be guessed and no
 * `.required()` either: an empty one must not stop the plugin from loading, or
 * a fresh install would show no panel at all and no reason why. The check runs
 * when a conversion starts (`requireModelRoute` in `src/host/server.js`), which
 * names the setting in the error.
 *
 * @type {object | undefined}
 */
export const Config = z === null ? undefined : z.object({
  primaryModel: z.string().default('').description('Vision model route for transcription, as provider/model. Required before converting; set it in the plugin settings.'),
  reviewModels: z.array(String).default([]).description('Extra model routes that cross-review weak pages.'),
  dpi: z.natural().min(72).max(300).default(150).description('Page render DPI request. Values above 150 are kept as requestedDpi but render at 150: the platform image projection downsamples an A4 page to roughly 1092x1540, so extra DPI changes nothing the model sees.'),
  maxTokens: z.natural().min(512).max(16000).default(4000).description('Output ceiling for one page transcription.'),
  concurrency: z.natural().min(1).max(16).default(4).description('Pages transcribed at once.'),
  splitLevel: z.natural().min(1).max(6).default(2).description('Heading level that starts a new chapter.'),
  language: z.string().default('zh-CN').description('Language tag written into the EPUB.'),
  footnotePlacement: enumSchema(FOOTNOTE_PLACEMENTS).default('chapter').description('Where a page-bottom footnote goes: "chapter" collects every note in an endnotes section at the end of its chapter, so a note cannot split a paragraph the way it did on the printed page; "inline" leaves it where it was printed, as an aside in the flow.'),
  footnoteLinks: z.boolean().default(true).description('With footnotePlacement "chapter": turn the marker in the text into a link to its note and the note\'s number into a link back, for readers that jump between the two. Off leaves both as plain characters.'),
  outputDir: z.string().description('Output directory; defaults to the PDF\'s own directory.'),
})

/**
 * Register the model tool and the HTTP routes.
 *
 * @param {object} ctx - host context carrying the injected services.
 * @param {object} [config] - configuration as the host resolved it.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  ctx.effect(
    () => ctx.tools.register(definePdf2epubTool(ctx, settings)),
    'pdf2epub: tool',
  )
  registerRoutes(ctx, settings)
}

/**
 * Merge a host-resolved configuration over the built-in defaults.
 *
 * Written to tolerate three shapes: a validated object (the normal path), no
 * object at all (`Config` unavailable or omitted), and stray `undefined`
 * values, which must not shadow a default.
 *
 * @param {unknown} config - configuration from the host.
 * @returns {object} complete configuration.
 */
function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {}
  /** @type {Record<string, unknown>} */
  const merged = { ...CONFIG_DEFAULTS }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) merged[key] = value
  }
  merged.reviewModels = Array.isArray(merged.reviewModels)
    ? merged.reviewModels.map(item => String(item)).filter(item => item !== '')
    : []
  for (const [key, [min, max]] of Object.entries(CONFIG_RANGES)) {
    const value = Number(merged[key])
    merged[key] = Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : CONFIG_DEFAULTS[key]
  }
  merged.outputDir = typeof merged.outputDir === 'string' && merged.outputDir !== '' ? merged.outputDir : undefined
  merged.primaryModel = typeof merged.primaryModel === 'string' ? merged.primaryModel : ''
  merged.language = typeof merged.language === 'string' && merged.language !== '' ? merged.language : CONFIG_DEFAULTS.language
  merged.footnotePlacement = FOOTNOTE_PLACEMENTS.includes(merged.footnotePlacement)
    ? merged.footnotePlacement
    : CONFIG_DEFAULTS.footnotePlacement
  // Anything but an explicit `false` means on: a host that hands the key over as
  // a string ("false") must not silently switch the links off.
  merged.footnoteLinks = merged.footnoteLinks !== false
  return merged
}

/**
 * Declare the `pdf2epub` model tool.
 *
 * @param {object} ctx - host context carrying `llm` and `attachments`.
 * @param {object} settings - normalized plugin configuration.
 * @returns {object} registry-ready tool definition.
 */
function definePdf2epubTool(ctx, settings) {
  return {
    name: 'pdf2epub',
    description: [
      'Convert a whole PDF into a reflowable EPUB 3, fully automatically: every page is rendered and transcribed by a vision model, the pipeline\'s page sentinels never block on a bad page, weak pages are cross-reviewed by the configured extra models, and the result is assembled into chapters.',
      'Writes three files next to each other in the output directory: <book>.epub, <book>.report.json (per-page quality, models used, token ledger) and <book>.book.json (the chapter list a reading view renders without unpacking the EPUB).',
      'Returns canonical JSON with the three output paths, page and chapter counts, token usage and the number of degraded pages. Pages are cached on disk, so re-running after an interruption resumes instead of starting over; pass force to ignore the cache.',
      'A big book can be converted in batches with pages ("1-5,31-35,73") and excludePages: only the selected pages are rendered and sent to a model, and the per-page cache stays keyed by the whole book, so later batches and the final whole-book run reuse every page already transcribed. Never copy or rename the PDF to split it - that changes the cache identity and throws the whole cache away.',
      'cover renders page 1 as the EPUB cover image; title, author and publisher override the PDF metadata on the book itself (the caller\'s value wins over the PDF\'s, and the PDF\'s over the file name).',
      'Page-bottom footnotes are collected in an endnotes section at the end of their chapter (footnotePlacement "chapter", the default) with each marker linked to its note and each note linked back, so a note cannot be left standing in the middle of the sentence the next page continues; footnotePlacement "inline" keeps them in the flow instead.',
      'The primary model must accept image input. A long book takes minutes and the call returns only when the EPUB is written; for big documents the panel starts the same conversion as a background job instead.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: {
        input: {
          type: 'string',
          description: 'PDF to convert: an absolute path, or a path relative to the working directory.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory for the EPUB, report and chapter list. Defaults to the plugin configuration, then to the PDF\'s own directory.',
        },
        model: {
          type: 'string',
          description: 'Primary model route (provider/model) overriding the configured primaryModel. Must accept image input.',
        },
        reviewModels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra model routes that cross-review weak pages, overriding the configured reviewModels. Empty means weak pages are only marked degraded.',
        },
        dpi: {
          type: 'number',
          description: 'Page render DPI, 72-300. The pipeline caps the effective value at 150: the platform image projection downsamples an A4 page to roughly 1092x1540, so a higher request buys no model-visible detail. The report records requestedDpi vs effectiveDpi.',
        },
        maxTokens: {
          type: 'number',
          description: 'Output ceiling per page transcription, 512-16000.',
        },
        concurrency: {
          type: 'number',
          description: 'Pages transcribed at once, 1-16.',
        },
        splitLevel: {
          type: 'number',
          description: 'Heading level that starts a new chapter, 1-6.',
        },
        footnotePlacement: {
          type: 'string',
          enum: ['chapter', 'inline'],
          description: 'Where a page-bottom footnote goes, overriding the configured footnotePlacement. "chapter" (the default) collects every note in an endnotes section at the end of its chapter and links each marker to its note, so a note printed under the last line of a page can no longer split a paragraph in half; "inline" keeps the aside where the note was printed.',
        },
        footnoteLinks: {
          type: 'boolean',
          description: 'With footnotePlacement "chapter": link every marker in the text to its note and every note number back to the text. Off leaves both as plain characters. Overrides the configured footnoteLinks.',
        },
        pages: {
          type: 'string',
          description: 'Pages to convert, as "1-5,31-35,73" (1-based, comma separated, ranges inclusive). Omit to convert the whole document. Pages outside the selection are neither rendered nor sent to a model and do not enter the EPUB; the page cache stays keyed by the whole book plus the page number, so several batches and the final whole-book run share every page already transcribed.',
        },
        excludePages: {
          type: 'string',
          description: 'Pages to leave out of the run, same syntax as pages. Applied after pages: "pages: 1-3" with "excludePages: 2" converts pages 1 and 3. Useful for a scan that ends with a library or archive cover sheet.',
        },
        cover: {
          type: 'boolean',
          description: 'Render page 1 as the EPUB cover image (PNG, long edge 1400px) and declare it as the package cover. Off by default. Page 1 is still transcribed only if the page selection includes it, and a render failure is recorded as a warning instead of failing the book.',
        },
        title: {
          type: 'string',
          description: 'Book title for the EPUB metadata. Wins over the PDF\'s own title, which wins over the file name.',
        },
        author: {
          type: 'string',
          description: 'Book author (dc:creator) for the EPUB metadata. Wins over the PDF\'s own author metadata.',
        },
        publisher: {
          type: 'string',
          description: 'Publisher (dc:publisher) for the EPUB metadata. A PDF carries no publisher field, so without this the OPF simply has none.',
        },
        force: {
          type: 'boolean',
          description: 'Ignore the per-page disk cache and transcribe every page again.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'epubPath', 'reportPath', 'bookJsonPath', 'pages', 'chapters', 'tokens', 'degradedPages'],
        properties: {
          ok: { type: 'boolean', description: 'True for a finished conversion; failures throw instead.' },
          epubPath: { type: 'string', description: 'Absolute path of the written EPUB 3 file.' },
          reportPath: { type: 'string', description: 'Absolute path of the JSON report.' },
          bookJsonPath: { type: 'string', description: 'Absolute path of the JSON chapter list the reading view renders.' },
          pages: { type: 'integer', description: 'Pages in the PDF.' },
          chapters: { type: 'integer', description: 'Chapters assembled into the EPUB.' },
          tokens: {
            type: 'object',
            additionalProperties: false,
            required: ['input', 'output', 'total'],
            properties: {
              input: { type: 'integer', description: 'Prompt tokens billed across all model calls.' },
              output: { type: 'integer', description: 'Completion tokens billed across all model calls.' },
              total: { type: 'integer', description: 'Input plus output.' },
            },
          },
          degradedPages: { type: 'integer', description: 'Pages kept in the book but flagged degraded: the cross-review found no model agreement, or no reviewer was configured.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    /**
     * Run one conversion, register its files and return the canonical value.
     *
     * Registration happens after the awaited conversion returned, so a failure
     * (the throw below) leaves the artifact table untouched. `'tool'` marks the
     * source: a conversation conversion has no job id, and the panel's two file
     * readers must still be able to open what it wrote.
     *
     * @param {unknown} args - parsed model arguments; validated by {@link parseSpec}.
     * @param {{ signal?: AbortSignal, agent?: { id?: unknown } }} exec - execution identity; the signal is forwarded so a cancelled call stops the pages in flight, and the agent's Session id becomes the model route's per-session routing id.
     * @returns {Promise<object>} canonical value declared by `output.schema`.
     */
    async execute(args, exec) {
      const spec = extendSpec(parseSpec(args), args)
      // The adapter derives a required per-session routing header from
      // `GenerateOptions.sessionId` (opencode-go answers `400 MissingSessionID`
      // without it), and the Agent that called this tool *is* the session the
      // work belongs to, so its id is forwarded when the runtime supplied one.
      // The other surfaces - the panel's job, a direct `runConversion()` - hold
      // no Agent, and the pipeline then uses its own per-book derived id instead
      // of inventing a second one here.
      const sessionId = agentSessionId(exec)
      const request = sessionId === undefined ? spec : { ...spec, sessionId }
      try {
        const canonical = await convertToCanonical(ctx, settings, request, { signal: exec?.signal })
        recordArtifacts('tool', canonical)
        return canonical
      } catch (error) {
        if (exec?.signal?.aborted === true) throw abortedError(error)
        throw error
      }
    },
    presentCall: args => ({ card: 'generic', title: 'pdf2epub', rawInput: args }),
  }
}

/**
 * Options this tool declares on top of the request shape `parseSpec()` owns.
 *
 * `parseSpec()` is the request contract the panel and the tool share, so it only
 * copies the fields both surfaces understand. These six exist for the tool (and
 * for any direct `runConversion()` caller that builds its own spec): they are
 * type checked here, because a boolean where a page expression belongs must fail
 * before a conversion starts, while their *meaning* is validated by the pipeline -
 * the only layer that knows how many pages the document really has.
 *
 * @type {string[]}
 */
const TOOL_STRING_OPTIONS = ['pages', 'excludePages', 'title', 'author', 'publisher']

/**
 * Fold the tool's own options into a `parseSpec()` result.
 *
 * Keys the caller did not supply are left absent, exactly as `parseSpec()` does,
 * so the pipeline's own defaults stay in charge.
 *
 * @param {object} spec - spec returned by `parseSpec()`.
 * @param {Record<string, unknown>} args - parsed model arguments.
 * @returns {object} the spec with the tool's options added.
 * @throws {Error} when an option has the wrong type.
 */
function extendSpec(spec, args) {
  /** @type {Record<string, unknown>} */
  const extended = { ...spec }
  for (const key of TOOL_STRING_OPTIONS) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new Error(`pdf2epub: "${key}" must be a string${key === 'pages' || key === 'excludePages' ? ' such as "1-5,31-35,73"' : ''}`)
    }
    extended[key] = value
  }
  if (args.cover !== undefined) {
    if (typeof args.cover !== 'boolean') throw new Error('pdf2epub: "cover" must be a boolean')
    extended.cover = args.cover
  }
  for (const key of ['footnoteLinks']) {
    if (args[key] === undefined) continue
    if (typeof args[key] !== 'boolean') throw new Error(`pdf2epub: "${key}" must be a boolean`)
    extended[key] = args[key]
  }
  if (args.footnotePlacement !== undefined) {
    const value = args.footnotePlacement
    if (typeof value !== 'string') throw new Error('pdf2epub: "footnotePlacement" must be a string')
    if (!FOOTNOTE_PLACEMENTS.includes(value)) {
      throw new Error(`pdf2epub: "footnotePlacement" must be ${FOOTNOTE_PLACEMENTS.map(item => JSON.stringify(item)).join(' or ')}`)
    }
    extended.footnotePlacement = value
  }
  return extended
}

/**
 * The calling Agent's Session id, when the tool runtime exposes one.
 *
 * `ToolRunContext.agent` is optional (`@deepseek-ai/dsh-tools`: "set by the agent
 * loop"), and `Agent.id` is the Session id itself - a `SessionId` is a branded
 * STRING, so the value is read from `agent.id` and not from something like
 * `agent.session.id`. Anything unusable (no agent, an empty id, a non-string)
 * yields `undefined`, which leaves the pipeline to derive `<book>`'s own stable
 * id: a wrong or empty header would be rejected exactly like a missing one.
 *
 * @param {{ agent?: { id?: unknown } } | null | undefined} exec - the tool execution context.
 * @returns {string | undefined} session routing id, or undefined when none is available.
 */
function agentSessionId(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Build the error a cancelled tool call throws.
 *
 * Mirrors the tools contract's canonical `ABORTED` code without importing the
 * package, so a caller-requested cancellation is distinguishable from a real
 * conversion failure in the result metadata.
 *
 * @param {unknown} cause - the underlying error or abort reason.
 * @returns {Error} error carrying `code: 'ABORTED'`.
 */
function abortedError(cause) {
  /** @type {Error & { code?: string }} */
  const error = new Error('pdf2epub: cancelled', { cause })
  error.code = 'ABORTED'
  return error
}
