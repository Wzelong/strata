// Compress dataset/seed.json into base64 gzip for embedding in the Devvit bundle.
// Run after any change to dataset/seed.json so the deployed app picks up the new seed.
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED = resolve(__dirname, 'seed.json')
const OUT = resolve(__dirname, '..', 'src', 'server', 'seed-data.ts')

const raw = readFileSync(SEED)
const gz = gzipSync(raw)
const b64 = gz.toString('base64')
writeFileSync(OUT, `export const SEED_DATA_B64 = ${JSON.stringify(b64)}\n`)

console.log(`raw seed:  ${(raw.length / 1024 / 1024).toFixed(1)} MB`)
console.log(`gzipped:   ${(gz.length / 1024 / 1024).toFixed(1)} MB`)
console.log(`base64:    ${(b64.length / 1024 / 1024).toFixed(1)} MB  -> ${OUT}`)
