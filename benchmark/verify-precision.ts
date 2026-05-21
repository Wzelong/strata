import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cosine } from '../src/engine/embed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))

const cpObj = seed.entityEmbeddings['t3_strata_casepost'].find((e: any) => e.type === 'object')
const s1Obj = seed.entityEmbeddings['t1_strata_surface1'].find((e: any) => e.surfaceText === 'dark green Subaru Outback')

const sim = cosine(cpObj.embedding, s1Obj.embedding)
console.log('Case post object:', cpObj.surfaceText.slice(0, 50))
console.log('Surface1 object:', s1Obj.surfaceText)
console.log('Cosine (full precision):', sim.toFixed(4))
console.log('Passes 0.70?', sim >= 0.70)
console.log('Passes 0.75?', sim >= 0.75)

const storagePerEntity = JSON.stringify(cpObj.embedding).length
console.log('\nStorage per entity embedding:', storagePerEntity, 'bytes (~' + Math.round(storagePerEntity / 1024 * 100) / 100 + 'KB)')
console.log('Total for 16K entities: ~' + Math.round(16692 * storagePerEntity / 1024 / 1024) + 'MB')
