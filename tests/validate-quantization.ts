import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { cosine } from '../src/engine/embed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, '..', 'dataset', 'seed.json')

// ============================================================
// HYPOTHESIS: Int8 quantized embeddings preserve retrieval quality
//
// BASELINE: Float64 embeddings (current), cosine similarity
// TREATMENT: Int8 quantized (256 bytes per vector), cosine on dequantized
//
// SUCCESS CONDITIONS:
//   C1: Rank correlation between float and int8 cosines >= 0.99
//   C2: Top-10 overlap >= 9/10 (same items retrieved)
//   C3: Signal items maintain same rank positions (±1)
//   C4: Storage reduction >= 5x
// ============================================================

// --- Quantization functions ---

function quantizeInt8(embedding: number[]): { bytes: Uint8Array; min: number; max: number } {
  let min = Infinity, max = -Infinity
  for (const v of embedding) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min || 1
  const bytes = new Uint8Array(embedding.length)
  for (let i = 0; i < embedding.length; i++) {
    bytes[i] = Math.round(((embedding[i] - min) / range) * 255)
  }
  return { bytes, min, max }
}

function dequantizeInt8(bytes: Uint8Array, min: number, max: number): number[] {
  const range = max - min
  const result = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    result[i] = (bytes[i] / 255) * range + min
  }
  return result
}

function encodeForRedis(bytes: Uint8Array, min: number, max: number): string {
  const header = `${min.toExponential(6)},${max.toExponential(6)},`
  return header + Buffer.from(bytes).toString('base64')
}

function decodeFromRedis(stored: string): number[] {
  const firstComma = stored.indexOf(',')
  const secondComma = stored.indexOf(',', firstComma + 1)
  const min = parseFloat(stored.slice(0, firstComma))
  const max = parseFloat(stored.slice(firstComma + 1, secondComma))
  const bytes = new Uint8Array(Buffer.from(stored.slice(secondComma + 1), 'base64'))
  return dequantizeInt8(bytes, min, max)
}

// --- Int8 cosine (operates directly on quantized bytes) ---

function cosineInt8(a: { bytes: Uint8Array; min: number; max: number }, b: { bytes: Uint8Array; min: number; max: number }): number {
  const aVec = dequantizeInt8(a.bytes, a.min, a.max)
  const bVec = dequantizeInt8(b.bytes, b.min, b.max)
  return cosine(aVec, bVec)
}

// ============================================================

const SIGNAL_IDS = new Set([
  't1_strata_surface1',
  't3_strata_surface2',
  't1_strata_surface3',
  't3_strata_surface4',
])

