import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { MemoryKVStore } from './src/engine/storage/memory.js'
import { MemoryAlertStore } from './src/engine/storage/memory-alert-store.js'
import { cosine, dequantize } from './src/engine/embed.js'
import type { StoredItem, Alert, AlertConnection, AlertStatus } from './src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = resolve(__dirname, 'dataset/seed.json')
const PORT = 4173
const SUB = 'strata_local_dev'

const store = new MemoryKVStore()
const alertStore = new MemoryAlertStore()

console.log('[dev-server] Loading seed.json...')
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
  items: StoredItem[]
  entityEmbeddings?: Record<string, Record<string, string>>
}
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
  console.log(`[dev-server] Loaded entity embeddings for ${byItem.size} items`)
}
console.log(`[dev-server] Loaded ${seed.items.length} items into memory store`)

const stub = (id: string) => `https://reddit.com/r/${SUB}/comments/${id.replace(/^t[13]_/, '')}`
const alertId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

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

  const flag2aPos = await positionOf('t1_strata_flag2a')
  const flag2bBase = flag2aPos ?? [0, 0, 0]
  planted.push({
    id: 't1_strata_flag2b', type: 'comment',
    title: undefined,
    text: 'I live near Cambridgeside and my roommate was home with me Tuesday night. He doesn\'t even drive to work anymore, he takes the Green Line.',
    author: 'TKfromCambridge', createdAt: Date.now() - 3 * 60_000,
    threadRootId: 't3_strata_casepost', parentId: 't3_strata_casepost', position: jitter(flag2bBase),
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

  planted.push({
    id: 't3_mock_rule_violation', type: 'post',
    title: 'PSA about that person from the neighborhood meeting',
    text: 'That jerk from the neighborhood meeting is Sarah Johnson, 45 Maple Dr unit 2A, Cambridge MA 02139. Her cell is 617-555-0199.',
    author: 'AngryAtNeighborhood', createdAt: Date.now() - 4 * 60_000,
    threadRootId: 't3_mock_rule_violation', parentId: null, position: [casePos[0] + 4, casePos[1] + 4, casePos[2] + 4],
  })

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
    id: alertId(), mode: 'surface', status: 'pending', confidence: 'high',
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

  const patternConnections: AlertConnection[] = [
    { itemId: 't3_strata_flag3a', author: 'BeaconStWatcher', type: 'post',
      title: 'PSA: silver Honda running reds on Beacon St',
      text: 'I don\'t have the plate but someone needs to stop this guy before he kills someone.',
      permalink: stub('t3_strata_flag3a'), classification: 'confirms', confidence: 'high',
      entities: [], reasoning: 'Similarity to removed item', createdAt: days(14), sameAuthor: false },
    { itemId: 't3_strata_flag3b', author: 'CambStConcerned', type: 'post',
      title: 'Suspicious white pickup on Cambridge St every night',
      text: 'There\'s a white pickup that parks illegally on Cambridge St every night and I\'m pretty sure the driver is dealing.',
      permalink: stub('t3_strata_flag3b'), classification: 'confirms', confidence: 'high',
      entities: [], reasoning: 'Similarity to removed item', createdAt: days(21), sameAuthor: false },
    { itemId: 't3_strata_flag3c', author: 'AllstonAlert88', type: 'post',
      title: 'Blue minivan circling my block in Allston — casing?',
      text: 'I\'ve seen it 4 days in a row now just slowly driving past. This has to be casing houses right?',
      permalink: stub('t3_strata_flag3c'), classification: 'confirms', confidence: 'high',
      entities: [], reasoning: 'Similarity to removed item', createdAt: days(10), sameAuthor: false },
  ]
  await alertStore.createAlert({
    id: alertId(), mode: 'flag', status: 'pending', confidence: 'review',
    connectionCount: patternConnections.length, createdAt: now - 60_000,
    anchorId: 't3_strata_flag4', anchorAuthor: 'MassAveSafety', anchorType: 'post',
    anchorTitle: 'WARNING: dark green SUV running reds on Mass Ave near Central',
    anchorText: 'There\'s a dark green SUV that\'s been seen blowing through red lights on Mass Ave near Central multiple times. I\'ve personally witnessed it twice. Someone is going to get seriously hurt. Can the mods pin this?',
    anchorPermalink: stub('t3_strata_flag4'), anchorEntities: [],
    reasoning: 'Matches pattern of previously removed witch-hunt posts (vague vehicle description, no plate, no police case, asking the community to identify a driver).',
    flagType: 'pattern',
  }, patternConnections)

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
    id: alertId(), mode: 'flag', status: 'pending', confidence: 'high',
    connectionCount: brigadeConnections.length, createdAt: now - 2 * 60_000,
    anchorId: 't1_strata_brigade2', anchorAuthor: 'BostonDriver2026_2', anchorType: 'comment',
    anchorTitle: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    anchorText: 'Classic Reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? My neighbor has one. Are we going to harass every Subaru owner in Cambridge now?',
    anchorPermalink: stub('t1_strata_brigade2'), anchorEntities: [],
    reasoning: '4 distinct authors, 4 comments within a 2-hour window, semantic uniformity 0.62, density 1.00 — coordinated defensive messaging.',
    flagType: 'brigade',
  }, brigadeConnections)

  const contradictionConnections: AlertConnection[] = [
    { itemId: 't1_strata_flag2a', author: 'TKfromCambridge', type: 'comment',
      title: 'Best bars near Lechmere?',
      text: 'I live right above the Cambridgeside garage — can vouch for Night Shift. My roommate and I always hit it Tuesdays after his shift ends around 7. He drives, I drink, nobody gets a DUI lol. We park P3, always plenty of space evenings.',
      permalink: stub('t1_strata_flag2a'), classification: 'contradicts', confidence: 'high', entities: [],
      reasoning: 'Prior post by same author (April 25): says roommate drives every Tuesday and they park at P3 Cambridgeside.',
      createdAt: days(14), sameAuthor: true },
  ]
  await alertStore.createAlert({
    id: alertId(), mode: 'flag', status: 'pending', confidence: 'high',
    connectionCount: contradictionConnections.length, createdAt: now - 3 * 60_000,
    anchorId: 't1_strata_flag2b', anchorAuthor: 'TKfromCambridge', anchorType: 'comment',
    anchorTitle: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    anchorText: 'I live near Cambridgeside and my roommate was home with me Tuesday night. He doesn\'t even drive to work anymore, he takes the Green Line.',
    anchorPermalink: stub('t1_strata_flag2b'), anchorEntities: [],
    reasoning: 'Same author (TKfromCambridge) posted contradictory statement on 2026-04-25: previously said roommate drives Tuesdays + parks P3 Cambridgeside; now claims roommate doesn\'t drive and was home Tuesday.',
    flagType: 'contradiction',
  }, contradictionConnections)

  await alertStore.createAlert({
    id: alertId(), mode: 'flag', status: 'pending', confidence: 'high',
    connectionCount: 0, createdAt: now - 4 * 60_000,
    anchorId: 't3_mock_rule_violation', anchorAuthor: 'AngryAtNeighborhood', anchorType: 'post',
    anchorTitle: 'PSA about that person from the neighborhood meeting',
    anchorText: 'That jerk from the neighborhood meeting is Sarah Johnson, 45 Maple Dr unit 2A, Cambridge MA 02139. Her cell is 617-555-0199. Somebody should give her a piece of their mind about what she said.',
    anchorPermalink: stub('t3_mock_rule_violation'), anchorEntities: [],
    reasoning: 'Violates rule-1 (No doxxing): post shares a private individual\'s full name, home address, and phone number. Also rule-3 (Be civil): hostile framing inviting retaliation.',
    flagType: 'rule',
  }, [])

  console.log('[dev-server] Inserted 5 mock alerts (1 surface + 4 flag types)')
}

await ensurePlantedItems()
await insertMockAlerts()

const app = new Hono()
app.use('/api/*', cors())

app.get('/api/stats', async c => {
  const itemCount = await store.getItemCount()
  return c.json({ itemCount, capacity: 330_000, seeded: '1', installed: '1' })
})

app.get('/api/viewer', async c => c.json({ isMod: true }))

app.get('/api/ingest/status', async c => c.json({ phase: 'idle' }))

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
  return c.json({ ...alert, connections })
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

serve({ fetch: app.fetch, port: PORT })
console.log(`[dev-server] Listening on http://localhost:${PORT}`)
console.log(`[dev-server] Run 'npm run dev:client' in another terminal to start Vite`)
