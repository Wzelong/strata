// Tests for the new flag-handling pipeline:
//   1. routeFlag predicate — rule + high-pattern → queue, review-pattern → drop, brigade → ui
//   2. formatReportReason — caps at 100 chars, embeds precedent IDs for pattern
//   3. brigade dedup — first comment in window acquires lock, subsequent skipped, TTL expiry re-opens
//   4. similar-decisions composition — engine.findSimilar filtered to removed-decision returns seeded precedents
//
// Sections 1-3 are pure-logic, no API calls. Section 4 requires OPENAI_API_KEY
// (gated; the section is skipped if not set so the routing tests still run).

import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { routeFlag, formatReportReason, brigadeLockKey, BRIGADE_LOCK_TTL_MS } from '../src/engine/flag-routing.js'
import type { FlagResult, Item, RawItem } from '../src/engine/types.js'

let passed = 0
let failed = 0

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
    failed++
  }
}

function stubFlag(over: Partial<FlagResult> & { type: FlagResult['type']; confidence: FlagResult['confidence'] }): FlagResult {
  return {
    type: over.type,
    confidence: over.confidence,
    reasoning: over.reasoning ?? 'stub reasoning',
    anchorId: over.anchorId ?? 'anchor',
    connectionItems: over.connectionItems ?? [],
    ruleId: over.ruleId,
  }
}

function stubItem(id: string): Item {
  return {
    id, type: 'post', text: '', textNormalized: '', authorId: 'u', authorName: 'u',
    createdAt: 0, threadRootId: id, parentId: null, entities: [], embedding: [],
    decision: 'pending', decisionAt: null, decisionBy: null, decisionReason: null,
  } as unknown as Item
}

// ============================================================
// Section 1 — routeFlag predicate
// ============================================================

console.log('--- routeFlag ---')
check('rule → queue', routeFlag(stubFlag({ type: 'rule', confidence: 'high' })) === 'queue')
check('rule (review) → queue (rule ignores confidence)', routeFlag(stubFlag({ type: 'rule', confidence: 'review' })) === 'queue')
check('pattern high → queue', routeFlag(stubFlag({ type: 'pattern', confidence: 'high' })) === 'queue')
check('pattern review → drop', routeFlag(stubFlag({ type: 'pattern', confidence: 'review' })) === 'drop')
check('brigade high → ui', routeFlag(stubFlag({ type: 'brigade', confidence: 'high' })) === 'ui')
check('brigade review → ui', routeFlag(stubFlag({ type: 'brigade', confidence: 'review' })) === 'ui')

// ============================================================
// Section 2 — formatReportReason
// ============================================================

console.log('\n--- formatReportReason ---')
const ruleReason = formatReportReason(stubFlag({
  type: 'rule', confidence: 'high', reasoning: 'doxxes a private individual with full name + address',
}))
check('rule reason starts with "Strata rule"', ruleReason.startsWith('Strata rule:'))
check('reason ≤ 100 chars', ruleReason.length <= 100, `got ${ruleReason.length}`)

const patternReason = formatReportReason(stubFlag({
  type: 'pattern', confidence: 'high',
  reasoning: 'matches removed witch-hunt precedent',
  connectionItems: [stubItem('t3_flag3a'), stubItem('t3_flag3b'), stubItem('t3_flag3c')],
}))
check('pattern reason embeds first 2 precedent IDs', patternReason.includes('t3_flag3a') && patternReason.includes('t3_flag3b'), `got: ${patternReason}`)
check('pattern reason omits 3rd precedent (cap at 2)', !patternReason.includes('t3_flag3c'))
check('pattern reason ≤ 100 chars', patternReason.length <= 100, `got ${patternReason.length}`)

const patternReasonNoConnections = formatReportReason(stubFlag({
  type: 'pattern', confidence: 'high', reasoning: 'matches a removed item',
  connectionItems: [],
}))
check('pattern reason without connections omits "similar to" clause', !patternReasonNoConnections.includes('similar to'))

const longReason = formatReportReason(stubFlag({
  type: 'rule', confidence: 'high',
  reasoning: 'x'.repeat(500),
}))
check('long reason truncated to 100 chars', longReason.length === 100)

// ============================================================
// Section 3 — brigade dedup (mock Redis)
// ============================================================

console.log('\n--- brigade dedup ---')

class MockRedis {
  private store = new Map<string, { value: string; expiresAt: number }>()
  now = Date.now()

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, opts: { expiration: Date }): Promise<void> {
    this.store.set(key, { value, expiresAt: opts.expiration.getTime() })
  }

  advanceTime(ms: number): void {
    this.now += ms
  }
}