async function main() {
  console.log('=== Quantization Validation ===\n')

  // Load seed
  console.log('Loading seed.json...')
  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: Array<{ id: string; text: string }>
    embeddings: Record<string, number[]>
  }
  const embEntries = Object.entries(seed.embeddings)
  console.log(`  ${embEntries.length} embeddings, dim=${embEntries[0][1].length}`)

  // Pick case post embedding
  const caseEmb = seed.embeddings['t3_strata_casepost']
  if (!caseEmb) {
    console.log('ERROR: case post not in seed embeddings, using first signal item as query')
  }
  const queryId = caseEmb ? 't3_strata_casepost' : 't3_strata_surface2'
  const queryEmb = seed.embeddings[queryId]

  // --- Quantize all embeddings ---
  console.log('\nQuantizing all embeddings to int8...')
  const quantized = new Map<string, { bytes: Uint8Array; min: number; max: number }>()
  for (const [id, emb] of embEntries) {
    quantized.set(id, quantizeInt8(emb))
  }

  // --- Storage comparison ---
  const floatJsonSize = JSON.stringify(seed.embeddings).length
  let int8TotalSize = 0
  for (const [id, q] of quantized) {
    int8TotalSize += encodeForRedis(q.bytes, q.min, q.max).length
  }
  const reduction = floatJsonSize / int8TotalSize
  console.log(`  Float JSON size: ${(floatJsonSize / 1024 / 1024).toFixed(2)}MB`)
  console.log(`  Int8 encoded size: ${(int8TotalSize / 1024 / 1024).toFixed(2)}MB`)
  console.log(`  Reduction: ${reduction.toFixed(1)}x`)

  // --- Verify encode/decode round-trip ---
  console.log('\nVerifying encode/decode round-trip...')
  const sampleId = embEntries[0][0]
  const sampleQ = quantized.get(sampleId)!
  const encoded = encodeForRedis(sampleQ.bytes, sampleQ.min, sampleQ.max)
  const decoded = decodeFromRedis(encoded)
  const original = seed.embeddings[sampleId]
  const roundTripCosine = cosine(original, decoded)
  console.log(`  Round-trip cosine: ${roundTripCosine.toFixed(6)} (should be ~0.999+)`)

  // --- Rank correlation test ---
  console.log('\nComputing similarities (float vs int8)...')
  const queryQuantized = quantized.get(queryId)!

  type ScoredItem = { id: string; floatSim: number; int8Sim: number }
  const scores: ScoredItem[] = []

  for (const [id, emb] of embEntries) {
    if (id === queryId) continue
    const floatSim = cosine(queryEmb, emb)
    const int8Sim = cosineInt8(queryQuantized, quantized.get(id)!)
    scores.push({ id, floatSim, int8Sim })
  }

  // Sort by float sim
  const byFloat = [...scores].sort((a, b) => b.floatSim - a.floatSim)
  const byInt8 = [...scores].sort((a, b) => b.int8Sim - a.int8Sim)

  const floatRanking = byFloat.map(s => s.id)
  const int8Ranking = byInt8.map(s => s.id)

  // --- C1: Rank correlation (Spearman on top 100) ---
  console.log('\n--- C1: Rank correlation ---')
  const top100Float = floatRanking.slice(0, 100)
  const top100Int8Map = new Map(int8Ranking.slice(0, 200).map((id, i) => [id, i]))

  let rankDiffSum = 0, counted = 0
  for (let i = 0; i < top100Float.length; i++) {
    const int8Rank = top100Int8Map.get(top100Float[i])
    if (int8Rank !== undefined) {
      rankDiffSum += (i - int8Rank) ** 2
      counted++
    }
  }
  const spearman = 1 - (6 * rankDiffSum) / (counted * (counted ** 2 - 1))
  console.log(`  Spearman rank correlation (top 100): ${spearman.toFixed(4)}`)
  const c1Pass = spearman >= 0.99
  console.log(`  C1: ${c1Pass ? 'PASS' : 'FAIL'} (need >= 0.99)`)

  // --- C2: Top-10 overlap ---
  console.log('\n--- C2: Top-10 overlap ---')
  const floatTop10 = new Set(floatRanking.slice(0, 10))
  const int8Top10 = new Set(int8Ranking.slice(0, 10))
  const overlap = [...floatTop10].filter(id => int8Top10.has(id)).length
  console.log(`  Float top 10: ${[...floatTop10].join(', ')}`)
  console.log(`  Int8 top 10:  ${[...int8Top10].join(', ')}`)
  console.log(`  Overlap: ${overlap}/10`)
  const c2Pass = overlap >= 9
  console.log(`  C2: ${c2Pass ? 'PASS' : 'FAIL'} (need >= 9)`)

  // --- C3: Signal item rank stability ---
  console.log('\n--- C3: Signal rank stability ---')
  let maxDrift = 0
  for (const sigId of SIGNAL_IDS) {
    const floatRank = floatRanking.indexOf(sigId) + 1
    const int8Rank = int8Ranking.indexOf(sigId) + 1
    const drift = Math.abs(floatRank - int8Rank)
    maxDrift = Math.max(maxDrift, drift)
    console.log(`  ${sigId}: float rank=${floatRank}, int8 rank=${int8Rank}, drift=${drift}`)
  }
  const c3Pass = maxDrift <= 1
  console.log(`  Max drift: ${maxDrift}`)
  console.log(`  C3: ${c3Pass ? 'PASS' : 'FAIL'} (need drift <= 1)`)

  // --- C4: Storage reduction ---
  console.log('\n--- C4: Storage reduction ---')
  const c4Pass = reduction >= 5
  console.log(`  ${reduction.toFixed(1)}x reduction`)
  console.log(`  C4: ${c4Pass ? 'PASS' : 'FAIL'} (need >= 5x)`)

  // --- Cosine error distribution ---
  console.log('\n--- Diagnostic: Cosine error ---')
  const errors = scores.map(s => Math.abs(s.floatSim - s.int8Sim))
  errors.sort((a, b) => a - b)
  console.log(`  Mean error: ${(errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(6)}`)
  console.log(`  Median error: ${errors[Math.floor(errors.length / 2)].toFixed(6)}`)
  console.log(`  P95 error: ${errors[Math.floor(errors.length * 0.95)].toFixed(6)}`)
  console.log(`  P99 error: ${errors[Math.floor(errors.length * 0.99)].toFixed(6)}`)
  console.log(`  Max error: ${errors[errors.length - 1].toFixed(6)}`)

  // --- Summary ---
  const conditions = [
    { id: 'C1', name: 'Rank correlation >= 0.99', pass: c1Pass },
    { id: 'C2', name: 'Top-10 overlap >= 9/10', pass: c2Pass },
    { id: 'C3', name: 'Signal rank drift <= 1', pass: c3Pass },
    { id: 'C4', name: 'Storage reduction >= 5x', pass: c4Pass },
  ]

  console.log('\n=== RESULTS ===\n')
  for (const c of conditions) {
    console.log(`  ${c.id} (${c.name}): ${c.pass ? 'PASS' : 'FAIL'}`)
  }
  const passCount = conditions.filter(c => c.pass).length
  console.log(`\n  ${passCount}/${conditions.length} passed`)
  console.log(`  Verdict: ${passCount === 4 ? 'INT8 QUANTIZATION SAFE — SHIP IT' : passCount >= 3 ? 'MOSTLY SAFE — REVIEW FAILURES' : 'QUALITY LOSS TOO HIGH'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
