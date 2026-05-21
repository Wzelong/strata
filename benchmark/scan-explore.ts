import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { findSimilar } from '../src/engine/search.js'
import { buildScanPairs } from '../src/engine/scan.js'
import { classifyBatch } from '../src/engine/classify.js'
import { LIVE_ITEMS, ALL_SIGNAL_IDS } from '../dataset/signal-items.js'
import type { StoredItem, Entity, Item } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, 'benchmark-seed.json')
const LIVE_FILE = resolve(__dirname, 'benchmark-live-items.json')

async function loadData(store: MemoryKVStore) {
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

  return seen.size
}

async function getItem(store: MemoryKVStore, id: string): Promise<Item | null> {
  const stored = await store.getItem(id)
  if (!stored) return null
  const emb = await store.getEmbedding(id)
  return { ...stored, embedding: emb ?? [] }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const store = new MemoryKVStore()

  console.log('Loading dataset...')
  const count = await loadData(store)
  console.log(`${count} items loaded\n`)

  console.log('Building scan pairs...')
  const pairs = await buildScanPairs(store)
  console.log(`Found ${pairs.length} anchor groups\n`)

  console.log('='.repeat(70))
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    const anchor = await getItem(store, pair.anchorId)
    if (!anchor) continue

    const isSignalAnchor = ALL_SIGNAL_IDS.has(pair.anchorId)
    const signalConns = pair.connectionIds.filter(id => ALL_SIGNAL_IDS.has(id))

    console.log(`\nGroup ${i + 1}: anchor=${pair.anchorId} ${isSignalAnchor ? '[SIGNAL]' : ''}`)
    console.log(`  Author: ${anchor.authorName}`)
    console.log(`  Text: "${anchor.text.slice(0, 120)}..."`)
    console.log(`  Shared entities: ${pair.entities.join(', ')}`)
    console.log(`  Connections: ${pair.connectionIds.length} items${signalConns.length > 0 ? ` (${signalConns.length} signal)` : ''}`)

    // Show connection texts (limit to 15 for classification)
    const allCandidates: Item[] = []
    for (const id of pair.connectionIds.slice(0, 20)) {
      const item = await getItem(store, id)
      if (item) allCandidates.push(item)
    }
    const candidates = allCandidates.slice(0, 15)

    for (const item of candidates) {
      const sig = ALL_SIGNAL_IDS.has(item.id) ? ' [SIGNAL]' : ''
      console.log(`    - ${item.id}${sig} (${item.authorName}): "${item.text.slice(0, 100)}..."`)
    }
    if (pair.connectionIds.length > 15) {
      console.log(`    ... and ${pair.connectionIds.length - 15} more`)
    }

    // Classify
    console.log(`\n  Classifying top 15 with GPT-5.5...`)
    const t0 = performance.now()
    const classifications = await classifyBatch(
      client,
      anchor,
      candidates.map(c => ({ id: c.id, text: c.text })),
    )
    const ms = performance.now() - t0

    const related = classifications.filter(c => c.relationship !== 'UNRELATED')
    console.log(`  Results (${Math.round(ms)}ms):`)
    for (const cls of classifications) {
      const marker = cls.relationship !== 'UNRELATED' ? '>>>' : '   '
      console.log(`  ${marker} ${cls.id}: ${cls.relationship} (${cls.confidence ?? '-'}) — ${cls.reason}`)
    }

    if (related.length > 0) {
      console.log(`\n  *** ALERT: ${related.length} connection(s) found ***`)
    } else {
      console.log(`\n  (no alerts)`)
    }
    console.log('-'.repeat(70))
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
