/**
 * Thin seam over the Host services the pipeline needs. Everything that depends
 * on an uncertain Host contract lives here, so the pipeline itself stays pure
 * orchestration.
 */

/**
 * Collect a model stream into text plus normalised usage.
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
 * @param {AsyncIterable<unknown>} stream - chunks from `ctx.llm.stream`.
 * @param {(delta: string) => void} [onDelta] - optional live sink for progress.
 * @returns {Promise<{ text: string, usage: unknown, finish: unknown, error: string | null, truncated: boolean }>}
 */
export async function collectStream(stream, onDelta) {
  let text = ''
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
      } else if (reasonKind === 'max-tokens') {
        truncated = true
      }
      continue
    }
  }
  if (error === null && text.trim() === '') error = 'model returned no text'
  return { text, usage, finish, error, truncated }
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
 * @param {object} host - context carrying `llm`.
 * @param {{ provider: string, model: string, system?: string, user: string, image?: object, maxTokens: number, signal?: AbortSignal }} request - call parameters.
 * @returns {Promise<{ text: string, usage: unknown, error: string | null, truncated: boolean, finish: unknown, finishKind: string | null, ms: number }>} outcome.
 */
export async function callModel(host, request) {
  const started = Date.now()
  const content = [{ type: 'text', text: request.user }]
  if (request.image !== undefined) content.push(request.image)
  const options = {
    provider: request.provider,
    model: request.model,
    messages: [{ role: 'user', content }],
    maxTokens: request.maxTokens,
    ...request.system === undefined || request.system === '' ? {} : { system: request.system },
    ...request.signal === undefined ? {} : { signal: request.signal },
  }
  try {
    const result = await collectStream(host.llm.stream(options))
    return {
      text: result.text,
      usage: result.usage,
      error: result.error,
      truncated: result.truncated === true,
      finish: result.finish,
      finishKind: typeof result.finish?.kind === 'string' ? result.finish.kind : null,
      ms: Date.now() - started,
    }
  } catch (error) {
    return {
      text: '',
      usage: null,
      error: error instanceof Error ? error.message : String(error),
      truncated: false,
      finish: null,
      finishKind: null,
      ms: Date.now() - started,
    }
  }
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
 * Check that a route advertises image input before the run starts.
 *
 * `inputModalities` is `readonly ModelModality[] | undefined`: absent means
 * unknown, while an explicit list without `'image'` - including an empty list -
 * is negative capability. The runtime projects images to a text placeholder for
 * such a route, so the call would "succeed" while the model never sees the page.
 *
 * @param {object} host - context carrying `llm`.
 * @param {{ provider: string, model: string }} route - resolved route.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string | null>} a human-readable problem, or null when the route can read images.
 */
export async function checkImageCapability(host, route, signal) {
  try {
    const info = await host.llm.resolveModelInfo(route.provider, route.model, signal)
    const modalities = info?.inputModalities
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      const listed = modalities.length === 0 ? 'none' : modalities.join(', ')
      return `${route.provider}/${route.model} does not accept image input (inputModalities: ${listed})`
    }
    return null
  } catch (error) {
    return `cannot resolve ${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`
  }
}
