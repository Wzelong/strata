import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import OpenAI from 'openai'
import { MemoryKVStore } from './src/engine/storage/memory.js'
import { MemoryAlertStore } from './src/engine/storage/memory-alert-store.js'
import { cosine, dequantize } from './src/engine/embed.js'
import type { StoredItem, Alert, AlertConnection, AlertStatus } from './src/engine/types.js'
import { createChatHandler } from './src/server/chat/route.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = resolve(__dirname, 'dataset/seed.json')
const PORT = 4173
const SUB = 'strata_local_dev'

const store = new MemoryKVStore()
const alertStore = new MemoryAlertStore()

console.log('[dev-server] Loading seed.json...')
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
  items: StoredItem[]
  embeddings?: Record<string, number[]>
  entityEmbeddings?: Record<string, Record<string, string>>
  clusters?: Array<{ id: number; label: string; size: number }>
}

const itemEmbeddings = new Map<string, number[]>()
if (seed.embeddings) {
  for (const [id, vec] of Object.entries(seed.embeddings)) itemEmbeddings.set(id, vec)
  console.log(`[dev-server] Loaded ${itemEmbeddings.size} item embeddings`)
}

const clusterLabelById = new Map<number, string>()
for (const c of seed.clusters ?? []) clusterLabelById.set(c.id, c.label)

async function loadSeedIntoStore() {
  for (const item of seed.items) {
    await store.setItem(item)
    if (item.entities?.length) await store.addToEntityIndex(item.entities, item.id, item.createdAt)
  }
  if (seed.entityEmbeddings) {
    const byItem = new Map<string, Array<{ type: string; surfaceText: string; embedding: string }>>()
    for (const [type, entries] of Object.entries(seed.entityEmbeddings)) {
      for (const [key, embedding] of Object.entries(entries)) {
        const colonIdx = key.indexOf(':')
        if (colonIdx === -1) continue
        const itemId = key.slice(0, colonIdx)
        const surfaceText = key.slice(colonIdx + 1)
        if (!byItem.has(itemId)) byItem.set(itemId, [])
        byItem.get(itemId)!.push({ type, surfaceText, embedding })
      }
    }
    for (const [itemId, embs] of byItem) await store.setEntityEmbeddings(itemId, embs)
  }
}

async function clearAllItems() {
  const ids = await store.getItemIds()
  if (ids.length > 0) await store.deleteItems(ids)
}

await loadSeedIntoStore()
console.log(`[dev-server] Loaded ${seed.items.length} items into memory store`)

const stub = (id: string) => `https://reddit.com/r/${SUB}/comments/${id.replace(/^t[13]_/, '')}`
const MOCK_SURFACE_ALERT_ID = 'dev-alert-surface'
const MOCK_BRIGADE_ALERT_ID = 'dev-alert-brigade'

function jitter(p: [number, number, number], r = 0.6): [number, number, number] {
  return [p[0] + (Math.random() - 0.5) * r, p[1] + (Math.random() - 0.5) * r, p[2] + (Math.random() - 0.5) * r]
}

async function ensurePlantedItems() {
  const positionOf = async (id: string): Promise<[number, number, number] | null> => {
    const it = await store.getItem(id)
    return it?.position3d ?? null
  }
  const centroidOf = async (ids: string[]): Promise<[number, number, number] | null> => {
    const positions: [number, number, number][] = []
    for (const id of ids) {
      const p = await positionOf(id)
      if (p) positions.push(p)
    }
    if (positions.length === 0) return null
    const c = positions.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as [number, number, number], [0, 0, 0])
    return [c[0] / positions.length, c[1] / positions.length, c[2] / positions.length]
  }

  const planted: Array<{ id: string; type: 'post' | 'comment'; title?: string; text: string; author: string; createdAt: number; threadRootId: string; parentId: string | null; position: [number, number, number]; clusterId?: number }> = []

  const surfaceCentroid = await centroidOf(['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4'])
  const casePos = surfaceCentroid ?? [0, 0, 0]
  planted.push({
    id: 't3_strata_casepost', type: 'post',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'Posting on behalf of my roommate Sarah. She was riding home on Mass Ave near the Prospect St intersection in Central around 5:30pm Tuesday when a driver ran the light, hit her, and took off.',
    author: 'SarahsRoommate2026', createdAt: Date.now() - 2 * 60 * 60_000,
    threadRootId: 't3_strata_casepost', parentId: null, position: jitter(casePos),
  })

  const flag3Centroid = await centroidOf(['t3_strata_flag3a', 't3_strata_flag3b', 't3_strata_flag3c'])
  const flag4Pos = flag3Centroid ?? [0, 0, 0]
  planted.push({
    id: 't3_strata_flag4', type: 'post',
    title: 'WARNING: dark green SUV running reds on Mass Ave near Central',
    text: 'There\'s a dark green SUV that\'s been seen blowing through red lights on Mass Ave near Central multiple times.',
    author: 'MassAveSafety', createdAt: Date.now() - 60_000,
    threadRootId: 't3_strata_flag4', parentId: null, position: jitter(flag4Pos),
  })

  const surfaceThreadRoots: Array<{ id: string; title: string; childId: string }> = [
    { id: 't3_bike_commute_daily', title: 'Cambridge bike commute - daily thread', childId: 't1_strata_surface1' },
    { id: 't3_cambridge_pd_blackhole', title: 'Cambridge PD black hole - anyone actually had a detective call back?', childId: 't3_strata_surface2' },
    { id: 't3_cambridgeside_garage_rants', title: 'Cambridgeside garage parking complaints', childId: 't1_strata_surface3' },
  ]
  for (const tr of surfaceThreadRoots) {
    const childPos = await positionOf(tr.childId)
    planted.push({
      id: tr.id, type: 'post', title: tr.title,
      text: tr.title,
      author: 'planted', createdAt: Date.now() - 7 * 24 * 60 * 60_000,
      threadRootId: tr.id, parentId: null,
      position: jitter(childPos ?? [0, 0, 0], 0.8),
    })
  }

  const brigadeBase = casePos
  const brigadeItems = [
    { id: 't1_strata_brigade1', author: 'BostonDriver2026_1', text: 'This is getting out of hand. I know the owner of that car and he\'s a good dude who works two jobs.', t: 90 },
    { id: 't1_strata_brigade2', author: 'BostonDriver2026_2', text: 'Classic Reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area?', t: 120 },
    { id: 't1_strata_brigade3', author: 'BostonDriver2026_3', text: 'I drive past Cambridgeside garage every day and there\'s no damaged Subaru there.', t: 105 },
    { id: 't1_strata_brigade4', author: 'BostonDriver2026_4', text: 'Has anyone verified this story is even real? No news articles, no police confirmation.', t: 75 },
  ]
  for (const b of brigadeItems) {
    planted.push({
      id: b.id, type: 'comment', text: b.text, author: b.author,
      createdAt: Date.now() - b.t * 60_000,
      threadRootId: 't3_strata_casepost', parentId: 't3_strata_casepost', position: jitter(brigadeBase, 0.9),
    })
  }

  for (const p of planted) {
    if (await store.getItem(p.id)) continue
    const item: StoredItem = {
      id: p.id, type: p.type, title: p.title, text: p.text,
      textNormalized: p.text.toLowerCase(),
      authorId: p.author, authorName: p.author,
      createdAt: p.createdAt, threadRootId: p.threadRootId, parentId: p.parentId,
      entities: [], decision: 'pending', decisionAt: null, decisionBy: null, decisionReason: null,
      position3d: p.position, clusterId: -1,
    }
    await store.setItem(item)
  }
  console.log(`[dev-server] Inserted ${planted.length} planted items`)
}

