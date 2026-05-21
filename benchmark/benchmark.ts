import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { cosine, embedSingle } from '../src/engine/embed.js'
import { extractEntities } from '../src/engine/extract.js'
import { classifyBatch } from '../src/engine/classify.js'
import { findSimilar, detectCampaign } from '../src/engine/search.js'
import { buildScanPairs } from '../src/engine/scan.js'
import { normalize } from '../src/engine/normalize.js'
import { LIVE_ITEMS, BACKFILL_ITEMS, REMOVED_ITEMS, SURFACE_IDS, BRIGADE_IDS, ALL_SIGNAL_IDS } from '../dataset/signal-items.js'
import type { StoredItem, Entity, Item } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, 'benchmark-seed.json')
const LIVE_FILE = resolve(__dirname, 'benchmark-live-items.json')
const RESULTS_FILE = resolve(__dirname, 'benchmark-results.json')
const VIZ_FILE = resolve(__dirname, 'benchmark-viz.json')

const FULL_MODE = process.argv.includes('--full')

type MetricResult = {
  name: string
  value: number
  unit: string
  pass: boolean
  threshold?: number
}

type BenchmarkSection = {
  name: string
  metrics: MetricResult[]
  durationMs: number
  details?: Record<string, unknown>
}

// --- Data Loading ---

async function loadData(store: MemoryKVStore): Promise<{ itemCount: number; loadTimeMs: number }> {
  const t0 = performance.now()

  const raw = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: StoredItem[]
    embeddings: Record<string, number[]>
    entityEmbeddings?: Record<string, Array<{ type: string; surfaceText: string; embedding: string }>>
  }

  const seen = new Set<string>()
  for (const item of raw.items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    await store.setItem(item)
    const emb = raw.embeddings[item.id]
    if (emb) await store.setEmbedding(item.id, emb)
    if (item.entities.length > 0) {
      await store.addToEntityIndex(item.entities, item.id, item.createdAt)
    }
    const entEmbs = raw.entityEmbeddings?.[item.id]
    if (entEmbs && entEmbs.length > 0) {
      await store.setEntityEmbeddings(item.id, entEmbs)
    }
  }

  // Load live items (merge raw metadata + pre-computed embeddings/entities)
  const liveData = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as {
    items: Array<{ id: string; textNormalized: string; embedding: number[]; entities: Entity[] }>
  }
  const liveMap = new Map(liveData.items.map(i => [i.id, i]))

  for (const rawItem of LIVE_ITEMS) {
    if (seen.has(rawItem.id)) continue
    seen.add(rawItem.id)
    const live = liveMap.get(rawItem.id)
    if (!live) continue

    const item: StoredItem = {
      id: rawItem.id,
      type: rawItem.type,
      text: rawItem.text,
      textNormalized: live.textNormalized,
      authorId: rawItem.authorId,
      authorName: rawItem.authorName,
      createdAt: rawItem.createdAt,
      threadRootId: rawItem.threadRootId,
      parentId: rawItem.parentId,
      entities: live.entities,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }
    await store.setItem(item)
    await store.setEmbedding(rawItem.id, live.embedding)
    if (live.entities.length > 0) {
      await store.addToEntityIndex(live.entities, rawItem.id, rawItem.createdAt)
    }
    const entEmbs = raw.entityEmbeddings?.[rawItem.id]
    if (entEmbs && entEmbs.length > 0) {
      await store.setEntityEmbeddings(rawItem.id, entEmbs)
    }
  }

  return { itemCount: seen.size, loadTimeMs: performance.now() - t0 }
}

// --- Helpers ---

function metric(name: string, value: number, unit: string, threshold?: number): MetricResult {
  return {
    name,
    value: Math.round(value * 10000) / 10000,
    unit,
    pass: threshold !== undefined ? value >= threshold : true,
    threshold,
  }
}

function metricLt(name: string, value: number, unit: string, threshold: number): MetricResult {
  return {
    name,
    value: Math.round(value * 10000) / 10000,
    unit,
    pass: value <= threshold,
    threshold,
  }
}

