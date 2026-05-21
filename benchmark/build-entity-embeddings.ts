import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { quantize } from '../src/engine/embed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, 'benchmark-seed.json')
const LIVE_FILE = resolve(__dirname, 'benchmark-live-items.json')

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

type Entity = { type: string; surfaceText: string }
type StoredItem = { id: string; entities: Entity[]; [key: string]: any }

async function embedBatch(texts: string[]): Promise<number[][]> {
  const MAX = 2048
  const results: number[][] = []
  for (let i = 0; i < texts.length; i += MAX) {
    const chunk = texts.slice(i, i + MAX)
    console.log(`  Embedding ${i}–${i + chunk.length} / ${texts.length}`)
    const response = await client.embeddings.create({
      input: chunk,
      model: 'text-embedding-3-small',
      dimensions: 256,
    })
    const sorted = response.data.sort((a, b) => a.index - b.index)
    for (const d of sorted) results.push(d.embedding)
  }
  return results
}

async function main() {
  console.log('Loading seed data...')
  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as { items: StoredItem[]; embeddings: Record<string, number[]> }
  const live = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as { items: Array<{ id: string; entities: Entity[]; [key: string]: any }> }

  // Collect all entity texts with their metadata
  const entityMeta: Array<{ itemId: string; type: string; surfaceText: string }> = []
  const entityTexts: string[] = []

  for (const item of seed.items) {
    for (const e of item.entities) {
      entityMeta.push({ itemId: item.id, type: e.type, surfaceText: e.surfaceText })
      entityTexts.push(e.surfaceText)
    }
  }
  for (const item of live.items) {
    for (const e of item.entities) {
      entityMeta.push({ itemId: item.id, type: e.type, surfaceText: e.surfaceText })
      entityTexts.push(e.surfaceText)
    }
  }

  console.log(`Embedding ${entityTexts.length} entities...`)
  const embeddings = await embedBatch(entityTexts)

  const entityEmbeddings: Record<string, Array<{ type: string; surfaceText: string; embedding: string }>> = {}

  for (let i = 0; i < entityMeta.length; i++) {
    const { itemId, type, surfaceText } = entityMeta[i]
    if (!entityEmbeddings[itemId]) entityEmbeddings[itemId] = []
    entityEmbeddings[itemId].push({
      type,
      surfaceText,
      embedding: quantize(embeddings[i]),
    })
  }

  // Write to seed file
  const output = { ...seed, entityEmbeddings }
  console.log(`Writing ${Object.keys(entityEmbeddings).length} items with entity embeddings...`)
  writeFileSync(SEED_FILE, JSON.stringify(output))
  console.log('Done.')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