async function insertMockAlerts() {
  const now = Date.now()
  const hours = (n: number) => now - n * 60 * 60_000
  const days = (n: number) => now - n * 24 * 60 * 60_000
  const minutes = (n: number) => now - n * 60_000

  const surfaceConnections: AlertConnection[] = [
    { itemId: 't1_strata_surface1', author: 'ThursdayCommuter', type: 'comment',
      title: 'Cambridge bike commute - daily thread',
      text: 'Almost ate it this morning at the Mass Ave / Prospect light — dark green Subaru wagon came flying through the red heading east. Plate started with a K, that\'s all I caught before he was gone.',
      permalink: stub('t1_strata_surface1'),
      classification: 'updates', confidence: 'high',
      entities: [{ text: 'Mass Ave / Prospect light', clusterId: 'loc:intersection' }],
      reasoning: 'Same vehicle description (dark green Subaru wagon) and same intersection (Mass Ave / Prospect) running the red light. Plate starts with K, consistent with the case post\'s partial plate ending in -K77.',
      createdAt: hours(5), sameAuthor: false },
    { itemId: 't3_strata_surface2', author: 'DashcamDave_617', type: 'comment',
      title: 'Cambridge PD black hole - anyone actually had a detective call back?',
      text: 'Submitted my dashcam clip to case #2026-04891 close to three weeks ago. Detective on the desk said "we\'ll be in touch within 48 hours" and that was the last contact.',
      permalink: stub('t3_strata_surface2'),
      classification: 'updates', confidence: 'high',
      entities: [{ text: 'case #2026-04891', clusterId: 'qty:case' }],
      reasoning: 'Directly references the same Cambridge PD case number and reports submitting dashcam footage — actionable evidence the case post is asking for.',
      createdAt: days(2), sameAuthor: false },
    { itemId: 't1_strata_surface3', author: 'CambridgeSide_Resident', type: 'comment',
      title: 'Cambridgeside garage parking complaints',
      text: 'Whoever\'s parking a dark green Subaru wagon in P3 — your friend clipped my side mirror last Tuesday around 5:30 and just bounced. Partial plate ended in -K77 if anyone has dashcam from P3.',
      permalink: stub('t1_strata_surface3'),
      classification: 'updates', confidence: 'high',
      entities: [
        { text: 'Partial plate ended in -K77', clusterId: 'obj:plate' },
        { text: 'Tuesday around 5:30', clusterId: 'qty:time' },
      ],
      reasoning: 'Partial plate -K77 matches the case post exactly. Same vehicle description. Same time of day (Tuesday around 5:30) as the cyclist incident. Possibly the same driver leaving the scene of a second hit.',
      createdAt: days(3), sameAuthor: false },
    { itemId: 't3_strata_surface4', author: 'InmanSq_Walker', type: 'post',
      title: 'Tuesday around 5:30 near Central — what was that crash?',
      text: 'Was walking down to dinner Tuesday evening and heard a real bad bang from up the street, then someone screaming. By the time I got close it had already cleared out — cops weren\'t there yet. Kept walking like a coward.',
      permalink: stub('t3_strata_surface4'),
      classification: 'confirms', confidence: 'review',
      entities: [{ text: 'Tuesday evening', clusterId: 'qty:time' }],
      reasoning: 'Earwitness near Central at the same time as the reported incident. No vehicle or victim details, but the audio narrative (loud bang + screaming) and timing line up.',
      createdAt: days(6), sameAuthor: false },
  ]
  await alertStore.createAlert({
    id: MOCK_SURFACE_ALERT_ID, mode: 'surface', status: 'pending', confidence: 'high',
    connectionCount: surfaceConnections.length, createdAt: now,
    anchorId: 't3_strata_casepost', anchorAuthor: 'SarahsRoommate2026', anchorType: 'post',
    anchorTitle: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    anchorText: 'Posting on behalf of my roommate Sarah. She was riding home on Mass Ave near the Prospect St intersection in Central around 5:30pm Tuesday when a driver ran the light, hit her, and took off. She\'s at MGH — broken pelvis, broken collarbone, internal bleeding. Stable but it\'s bad.\n\nCambridge PD opened it as case #2026-04891. They have a partial plate ending in -K77 but it isn\'t enough on its own.',
    anchorPermalink: stub('t3_strata_casepost'),
    anchorEntities: [
      { text: 'Mass Ave near the Prospect St intersection', clusterId: 'loc:intersection' },
      { text: 'around 5:30pm Tuesday', clusterId: 'qty:time' },
      { text: 'case #2026-04891', clusterId: 'qty:case' },
      { text: 'partial plate ending in -K77', clusterId: 'obj:plate' },
    ],
  }, surfaceConnections)

  const brigadeConnections: AlertConnection[] = [
    { itemId: 't1_strata_brigade1', author: 'BostonDriver2026_1', type: 'comment',
      title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
      text: 'This is getting out of hand. I know the owner of that car and he\'s a good dude who works two jobs. You people are ready to ruin someone\'s life over a description that could match hundreds of green SUVs.',
      permalink: stub('t1_strata_brigade1'), classification: 'confirms', confidence: 'review',
      entities: [], reasoning: '', createdAt: minutes(90), sameAuthor: false },
    { itemId: 't1_strata_brigade3', author: 'BostonDriver2026_3', type: 'comment',
      title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
      text: 'I drive past Cambridgeside garage every day and there\'s no damaged Subaru there. That commenter is either lying or confused.',
      permalink: stub('t1_strata_brigade3'), classification: 'confirms', confidence: 'review',
      entities: [], reasoning: '', createdAt: minutes(105), sameAuthor: false },
    { itemId: 't1_strata_brigade4', author: 'BostonDriver2026_4', type: 'comment',
      title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
      text: 'Has anyone verified this story is even real? No news articles, no police confirmation, just an anonymous Reddit post.',
      permalink: stub('t1_strata_brigade4'), classification: 'confirms', confidence: 'review',
      entities: [], reasoning: '', createdAt: minutes(75), sameAuthor: false },
  ]
  await alertStore.createAlert({
    id: MOCK_BRIGADE_ALERT_ID, mode: 'flag', status: 'pending', confidence: 'high',
    connectionCount: brigadeConnections.length, createdAt: now - 2 * 60_000,
    anchorId: 't1_strata_brigade2', anchorAuthor: 'BostonDriver2026_2', anchorType: 'comment',
    anchorTitle: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    anchorText: 'Classic Reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? My neighbor has one. Are we going to harass every Subaru owner in Cambridge now?',
    anchorPermalink: stub('t1_strata_brigade2'), anchorEntities: [],
    reasoning: '4 distinct authors, 4 comments within a 2-hour window, semantic uniformity 0.62, density 1.00 — coordinated defensive messaging.',
    flagType: 'brigade',
  }, brigadeConnections)

  console.log('[dev-server] Inserted 2 mock alerts (1 surface + 1 brigade)')
}

