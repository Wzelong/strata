import { redis } from '@devvit/web/server'

interface PricePerMillion {
  input: number
  output: number
}

// Prices in USD per million tokens (standard tier, not batch)
const PRICING: Record<string, PricePerMillion> = {
  'gpt-5.5': { input: 2.50, output: 10.00 },
  'gpt-5.4': { input: 2.00, output: 8.00 },
  'gpt-5.4-mini': { input: 0.20, output: 0.80 },
  'gpt-5.4-nano': { input: 0.10, output: 0.40 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
}

function priceFor(model: string): PricePerMillion {
  if (PRICING[model]) return PRICING[model]
  const match = Object.keys(PRICING).find(k => model.startsWith(k))
  return match ? PRICING[match] : { input: 0, output: 0 }
}

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7)
}

export interface UsageRecord {
  inputTokens: number
  outputTokens: number
}

export async function recordUsage(model: string, usage: UsageRecord | undefined | null): Promise<void> {
  if (!usage) return
  const input = usage.inputTokens || 0
  const output = usage.outputTokens || 0
  if (input <= 0 && output <= 0) return
  const day = dayKey()
  const month = monthKey()
  try {
    await Promise.all([
      redis.hIncrBy(`strata:usage:day:${day}`, `${model}:input`, input),
      redis.hIncrBy(`strata:usage:day:${day}`, `${model}:output`, output),
      redis.hIncrBy(`strata:usage:day:${day}`, `${model}:calls`, 1),
      redis.hIncrBy(`strata:usage:month:${month}`, `${model}:input`, input),
      redis.hIncrBy(`strata:usage:month:${month}`, `${model}:output`, output),
      redis.hIncrBy(`strata:usage:month:${month}`, `${model}:calls`, 1),
    ])
  } catch {}
}

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  calls: number
  costCents: number
}

export interface UsageSummary {
  today: ModelUsage[]
  month: ModelUsage[]
  totals: { today: ModelUsage; month: ModelUsage }
}

function parseBucket(hash: Record<string, string>): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>()
  for (const [field, raw] of Object.entries(hash)) {
    const [model, metric] = field.split(':')
    if (!model || !metric) continue
    const value = parseInt(raw, 10) || 0
    const m = byModel.get(model) ?? { model, inputTokens: 0, outputTokens: 0, calls: 0, costCents: 0 }
    if (metric === 'input') m.inputTokens = value
    else if (metric === 'output') m.outputTokens = value
    else if (metric === 'calls') m.calls = value
    byModel.set(model, m)
  }
  for (const m of byModel.values()) {
    const p = priceFor(m.model)
    m.costCents = (m.inputTokens * p.input + m.outputTokens * p.output) / 1_000_000 * 100
  }
  return Array.from(byModel.values()).sort((a, b) => b.costCents - a.costCents)
}

function rollup(rows: ModelUsage[]): ModelUsage {
  return rows.reduce<ModelUsage>(
    (acc, r) => ({
      model: 'all',
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      calls: acc.calls + r.calls,
      costCents: acc.costCents + r.costCents,
    }),
    { model: 'all', inputTokens: 0, outputTokens: 0, calls: 0, costCents: 0 },
  )
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const day = dayKey()
  const month = monthKey()
  const [dayHash, monthHash] = await Promise.all([
    redis.hGetAll(`strata:usage:day:${day}`).catch(() => ({} as Record<string, string>)),
    redis.hGetAll(`strata:usage:month:${month}`).catch(() => ({} as Record<string, string>)),
  ])
  const today = parseBucket(dayHash)
  const monthRows = parseBucket(monthHash)
  return {
    today,
    month: monthRows,
    totals: { today: rollup(today), month: rollup(monthRows) },
  }
}
