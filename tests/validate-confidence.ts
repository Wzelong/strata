import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import { embedBatch, cosine, dequantize } from '../src/engine/embed.js'
import { stringSimilarity } from '../src/engine/search.js'
import type { StoredItem, CostTracker } from '../src/engine/types.js'
import { LIVE_ITEMS, SURFACE_IDS } from '../dataset/signal-items.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, '..', 'dataset', 'seed.json')

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

const HAS_IDENTIFIER = /\d|@|\.com|\.org|\.net|#|\/\//
const EMBEDDING_THRESHOLD = 0.80
const STRING_THRESHOLD = 0.90

function entityMatchScore(querySurface: string, queryEmb: number[], storedSurface: string, storedEmb: number[]): { score: number; method: string } {
  const strSim = stringSimilarity(querySurface, storedSurface)
  const embSim = cosine(queryEmb, storedEmb)

  if (HAS_IDENTIFIER.test(querySurface) || HAS_IDENTIFIER.test(storedSurface)) {
    if (strSim >= STRING_THRESHOLD) return { score: strSim, method: 'string (identifier)' }
    return { score: 0, method: `identifier miss (str=${strSim.toFixed(3)}, emb=${embSim.toFixed(3)})` }
  }

  if (strSim >= STRING_THRESHOLD) return { score: strSim, method: 'string' }
  if (embSim >= EMBEDDING_THRESHOLD) return { score: embSim, method: 'embedding' }
  return { score: 0, method: `miss (str=${strSim.toFixed(3)}, emb=${embSim.toFixed(3)})` }
}

// Confidence assignment logic under test
function assignConfidence(matches: Array<{ score: number }>, classification: string): 'high' | 'review' {
  if (classification === 'contradicts') return 'high'
  if (matches.length >= 2) return 'high'
  if (matches.some(m => m.score >= 0.80)) return 'high'
  return 'review'
}

type SeedData = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
}