async function getItem(store: MemoryKVStore, id: string): Promise<Item | null> {
  const stored = await store.getItem(id)
  if (!stored) return null
  const emb = await store.getEmbedding(id)
  return { ...stored, embedding: emb ?? [] }
}

// --- Section A: Retrieval Quality ---

async function benchRetrievalQuality(store: MemoryKVStore): Promise<BenchmarkSection & { vizData: any }> {
  const t0 = performance.now()

  const casePost = await getItem(store, 't3_strata_casepost')
  if (!casePost) throw new Error('Case post not found in store')

  const results = await findSimilar(store, casePost.embedding, 50, {
    excludeIds: new Set([casePost.id]),
  })

  const rankedIds = results.map(h => h.item.id)
  const surfaceIds = [...SURFACE_IDS]

  const recallAt = (k: number) => {
    const topK = new Set(rankedIds.slice(0, k))
    return surfaceIds.filter(id => topK.has(id)).length / surfaceIds.length
  }

  const firstSignalRank = rankedIds.findIndex(id => SURFACE_IDS.has(id))
  const mrr = firstSignalRank >= 0 ? 1 / (firstSignalRank + 1) : 0

  const signalPositions: Record<string, number> = {}
  for (const id of surfaceIds) {
    const idx = rankedIds.indexOf(id)
    signalPositions[id] = idx >= 0 ? idx + 1 : -1
  }

  // Signal vs noise separation
  const signalScores = results
    .filter(h => SURFACE_IDS.has(h.item.id))
    .map(h => h.weight)
  const noiseScores = results
    .filter(h => !ALL_SIGNAL_IDS.has(h.item.id))
    .slice(0, 100)
    .map(h => h.weight)

  const avgSignal = signalScores.length > 0 ? signalScores.reduce((a, b) => a + b, 0) / signalScores.length : 0
  const avgNoise = noiseScores.length > 0 ? noiseScores.reduce((a, b) => a + b, 0) / noiseScores.length : 0

  // Recall curve for viz
  const recallCurve = Array.from({ length: 50 }, (_, i) => ({
    k: i + 1,
    recall: recallAt(i + 1),
    precision: rankedIds.slice(0, i + 1).filter(id => SURFACE_IDS.has(id)).length / (i + 1),
  }))

  // Similarity distribution for viz
  const allScores = results.slice(0, 100).map(h => ({
    id: h.item.id,
    score: h.weight,
    isSignal: ALL_SIGNAL_IDS.has(h.item.id),
    label: SURFACE_IDS.has(h.item.id) ? 'surface' : BRIGADE_IDS.has(h.item.id) ? 'brigade' : ALL_SIGNAL_IDS.has(h.item.id) ? 'other_signal' : 'noise',
  }))

  return {
    name: 'Retrieval Quality',
    durationMs: performance.now() - t0,
    metrics: [
      metric('recall@5', recallAt(5), 'ratio', 0.25),
      metric('recall@10', recallAt(10), 'ratio', 0.50),
      metric('recall@15', recallAt(15), 'ratio', 0.75),
      metric('precision@15', rankedIds.slice(0, 15).filter(id => SURFACE_IDS.has(id)).length / 15, 'ratio'),
      metric('mrr', mrr, 'score', 0.10),
      metric('signal_noise_separation', avgSignal - avgNoise, 'delta'),
    ],
    details: { signalPositions, avgSignal, avgNoise },
    vizData: { recallCurve, similarityDistribution: allScores },
  }
}

// --- Section B: Scan Pipeline ---

