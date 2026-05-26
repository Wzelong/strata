const BATCH_PRICE_PER_M_EMBED_INPUT = 0.01
const BATCH_PRICE_PER_M_EXTRACT_INPUT = 0.10
const BATCH_PRICE_PER_M_EXTRACT_OUTPUT = 0.40

const RT_PRICE_PER_M_EMBED_INPUT = 0.02
const RT_PRICE_PER_M_EXTRACT_INPUT = 0.20
const RT_PRICE_PER_M_EXTRACT_OUTPUT = 0.80

const AVG_INPUT_TOKENS_PER_ITEM = 250
const AVG_OUTPUT_TOKENS_PER_ITEM = 200
const AVG_ENTITIES_PER_ITEM = 5
const AVG_ENTITY_TOKENS = 8

export const RT_ITEMS_PER_TICK = 500
export const RT_TICK_SPACING_MS = 3000

const BYTES_PER_ITEM = 2500

export const REDIS_CAPACITY_BYTES = 500 * 1024 * 1024
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

function computeCost(itemCount: number, embedRate: number, extractInRate: number, extractOutRate: number): number {
  const embedTokens = itemCount * AVG_INPUT_TOKENS_PER_ITEM
  const extractInputTokens = itemCount * AVG_INPUT_TOKENS_PER_ITEM
  const extractOutputTokens = itemCount * AVG_OUTPUT_TOKENS_PER_ITEM
  const entityEmbedTokens = itemCount * AVG_ENTITIES_PER_ITEM * AVG_ENTITY_TOKENS
  return ((embedTokens + entityEmbedTokens) / 1_000_000) * embedRate +
    (extractInputTokens / 1_000_000) * extractInRate +
    (extractOutputTokens / 1_000_000) * extractOutRate
}

export function estimateBackfill(itemCount: number, currentBytes: number): BackfillEstimate {
  const estimatedCostUsd = computeCost(itemCount, BATCH_PRICE_PER_M_EMBED_INPUT, BATCH_PRICE_PER_M_EXTRACT_INPUT, BATCH_PRICE_PER_M_EXTRACT_OUTPUT)
  const estimatedBytes = itemCount * BYTES_PER_ITEM
  const willExceed = currentBytes + estimatedBytes > REDIS_CAPACITY_BYTES
  const estimatedMinutes = Math.max(3, Math.ceil(itemCount / 500))

  return { itemCount, estimatedMinutes, estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100, estimatedBytes, currentBytes, capacityBytes: REDIS_CAPACITY_BYTES, willExceed }
}

export function estimateBackfillRealtime(itemCount: number, currentBytes: number): BackfillEstimate {
  const estimatedCostUsd = computeCost(itemCount, RT_PRICE_PER_M_EMBED_INPUT, RT_PRICE_PER_M_EXTRACT_INPUT, RT_PRICE_PER_M_EXTRACT_OUTPUT)
  const estimatedBytes = itemCount * BYTES_PER_ITEM
  const willExceed = currentBytes + estimatedBytes > REDIS_CAPACITY_BYTES
  const RT_TICK_PROCESSING_MS = 15000
  const CLUSTER_MS_PER_ITEM = 17
  const tickCount = Math.ceil(itemCount / RT_ITEMS_PER_TICK)
  const clusterMs = itemCount * CLUSTER_MS_PER_ITEM
  const estimatedMinutes = Math.max(1, Math.ceil((tickCount * (RT_TICK_PROCESSING_MS + RT_TICK_SPACING_MS) + clusterMs) / 60000))

  return { itemCount, estimatedMinutes, estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100, estimatedBytes, currentBytes, capacityBytes: REDIS_CAPACITY_BYTES, willExceed }
}

export function estimateCurrentBytes(itemCount: number): number {
  return itemCount * BYTES_PER_ITEM
}