await ensurePlantedItems()
await insertMockAlerts()

const app = new Hono()
app.use('/api/*', cors())

app.get('/api/stats', async c => {
  const itemCount = await store.getItemCount()
  return c.json({ itemCount, capacity: 330_000, seeded: '1', installed: '1' })
})

app.get('/api/viewer', async c => c.json({ isMod: true, subredditName: SUB }))

// ----- Mock backfill simulator -----

type Phase = 'idle' | 'embedding' | 'extracting' | 'entity-embedding' | 'storing' | 'done' | 'error' | 'cancelled'

type DevRecord = {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  from: string
  to: string
  startedAt: number
  endedAt: number | null
  totalItems: number
  processed: number
  initiatedBy: string
  error?: string
  costUsdEstimated?: number
}

const sim = {
  phase: 'idle' as Phase,
  totalItems: 0,
  processed: 0,
  startedAt: 0,
  endedAt: null as number | null,
  error: null as string | null,
  backfillId: null as string | null,
  timers: [] as ReturnType<typeof setTimeout>[],
  history: new Map<string, DevRecord>(),
  previews: new Map<string, { itemCount: number; from: string; to: string }>(),
}

function clearSimTimers() {
  for (const t of sim.timers) clearTimeout(t)
  sim.timers = []
}

function updateRecord(id: string, patch: Partial<DevRecord>) {
  const existing = sim.history.get(id)
  if (!existing) return
  sim.history.set(id, { ...existing, ...patch })
}

// Seed a couple of historical records so the StorageView's history list isn't empty.
{
  const now = Date.now()
  const r1: DevRecord = {
    id: 'demo-bf-1', status: 'done',
    from: '2026-03-01', to: '2026-03-14',
    startedAt: now - 14 * 86400_000, endedAt: now - 14 * 86400_000 + 11 * 60_000,
    totalItems: 1890, processed: 1890, initiatedBy: 'u/jane', costUsdEstimated: 0.18,
  }
  const r2: DevRecord = {
    id: 'demo-bf-2', status: 'error',
    from: '2026-02-01', to: '2026-02-28',
    startedAt: now - 21 * 86400_000, endedAt: now - 21 * 86400_000 + 4 * 60_000,
    totalItems: 0, processed: 0, initiatedBy: 'u/zelong',
    error: 'rate-limit exceeded', costUsdEstimated: 0.0,
  }
  sim.history.set(r1.id, r1)
  sim.history.set(r2.id, r2)
}

function startSimulatedBackfill(itemCount: number, from: string, to: string, initiatedBy: string): string {
  clearSimTimers()
  const id = `demo-bf-${Date.now().toString(36)}`
  sim.phase = 'embedding'
  sim.totalItems = itemCount
  sim.processed = 0
  sim.startedAt = Date.now()
  sim.endedAt = null
  sim.error = null
  sim.backfillId = id
  sim.history.set(id, {
    id, status: 'running', from, to,
    startedAt: sim.startedAt, endedAt: null,
    totalItems: itemCount, processed: 0,
    initiatedBy, costUsdEstimated: 0.34,
  })

  // Phase walk: 8s embedding → 8s extracting → 8s entity-embedding → 4s storing → done
  // Bump processed monotonically across all phases.
  const phases: Array<{ phase: Phase; delay: number; processedAt: number }> = [
    { phase: 'extracting', delay: 8000, processedAt: itemCount * 0.4 },
    { phase: 'entity-embedding', delay: 16000, processedAt: itemCount * 0.7 },
    { phase: 'storing', delay: 24000, processedAt: itemCount * 0.9 },
    { phase: 'done', delay: 28000, processedAt: itemCount },
  ]

  // Smooth processed updates every second.
  for (let t = 1; t <= 28; t++) {
    sim.timers.push(setTimeout(() => {
      sim.processed = Math.min(itemCount, Math.round((t / 28) * itemCount))
      updateRecord(id, { processed: sim.processed })
    }, t * 1000))
  }

  for (const step of phases) {
    sim.timers.push(setTimeout(async () => {
      sim.phase = step.phase
      sim.processed = Math.round(step.processedAt)
      if (step.phase === 'done') {
        sim.endedAt = Date.now()
        await loadSeedIntoStore()
        updateRecord(id, { status: 'done', endedAt: sim.endedAt, processed: itemCount })
      } else {
        updateRecord(id, { processed: sim.processed })
      }
    }, step.delay))
  }

  return id
}

function cancelSimulatedBackfill(): boolean {
  if (!sim.backfillId || sim.phase === 'done' || sim.phase === 'idle' || sim.phase === 'error' || sim.phase === 'cancelled') {
    return false
  }
  clearSimTimers()
  const id = sim.backfillId
  sim.phase = 'cancelled'
  sim.endedAt = Date.now()
  updateRecord(id, { status: 'cancelled', endedAt: sim.endedAt })
  return true
}

app.get('/api/ingest/status', async c => {
  return c.json({
    phase: sim.phase,
    totalItems: sim.totalItems,
    processed: sim.processed,
    startedAt: sim.startedAt,
    endedAt: sim.endedAt,
    error: sim.error,
  })
})

