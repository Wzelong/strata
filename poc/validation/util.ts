import OpenAI from 'openai'

export function createClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY before running')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

export class CostTracker {
  total = 0
  private budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  track(usage: { input_tokens?: number; output_tokens?: number } | undefined) {
    if (!usage) return
    // gpt-5.4-mini pricing (approximate)
    const inputCost = ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    const outputCost = ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
    this.total += inputCost + outputCost
    if (this.total > this.budget) {
      throw new Error(`Budget exceeded: $${this.total.toFixed(4)} > $${this.budget}`)
    }
  }

  report(): string {
    return `Total cost: $${this.total.toFixed(4)}`
  }
}

// Seeded PRNG (mulberry32) for deterministic timestamp jitter
export function createRng(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = createRng(42)

export function spreadTimestamps(baseMs: number, count: number, windowMs: number): number[] {
  const step = windowMs / (count + 1)
  return Array.from({ length: count }, (_, i) => {
    const jitter = rng() * step * 0.3
    return Math.floor(baseMs + step * (i + 1) + jitter)
  })
}

let commentCounter = 1
export function nextCommentId(): string {
  return `t1_${String(commentCounter++).padStart(3, '0')}`
}

export function resetCommentCounter() {
  commentCounter = 1
}
