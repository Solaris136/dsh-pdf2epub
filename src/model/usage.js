/**
 * Token accounting. Provider adapters report usage in slightly different field
 * names, so this normalises whatever arrives and keeps the raw object for the
 * report instead of silently dropping an unfamiliar shape.
 */

const INPUT_KEYS = ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'promptTokenCount']
const OUTPUT_KEYS = ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'candidatesTokenCount']
/**
 * Cache reads and writes are reported separately from input, and `inputTokens`
 * counts uncached input only: the DSH `TokenUsage` contract says the counts are
 * disjoint and billed input is the sum of `inputTokens`, `cacheReadTokens` and
 * `cacheWriteTokens` (dsh-llm/src/types.ts, `TokenUsage`). Older shapes that fold
 * a cache hit into a prompt total keep their own key names, so they are accepted
 * as aliases of the read side.
 */
const CACHE_READ_KEYS = ['cacheReadTokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cachedTokens', 'cached_tokens']
const CACHE_WRITE_KEYS = ['cacheWriteTokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheWriteInputTokens']
const REASONING_KEYS = ['reasoningTokens', 'reasoning_tokens']
const TOTAL_KEYS = ['totalTokens', 'total_tokens']

/** An empty accumulator. */
export function emptyLedger() {
  return { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0, unknownShapes: [] }
}

/**
 * Read a number from the first matching key of an object.
 * @param {Record<string, unknown>} source - usage object.
 * @param {string[]} keys - candidate keys, in priority order.
 * @returns {number | null} the value when it is a finite number.
 */
function firstNumber(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * Normalise one usage payload.
 * @param {unknown} usage - whatever the adapter attached to a chunk.
 * @returns {{ input: number, output: number, cached: number, cacheWrite: number, reasoning: number, total: number } | null} counts, or null when unrecognised.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const source = usage
  const input = firstNumber(source, INPUT_KEYS)
  const output = firstNumber(source, OUTPUT_KEYS)
  if (input === null && output === null) return null
  const cached = firstNumber(source, CACHE_READ_KEYS) ?? 0
  const cacheWrite = firstNumber(source, CACHE_WRITE_KEYS) ?? 0
  const reasoning = firstNumber(source, REASONING_KEYS) ?? 0
  // `input` excludes cached input, so the fallback total bills all three input
  // buckets plus output, matching the adapter's own `totalTokens` formula.
  const total = firstNumber(source, TOTAL_KEYS) ?? (input ?? 0) + (output ?? 0) + cached + cacheWrite
  return { input: input ?? 0, output: output ?? 0, cached, cacheWrite, reasoning, total }
}

/**
 * Add one call's usage to a ledger.
 * @param {ReturnType<typeof emptyLedger>} ledger - accumulator, mutated in place.
 * @param {{ input: number, output: number, cached: number, cacheWrite: number, reasoning: number, total: number } | null} usage - normalised usage.
 * @param {unknown} [raw] - the original payload, recorded when it did not normalise.
 * @returns {ReturnType<typeof emptyLedger>} the same ledger.
 */
export function addUsage(ledger, usage, raw) {
  ledger.calls += 1
  if (usage === null) {
    if (raw !== undefined && ledger.unknownShapes.length < 5) ledger.unknownShapes.push(String(safeJson(raw)).slice(0, 400))
    return ledger
  }
  ledger.input += usage.input
  ledger.output += usage.output
  ledger.cached += usage.cached
  ledger.cacheWrite += usage.cacheWrite
  ledger.reasoning += usage.reasoning
  ledger.total += usage.total
  return ledger
}

/**
 * Merge a child ledger into a parent one.
 * @param {ReturnType<typeof emptyLedger>} target - accumulator, mutated in place.
 * @param {ReturnType<typeof emptyLedger>} source - ledger to fold in.
 * @returns {ReturnType<typeof emptyLedger>} the target.
 */
export function mergeLedger(target, source) {
  target.input += source.input ?? 0
  target.output += source.output ?? 0
  target.cached += source.cached ?? 0
  // A cache entry written before cache writes were tracked has no such field.
  target.cacheWrite += source.cacheWrite ?? 0
  target.reasoning += source.reasoning ?? 0
  target.total += source.total ?? 0
  target.calls += source.calls ?? 0
  for (const shape of source.unknownShapes ?? []) {
    if (target.unknownShapes.length < 5) target.unknownShapes.push(shape)
  }
  return target
}

/**
 * Rough fallback count when a provider reports no usage at all.
 * @param {string} text - counted text.
 * @returns {number} estimated tokens; CJK counts near one token per character.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  let cjk = 0
  for (const char of value) if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
  const rest = value.length - cjk
  return Math.ceil(cjk + rest / 4)
}

/** JSON stringify that never throws. */
function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}
