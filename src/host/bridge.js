/**
 * Thin seam over the Host services the pipeline needs. Everything that depends
 * on an uncertain Host contract lives here, so the pipeline itself stays pure
 * orchestration.
 */

/**
 * Tokens requested on top of the caller's answer budget.
 *
 * On a route that supports thinking, reasoning and the answer are charged against
 * one provider `max_tokens` field - the pi-ai adapter says so itself
 * ("Reasoning and the answer share max_tokens here, so an uncapped reasoning phase
 * can consume the whole response and leave no answer"). This route family cannot
 * turn thinking off, so a ceiling sized for the answer alone is spent by the
 * reasoning phase and the reply arrives with no text block at all.
 *
 * `callModel` therefore keeps the caller's `maxTokens` meaning "book text budget"
 * and sends `maxTokens + REASONING_HEADROOM` as the ceiling. It is a cap, not a
 * spend: a short reasoning phase costs nothing extra, and a non-reasoning route
 * simply never reaches it.
 */
export const REASONING_HEADROOM = 16384

/**
 * Collect a model stream into text, reasoning and normalised usage.
 *
 * The stream vocabulary is exactly `StreamChunk` from `@deepseek-ai/dsh-llm`:
 * `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` /
 * `block-end` / `usage` / `finish`. There is no `text` chunk, and `block-end`
 * only repeats the deltas already collected, so neither is a text source. The
 * terminal `finish` chunk carries `{ type:'finish', reason: FinishReason }`, and
 * a failed call is `reason.kind === 'error'|'aborted'` with the failure at
 * `reason.failure`; `max-tokens` is not a failure but a truncation, reported
 * separately so it cannot be mistaken for a complete answer.
 *
 * `reasoning-delta` is accumulated too, and not for display. On a route that
 * cannot turn thinking off the reasoning phase may be the only thing the stream
 * delivers, and reporting "no text" without knowing that reasoning ran is what
 * turned a spent output budget into an invisible per-page mystery. A reply with
 * no text is therefore classified: `failureKind === 'reasoning-budget'` when the
 * answer was crowded out by reasoning, so callers never have to match the
 * wording of `error`.
 *
 * @param {AsyncIterable<unknown>} stream - chunks from `ctx.llm.stream`.
 * @param {(delta: string) => void} [onDelta] - optional live sink for text progress.
 * @returns {Promise<{ text: string, reasoning: string, reasoningChars: number, usage: unknown, finish: unknown, error: string | null, truncated: boolean, failureKind: 'reasoning-budget' | null }>}
 */
export async function collectStream(stream, onDelta) {
  let text = ''
  let reasoning = ''
  let usage = null
  let finish = null
  let error = null
  let truncated = false
  for await (const raw of stream) {
    if (raw === null || typeof raw !== 'object') continue
    const kind = String(raw.type ?? raw.kind ?? '')
    if (kind === 'text-delta') {
      const delta = typeof raw.text === 'string' ? raw.text : typeof raw.delta === 'string' ? raw.delta : ''
      if (delta !== '') {
        text += delta
        onDelta?.(delta)
      }
      continue
    }
    if (kind === 'reasoning-delta') {
      // Same tolerant field reading as `text-delta`: the chunk carries `text`,
      // but `delta` is accepted so a differently shaped adapter still counts.
      const delta = typeof raw.text === 'string' ? raw.text : typeof raw.delta === 'string' ? raw.delta : ''
      if (delta !== '') reasoning += delta
      continue
    }
    if (kind === 'block-end') {
      // The assembled block duplicates text already taken from `text-delta`;
      // appending it would double every answer.
      continue
    }
    if (kind === 'usage') {
      usage = raw.usage ?? raw
      continue
    }
    if (kind === 'finish') {
      finish = raw.reason ?? null
      const reason = raw.reason ?? {}
      const reasonKind = String(reason.kind ?? '')
      if (reasonKind === 'error' || reasonKind === 'aborted') {
        const failure = reason.failure
        error = typeof failure?.message === 'string'
          ? failure.message
          : String(failure?.code ?? `stream ${reasonKind}`)
      } else if (reasonKind === 'max-tokens' || reason === 'length') {
        // `{ kind: 'max-tokens' }` is the normalised shape; a bare `'length'` is
        // the provider's own finish reason, accepted so a truncation cannot slip
        // through and be reported as a complete answer.
        truncated = true
      }
      continue
    }
  }
  const reasoningChars = reasoning.length
  let failureKind = null
  if (error === null && text.trim() === '') {
    if (reasoningChars > 0) {
      // The answer never started, but the model did produce tokens: the output
      // budget went to reasoning. `truncated` only sharpens the wording - a clean
      // finish carrying nothing but reasoning has lost the answer the same way.
      failureKind = 'reasoning-budget'
      error = truncated
        ? `the model spent the whole output budget on reasoning (${reasoningChars} chars) and returned no text; raise maxTokens`
        : `the model returned reasoning but no text (${reasoningChars} chars) and never reached an answer; raise maxTokens`
    } else {
      error = 'model returned no text'
    }
  }
  return { text, reasoning, reasoningChars, usage, finish, error, truncated, failureKind }
}