app.post('/api/backfill/preview', async c => {
  const { from, to } = await c.req.json<{ from: string; to: string }>()
  // Item count proportional to date range so previews feel real.
  const days = Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400_000))
  const itemCount = Math.min(5000, Math.max(50, days * 35))
  const estimatedBytes = itemCount * 2500
  const currentCount = await store.getItemCount()
  const currentBytes = currentCount * 2500
  const token = `dev-${Date.now().toString(36)}`
  sim.previews.set(token, { itemCount, from, to })
  return c.json({
    token,
    itemCount,
    estimatedMinutes: Math.max(3, Math.ceil(itemCount / 500)),
    estimatedCostUsd: Math.round(itemCount * 0.00011 * 100) / 100,
    estimatedBytes,
    currentBytes,
    capacityBytes: 500 * 1024 * 1024,
    willExceed: false,
    currentItemCount: currentCount,
    itemCapacity: 330_000,
    from,
    to,
  })
})

app.post('/api/backfill/confirm', async c => {
  const { token } = await c.req.json<{ token: string }>()
  const preview = sim.previews.get(token)
  if (!preview) return c.json({ error: 'Preview expired — generate a new estimate' }, 410)
  if (sim.phase !== 'idle' && sim.phase !== 'done' && sim.phase !== 'error' && sim.phase !== 'cancelled') {
    return c.json({ error: 'A backfill is already running' }, 409)
  }
  const id = startSimulatedBackfill(preview.itemCount, preview.from, preview.to, 'u/dev')
  sim.previews.delete(token)
  return c.json({ id, totalItems: preview.itemCount })
})

app.post('/api/backfill/cancel', async c => {
  const ok = cancelSimulatedBackfill()
  return c.json({ ok })
})

app.get('/api/backfill/history', async c => {
  const records = [...sim.history.values()].sort((a, b) => b.startedAt - a.startedAt)
  const currentCount = await store.getItemCount()
  return c.json({
    records,
    currentItemCount: currentCount,
    currentBytes: currentCount * 2500,
    itemCapacity: 330_000,
  })
})

// ----- Mock rules -----

const mockRules = [
  { id: 'rule-1', shortName: 'No doxxing', description: 'Posting personal information about other users is not allowed.', priority: 1 },
  { id: 'rule-2', shortName: 'Be civil', description: 'Personal attacks, hostility, and hate speech will be removed.', priority: 2 },
  { id: 'rule-3', shortName: 'No witch hunts', description: 'Posts identifying individuals without a police case will be removed.', priority: 3 },
  { id: 'rule-4', shortName: 'Local content only', description: 'Off-topic content unrelated to Boston will be removed.', priority: 4 },
]
let loadedRules = [...mockRules]
app.get('/api/rules', async c => c.json({ rules: loadedRules }))
app.post('/api/rules/reload', async c => {
  loadedRules = [...mockRules]
  return c.json({ count: loadedRules.length })
})

// ----- Mock danger zone -----

app.post('/api/items/delete-all', async c => {
  const before = await store.getItemCount()
  await clearAllItems()
  return c.json({ deleted: before })
})
app.post('/api/alerts/reset', async c => {
  await alertStore.resetAll()
  return c.json({ ok: true })
})

app.post('/api/strata/reset', async c => {
  const before = await store.getItemCount()
  await clearAllItems()
  await alertStore.resetAll()
  loadedRules = []
  sim.history.clear()
  scanSim.history.clear()
  clearSimTimers()
  clearScanTimers()
  sim.phase = 'idle'
  scanSim.phase = 'idle'
  return c.json({ ok: true, deleted: before })
})

// ----- Mock scan simulator -----

type ScanPhase = 'idle' | 'building' | 'classifying' | 'done' | 'error' | 'cancelled'

type ScanDevRecord = {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt: number | null
  anchorsTotal: number
  anchorsProcessed: number
  alertsCreated: number
  autoTriggered: boolean
  initiatedBy: string
  error?: string
}

const scanSim = {
  phase: 'idle' as ScanPhase,
  scanId: null as string | null,
  startedAt: 0,
  endedAt: null as number | null,
  anchorsTotal: 0,
  anchorsProcessed: 0,
  alertsCreated: 0,
  error: null as string | null,
  timers: [] as ReturnType<typeof setTimeout>[],
  history: new Map<string, ScanDevRecord>(),
}

// Seed one completed scan so history has content.
{
  const now = Date.now()
  const sr: ScanDevRecord = {
    id: 'demo-scan-1', status: 'done',
    startedAt: now - 2 * 86400_000, endedAt: now - 2 * 86400_000 + 75_000,
    anchorsTotal: 18, anchorsProcessed: 18, alertsCreated: 4,
    autoTriggered: true, initiatedBy: 'auto-scan',
  }
  scanSim.history.set(sr.id, sr)
}

function clearScanTimers() {
  for (const t of scanSim.timers) clearTimeout(t)
  scanSim.timers = []
}

function startSimulatedScan(): string {
  clearScanTimers()
  const id = `demo-scan-${Date.now().toString(36)}`
  const anchorsTotal = 20
  scanSim.phase = 'building'
  scanSim.scanId = id
  scanSim.startedAt = Date.now()
  scanSim.endedAt = null
  scanSim.anchorsTotal = 0
  scanSim.anchorsProcessed = 0
  scanSim.alertsCreated = 0
  scanSim.error = null
  scanSim.history.set(id, {
    id, status: 'running',
    startedAt: scanSim.startedAt, endedAt: null,
    anchorsTotal: 0, anchorsProcessed: 0, alertsCreated: 0,
    autoTriggered: false, initiatedBy: 'u/dev',
  })

  // Build phase: 3s. Then classifying: 4 anchors per tick, 2s per tick, until done.
  scanSim.timers.push(setTimeout(() => {
    scanSim.phase = 'classifying'
    scanSim.anchorsTotal = anchorsTotal
    const rec = scanSim.history.get(id)
    if (rec) scanSim.history.set(id, { ...rec, anchorsTotal })
    const ticks = Math.ceil(anchorsTotal / 4)
    for (let i = 1; i <= ticks; i++) {
      scanSim.timers.push(setTimeout(() => {
        scanSim.anchorsProcessed = Math.min(anchorsTotal, i * 4)
        if (Math.random() < 0.5) scanSim.alertsCreated += 1
        const r = scanSim.history.get(id)
        if (r) scanSim.history.set(id, { ...r, anchorsProcessed: scanSim.anchorsProcessed, alertsCreated: scanSim.alertsCreated })
      }, i * 2000))
    }
    scanSim.timers.push(setTimeout(() => {
      scanSim.phase = 'done'
      scanSim.endedAt = Date.now()
      scanSim.anchorsProcessed = anchorsTotal
      const r = scanSim.history.get(id)
      if (r) scanSim.history.set(id, {
        ...r, status: 'done', endedAt: scanSim.endedAt,
        anchorsProcessed: anchorsTotal, alertsCreated: scanSim.alertsCreated,
      })
    }, ticks * 2000 + 500))
  }, 3000))

  return id
}

