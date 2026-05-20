import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { embedBatch, cosine } from '../src/engine/embed.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
const seed = JSON.parse(readFileSync('./dataset/seed.json', 'utf8'))
const seedEmbById = new Map<string, number[]>(Object.entries(seed.embeddings))

const CASE = normalize(`My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop. Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out. Cambridge PD case #2026-04891.`)

const [caseEmb] = await embedBatch(client, [CASE])

const scores = [...seedEmbById.entries()].map(([id, emb]) => ({
  id, score: cosine(caseEmb, emb)
}))
scores.sort((a, b) => b.score - a.score)

const SIGNAL = new Set(['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4',
  't3_strata_flag3a', 't3_strata_flag3b', 't3_strata_flag3c', 't1_strata_flag2a'])

console.log('Top 30 from 3K seed by full-text cosine to case post:')
console.log('(These are what safety net K=30 would pull in)\n')
for (let i = 0; i < 30; i++) {
  const s = scores[i]
  const isSignal = SIGNAL.has(s.id)
  const item = seed.items.find((it: any) => it.id === s.id)
  const text = item?.text?.slice(0, 90) ?? '???'
  console.log(`${String(i+1).padStart(3)}. ${isSignal ? '★' : ' '} (${s.score.toFixed(4)}) [${s.id}] ${text}`)
}

console.log('\n\nNoise items in top-15 that classifier would need to reject:')
let noiseCount = 0
for (let i = 0; i < 15; i++) {
  const s = scores[i]
  if (!SIGNAL.has(s.id)) {
    noiseCount++
    const item = seed.items.find((it: any) => it.id === s.id)
    console.log(`  ${s.id}: "${item?.text?.slice(0, 120)}..."`)
  }
}
console.log(`\n  ${noiseCount} noise items in top-15 (classifier should mark these UNRELATED)`)
