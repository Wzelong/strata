import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIVE_ITEMS, SURFACE_IDS } from '../dataset/signal-items.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))
const LIVE = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-live-items.json'), 'utf8'))
const liveMap = new Map(LIVE.items.map((i: any) => [i.id, i]))

const casePost = SEED.items.find((i: any) => i.id === 't3_strata_casepost')
console.log('=== CASE POST entities ===')
console.log('Text:', casePost.text.slice(0, 120) + '...')
for (const e of casePost.entities) console.log('  ' + e.type + ': ' + e.surfaceText)

console.log('')

for (const raw of LIVE_ITEMS) {
  if (!SURFACE_IDS.has(raw.id)) continue
  const live = liveMap.get(raw.id)
  if (!live) continue
  console.log('=== ' + raw.id + ' (' + raw.authorName + ') ===')
  console.log('  Text: ' + raw.text.slice(0, 120) + '...')
  console.log('  Entities:')
  for (const e of live.entities) console.log('    ' + e.type + ': ' + e.surfaceText)
  console.log('')
}