async function main() {
  const cost = new SimpleCost()
  console.log('=== Confidence Assignment Validation ===\n')

  console.log('Loading seed...')
  const seed: SeedData = JSON.parse(readFileSync(SEED_FILE, 'utf8'))
  const itemById = new Map<string, StoredItem>(seed.items.map(i => [i.id, i]))

  // Case post
  const casePost = LIVE_ITEMS.find(i => i.id === 't3_strata_casepost')!
  const caseText = normalize(casePost.text)

  // Extract + embed case post entities
  console.log('Extracting case post entities...')
  const caseEntities = await extractEntities(client, caseText, cost)
  console.log(`  ${caseEntities.length} entities:`)
  for (const e of caseEntities) console.log(`    ${e.type}: "${e.surfaceText}"`)

  console.log('\nEmbedding case post entities...')
  const caseEntityEmbs = await embedBatch(client, caseEntities.map(e => e.surfaceText), cost)

  // Build entity embedding index for signal items only (+ some noise for context)
  const signalItems = [...SURFACE_IDS].map(id => itemById.get(id)!).filter(Boolean)

  console.log(`\nEmbedding signal item entities...`)
  const signalEntityTexts: Array<{ itemId: string; type: string; surfaceText: string }> = []
  for (const item of signalItems) {
    for (const e of item.entities) {
      signalEntityTexts.push({ itemId: item.id, type: e.type, surfaceText: e.surfaceText })
    }
  }
  const signalEntityEmbs = await embedBatch(client, signalEntityTexts.map(e => e.surfaceText), cost)

  // Build lookup: itemId → [{type, surfaceText, embedding}]
  const signalEntityIndex = new Map<string, Array<{ type: string; surfaceText: string; embedding: number[] }>>()
  for (let i = 0; i < signalEntityTexts.length; i++) {
    const { itemId, type, surfaceText } = signalEntityTexts[i]
    if (!signalEntityIndex.has(itemId)) signalEntityIndex.set(itemId, [])
    signalEntityIndex.get(itemId)!.push({ type, surfaceText, embedding: signalEntityEmbs[i] })
  }

  // Run dual matching for each signal item
  console.log('\n=== Entity Match Scores (case post → each signal) ===\n')

  const results: Array<{ id: string; matches: Array<{ score: number; method: string; pair: string }>; confidence: 'high' | 'review' }> = []

  for (const sigId of SURFACE_IDS) {
    const item = itemById.get(sigId)!
    const itemEntities = signalEntityIndex.get(sigId) ?? []
    console.log(`${sigId}: "${item.text.slice(0, 60)}..."`)
    console.log(`  Item entities: ${item.entities.map(e => `${e.type}:"${e.surfaceText}"`).join(', ')}`)

    const matches: Array<{ score: number; method: string; pair: string }> = []

    for (let ci = 0; ci < caseEntities.length; ci++) {
      const qEntity = caseEntities[ci]
      for (const storedEntity of itemEntities) {
        if (qEntity.type !== storedEntity.type) continue
        const result = entityMatchScore(qEntity.surfaceText, caseEntityEmbs[ci], storedEntity.surfaceText, storedEntity.embedding)
        if (result.score > 0) {
          matches.push({ score: result.score, method: result.method, pair: `"${qEntity.surfaceText}" ↔ "${storedEntity.surfaceText}"` })
        } else {
          // Show near-misses too
          const strSim = stringSimilarity(qEntity.surfaceText, storedEntity.surfaceText)
          const embSim = cosine(caseEntityEmbs[ci], storedEntity.embedding)
          if (embSim > 0.60 || strSim > 0.60) {
            console.log(`    near-miss: ${qEntity.type}: "${qEntity.surfaceText}" ↔ "${storedEntity.surfaceText}" (str=${strSim.toFixed(3)}, emb=${embSim.toFixed(3)})`)
          }
        }
      }
    }

    // Also check cross-type near-misses (case entities vs all stored entities)
    for (let ci = 0; ci < caseEntities.length; ci++) {
      const qEntity = caseEntities[ci]
      for (const storedEntity of itemEntities) {
        if (qEntity.type === storedEntity.type) continue
        const embSim = cosine(caseEntityEmbs[ci], storedEntity.embedding)
        if (embSim > 0.75) {
          console.log(`    cross-type near-hit: ${qEntity.type}:"${qEntity.surfaceText}" ↔ ${storedEntity.type}:"${storedEntity.surfaceText}" (emb=${embSim.toFixed(3)})`)
        }
      }
    }

    const confidence = assignConfidence(matches, 'confirms')
    results.push({ id: sigId, matches, confidence })

    if (matches.length > 0) {
      console.log(`  MATCHES:`)
      for (const m of matches) {
        console.log(`    ${m.score.toFixed(3)} via ${m.method}: ${m.pair}`)
      }
    } else {
      console.log(`  NO ENTITY MATCHES (narrative-only)`)
    }
    console.log(`  → confidence: ${confidence}`)
    console.log()
  }

  // Summary
  console.log('=== CONFIDENCE ASSIGNMENT SUMMARY ===\n')
  console.log('  ID                       | Matches | Best Score | Confidence')
  console.log('  -------------------------|---------|------------|----------')
  for (const r of results) {
    const best = r.matches.length > 0 ? Math.max(...r.matches.map(m => m.score)) : 0
    console.log(`  ${r.id.padEnd(25)} | ${String(r.matches.length).padStart(7)} | ${best > 0 ? best.toFixed(3).padStart(10) : '       N/A'} | ${r.confidence}`)
  }

  // Validate the logic
  console.log('\n=== LOGIC VALIDATION ===\n')

  // Expected: surface1,2,3 have entity matches (vehicle) → should be "high"
  // Expected: surface4 (earwitness) has no entity overlap → should be "review"
  const surface4 = results.find(r => r.id === 't3_strata_surface4')!
  const entityItems = results.filter(r => r.matches.length > 0)

  console.log(`  Entity-matched items → "high": ${entityItems.filter(r => r.confidence === 'high').length}/${entityItems.length}`)
  console.log(`  Narrative-only (surface4) → "review": ${surface4.confidence === 'review' ? 'YES' : 'NO (got ' + surface4.confidence + ')'}`)

  const allCorrect = entityItems.every(r => r.confidence === 'high') && surface4.confidence === 'review'
  console.log(`\n  Logic makes sense: ${allCorrect ? 'YES' : 'NO — needs adjustment'}`)

  // Show edge case: what if earwitness somehow got a low entity score?
  console.log('\n=== EDGE CASE: What if 0.80 threshold is too strict? ===')
  console.log('  Checking all entity match scores across all signals:')
  for (const r of results) {
    for (const m of r.matches) {
      if (m.score < 0.85) {
        console.log(`    ⚠️  ${r.id}: ${m.score.toFixed(3)} — close to threshold: ${m.pair}`)
      }
    }
  }

  console.log(`\n  Cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