/**
 * Save a rendered page image and return an `ImageBlock` for a user message.
 *
 * The attachment contract is only `{ data, mediaType, name? }`; intrinsic pixel
 * size is measured by the store from the bytes, so no `width`/`height` is sent.
 * The returned `ImageAttachmentRef` is the authoritative description of what the
 * model will see (`width`/`height`/`bytes`), and its `mediaType` comes from the
 * stored bytes rather than from this call.
 *
 * @param {{ attachments: { saveImage: (input: object) => Promise<unknown> } }} host - context carrying the attachment service.
 * @param {Uint8Array} png - PNG bytes.
 * @returns {Promise<{ type: 'image', attachment: unknown }>} content block.
 */
export async function imageBlock(host, png) {
  const attachment = await host.attachments.saveImage({
    data: png,
    mediaType: 'image/png',
    name: 'page.png',
  })
  return { type: 'image', attachment }
}

/**
 * One model call with an optional image.
 *
 * A one-shot system prompt belongs in `GenerateOptions.system`, which adapters
 * map to the provider's system slot ahead of `messages`. It is not a
 * `role: 'system'` message: a durable `SystemMessage` must carry `id` and
 * `source`, and a hand-built envelope without them is not a `RequestMessage`.
 * The user turn is a `RequestUserInput` (`{ role: 'user', content }`), which is
 * allowed to have no Session identity.
 *
 * `maxTokens` is the answer budget, not the ceiling sent out: see
 * {@link REASONING_HEADROOM} for why the request carries headroom on top of it.
 * `reasoningEffort` is forwarded only when the caller resolved it from the model's
 * own capability report (see {@link resolveRoute}); an effort the route does not
 * support makes the Host throw `UNSUPPORTED_REASONING_EFFORT`, so it is never
 * guessed here.
 *
 * `sessionId` is forwarded as supplied and only when it is supplied: adapters
 * derive a per-session routing header from it (`x-opencode-session` on
 * opencode-go, which rejects a call carrying none with `400 MissingSessionID`),
 * so an `undefined` here means the caller asked for a session-less call. The
 * value is the caller's to choose and need not be a real DSH Session: the
 * pipeline resolves one stable opaque id per run (`resolveSessionId` in
 * `src/pipeline.js`) and hands it in. Omitting the key rather than sending a
 * placeholder is deliberate - an empty header fails exactly like a missing one,
 * only later and less clearly.
 *
 * @param {object} host - context carrying `llm`.
 * @param {{ provider: string, model: string, system?: string, user: string, image?: object, maxTokens: number, reasoningEffort?: string, sessionId?: string, signal?: AbortSignal }} request - call parameters.
 * @returns {Promise<{ text: string, usage: unknown, error: string | null, failureKind: 'reasoning-budget' | null, reasoningChars: number, truncated: boolean, finish: unknown, finishKind: string | null, ms: number }>} outcome.
 */
