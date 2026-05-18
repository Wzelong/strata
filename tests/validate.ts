import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore, cosine } from '../src/engine/index.js'
import type { Item, RawItem, CostTracker, Hit } from '../src/engine/types.js'

type SyntheticCorpus = {
  subredditName: string
  rules: Array<{ id: string; shortName: string; description: string; priority: number }>
  items: Array<RawItem & { text: string }>
  groundTruth: {
    buriedConnections: Array<{
      caseItemId: string
      connections: Array<{ connectedItemId: string; difficulty: string; expectedRelationship: string }>
    }>
    scamPatterns: Array<{ patternId: string; sharedEntity: { type: string; canonical: string }; itemIds: string[] }>
    ruleViolations: Array<{ itemId: string; violatesRule: string }>
    standouts: string[]
    distractors: string[]
    brigadePatterns?: Array<{ patternId: string; targetEntity: { type: string; canonical: string }; itemIds: string[]; windowMs: number }>
  }
}

class SimpleCostTracker implements CostTracker {
  total = 0
  private budget: number

  constructor(budget: number) { this.budget = budget }

  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    const inputCost = ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    const outputCost = ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
    this.total += inputCost + outputCost
    if (this.total > this.budget) throw new Error(`Budget exceeded: $${this.total.toFixed(4)}`)
  }

  report(): string { return `Total cost: $${this.total.toFixed(4)}` }
}

function cacheKey(corpusJson: string): string {
  return createHash('sha256').update(corpusJson).update('v2-engine').digest('hex').slice(0, 16)
}

// --- H1: Entity Canonicalization ---
async function testH1(engine: StrataEngine, corpus: SyntheticCorpus) {
  const details: Array<{ testCase: string; entityType: string; expected: string; actuals: string[]; match: boolean }> = []

  for (const sp of corpus.groundTruth.scamPatterns) {
    const canonicals: string[] = []
    for (const itemId of sp.itemIds) {
      const item = await engine.getItem(itemId)
      if (!item) continue
      const matching = item.entities.filter(e => e.type === sp.sharedEntity.type)
      canonicals.push(...matching.map(e => e.canonical))
    }
    const unique = [...new Set(canonicals)]
    const match = unique.length === 1 && unique[0] === sp.sharedEntity.canonical
    details.push({ testCase: sp.patternId, entityType: sp.sharedEntity.type, expected: sp.sharedEntity.canonical, actuals: unique, match })
  }

  for (const bc of corpus.groundTruth.buriedConnections) {
    const caseItem = await engine.getItem(bc.caseItemId)
    if (!caseItem) continue
    for (const conn of bc.connections) {
      if (conn.difficulty === 'hard' || conn.difficulty === 'very-hard') continue
      const connItem = await engine.getItem(conn.connectedItemId)
      if (!connItem) continue
      for (const ce of caseItem.entities) {
        const connMatch = connItem.entities.find(e => e.type === ce.type && e.canonical === ce.canonical)
        if (connMatch) {
          details.push({ testCase: `${bc.caseItemId}->${conn.connectedItemId}`, entityType: ce.type, expected: ce.canonical, actuals: [connMatch.canonical], match: true })
        }
      }
      for (const ce of caseItem.entities) {
        const sameTypeInConn = connItem.entities.filter(e => e.type === ce.type)
        for (const cte of sameTypeInConn) {
          if (cte.canonical !== ce.canonical && cte.surfaceText.toLowerCase().includes(ce.surfaceText.toLowerCase().slice(0, 4))) {
            details.push({ testCase: `${bc.caseItemId}->${conn.connectedItemId}`, entityType: ce.type, expected: ce.canonical, actuals: [cte.canonical], match: false })
          }
        }
      }
    }
  }

  const matched = details.filter(d => d.match).length
  const score = details.length > 0 ? (matched / details.length) * 100 : 100
  return { score, pass: score >= 80, details }
}