app.get('/api/scan/status', async c => c.json({
  phase: scanSim.phase,
  scanId: scanSim.scanId,
  startedAt: scanSim.startedAt,
  endedAt: scanSim.endedAt,
  anchorsTotal: scanSim.anchorsTotal,
  anchorsProcessed: scanSim.anchorsProcessed,
  alertsCreated: scanSim.alertsCreated,
  error: scanSim.error,
}))

app.post('/api/scan/start', async c => {
  const itemCount = await store.getItemCount()
  if (itemCount === 0) return c.json({ error: 'No items to scan' }, 400)
  if (scanSim.phase === 'building' || scanSim.phase === 'classifying') {
    return c.json({ error: 'A scan is already running' }, 409)
  }
  const id = startSimulatedScan()
  return c.json({ id })
})

app.post('/api/scan/cancel', async c => {
  if (scanSim.phase !== 'building' && scanSim.phase !== 'classifying') {
    return c.json({ error: 'No active scan' }, 404)
  }
  clearScanTimers()
  scanSim.phase = 'cancelled'
  scanSim.endedAt = Date.now()
  if (scanSim.scanId) {
    const r = scanSim.history.get(scanSim.scanId)
    if (r) scanSim.history.set(scanSim.scanId, { ...r, status: 'cancelled', endedAt: scanSim.endedAt })
  }
  return c.json({ ok: true })
})

app.get('/api/scan/history', async c => {
  const records = [...scanSim.history.values()].sort((a, b) => b.startedAt - a.startedAt)
  return c.json({ records })
})

// Dev-only state controls for reviewing UI states.
app.post('/api/dev/reset-items', async c => {
  await clearAllItems()
  sim.phase = 'idle'
  sim.totalItems = 0
  sim.processed = 0
  sim.startedAt = 0
  sim.endedAt = null
  sim.backfillId = null
  clearSimTimers()
  return c.json({ ok: true })
})

app.post('/api/dev/reseed', async c => {
  await loadSeedIntoStore()
  return c.json({ ok: true })
})

app.get('/api/alerts', async c => {
  const status = c.req.query('status') as AlertStatus | undefined
  const limit = parseInt(c.req.query('limit') || '20', 10)
  const cursor = c.req.query('cursor') ? parseInt(c.req.query('cursor')!, 10) : undefined
  const result = await alertStore.listAlerts({ status, limit, cursor })
  return c.json(result)
})

app.get('/api/alerts/:id', async c => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const connections = await alertStore.getAlertConnections(id)
  connections.sort((a, b) => {
    if (a.confidence === 'high' && b.confidence !== 'high') return -1
    if (b.confidence === 'high' && a.confidence !== 'high') return 1
    return 0
  })
  const anchorItem = await store.getItem(alert.anchorId)
  const hydrated = await Promise.all(connections.map(async conn => {
    const it = await store.getItem(conn.itemId)
    return { ...conn, decision: it?.decision ?? 'pending' }
  }))
  return c.json({
    ...alert,
    connections: hydrated,
    anchorDecision: anchorItem?.decision ?? 'pending',
  })
})

app.post('/api/alerts/:id/action', async c => {
  const id = c.req.param('id')
  const { action } = await c.req.json<{ action: 'resolved' | 'dismissed' }>()
  if (action !== 'resolved' && action !== 'dismissed') return c.json({ error: 'Invalid action' }, 400)
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  await alertStore.updateAlertStatus(id, action)
  return c.json({ ok: true })
})

async function writeDevDecision(itemId: string, decision: 'removed' | 'approved'): Promise<boolean> {
  const item = await store.getItem(itemId)
  if (!item) return false
  if (item.decision === decision) return true
  const now = Date.now()
  await store.moveDecision(itemId, item.decision, decision, now)
  await store.setItem({
    ...item,
    decision,
    decisionAt: now,
    decisionBy: 'dev-mod',
    decisionReason: 'Strata brigade action (dev)',
  })
  return true
}

app.post('/api/items/:id/remove', async c => {
  const id = c.req.param('id')
  const ok = await writeDevDecision(id, 'removed')
  if (!ok) return c.json({ error: 'Not found' }, 404)
  console.log(`[dev-server] remove ${id}`)
  return c.json({ ok: true })
})

app.post('/api/items/:id/approve', async c => {
  const id = c.req.param('id')
  const ok = await writeDevDecision(id, 'approved')
  if (!ok) return c.json({ error: 'Not found' }, 404)
  console.log(`[dev-server] approve ${id}`)
  return c.json({ ok: true })
})

app.post('/api/alerts/:id/bulk-remove', async c => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const connections = await alertStore.getAlertConnections(id)
  const candidateIds = [alert.anchorId, ...connections.map(conn => conn.itemId)]
  let removed = 0
  for (const cid of candidateIds) {
    const item = await store.getItem(cid)
    if (item && item.decision !== 'pending') continue
    if (await writeDevDecision(cid, 'removed')) removed++
  }
  await alertStore.updateAlertStatus(id, 'resolved')
  console.log(`[dev-server] bulk-remove ${id}: ${removed} removed`)
  return c.json({ ok: true, removed })
})

app.post('/api/alerts/:id/bulk-lock', async c => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const anchorItem = await store.getItem(alert.anchorId)
  if (!anchorItem) return c.json({ error: 'Anchor item not found' }, 404)
  await alertStore.updateAlertStatus(id, 'resolved')
  console.log(`[dev-server] bulk-lock ${id} on thread ${anchorItem.threadRootId}`)
  return c.json({ ok: true, threadRootId: anchorItem.threadRootId })
})

