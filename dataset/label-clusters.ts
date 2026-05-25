import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import type { StoredItem, LayoutCluster } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED = resolve(__dirname, 'seed.json')
const LAYOUT = resolve(__dirname, 'layout.json')

type LayoutFile = {
  positions: Record<string, [number, number, number]>
  clusters: Array<{ id: number; size: number; memberIds: string[]; sampleItemIds: string[] }>
  noiseIds: string[]
}

type SeedShape = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
  entityEmbeddings: Record<string, Record<string, string>>
  clusters?: LayoutCluster[]
}

const seed: SeedShape = JSON.parse(readFileSync(SEED, 'utf8'))
const layout: LayoutFile = JSON.parse(readFileSync(LAYOUT, 'utf8'))
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const itemsById = new Map<string, StoredItem>()
for (const it of seed.items) itemsById.set(it.id, it)

const buildSampleBlock = (sampleIds: string[]) =>
  sampleIds
    .map(id => itemsById.get(id))
    .filter((x): x is StoredItem => !!x)
    .map((x, i) => {
      const title = x.title ? `[${x.title}] ` : ''
      const text = x.text.slice(0, 220).replace(/\s+/g, ' ')
      return `${i + 1}. ${title}${text}`
    })
    .join('\n')

console.log(`Labeling ${layout.clusters.length} clusters in parallel...`)

const SYSTEM = `You name topic clusters in a Reddit subreddit dataset.

You see N sample items drawn from a cluster of M total items.

Rules:
- 2-5 words.
- If M < 30: label can describe a specific thread or incident.
- If 30 <= M < 150: label a clear topic (e.g. "Cambridge bike incidents", "rental disputes").
- If M >= 150: label a BROAD theme covering the whole cluster (e.g. "Boston dating + social meetups"). Look for the common thread across diverse samples, not just one slice.
- Everyday language only. No jargon, no "discussion", no "various topics", no "Boston news".

Examples:
- 22 items all about one Sullivan Tire ad and its nostalgia comments  ->  "Sullivan Tire ad culture"
- 80 items about rentals + leases + brokers + scams                    ->  "rental hunt and disputes"
- 180 items spanning sober meetups + queer nightlife + EDM events     ->  "Boston social scene"
- 14 items all about pedestrian signal timing at one intersection     ->  "concurrent pedestrian signals"

Return strict JSON: {"label": "..."}.`

const labels: LayoutCluster[] = await Promise.all(layout.clusters.map(async c => {
  const samples = buildSampleBlock(c.sampleItemIds)
  const n = c.sampleItemIds.length
  const m = c.size
  const resp = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Cluster has M=${m} total items. You are seeing N=${n} samples:\n${samples}` },
    ],
    response_format: { type: 'json_object' },
  })
  const raw = resp.choices[0]?.message?.content ?? '{}'
  let label = `cluster-${c.id}`
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.label && typeof parsed.label === 'string') label = parsed.label.trim()
  } catch {}
  return { id: c.id, label, size: c.size }
}))

labels.sort((a, b) => b.size - a.size)

const clusterByItemId = new Map<string, number>()
for (const c of layout.clusters) for (const m of c.memberIds) clusterByItemId.set(m, c.id)
for (const id of layout.noiseIds) clusterByItemId.set(id, -1)

let positionsApplied = 0
let clustersApplied = 0
for (const it of seed.items) {
  const p = layout.positions[it.id]
  if (p) { it.position3d = p; positionsApplied++ }
  const cid = clusterByItemId.get(it.id)
  if (cid !== undefined) { it.clusterId = cid; clustersApplied++ }
}

seed.clusters = labels

writeFileSync(SEED, JSON.stringify(seed))
const sizeMB = (Buffer.byteLength(JSON.stringify(seed)) / 1024 / 1024).toFixed(1)
console.log(`\nSeed updated (${sizeMB} MB):`)
console.log(`  ${positionsApplied}/${seed.items.length} items got position3d`)
console.log(`  ${clustersApplied}/${seed.items.length} items got clusterId`)
console.log(`  ${labels.length} clusters labeled\n`)
console.log('Top 10 clusters by size:')
for (const c of labels.slice(0, 10)) console.log(`  #${c.id.toString().padStart(3)}  ${c.size.toString().padStart(4)} items   ${c.label}`)
