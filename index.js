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
export const inject = ['llm', 'attachments', 'jobs', 'tools', 'webServer', 'connection']

/** Values used when the host resolves no configuration at all. */
const CONFIG_DEFAULTS = Object.freeze({
  primaryModel: '',
  reviewModels: Object.freeze([]),
  dpi: 150,
  maxTokens: 4000,
  concurrency: 4,
  splitLevel: 2,
  language: 'zh-CN',
})

/** Field ranges, restated here for the fallback path below. */
const CONFIG_RANGES = Object.freeze({
  dpi: [72, 300],
  maxTokens: [512, 16000],
  concurrency: [1, 16],
  splitLevel: [1, 6],
})

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
     * @param {{ signal?: AbortSignal }} exec - execution identity; the signal is forwarded so a cancelled call stops the pages in flight.
     * @returns {Promise<object>} canonical value declared by `output.schema`.
     */
    async execute(args, exec) {
      const spec = parseSpec(args)
      try {
        const canonical = await convertToCanonical(ctx, settings, spec, { signal: exec?.signal })
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