app.post('/api/alerts/:id/compose', async c => {
  try {
    const id = c.req.param('id')
    const alert = await alertStore.getAlert(id)
    if (!alert) return c.json({ error: 'Not found' }, 404)
    const connections = await alertStore.getAlertConnections(id)
    const body = await c.req.json<{ refinementPrompt?: string; currentDraft?: { title: string; body: string } }>().catch(() => ({}))

    await new Promise(res => setTimeout(res, 600))

    const title = body.currentDraft && body.refinementPrompt
      ? body.currentDraft.title
      : alert.anchorTitle
        ? `Update — ${alert.anchorTitle.slice(0, 70)}`
        : 'Community update from your mod team'

    const bulletLines = connections.slice(0, 4).map(c => `- ${c.reasoning || c.text.slice(0, 120)}`)
    const draftBody = [
      body.refinementPrompt
        ? `[Refined per: "${body.refinementPrompt}"]`
        : `Hi r/${SUB}, posting an update on a situation several of you have already reached out about.`,
      '',
      alert.anchorText.slice(0, 280),
      '',
      'Here is what the community has surfaced so far:',
      ...bulletLines,
      '',
      'If you saw or heard anything related, please reach out. Thanks for looking out for each other.',
    ].join('\n')

    await alertStore.updateAlertDraft(id, {
      draftPostTitle: title,
      draftPostBody: draftBody,
      draftedAt: Date.now(),
      draftedBy: 'dev-mod',
    })

    console.log(`[dev-server] compose ${id} (refinement="${body.refinementPrompt ?? ''}")`)
    return c.json({ title, body: draftBody })
  } catch (err) {
    console.error('[dev-server] compose failed:', err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/api/alerts/:id/publish', async c => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  if (alert.publishedPostId) return c.json({ error: 'Alert already published' }, 409)

  const payload = await c.req.json<{ title: string; body: string }>().catch(() => ({} as { title?: string; body?: string }))
  if (!payload.title?.trim() || !payload.body?.trim()) {
    return c.json({ error: 'Title and body are required' }, 400)
  }

  const postId = 't3_' + Math.random().toString(36).slice(2, 10)
  const permalink = `/r/${SUB}/comments/${postId.replace(/^t3_/, '')}`
  const at = Date.now()
  const by = 'dev-mod'

  await alertStore.updateAlertPublished(id, {
    publishedPostId: postId,
    publishedPostTitle: payload.title.trim(),
    publishedPostBody: payload.body,
    publishedPostPermalink: permalink,
    publishedAt: at,
    publishedBy: by,
  })
  await alertStore.updateAlertStatus(id, 'resolved')

  console.log(`[dev-server] publish ${id} → ${postId}`)
  return c.json({ ok: true, postId, permalink, publishedAt: at, publishedBy: by })
})

let sortedItemsCache: StoredItem[] | null = null
async function getSortedItems(): Promise<StoredItem[]> {
  if (sortedItemsCache) return sortedItemsCache
  const ids = await store.getItemIds()
  const uniqueIds = [...new Set(ids)]
  const items = (await Promise.all(uniqueIds.map(id => store.getItem(id)))).filter((i): i is StoredItem => !!i)
  items.sort((a, b) => b.createdAt - a.createdAt)
  sortedItemsCache = items
  return items
}

app.get('/api/items', async c => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const cursor = c.req.query('cursor') ? parseInt(c.req.query('cursor')!, 10) : null
  const type = c.req.query('type') as 'post' | 'comment' | undefined
  const search = (c.req.query('search') || '').toLowerCase()

  const all = await getSortedItems()
  const commentsPerThread = new Map<string, number>()
  for (const i of all) {
    if (i.type === 'comment') commentsPerThread.set(i.threadRootId, (commentsPerThread.get(i.threadRootId) ?? 0) + 1)
  }
  const max = cursor !== null ? cursor : Infinity
  const filtered: StoredItem[] = []
  for (const item of all) {
    if (item.createdAt >= max) continue
    if (type && item.type !== type) continue
    if (search && !item.text.toLowerCase().includes(search) && !item.authorName.toLowerCase().includes(search)) continue
    filtered.push(item)
    if (filtered.length >= limit) break
  }
  const items = filtered.map(item => ({
    id: item.id, type: item.type, title: item.title,
    text: item.text.slice(0, 200), authorName: item.authorName,
    createdAt: item.createdAt, entityCount: item.entities.length,
    commentCount: item.type === 'post' ? (commentsPerThread.get(item.id) ?? 0) : 0,
  }))
  const nextCursor = items.length > 0 ? items[items.length - 1].createdAt : null
  const total = type ? all.filter(i => i.type === type).length : all.length
  return c.json({ items, nextCursor, total })
})

app.get('/api/clusters', async c => {
  const sort = (c.req.query('sort') as 'hot' | 'size' | 'name') || 'hot'
  const all = await getSortedItems()
  const clustersMeta = (seed as { clusters?: Array<{ id: number; label: string; size: number }> }).clusters ?? []
  const now = Date.now()
  const halfLifeMs = 24 * 60 * 60_000
  const recentWindowMs = 48 * 60 * 60_000

  const stats = new Map<number | 'orphan', { postCount: number; commentCount: number; recentCount: number; lastActivity: number; hotScore: number }>()
  const bump = (key: number | 'orphan', it: StoredItem) => {
    const cur = stats.get(key) ?? { postCount: 0, commentCount: 0, recentCount: 0, lastActivity: 0, hotScore: 0 }
    const age = now - it.createdAt
    if (it.type === 'post') cur.postCount++
    else cur.commentCount++
    if (age < recentWindowMs) cur.recentCount++
    if (it.createdAt > cur.lastActivity) cur.lastActivity = it.createdAt
    cur.hotScore += Math.exp(-age / halfLifeMs)
    stats.set(key, cur)
  }
  for (const it of all) {
    const key: number | 'orphan' = it.clusterId === undefined || it.clusterId === -1 ? 'orphan' : it.clusterId
    bump(key, it)
  }

  const empty = { postCount: 0, commentCount: 0, recentCount: 0, lastActivity: 0, hotScore: 0 }
  const rows = clustersMeta
    .map(meta => ({ id: `cluster:${meta.id}`, label: meta.label, isOrphan: false, ...(stats.get(meta.id) ?? empty) }))
    .filter(r => r.postCount + r.commentCount > 0)

  const orphanRow = { id: 'no-topic', label: 'no topic', isOrphan: true, ...(stats.get('orphan') ?? empty) }

  rows.sort((a, b) => {
    if (sort === 'size') return (b.postCount + b.commentCount) - (a.postCount + a.commentCount)
    if (sort === 'name') return a.label.localeCompare(b.label)
    return b.hotScore - a.hotScore || b.lastActivity - a.lastActivity
  })

  return c.json({ clusters: [...rows, orphanRow] })
})

app.get('/api/clusters/:id', async c => {
  const idParam = c.req.param('id')
  const all = await getSortedItems()
  const clustersMeta = (seed as { clusters?: Array<{ id: number; label: string; size: number }> }).clusters ?? []
  let posts
  let label: string
  let isOrphan: boolean
  if (idParam === 'no-topic') {
    posts = all.filter(i => i.type === 'post' && (i.clusterId === undefined || i.clusterId === -1))
    label = 'no topic'
    isOrphan = true
  } else if (idParam.startsWith('cluster:')) {
    const cid = parseInt(idParam.slice('cluster:'.length), 10)
    posts = all.filter(i => i.type === 'post' && i.clusterId === cid)
    const meta = clustersMeta.find(m => m.id === cid)
    if (!meta) return c.json({ error: 'Not found' }, 404)
    label = meta.label
    isOrphan = false
  } else {
    return c.json({ error: 'Not found' }, 404)
  }

  const commentsPerThread = new Map<string, number>()
  for (const i of all) {
    if (i.type === 'comment') commentsPerThread.set(i.threadRootId, (commentsPerThread.get(i.threadRootId) ?? 0) + 1)
  }
  const now = Date.now()
  const recentWindowMs = 48 * 60 * 60_000
  let postCount = 0, commentCount = 0, recentCount = 0, lastActivity = 0
  for (const p of posts) {
    postCount++
    const replies = commentsPerThread.get(p.id) ?? 0
    commentCount += replies
    if (now - p.createdAt < recentWindowMs) recentCount++
    if (p.createdAt > lastActivity) lastActivity = p.createdAt
  }

  const postsOut = [...posts].sort((a, b) => b.createdAt - a.createdAt).map(p => ({
    id: p.id,
    title: p.title ?? null,
    text: p.text,
    author: p.authorName,
    createdAt: p.createdAt,
    commentCount: commentsPerThread.get(p.id) ?? 0,
    permalink: `/r/${SUB}/comments/${p.id.replace(/^t3_/, '')}/`,
  }))

  return c.json({
    id: idParam,
    label,
    isOrphan,
    postCount,
    commentCount,
    recentCount,
    lastActivity,
    posts: postsOut,
  })
})

const STRING_ONLY_ENTITY_TYPES = new Set(['quantity', 'url', 'username', 'phone', 'email'])
const EMBEDDING_SIM_THRESHOLD = 0.78
const HUB_RATIO = 0.03
const MIN_HUB_COUNT = 10

app.get('/api/items/:id/entity-matches', async c => {
  const id = c.req.param('id')
  const sourceItem = await store.getItem(id)
  if (!sourceItem || !sourceItem.entities?.length) return c.json({ matchedIds: [] })

  const totalItems = await store.getItemCount()
  const hubCounts = await store.getEntityHubCounts()
  const itemsPerType = new Map<string, number>()
  for (const [key, count] of hubCounts) {
    const type = key.split(':')[0]
    itemsPerType.set(type, (itemsPerType.get(type) ?? 0) + count)
  }
  const isHub = (type: string, surface: string) => {
    const count = hubCounts.get(`${type}:${surface.toLowerCase()}`) ?? 0
    if (count < MIN_HUB_COUNT) return false
    return count / (itemsPerType.get(type) ?? 1) > HUB_RATIO
  }

  const scores = new Map<string, number>()

  for (const e of sourceItem.entities) {
    if (!e.surfaceText || isHub(e.type, e.surfaceText)) continue
    const matches = await store.getItemIdsByEntity(e.type, e.surfaceText)
    if (matches.length <= 1) continue
    const idf = Math.log(totalItems / matches.length)
    for (const matchedId of matches) {
      if (matchedId === id) continue
      scores.set(matchedId, (scores.get(matchedId) ?? 0) + idf)
    }
  }

  const queriesByType = new Map<string, Array<{ surface: string; emb: number[] }>>()
  for (const e of sourceItem.entities) {
    if (!e.surfaceText || STRING_ONLY_ENTITY_TYPES.has(e.type)) continue
    if (isHub(e.type, e.surfaceText)) continue
    const bucket = await store.getEntityEmbeddingsByType(e.type)
    const found = bucket.find(b => b.itemId === id && b.surfaceText === e.surfaceText)
    if (!found) continue
    if (!queriesByType.has(e.type)) queriesByType.set(e.type, [])
    queriesByType.get(e.type)!.push({ surface: e.surfaceText, emb: dequantize(found.embedding) })
  }

  for (const [type, queries] of queriesByType) {
    const bucket = await store.getEntityEmbeddingsByType(type)
    for (const entry of bucket) {
      if (entry.itemId === id) continue
      if (isHub(type, entry.surfaceText)) continue
      const entryEmb = dequantize(entry.embedding)
      let best = 0
      for (const q of queries) {
        const sim = cosine(q.emb, entryEmb)
        if (sim > best) best = sim
      }
      if (best < EMBEDDING_SIM_THRESHOLD) continue
      const idf = Math.log(totalItems / Math.max(1, bucket.length))
      const score = (best - EMBEDDING_SIM_THRESHOLD) * 4 * idf
      scores.set(entry.itemId, Math.max(scores.get(entry.itemId) ?? 0, score))
    }
  }

  const postScores = new Map<string, number>()
  for (const [itemId, score] of scores) {
    const it = await store.getItem(itemId)
    if (!it) continue
    const postId = it.type === 'post' ? itemId : it.threadRootId
    if (postId === id) continue
    postScores.set(postId, Math.max(postScores.get(postId) ?? 0, score))
  }

  const sorted = [...postScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  return c.json({ matchedIds: sorted.map(([pid]) => pid) })
})

app.get('/api/threads/:postId', async c => {
  const postId = c.req.param('postId')
  const post = await store.getItem(postId)
  if (!post || post.type !== 'post') return c.json({ error: 'Not found' }, 404)
  const all = await getSortedItems()
  const clustersMeta = (seed as { clusters?: Array<{ id: number; label: string; size: number }> }).clusters ?? []
  const labelById = new Map<number, string>()
  for (const c of clustersMeta) labelById.set(c.id, c.label)
  const comments = all
    .filter(i => i.type === 'comment' && i.threadRootId === postId)
    .sort((a, b) => a.createdAt - b.createdAt)
  return c.json({
    post: {
      id: post.id,
      title: post.title ?? null,
      text: post.text,
      author: post.authorName,
      createdAt: post.createdAt,
      entities: (post.entities ?? []).filter(e => e.surfaceText).map(e => ({ text: e.surfaceText, clusterId: e.type })),
      clusterLabel: post.clusterId !== undefined && post.clusterId !== -1 ? (labelById.get(post.clusterId) ?? null) : null,
      replyCount: comments.length,
      permalink: `/r/${SUB}/comments/${post.id.replace(/^t3_/, '')}/`,
    },
    comments: comments.map(c => ({
      id: c.id,
      kind: 'comment' as const,
      text: c.text,
      author: c.authorName,
      createdAt: c.createdAt,
      created_at: c.createdAt,
      thread_title: post.title ?? null,
      cluster_label: c.clusterId !== undefined && c.clusterId !== -1 ? (labelById.get(c.clusterId) ?? null) : null,
      entities: (c.entities ?? []).filter(e => e.surfaceText).map(e => ({ text: e.surfaceText, clusterId: e.type })),
    })),
  })
})

app.get('/api/graph', async c => {
  const all = await getSortedItems()
  const { alerts } = await alertStore.listAlerts({ limit: 1000 })
  const alertIncludeIds = new Set<string>()
  const threadTitleFromAlerts = new Map<string, string>()
  for (const a of alerts) {
    alertIncludeIds.add(a.anchorId)
    const conns = await alertStore.getAlertConnections(a.id)
    for (const conn of conns) {
      alertIncludeIds.add(conn.itemId)
      if (conn.type === 'comment' && conn.title) threadTitleFromAlerts.set(conn.itemId, conn.title)
    }
  }
  const clustersMeta = (seed as { clusters?: Array<{ id: number; label: string; size: number }> }).clusters ?? []
  const labelById = new Map<number, string>()
  for (const c of clustersMeta) labelById.set(c.id, c.label)
  const titleById = new Map<string, string | null>()
  for (const i of all) if (i.type === 'post') titleById.set(i.id, i.title ?? null)
  const replyCount = new Map<string, number>()
  for (const i of all) if (i.parentId) replyCount.set(i.parentId, (replyCount.get(i.parentId) ?? 0) + 1)
  const maxReplies = Math.max(1, ...replyCount.values())
  const nodes = all
    .filter(i => i.position3d && (i.type === 'post' || alertIncludeIds.has(i.id)))
    .map(i => ({
      id: i.id,
      qualname: i.id,
      symbol_name: i.title ?? i.text.slice(0, 60),
      title: i.title ?? null,
      text: i.text,
      author: i.authorName,
      created_at: i.createdAt,
      reply_count: replyCount.get(i.id) ?? 0,
      kind: i.type,
      cluster_label: i.clusterId !== undefined && i.clusterId !== -1 ? (labelById.get(i.clusterId) ?? null) : null,
      hub_score: (replyCount.get(i.id) ?? 0) / maxReplies,
      thread_root_id: i.threadRootId,
      thread_title: i.type === 'comment' ? (titleById.get(i.threadRootId) ?? threadTitleFromAlerts.get(i.id) ?? null) : null,
      parent_id: i.parentId,
      x2d: i.position3d![0],
      y2d: i.position3d![1],
      x3d: i.position3d![0],
      y3d: i.position3d![1],
      z3d: i.position3d![2],
    }))
  const meta = {
    postCount: all.filter(i => i.type === 'post').length,
    commentCount: all.filter(i => i.type === 'comment').length,
    clusterCount: clustersMeta.length,
    clusterSizeByLabel: Object.fromEntries(clustersMeta.map(c => [c.label, c.size])),
  }
  return c.json({ nodes, edges: [], meta })
})

const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null

if (!openaiClient) {
  console.warn('[dev-server] OPENAI_API_KEY not set — /api/search and /api/chat will return 503')
}

app.post('/api/search', async c => {
  if (!openaiClient) return c.json({ error: 'OPENAI_API_KEY not configured' }, 503)
  const body = await c.req.json<{ query: string; top_k?: number; time_window?: string }>()
  if (!body.query) return c.json({ error: 'query required' }, 400)
  const top_k = Math.max(1, Math.min(body.top_k ?? 8, 20))
  const cutoff = body.time_window === 'today' ? Date.now() - 86_400_000
    : body.time_window === '7d' ? Date.now() - 7 * 86_400_000
    : body.time_window === '30d' ? Date.now() - 30 * 86_400_000
    : null
  const res = await openaiClient.embeddings.create({ input: body.query, model: 'text-embedding-3-small', dimensions: 256 })
  const queryVec = res.data[0].embedding
  const all = await getSortedItems()
  const scored: Array<{ item: StoredItem; score: number }> = []
  for (const item of all) {
    if (cutoff !== null && item.createdAt < cutoff) continue
    const emb = itemEmbeddings.get(item.id)
    if (!emb) continue
    scored.push({ item, score: cosine(queryVec, emb) })
  }
  scored.sort((a, b) => b.score - a.score)
  const hits = scored.slice(0, top_k).map(({ item, score }) => ({
    id: item.id,
    kind: item.type,
    title: item.title ?? null,
    snippet: (item.text ?? '').slice(0, 200),
    cluster_label: item.clusterId !== undefined && item.clusterId !== -1 ? (clusterLabelById.get(item.clusterId) ?? null) : null,
    created_at: item.createdAt,
    score: Number(score.toFixed(4)),
  }))
  return c.json({ hits })
})

app.post('/api/graph/extra-nodes', async c => {
  const body = await c.req.json<{ ids: string[] }>()
  if (!Array.isArray(body.ids) || body.ids.length === 0) return c.json({ nodes: [] })
  const all = await getSortedItems()
  const byId = new Map(all.map(i => [i.id, i]))
  const replyCount = new Map<string, number>()
  for (const i of all) if (i.parentId) replyCount.set(i.parentId, (replyCount.get(i.parentId) ?? 0) + 1)
  const maxReplies = Math.max(1, ...replyCount.values())
  const clustersMeta = (seed.clusters ?? [])
  const labelById = new Map<number, string>()
  for (const c of clustersMeta) labelById.set(c.id, c.label)
  const titleById = new Map<string, string | null>()
  for (const i of all) if (i.type === 'post') titleById.set(i.id, i.title ?? null)
  const nodes = body.ids
    .map(id => byId.get(id))
    .filter((i): i is StoredItem => !!i && !!i.position3d)
    .map(i => ({
      id: i.id,
      qualname: i.id,
      symbol_name: i.title ?? i.text.slice(0, 60),
      title: i.title ?? null,
      text: i.text,
      author: i.authorName,
      created_at: i.createdAt,
      reply_count: replyCount.get(i.id) ?? 0,
      kind: i.type,
      cluster_label: i.clusterId !== undefined && i.clusterId !== -1 ? (labelById.get(i.clusterId) ?? null) : null,
      hub_score: (replyCount.get(i.id) ?? 0) / maxReplies,
      thread_root_id: i.threadRootId,
      thread_title: i.type === 'comment' ? (titleById.get(i.threadRootId) ?? null) : null,
      parent_id: i.parentId,
      x2d: i.position3d![0],
      y2d: i.position3d![1],
      x3d: i.position3d![0],
      y3d: i.position3d![1],
      z3d: i.position3d![2],
    }))
  return c.json({ nodes })
})

app.post('/api/chat', async c => {
  if (!openaiClient) return c.json({ error: 'OPENAI_API_KEY not configured' }, 503)
  const handler = createChatHandler({
    openai: openaiClient,
    getAllItems: () => getSortedItems(),
    getItem: (id) => store.getItem(id),
    getEmbedding: (id) => itemEmbeddings.get(id) ?? null,
    clusterLabelById,
    listAlerts: (opts) => alertStore.listAlerts(opts),
    getAlert: (id) => alertStore.getAlert(id),
    getAlertConnections: (id) => alertStore.getAlertConnections(id),
    subreddit: SUB,
  })
  return handler(c)
})

serve({ fetch: app.fetch, port: PORT })
console.log(`[dev-server] Listening on http://localhost:${PORT}`)
console.log(`[dev-server] Run 'npm run dev:client' in another terminal to start Vite`)