export async function callModel(host, request) {
  const started = Date.now()
  const content = [{ type: 'text', text: request.user }]
  if (request.image !== undefined) content.push(request.image)
  const options = {
    provider: request.provider,
    model: request.model,
    messages: [{ role: 'user', content }],
    // The caller's budget describes the book text it needs; reasoning shares the
    // provider's response cap, so headroom is added on top of it.
    maxTokens: request.maxTokens + REASONING_HEADROOM,
    ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
    ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
    ...request.system === undefined || request.system === '' ? {} : { system: request.system },
    ...request.signal === undefined ? {} : { signal: request.signal },
  }
  try {
    const result = await collectStream(host.llm.stream(options))
    return {
      text: result.text,
      usage: result.usage,
      error: result.error,
      failureKind: result.failureKind,
      reasoningChars: result.reasoningChars,
      truncated: result.truncated === true,
      finish: result.finish,
      finishKind: finishKindOf(result.finish),
      ms: Date.now() - started,
    }
  } catch (error) {
    return {
      text: '',
      usage: null,
      error: error instanceof Error ? error.message : String(error),
      failureKind: null,
      reasoningChars: 0,
      truncated: false,
      finish: null,
      finishKind: null,
      ms: Date.now() - started,
    }
  }
}

/**
 * The normalised kind of a finish reason.
 *
 * `FinishReason` is `{ kind: 'stop' | 'max-tokens' | ... }`, but an adapter may
 * hand back the provider's own `finish_reason` string instead; a bare `'length'`
 * still has to reach the report as a finish kind rather than as "unknown".
 *
 * @param {unknown} finish - the terminal chunk's `reason`.
 * @returns {string | null} the kind, or null when the reply carried none.
 */
function finishKindOf(finish) {
  if (typeof finish === 'string') return finish
  return typeof finish?.kind === 'string' ? finish.kind : null
}

/**
 * Split a `provider/model` reference.
 * @param {string} reference - for example `deepseek-official/deepseek-v4-flash`.
 * @returns {{ provider: string, model: string }} parts; the model keeps any later slashes.
 */
export function parseRoute(reference) {
  const value = String(reference ?? '').trim()
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error(`invalid model route "${value}", expected provider/model`)
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/**
 * Resolve one route: what it can read, and the cheapest reasoning level it
 * supports.
 *
 * Both facts come from the same `resolveModelInfo` round-trip, because the image
 * verdict has to be known before the run starts and the reasoning level has to be
 * forwarded on every call afterwards. The lowest advertised effort is chosen
 * deliberately: this route family cannot turn thinking off (the pi-ai catalog
 * maps `thinkingLevelMap.off` to `null`, which drops `off` from the supported
 * levels), so the cheapest level is the deterministic one, while naming no level
 * at all leaves the provider default in charge of a budget the answer also needs.
 *
 * Nothing is hard-coded: an effort this model does not advertise makes the Host
 * throw `UNSUPPORTED_REASONING_EFFORT`, so the value only ever comes from the
 * model's own capability report - and a route with no `reasoning` (or an empty
 * effort list) simply gets none, which keeps its old behaviour.
 *
 * `inputModalities` is `readonly ModelModality[] | undefined`: absent means
 * unknown, while an explicit list without `'image'` - including an empty list -
 * is negative capability. The runtime projects images to a text placeholder for
 * such a route, so the call would "succeed" while the model never sees the page.
 *
 * @param {object} host - context carrying `llm`.
 * @param {{ provider: string, model: string }} route - resolved route.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ problem: string | null, reasoning: boolean, reasoningEffort?: string }>}
 *   `problem` is a human-readable image/capability failure (null when the route
 *   can read images), `reasoning` says whether thinking exists at all, and
 *   `reasoningEffort` is its lowest level when it does.
 */
export async function resolveRoute(host, route, signal) {
  try {
    const info = await host.llm.resolveModelInfo(route.provider, route.model, signal)
    const modalities = info?.inputModalities
    const problem = Array.isArray(modalities) && !modalities.includes('image')
      ? `${route.provider}/${route.model} does not accept image input (inputModalities: ${modalities.length === 0 ? 'none' : modalities.join(', ')})`
      : null
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
    const lowest = efforts[0]
    return {
      problem,
      reasoning: efforts.length > 0,
      ...typeof lowest?.id === 'string' ? { reasoningEffort: lowest.id } : {},
    }
  } catch (error) {
    return {
      problem: `cannot resolve ${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`,
      reasoning: false,
    }
  }
}

/**
 * Capability verdict only, for a caller that does not need the reasoning level.
 *
 * @param {object} host - context carrying `llm`.
 * @param {{ provider: string, model: string }} route - resolved route.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string | null>} a human-readable problem, or null when the route can read images.
 */
export async function checkImageCapability(host, route, signal) {
  return (await resolveRoute(host, route, signal)).problem
}
