// Patch only the planted items in seed.json + live-items.json.
// r/boston items are deterministic given the extraction prompt — no need to
// re-extract them when only signal-items.ts / labeled-cases.ts change.
//
// Drops every existing t[13]_strata_* item from the seed, re-ingests the
// current planted set through the engine, then writes the files back.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore } from '../src/engine/index.js'
import type { StoredItem, Entity, CostTracker } from '../src/engine/types.js'
import { BACKFILL_ITEMS, LIVE_ITEMS, REMOVED_ITEMS } from './signal-items.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED = resolve(__dirname, 'seed.json')
const LIVE = resolve(__dirname, 'live-items.json')

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

const isPlanted = (id: string) => id.startsWith('t1_strata_') || id.startsWith('t3_strata_')

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCost()
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  console.log('=== Patch planted items (keep r/boston intact) ===\n')

  // Step 1: load existing seed
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as {
    items: StoredItem[]
    embeddings: Record<string, number[]>
    entityEmbeddings: Record<string, Record<string, string>>
  }
  const beforeCount = seed.items.length
  const beforePlanted = seed.items.filter(i => isPlanted(i.id)).length
  console.log(`Loaded seed: ${beforeCount} items (${beforePlanted} planted)`)

  // Step 2: drop every existing planted item from items + embeddings + entityEmbeddings
  const keptItems = seed.items.filter(i => !isPlanted(i.id))
  const keptEmbeddings: Record<string, number[]> = {}
  for (const [id, emb] of Object.entries(seed.embeddings)) {
    if (!isPlanted(id)) keptEmbeddings[id] = emb
  }
  const keptEntityEmbeddings: Record<string, Record<string, string>> = {}
  for (const [type, entries] of Object.entries(seed.entityEmbeddings ?? {})) {
    keptEntityEmbeddings[type] = {}
    for (const [key, enc] of Object.entries(entries)) {
      const colon = key.indexOf(':')
      const itemId = key.slice(0, colon)
      if (!isPlanted(itemId)) keptEntityEmbeddings[type][key] = enc
    }
  }
  console.log(`After dropping planted: ${keptItems.length} items, ${Object.keys(keptEmbeddings).length} embeddings, ${Object.values(keptEntityEmbeddings).reduce((n, v) => n + Object.keys(v).length, 0)} entity embeddings`)

  // Step 3: rehydrate KV store with kept r/boston content
  for (const it of keptItems) {
    await store.setItem(it)
    if (keptEmbeddings[it.id]) await store.setEmbedding(it.id, keptEmbeddings[it.id])
    if (it.entities.length > 0) await store.addToEntityIndex(it.entities, it.id, it.createdAt)
  }
  // Rebuild type-keyed entity embeddings into the store
  const entsByItem = new Map<string, Array<{ type: string; surfaceText: string; embedding: string }>>()
  for (const [type, entries] of Object.entries(keptEntityEmbeddings)) {
    for (const [key, enc] of Object.entries(entries)) {
      const colon = key.indexOf(':')
      const itemId = key.slice(0, colon)
      const surfaceText = key.slice(colon + 1)
      if (!entsByItem.has(itemId)) entsByItem.set(itemId, [])
      entsByItem.get(itemId)!.push({ type, surfaceText, embedding: enc })
    }
  }
  for (const [itemId, ents] of entsByItem) await store.setEntityEmbeddings(itemId, ents)
  console.log(`Rehydrated store from kept r/boston content`)

  // Step 4: ingest planted items (backfill + labeled-case chatter + live)
  console.log(`\nIngesting ${BACKFILL_ITEMS.length} backfill signal items...`)
  for (const raw of BACKFILL_ITEMS) {
    const item = await engine.ingest(raw)
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }

  // Mark FLAG-3 removed
  console.log(`\nMarking FLAG-3 items removed...`)
  for (const [id, meta] of Object.entries(REMOVED_ITEMS)) {
    const it = await store.getItem(id)
    if (!it) { console.log(`  WARNING: ${id} not found`); continue }
    const updated: StoredItem = {
      ...it,
      decision: meta.decision,
      decisionAt: it.createdAt + 3600000,
      decisionBy: meta.decisionBy,
      decisionReason: meta.decisionReason,
    }
    await store.setItem(updated)
    await store.moveDecision(id, 'pending', 'removed', updated.decisionAt!)
    console.log(`  ${id} → removed`)
  }

  // Process LIVE items in a SEPARATE store. They must NOT be in seed.json
  // because "LIVE" means the user posts them at demo time. The separate store
  // gives us their embeddings + entities for benchmark hydration via
  // live-items.json, without polluting the seed.
  console.log(`\nProcessing ${LIVE_ITEMS.length} live items (separate store, not in seed)...`)
  const liveStore = new MemoryKVStore()
  const liveEngine = new StrataEngine(liveStore, client, cost)
  const liveResults: Array<{ id: string; textNormalized: string; embedding: number[]; entities: Entity[] }> = []
  for (const raw of LIVE_ITEMS) {
    const item = await liveEngine.ingest(raw)
    liveResults.push({ id: item.id, textNormalized: item.textNormalized, embedding: item.embedding, entities: item.entities })
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }
  writeFileSync(LIVE, JSON.stringify({ items: liveResults }, null, 2))
  console.log(`  wrote ${LIVE}`)

  // Step 5: re-assemble seed.json from the store
  const allIds = await store.getItemIds()
  const seedItems: StoredItem[] = []
  const seedEmbeddings: Record<string, number[]> = {}
  for (const id of allIds) {
    const it = await store.getItem(id)
    const emb = await store.getEmbedding(id)
    if (it && emb) { seedItems.push(it); seedEmbeddings[id] = emb }
  }
  const ENTITY_TYPES = ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity']
  const seedEntityEmbeddings: Record<string, Record<string, string>> = {}
  for (const type of ENTITY_TYPES) {
    const entries = await store.getEntityEmbeddingsByType(type)
    if (entries.length > 0) {
      seedEntityEmbeddings[type] = {}
      for (const e of entries) seedEntityEmbeddings[type][`${e.itemId}:${e.surfaceText}`] = e.embedding
    }
  }
  const out = { items: seedItems, embeddings: seedEmbeddings, entityEmbeddings: seedEntityEmbeddings }
  writeFileSync(SEED, JSON.stringify(out))
  const sizeMB = (Buffer.byteLength(JSON.stringify(out)) / 1024 / 1024).toFixed(1)
  const totalEnts = Object.values(seedEntityEmbeddings).reduce((n, v) => n + Object.keys(v).length, 0)
  const newPlanted = seedItems.filter(i => isPlanted(i.id)).length

  console.log(`\n=== Done ===`)
  console.log(`  ${seedItems.length} items in seed (${newPlanted} planted, ${seedItems.length - newPlanted} r/boston)`)
  console.log(`  ${totalEnts} entity embeddings`)
  console.log(`  ${sizeMB} MB seed file`)
  console.log(`  cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