async function benchScanPipeline(store: MemoryKVStore): Promise<BenchmarkSection> {
  const t0 = performance.now()
  const pairs = await buildScanPairs(store)
  const durationMs = performance.now() - t0

  let signalAnchors = 0
  let signalConnections = 0
  let firstSignalRank = -1

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    const hasSignalAnchor = ALL_SIGNAL_IDS.has(pair.anchorId)
    const hasSignalConn = pair.connectionIds.some(id => ALL_SIGNAL_IDS.has(id))

    if (hasSignalAnchor || hasSignalConn) {
      if (firstSignalRank === -1) firstSignalRank = i + 1
      if (hasSignalAnchor) signalAnchors++
      signalConnections += pair.connectionIds.filter(id => ALL_SIGNAL_IDS.has(id)).length
    }
  }

  return {
    name: 'Scan Pipeline',
    durationMs,
    metrics: [
      metric('signal_found', signalAnchors + signalConnections, 'count', 1),
      metric('signal_anchors', signalAnchors, 'count'),
      metric('signal_pair_rank', firstSignalRank > 0 ? firstSignalRank : 99, 'rank'),
      metricLt('total_pairs', pairs.length, 'count', 50),
      metric('computation_time_ms', durationMs, 'ms'),
    ],
    details: {
      pairs: pairs.map(p => ({
        anchor: p.anchorId,
        connections: p.connectionIds,
        entities: p.entities,
        hasSignal: ALL_SIGNAL_IDS.has(p.anchorId) || p.connectionIds.some(id => ALL_SIGNAL_IDS.has(id)),
      })),
    },
  }
}

// --- Section C: Brigade Detection ---

async function benchBrigadeDetection(store: MemoryKVStore): Promise<BenchmarkSection> {
  const t0 = performance.now()

  // Find entities shared by brigade items
  const brigadeEntities: string[] = []
  for (const id of BRIGADE_IDS) {
    const item = await store.getItem(id)
    if (item) {
      for (const e of item.entities) {
        brigadeEntities.push(`${e.type}:${e.surfaceText}`)
      }
    }
  }

  // Also try the case post thread as the campaign entity
  // Brigade detection works on entity co-occurrence in time windows
  // Use entity from case post that brigade items might share
  const casePost = await store.getItem('t3_strata_casepost')
  const caseEntities = casePost?.entities ?? []

  let detected = false
  let bestResult = { detected: false, items: [] as Item[], authorCount: 0, entityKey: '' }

  for (const e of caseEntities) {
    const result = await detectCampaign(store, e.type, e.surfaceText, {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      minItems: 3,
      minAuthors: 3,
    })
    if (result.detected && result.items.length > bestResult.items.length) {
      bestResult = result
      detected = true
    }
  }

  // Semantic uniformity of brigade embeddings
  const brigadeEmbeddings: number[][] = []
  for (const id of BRIGADE_IDS) {
    const emb = await store.getEmbedding(id)
    if (emb) brigadeEmbeddings.push(emb)
  }

  let uniformity = 0
  let pairCount = 0
  for (let i = 0; i < brigadeEmbeddings.length; i++) {
    for (let j = i + 1; j < brigadeEmbeddings.length; j++) {
      uniformity += cosine(brigadeEmbeddings[i], brigadeEmbeddings[j])
      pairCount++
    }
  }
  uniformity = pairCount > 0 ? uniformity / pairCount : 0

  // False positive rate: sample 20 random entities from the store
  const allItems = await store.getItemIds()
  const sampleIds = allItems.sort(() => Math.random() - 0.5).slice(0, 20)
  let falsePositives = 0
  for (const id of sampleIds) {
    const item = await store.getItem(id)
    if (!item || item.entities.length === 0) continue
    const e = item.entities[0]
    const result = await detectCampaign(store, e.type, e.surfaceText, {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      minItems: 3,
      minAuthors: 3,
    })
    if (result.detected) falsePositives++
  }
  const fpRate = falsePositives / 20

  return {
    name: 'Brigade Detection',
    durationMs: performance.now() - t0,
    metrics: [
      metric('detected', detected ? 1 : 0, 'bool', 1),
      metric('cluster_size', bestResult.items.length, 'count'),
      metric('author_count', bestResult.authorCount, 'count'),
      metric('semantic_uniformity', uniformity, 'cosine'),
      metricLt('false_positive_rate', fpRate, 'ratio', 0.35),
    ],
    details: {
      detectedEntity: bestResult.entityKey,
      clusterItemIds: bestResult.items.map(i => i.id),
    },
  }
}

