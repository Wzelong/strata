// Hardcoded OpenAI Batch API pricing (Batch tier = 50% discount) and storage
// heuristics. Tune here after observing real runs. All prices in USD.

const PRICE_PER_M_EMBED_INPUT = 0.01      // text-embedding-3-small batch tier
const PRICE_PER_M_EXTRACT_INPUT = 0.10    // gpt-5.4-mini batch tier input
const PRICE_PER_M_EXTRACT_OUTPUT = 0.40   // gpt-5.4-mini batch tier output

const AVG_INPUT_TOKENS_PER_ITEM = 250
const AVG_OUTPUT_TOKENS_PER_ITEM = 200    // entity-extraction JSON
const AVG_ENTITIES_PER_ITEM = 5
const AVG_ENTITY_TOKENS = 8

// Per-item Redis bytes: text + 256-d quantized embedding (~400) + entity
// payloads + index entries. Calibrated against seed.json (19 MB / 5391 items
// ≈ 3.5 KB), conservatized for headroom.
const BYTES_PER_ITEM = 2500

export const REDIS_CAPACITY_BYTES = 500 * 1024 * 1024  // 500 MB Devvit cap
export const ITEM_CAPACITY = 330_000

export type BackfillEstimate = {
  itemCount: number
  estimatedMinutes: number
  estimatedCostUsd: number
  estimatedBytes: number
  currentBytes: number
  capacityBytes: number
  willExceed: boolean
}

export function estimateBackfill(itemCount: number, currentBytes: number): BackfillEstimate {
  const embedTokens = itemCount * AVG_INPUT_TOKENS_PER_ITEM
  const extractInputTokens = itemCount * AVG_INPUT_TOKENS_PER_ITEM
  const extractOutputTokens = itemCount * AVG_OUTPUT_TOKENS_PER_ITEM
  const entityEmbedTokens = itemCount * AVG_ENTITIES_PER_ITEM * AVG_ENTITY_TOKENS

  const estimatedCostUsd =
    ((embedTokens + entityEmbedTokens) / 1_000_000) * PRICE_PER_M_EMBED_INPUT +
    (extractInputTokens / 1_000_000) * PRICE_PER_M_EXTRACT_INPUT +
    (extractOutputTokens / 1_000_000) * PRICE_PER_M_EXTRACT_OUTPUT

  const estimatedBytes = itemCount * BYTES_PER_ITEM
  const projectedBytes = currentBytes + estimatedBytes
  const willExceed = projectedBytes > REDIS_CAPACITY_BYTES

  const estimatedMinutes = Math.max(3, Math.ceil(itemCount / 500))

  return {
    itemCount,
    estimatedMinutes,
    estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
    estimatedBytes,
    currentBytes,
    capacityBytes: REDIS_CAPACITY_BYTES,
    willExceed,
  }
}

export function estimateCurrentBytes(itemCount: number): number {
  return itemCount * BYTES_PER_ITEM
}