// --- H2: Two-Stage Retrieval ---
async function testH2(engine: StrataEngine, corpus: SyntheticCorpus) {
  const perCase: Array<{ caseId: string; recall: number; breakdown: Record<string, { found: boolean; difficulty: string }> }> = []
  let totalHits = 0
  let totalExpected = 0

  for (const bc of corpus.groundTruth.buriedConnections) {
    const caseItem = await engine.getItem(bc.caseItemId)
    if (!caseItem) continue
    const expectedIds = new Set(bc.connections.map(c => c.connectedItemId))
    totalExpected += expectedIds.size

    const entityCandidates = new Set<string>()
    for (const entity of caseItem.entities) {
      const items = await engine.getItemsByEntity(entity.type, entity.canonical)
      for (const match of items) {
        if (match.id !== caseItem.id) entityCandidates.add(match.id)
      }
    }

    const candidateItems = await engine.getItems([...entityCandidates])
    const candidates = candidateItems.map(item => ({
      item,
      weight: cosine(caseItem.embedding, item.embedding),
    }))

    if (candidates.length < 5) {
      const embResults = await engine.findSimilar(
        caseItem.embedding, 20,
        { excludeIds: new Set([caseItem.id, ...entityCandidates]) },
      )
      candidates.push(...embResults)
    }

    candidates.sort((a, b) => b.weight - a.weight)
    const top5Ids = candidates.slice(0, 5).map(c => c.item.id)

    const breakdown: Record<string, { found: boolean; difficulty: string }> = {}
    let hits = 0
    for (const conn of bc.connections) {
      const found = top5Ids.includes(conn.connectedItemId)
      breakdown[conn.connectedItemId] = { found, difficulty: conn.difficulty }
      if (found) hits++
    }
    totalHits += hits
    perCase.push({ caseId: bc.caseItemId, recall: hits / expectedIds.size, breakdown })
  }

  const score = totalExpected > 0 ? (totalHits / totalExpected) * 100 : 100
  return { score, pass: score >= 70, perCase }
}

// --- H3: Relationship Classification ---
async function testH3(engine: StrataEngine, corpus: SyntheticCorpus) {
  const ACCEPTABLE_LABELS: Record<string, string[]> = {
    'CONFIRMS': ['CONFIRMS', 'UPDATES'],
    'UPDATES': ['UPDATES', 'TEMPORAL'],
    'TEMPORAL': ['TEMPORAL', 'UPDATES'],
    'UNRELATED': ['UNRELATED'],
  }

  const pairs: Array<{ aId: string; bId: string; expected: string; difficulty?: string }> = []

  for (const bc of corpus.groundTruth.buriedConnections) {
    for (const conn of bc.connections) {
      pairs.push({ aId: bc.caseItemId, bId: conn.connectedItemId, expected: conn.expectedRelationship, difficulty: conn.difficulty })
    }
  }
  for (const bc of corpus.groundTruth.buriedConnections) {
    for (const did of corpus.groundTruth.distractors.slice(0, 3)) {
      pairs.push({ aId: bc.caseItemId, bId: did, expected: 'UNRELATED' })
    }
  }

  const results: Array<{ aId: string; bId: string; expected: string; predicted: string; correct: boolean }> = []
  for (const pair of pairs) {
    const a = await engine.getItem(pair.aId)
    const b = await engine.getItem(pair.bId)
    if (!a || !b) continue
    const predicted = await engine.classifyRelationship(a, b)
    const isHard = pair.difficulty === 'hard' || pair.difficulty === 'very-hard'
    const acceptable = isHard ? ACCEPTABLE_LABELS[pair.expected] || [pair.expected] : [pair.expected]
    const correct = acceptable.includes(predicted)
    results.push({ aId: pair.aId, bId: pair.bId, expected: pair.expected, predicted, correct })
  }

  const labels = ['CONFIRMS', 'CONTRADICTS', 'UPDATES', 'TEMPORAL', 'UNRELATED']
  const matrix: Record<string, Record<string, number>> = {}
  for (const l of labels) { matrix[l] = {}; for (const l2 of labels) matrix[l][l2] = 0 }
  for (const r of results) matrix[r.expected][r.predicted]++

  const correct = results.filter(r => r.correct).length
  const score = (correct / results.length) * 100
  return { score, pass: score >= 85, matrix, pairs: results }
}