// --- Section D: Pattern Match ---

async function benchPatternMatch(store: MemoryKVStore): Promise<BenchmarkSection> {
  const t0 = performance.now()

  const flag4 = await getItem(store, 't3_strata_flag4')
  if (!flag4) throw new Error('flag4 not found')

  const results = await findSimilar(store, flag4.embedding, 10, {
    decision: ['removed'],
    excludeIds: new Set([flag4.id]),
  })

  const flag3Ids = new Set(['t3_strata_flag3a', 't3_strata_flag3b', 't3_strata_flag3c'])
  const topIds = results.slice(0, 5).map(h => h.item.id)
  const flag3InTop5 = topIds.filter(id => flag3Ids.has(id)).length

  const flag3Scores = results.filter(h => flag3Ids.has(h.item.id)).map(h => h.weight)
  const maxSim = flag3Scores.length > 0 ? Math.max(...flag3Scores) : 0
  const noiseScores = results.filter(h => !flag3Ids.has(h.item.id)).map(h => h.weight)
  const noiseMax = noiseScores.length > 0 ? Math.max(...noiseScores) : 0

  return {
    name: 'Pattern Match',
    durationMs: performance.now() - t0,
    metrics: [
      metric('flag3_recall@5', flag3InTop5 / 3, 'ratio', 0.67),
      metric('max_similarity', maxSim, 'cosine', 0.5),
      metric('threshold_pass', maxSim >= 0.5 ? 1 : 0, 'bool', 1),
      metric('separation', maxSim - noiseMax, 'delta'),
    ],
    details: {
      topResults: results.slice(0, 5).map(h => ({ id: h.item.id, score: h.weight })),
      flag3Scores,
    },
  }
}

// --- Section E: Performance ---

async function benchPerformance(store: MemoryKVStore, loadTimeMs: number, apiLatencies?: { embedMs: number; extractMs: number; classifyMs: number }): Promise<BenchmarkSection & { vizData: any }> {
  const casePost = await getItem(store, 't3_strata_casepost')
  if (!casePost) throw new Error('Case post not found')

  const trials = 10
  const cosineTimes: number[] = []
  const scanTimes: number[] = []

  // Cosine scan latency
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now()
    await findSimilar(store, casePost.embedding, 15, { excludeIds: new Set([casePost.id]) })
    cosineTimes.push(performance.now() - t0)
  }

  // Scan pipeline latency (only 3 trials since it's heavier)
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await buildScanPairs(store)
    scanTimes.push(performance.now() - t0)
  }

  cosineTimes.sort((a, b) => a - b)
  scanTimes.sort((a, b) => a - b)

  const p50Cosine = cosineTimes[Math.floor(trials / 2)]
  const p95Cosine = cosineTimes[Math.floor(trials * 0.95)]
  const p50Scan = scanTimes[Math.floor(scanTimes.length / 2)]

  const mem = process.memoryUsage()
  const heapMB = mem.heapUsed / 1024 / 1024

  return {
    name: 'Performance',
    durationMs: cosineTimes.reduce((a, b) => a + b, 0) + scanTimes.reduce((a, b) => a + b, 0),
    metrics: [
      metricLt('cosine_scan_p50_ms', p50Cosine, 'ms', 100),
      metricLt('cosine_scan_p95_ms', p95Cosine, 'ms', 200),
      metricLt('scan_pipeline_p50_ms', p50Scan, 'ms', 60000),
      metricLt('memory_mb', heapMB, 'MB', 2000),
      metric('load_time_ms', loadTimeMs, 'ms'),
    ],
    vizData: {
      latency: [
        { op: 'cosine_scan', p50: p50Cosine, p95: p95Cosine, trials: cosineTimes },
        { op: 'scan_pipeline', p50: p50Scan, p95: scanTimes[scanTimes.length - 1], trials: scanTimes },
        ...(apiLatencies ? [
          { op: 'embed_single', p50: apiLatencies.embedMs, p95: apiLatencies.embedMs, trials: [apiLatencies.embedMs] },
          { op: 'extract_entities', p50: apiLatencies.extractMs, p95: apiLatencies.extractMs, trials: [apiLatencies.extractMs] },
          { op: 'classify_batch', p50: apiLatencies.classifyMs, p95: apiLatencies.classifyMs, trials: [apiLatencies.classifyMs] },
        ] : []),
      ],
    },
  }
}