// Mirrors the dedup branch in src/server/index.ts:comment-submit
async function brigadeShouldProceed(redis: MockRedis, threadRootId: string): Promise<boolean> {
  const key = brigadeLockKey(threadRootId)
  if (await redis.get(key)) return false
  await redis.set(key, '1', { expiration: new Date(redis.now + BRIGADE_LOCK_TTL_MS) })
  return true
}

const r = new MockRedis()
const thread = 't3_some_brigade_thread'

check('first brigade in thread proceeds', await brigadeShouldProceed(r, thread) === true)
check('second brigade within TTL is blocked', await brigadeShouldProceed(r, thread) === false)
check('third brigade within TTL still blocked', await brigadeShouldProceed(r, thread) === false)

r.advanceTime(BRIGADE_LOCK_TTL_MS - 1)
check('just before TTL expiry, still blocked', await brigadeShouldProceed(r, thread) === false)

r.advanceTime(2) // cross the TTL boundary
check('after TTL expiry, brigade proceeds again', await brigadeShouldProceed(r, thread) === true)

const otherThread = 't3_unrelated_thread'
check('different thread has independent lock', await brigadeShouldProceed(r, otherThread) === true)

// ============================================================
// Section 4 — similar-decisions composition (real engine, gated by API key)
// ============================================================

if (!process.env.OPENAI_API_KEY) {
  console.log('\n--- similar-decisions ---')
  console.log('  SKIP  OPENAI_API_KEY not set')
} else {
  console.log('\n--- similar-decisions ---')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client)

  const removed: RawItem[] = [
    { id: 'removed-honda', type: 'post', text: 'PSA: silver Honda on Beacon St running reds every morning. No plate but someone has to stop this guy. Can we get community eyes?', authorId: 'u-r1', authorName: 'Watcher1', createdAt: Date.now() - 20 * 86400000, threadRootId: 'removed-honda', parentId: null },
    { id: 'removed-pickup', type: 'post', text: 'There is a white pickup parking illegally on Cambridge St every night and the driver is sketchy. License starts with 4R. Eyes on this please.', authorId: 'u-r2', authorName: 'Watcher2', createdAt: Date.now() - 15 * 86400000, threadRootId: 'removed-pickup', parentId: null },
    { id: 'removed-minivan', type: 'post', text: 'Blue minivan with NH plates circling my block in Allston four days in a row. Casing houses? Should I call police or am I paranoid?', authorId: 'u-r3', authorName: 'Watcher3', createdAt: Date.now() - 10 * 86400000, threadRootId: 'removed-minivan', parentId: null },
  ]
  for (const raw of removed) {
    const item = await engine.ingest(raw)
    await engine.recordDecision(item.id, 'removed', 'mod_team', 'witch-hunting / no evidence')
  }

  const candidate = await engine.ingest({
    id: 'candidate-suv',
    type: 'post',
    text: 'WARNING: dark SUV running reds on Mass Ave near Central multiple times this month. No plate. Someone is going to get hurt. Can the mods pin this?',
    authorId: 'u-cand',
    authorName: 'CandidatePoster',
    createdAt: Date.now(),
    threadRootId: 'candidate-suv',
    parentId: null,
  })

  const hits = await engine.findSimilar(candidate.embedding, 10, {
    decision: ['removed'],
    excludeIds: new Set([candidate.id]),
  })

  check('findSimilar returns at least 1 removed precedent', hits.length >= 1, `got ${hits.length}`)
  const ids = hits.map(h => h.item.id)
  check('all returned items are decision=removed', hits.every(h => h.item.decision === 'removed'))
  check('weights are valid cosine values [-1, 1]', hits.every(h => h.weight >= -1 && h.weight <= 1))
  check('weights are sorted descending', hits.every((h, i) => i === 0 || h.weight <= hits[i - 1].weight))
  const seededIds = new Set(removed.map(r => r.id))
  const seededHits = ids.filter(id => seededIds.has(id))
  check('at least 2 of 3 seeded precedents recalled', seededHits.length >= 2, `recalled ${seededHits.join(', ')}`)

  // Shape check matches what /api/items/:id/similar-decisions returns
  const sample = hits[0]
  check('precedent shape has expected fields', !!sample.item.id && typeof sample.weight === 'number' && 'decisionReason' in sample.item)
}

// ============================================================

console.log(`\n=== ${passed}/${passed + failed} PASSED ===`)
if (failed > 0) process.exit(1)