// --- H4: Brigade Detection ---
async function testH4(engine: StrataEngine, corpus: SyntheticCorpus) {
  const brigadePatterns = corpus.groundTruth.brigadePatterns ?? []
  if (brigadePatterns.length === 0) {
    return { score: 0, pass: false, brigadeDetected: false, brigadeRecall: 0, brigadeCluster: [] as Array<{ itemId: string; inCluster: boolean }>, baselineRuleProximity: { avgViolationScore: 0, avgNeutralScore: 0, separation: 0 } }
  }

  const brigade = brigadePatterns[0]
  const targetCanonical = brigade.targetEntity.canonical

  const allItemIds = await engine.getItems(
    (await (engine as any).store.getItemIds()) as string[]
  )
  const allItems = allItemIds

  const entityMatches = allItems.filter(item =>
    item.entities.some(e =>
      e.canonical === targetCanonical ||
      e.canonical.includes(targetCanonical) ||
      targetCanonical.includes(e.canonical)
    )
  )

  const sorted = [...entityMatches].sort((a, b) => a.createdAt - b.createdAt)
  let bestCluster: Item[] = []

  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i].createdAt
    const windowEnd = windowStart + brigade.windowMs
    const cluster = sorted.filter(item => item.createdAt >= windowStart && item.createdAt <= windowEnd)
    const uniqueAuthors = new Set(cluster.map(c => c.authorId))
    if (cluster.length >= 3 && uniqueAuthors.size >= 3 && cluster.length > bestCluster.length) {
      bestCluster = cluster
    }
  }

  const EMBED_BOOST_THRESHOLD = 0.3
  const clusterCandidates = bestCluster.filter(item => {
    if (bestCluster.length <= 1) return false
    const others = bestCluster.filter(o => o.id !== item.id)
    const avgSim = others.reduce((sum, o) => sum + cosine(item.embedding, o.embedding), 0) / others.length
    return avgSim > EMBED_BOOST_THRESHOLD
  })

  const detectedIds = new Set(clusterCandidates.map(i => i.id))
  const brigadeRecall = brigade.itemIds.filter(id => detectedIds.has(id)).length / brigade.itemIds.length
  const brigadeDetected = brigadeRecall >= 0.5

  const brigadeCluster = brigade.itemIds.map(id => ({
    itemId: id,
    inCluster: detectedIds.has(id),
  }))

  // Baseline: rule-embedding proximity
  const rules = corpus.rules
  const ruleTexts = rules.map(r => `${r.shortName}: ${r.description}`)
  const client = (engine as any).client as OpenAI
  const ruleResponse = await client.embeddings.create({
    input: ruleTexts,
    model: 'text-embedding-3-small',
    dimensions: 256,
  })
  const ruleEmbeddings = ruleResponse.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding as number[])

  const violations = corpus.groundTruth.ruleViolations
  let violationScoreSum = 0
  for (const v of violations) {
    const item = await engine.getItem(v.itemId)
    if (!item) continue
    const ruleIdx = rules.findIndex(r => r.id === v.violatesRule)
    if (ruleIdx >= 0) violationScoreSum += cosine(item.embedding, ruleEmbeddings[ruleIdx])
  }
  const avgViolationScore = violationScoreSum / violations.length

  const neutralIds = new Set([...corpus.groundTruth.distractors, ...corpus.groundTruth.standouts])
  let neutralScoreSum = 0
  let neutralCount = 0
  for (const nid of neutralIds) {
    const item = await engine.getItem(nid)
    if (!item) continue
    const maxScore = Math.max(...ruleEmbeddings.map(re => cosine(item.embedding, re)))
    neutralScoreSum += maxScore
    neutralCount++
  }
  const avgNeutralScore = neutralCount > 0 ? neutralScoreSum / neutralCount : 0
  const separation = avgViolationScore - avgNeutralScore

  const score = brigadeRecall * 100
  return {
    score, pass: score >= 70,
    brigadeDetected, brigadeRecall, brigadeCluster,
    baselineRuleProximity: { avgViolationScore, avgNeutralScore, separation },
  }
}

// --- H5: Recommendation Agreement ---
async function testH5(engine: StrataEngine, corpus: SyntheticCorpus) {
  const RULES = corpus.rules.map(r => ({ ...r, embedding: [] as number[] }))
  const details: Array<{ itemId: string; category: string; expectedAction: string; predicted: string; expectedRule: string | null; predictedRule: string | null; correct: boolean }> = []
  const violations = corpus.groundTruth.ruleViolations

  const byRule = new Map<string, typeof violations>()
  for (const v of violations) {
    const arr = byRule.get(v.violatesRule) || []
    arr.push(v)
    byRule.set(v.violatesRule, arr)
  }

  for (const [ruleId, items] of byRule) {
    const seeded = items.slice(0, 2)
    const tested = items.slice(2)

    for (const s of seeded) await engine.recordDecision(s.itemId, 'removed', 'mod', ruleId)

    for (const t of tested) {
      const item = await engine.getItem(t.itemId)
      if (!item) continue
      const precedents = await engine.findSimilar(item.embedding, 5, { decision: ['removed', 'approved', 'distinguished'], excludeIds: new Set([item.id]) })
      const result = await engine.recommendDecision(item, precedents, RULES)
      details.push({
        itemId: t.itemId, category: 'violation',
        expectedAction: 'remove', predicted: result.recommendation,
        expectedRule: ruleId, predictedRule: result.ruleId,
        correct: result.recommendation === 'remove' && result.ruleId === ruleId,
      })
    }

    for (const s of seeded) await engine.recordDecision(s.itemId, 'pending', '', '')
  }

  const standouts = corpus.groundTruth.standouts
  for (const s of standouts.slice(0, 5)) await engine.recordDecision(s, 'distinguished', 'mod', '')

  for (const s of standouts.slice(5)) {
    const item = await engine.getItem(s)
    if (!item) continue
    const precedents = await engine.findSimilar(item.embedding, 5, { decision: ['removed', 'approved', 'distinguished'], excludeIds: new Set([item.id]) })
    const result = await engine.recommendDecision(item, precedents, RULES)
    details.push({
      itemId: s, category: 'standout',
      expectedAction: 'approve', predicted: result.recommendation,
      expectedRule: null, predictedRule: result.ruleId,
      correct: result.recommendation === 'approve',
    })
  }
  for (const s of standouts.slice(0, 5)) await engine.recordDecision(s, 'pending', '', '')

  for (const nid of corpus.groundTruth.distractors.slice(0, 5)) {
    const item = await engine.getItem(nid)
    if (!item) continue
    const precedents = await engine.findSimilar(item.embedding, 5, { decision: ['removed', 'approved', 'distinguished'], excludeIds: new Set([item.id]) })
    const result = await engine.recommendDecision(item, precedents, RULES)
    details.push({
      itemId: nid, category: 'neutral',
      expectedAction: 'approve', predicted: result.recommendation,
      expectedRule: null, predictedRule: result.ruleId,
      correct: result.recommendation === 'approve' || result.recommendation === 'skip',
    })
  }

  const correct = details.filter(d => d.correct).length
  const score = (correct / details.length) * 100
  return { score, pass: score >= 80, details }
}

