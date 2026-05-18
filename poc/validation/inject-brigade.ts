import { readFileSync, writeFileSync } from 'node:fs'
import OpenAI from 'openai'
import type { SyntheticCorpus, CorpusItem } from './schemas.js'
import { createClient, CostTracker } from './util.js'

const BRIGADE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          authorName: { type: 'string' },
        },
        required: ['text', 'authorName'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

const BRIGADE_SYSTEM = `You generate realistic Reddit comments for r/citysafety that form a coordinated pile-on targeting one community member.

Rules:
1. Each comment is from a different author.
2. All comments criticize the same person (BlockCaptainLee) for their neighborhood watch organizing efforts.
3. Each comment INDIVIDUALLY does NOT clearly violate any rule — it's borderline civil, uses no slurs, makes no threats. It reads as legitimate criticism.
4. But together, the pattern is obvious: 6 people all showing up within hours to undermine the same person with similar talking points.
5. Each comment should be 2-3 sentences, casual Reddit tone.
6. Vary the angle: one questions their motives, one says they're making the neighborhood worse, one says they're power-tripping, one says their methods don't work, one implies they're doing it for attention, one suggests the community doesn't want this.
7. Each must mention "BlockCaptainLee" or "block captain" or "Lee" by name at least once.`

const BRIGADE_USER = `Generate 6 comments from different authors all targeting the user BlockCaptainLee, who recently organized a neighborhood watch patrol schedule. Each comment should seem like independent criticism but together they form a coordinated campaign to discredit this person.

The comments should reference:
- BlockCaptainLee's neighborhood watch post (they can reference "that patrol schedule post" or "Lee's watch thing")
- Specific talking points that subtly align (e.g., "making the neighborhood feel less safe", "nobody asked for this")

Make each comment feel like a standalone opinion, not obviously coordinated. A mod reading one comment sees valid criticism. A mod seeing all 6 in a 2-hour window sees a brigade.`

async function main() {
  const client = createClient()
  const cost = new CostTracker(2.00)

  const corpusPath = new URL('./corpus.json', import.meta.url)
  const corpus: SyntheticCorpus = JSON.parse(readFileSync(corpusPath, 'utf8'))

  // Check if brigade already injected
  if (corpus.groundTruth.brigadePatterns) {
    console.log('Brigade already injected. Skipping.')
    return
  }

  console.log('Generating brigade items...')
  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: BRIGADE_SYSTEM },
      { role: 'user', content: BRIGADE_USER },
    ],
    text: { format: { type: 'json_schema', name: 'brigade', schema: BRIGADE_SCHEMA, strict: true } },
  })
  cost.track(response.usage)
  const result = JSON.parse(response.output_text) as { items: Array<{ text: string; authorName: string }> }

  // Place all 6 comments in the same thread within a 2-hour window
  // Use the neighborhood watch thread (t3_post_07) as the target
  const baseTime = corpus.items.find(i => i.id === 't3_post_07')!.createdAt + 24 * 60 * 60 * 1000 // 1 day after the post
  const brigadeIds: string[] = []

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i]
    const id = `t1_brigade_${i + 1}`
    brigadeIds.push(id)
    const corpusItem: CorpusItem = {
      id,
      type: 'comment',
      text: item.text,
      authorId: `user_brigade_${item.authorName.toLowerCase().replace(/\W/g, '_')}`,
      authorName: item.authorName,
      createdAt: baseTime + i * 20 * 60 * 1000, // 20 minutes apart
      threadRootId: 't3_post_07',
      parentId: null,
    }
    corpus.items.push(corpusItem)
  }

  // Add ground truth
  ;(corpus.groundTruth as any).brigadePatterns = [{
    patternId: 'brigade_blockcaptain',
    targetEntity: { type: 'username', canonical: 'blockcaptainlee' },
    itemIds: brigadeIds,
    windowMs: 2 * 60 * 60 * 1000,
  }]

  // Sort items by createdAt
  corpus.items.sort((a, b) => a.createdAt - b.createdAt)

  writeFileSync(corpusPath, JSON.stringify(corpus, null, 2))
  console.log(`Injected ${brigadeIds.length} brigade items. ${cost.report()}`)
  console.log('Brigade IDs:', brigadeIds.join(', '))

  // Invalidate cache
  const cachePath = new URL('./cache.json', import.meta.url)
  try { writeFileSync(cachePath, '{}') } catch {}
  console.log('Cache invalidated.')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