// --- Section F: Classification Quality (full mode) ---

async function benchClassification(store: MemoryKVStore): Promise<BenchmarkSection> {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY for --full mode')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const casePost = await getItem(store, 't3_strata_casepost')
  if (!casePost) throw new Error('Case post not found')

  const results = await findSimilar(store, casePost.embedding, 15, {
    excludeIds: new Set([casePost.id]),
  })
  const candidates = results.map(h => ({ id: h.item.id, text: h.item.text }))

  const t0 = performance.now()
  const classifications = await classifyBatch(client, casePost, candidates)
  const latency = performance.now() - t0

  const signalIds = new Set([...SURFACE_IDS])
  let signalCorrect = 0
  let signalTotal = 0
  let noiseCorrect = 0
  let noiseTotal = 0
  let highConfidenceSignal = 0

  for (const cls of classifications) {
    if (signalIds.has(cls.id)) {
      signalTotal++
      if (cls.relationship !== 'UNRELATED') signalCorrect++
      if (cls.confidence === 'high') highConfidenceSignal++
    } else {
      noiseTotal++
      if (cls.relationship === 'UNRELATED') noiseCorrect++
    }
  }

  return {
    name: 'Classification Quality',
    durationMs: latency,
    metrics: [
      metric('signal_accuracy', signalTotal > 0 ? signalCorrect / signalTotal : 0, 'ratio', 0.75),
      metric('noise_accuracy', noiseTotal > 0 ? noiseCorrect / noiseTotal : 0, 'ratio', 0.80),
      metric('confidence_calibration', signalTotal > 0 ? highConfidenceSignal / signalTotal : 0, 'ratio'),
      metric('latency_ms', latency, 'ms'),
    ],
    details: {
      classifications: classifications.map(c => ({
        id: c.id,
        relationship: c.relationship,
        confidence: c.confidence,
        isSignal: signalIds.has(c.id),
      })),
    },
  }
}

// --- Output Formatting ---