// --- Main ---
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY before running')
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCostTracker(10.00)
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  const corpusPath = new URL('../poc/validation/corpus.json', import.meta.url)
  const cachePath = new URL('./cache.json', import.meta.url)
  const corpusJson = readFileSync(corpusPath, 'utf8')
  const corpus: SyntheticCorpus = JSON.parse(corpusJson)
  const version = cacheKey(corpusJson)

  console.log(`Corpus: ${corpus.items.length} items`)
  console.log('Phase 1: Ingestion...')

  let cacheHit = false
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (cached.version === version) {
        for (const c of cached.items) {
          const raw = corpus.items.find(i => i.id === c.id)!
          const stored = {
            id: raw.id,
            type: raw.type as 'post' | 'comment',
            text: raw.text,
            textNormalized: c.textNormalized,
            authorId: raw.authorId,
            authorName: raw.authorName,
            createdAt: raw.createdAt,
            threadRootId: raw.threadRootId,
            parentId: raw.parentId,
            entities: c.entities,
            decision: 'pending' as const,
            decisionAt: null,
            decisionBy: null,
            decisionReason: null,
          }
          await store.setItem(stored)
          await store.setEmbedding(raw.id, c.embedding)
          await store.addToEntityIndex(c.entities, raw.id, raw.createdAt)
          await store.addCanonicals(c.entities)
        }
        cacheHit = true
        console.log('  Loaded from cache.')
      }
    } catch { /* cache corrupt, re-ingest */ }
  }

  if (!cacheHit) {
    const raws: RawItem[] = corpus.items.map(i => ({
      id: i.id,
      type: i.type as 'post' | 'comment',
      text: i.text,
      authorId: i.authorId,
      authorName: i.authorName,
      createdAt: i.createdAt,
      threadRootId: i.threadRootId,
      parentId: i.parentId,
    }))
    await engine.ingestBatch(raws)

    const cacheData: Array<{ id: string; textNormalized: string; entities: any[]; embedding: number[] }> = []
    for (const item of corpus.items) {
      const stored = await store.getItem(item.id)
      const emb = await store.getEmbedding(item.id)
      if (stored && emb) {
        cacheData.push({ id: item.id, textNormalized: stored.textNormalized, entities: stored.entities, embedding: emb })
      }
    }
    writeFileSync(cachePath, JSON.stringify({ version, items: cacheData }))
    console.log(`  Ingested fresh. Cache written. ${cost.report()}`)
  }

  console.log('\nPhase 2: Hypothesis tests...')

  console.log('  H1: Entity Canonicalization...')
  const h1 = await testH1(engine, corpus)
  console.log(`    Score: ${h1.score.toFixed(1)}% ${h1.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H2: Two-Stage Retrieval...')
  const h2 = await testH2(engine, corpus)
  console.log(`    Score: ${h2.score.toFixed(1)}% ${h2.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H3: Relationship Classification...')
  const h3 = await testH3(engine, corpus)
  console.log(`    Score: ${h3.score.toFixed(1)}% ${h3.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H4: Cross-Item Pattern Detection...')
  const h4 = await testH4(engine, corpus)
  console.log(`    Score: ${h4.score.toFixed(1)}% ${h4.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H5: Recommendation Agreement...')
  const h5 = await testH5(engine, corpus)
  console.log(`    Score: ${h5.score.toFixed(1)}% ${h5.pass ? 'PASS' : 'FAIL'}`)

  const passing = [h1, h2, h3, h4, h5].filter(h => h.pass).length
  console.log(`\nDone! ${passing}/5 hypotheses pass. ${cost.report()}`)
  process.exit(passing === 5 ? 0 : 1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