function printResults(sections: BenchmarkSection[], totalMs: number, itemCount: number) {
  const mode = FULL_MODE ? 'full' : 'cheap'
  console.log(`\n${'='.repeat(60)}`)
  console.log(` STRATA BENCHMARK (${mode}) — ${itemCount.toLocaleString()} items @ 256d`)
  console.log(`${'='.repeat(60)}\n`)

  let passed = 0
  let failed = 0

  for (const section of sections) {
    console.log(`  ${section.name.padEnd(40)} [${Math.round(section.durationMs)}ms]`)
    for (const m of section.metrics) {
      const valueStr = m.unit === 'ratio' ? (m.value * 100).toFixed(1) + '%'
        : m.unit === 'bool' ? (m.value ? 'true' : 'false')
        : m.unit === 'ms' ? Math.round(m.value) + 'ms'
        : m.unit === 'MB' ? Math.round(m.value) + 'MB'
        : m.unit === 'cosine' ? m.value.toFixed(4)
        : m.unit === 'delta' ? m.value.toFixed(4)
        : String(m.value)

      const status = m.threshold !== undefined ? (m.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') : ' '
      const threshStr = m.threshold !== undefined
        ? (m.unit === 'ratio' ? `${m.pass ? '>=' : '<'} ${(m.threshold * 100).toFixed(0)}%`
          : `${m.pass ? (m.name.includes('false') || m.name.includes('memory') || m.name.includes('scan') || m.name.includes('cosine') ? '<=' : '>=') : 'FAIL'} ${m.threshold}`)
        : ''

      console.log(`    ${m.name.padEnd(28)} ${valueStr.padStart(10)}  ${status} ${threshStr}`)
      if (m.threshold !== undefined) { m.pass ? passed++ : failed++ }
    }
    console.log()
  }

  console.log(`${'='.repeat(60)}`)
  console.log(` PASSED: ${passed}/${passed + failed} metrics`)
  console.log(` Duration: ${(totalMs / 1000).toFixed(1)}s`)
  console.log(`${'='.repeat(60)}\n`)
}

// --- Main ---

async function main() {
  console.log('Loading benchmark dataset...')
  const store = new MemoryKVStore()
  const { itemCount, loadTimeMs } = await loadData(store)
  console.log(`  ${itemCount.toLocaleString()} items loaded in ${(loadTimeMs / 1000).toFixed(1)}s`)

  const sections: BenchmarkSection[] = []
  const vizData: Record<string, unknown> = {}

  const t0 = performance.now()

  // A. Retrieval Quality
  console.log('\nRunning retrieval quality...')
  const retrieval = await benchRetrievalQuality(store)
  sections.push(retrieval)
  vizData.retrieval = retrieval.vizData

  // B. Scan Pipeline
  console.log('Running scan pipeline...')
  sections.push(await benchScanPipeline(store))

  // C. Brigade Detection
  console.log('Running brigade detection...')
  sections.push(await benchBrigadeDetection(store))

  // D. Pattern Match
  console.log('Running pattern match...')
  sections.push(await benchPatternMatch(store))

  // E. Performance (including real API latency measurement)
  console.log('Running performance benchmarks...')
  let apiLatencies: { embedMs: number; extractMs: number; classifyMs: number } | undefined

  if (process.env.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const sampleText = 'A red sedan ran a stop sign at the intersection of Main St and Oak Ave around 3pm yesterday.'

    console.log('  Timing embed API...')
    const t0Embed = performance.now()
    await embedSingle(client, sampleText)
    const embedMs = performance.now() - t0Embed

    console.log('  Timing extract entities API...')
    const t0Extract = performance.now()
    await extractEntities(client, sampleText)
    const extractMs = performance.now() - t0Extract

    console.log('  Timing classify batch API...')
    const casePost = await getItem(store, 't3_strata_casepost')
    const retrievalResults = await findSimilar(store, casePost!.embedding, 15, { excludeIds: new Set([casePost!.id]) })
    const candidates = retrievalResults.map(h => ({ id: h.item.id, text: h.item.text }))
    const t0Classify = performance.now()
    await classifyBatch(client, casePost!, candidates)
    const classifyMs = performance.now() - t0Classify

    apiLatencies = { embedMs, extractMs, classifyMs }
    console.log(`  Embed: ${Math.round(embedMs)}ms, Extract: ${Math.round(extractMs)}ms, Classify: ${Math.round(classifyMs)}ms`)
  }

  const perf = await benchPerformance(store, loadTimeMs, apiLatencies)
  sections.push(perf)
  vizData.performance = perf.vizData

  // F. Classification (full mode only)
  if (FULL_MODE) {
    console.log('Running classification (LLM calls)...')
    sections.push(await benchClassification(store))
  }

  const totalMs = performance.now() - t0

  printResults(sections, totalMs, itemCount)

  // Write results
  const results = {
    timestamp: new Date().toISOString(),
    mode: FULL_MODE ? 'full' : 'cheap',
    datasetSize: itemCount,
    sections: sections.map(s => ({ name: s.name, durationMs: s.durationMs, metrics: s.metrics, details: s.details })),
    totalDurationMs: totalMs,
    summary: {
      passed: sections.flatMap(s => s.metrics).filter(m => m.threshold !== undefined && m.pass).length,
      failed: sections.flatMap(s => s.metrics).filter(m => m.threshold !== undefined && !m.pass).length,
    },
  }
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
  writeFileSync(VIZ_FILE, JSON.stringify(vizData, null, 2))
  console.log(`Results: ${RESULTS_FILE}`)
  console.log(`Viz data: ${VIZ_FILE}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
