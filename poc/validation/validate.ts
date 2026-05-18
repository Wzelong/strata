import type OpenAI from 'openai'
import type { SyntheticCorpus, CorpusItem } from './schemas.js'
import { judgeSchema } from './schemas.js'
import { JUDGE_SYSTEM, judgeUserPrompt } from './prompts.js'
import type { CostTracker } from './util.js'

export function validateStructure(corpus: SyntheticCorpus): void {
  const errors: string[] = []
  const ids = new Set<string>()
  const postIds = new Set<string>()

  for (const item of corpus.items) {
    if (ids.has(item.id)) errors.push(`Duplicate id: ${item.id}`)
    ids.add(item.id)
    if (item.type === 'post') postIds.add(item.id)
  }

  for (const item of corpus.items) {
    if (!item.id || !item.type || !item.text || !item.authorId || !item.authorName) {
      errors.push(`Missing required field on ${item.id}`)
    }
    if (typeof item.createdAt !== 'number' || item.createdAt <= 0) {
      errors.push(`Invalid createdAt on ${item.id}`)
    }
    if (!postIds.has(item.threadRootId)) {
      errors.push(`threadRootId "${item.threadRootId}" on ${item.id} does not reference a post`)
    }
    if (item.parentId !== null && !ids.has(item.parentId)) {
      errors.push(`parentId "${item.parentId}" on ${item.id} does not reference an existing item`)
    }
    if (item.text.length < 10 || item.text.length > 2000) {
      errors.push(`Text length ${item.text.length} out of range on ${item.id}`)
    }
  }

  // Ground truth references
  const gt = corpus.groundTruth
  for (const bc of gt.buriedConnections) {
    if (!ids.has(bc.caseItemId)) errors.push(`GT: caseItemId "${bc.caseItemId}" not found`)
    for (const c of bc.connections) {
      if (!ids.has(c.connectedItemId)) errors.push(`GT: connectedItemId "${c.connectedItemId}" not found`)
    }
  }
  for (const sp of gt.scamPatterns) {
    for (const id of sp.itemIds) {
      if (!ids.has(id)) errors.push(`GT: scamPattern itemId "${id}" not found`)
    }
  }
  for (const rv of gt.ruleViolations) {
    if (!ids.has(rv.itemId)) errors.push(`GT: ruleViolation itemId "${rv.itemId}" not found`)
  }
  for (const id of gt.standouts) {
    if (!ids.has(id)) errors.push(`GT: standout "${id}" not found`)
  }
  for (const id of gt.distractors) {
    if (!ids.has(id)) errors.push(`GT: distractor "${id}" not found`)
  }

  if (errors.length > 0) {
    throw new Error(`Structural validation failed:\n${errors.join('\n')}`)
  }
  console.log(`  Pass 1: structural validation OK (${corpus.items.length} items)`)
}

function quickExtractEntities(text: string): string[] {
  const entities: string[] = []
  const lower = text.toLowerCase()

  // Locations (street names, landmarks, intersections)
  const locationKeywords = ['lincoln', 'oakdale', 'birchwood', 'elm', 'oak', 'riverside', 'washington', '3rd', '4th', '2nd', '5th', '6th']
  for (const kw of locationKeywords) {
    if (lower.includes(kw)) entities.push(kw)
  }

  // Intersections (e.g. "5th and Main")
  const intersections = lower.match(/\d+(?:st|nd|rd|th)\s+(?:and|&)\s+\w+/g)
  if (intersections) entities.push(...intersections)

  // Phone numbers
  const phones = text.match(/\b\d{3}[-.]?\d{4}\b/g)
  if (phones) entities.push(...phones)

  // Named people (Officer X, Detective X, or standalone known names)
  const people = text.match(/(?:Officer|Detective|Dr\.?)\s+[A-Z]\w+/gi)
  if (people) entities.push(...people.map(p => p.toLowerCase()))
  if (lower.includes('delgado')) entities.push('delgado')
  if (lower.includes('morrison')) entities.push('morrison')

  // Vehicles (individual words too, not just multi-word)
  const vehicleKeywords = ['explorer', 'civic', 'pacifica', 'chrysler', 'ford', 'honda', 'minivan', 'suv']
  for (const vk of vehicleKeywords) {
    if (lower.includes(vk)) entities.push(vk)
  }

  // Plate fragments
  if (lower.includes('7m3')) entities.push('7m3')

  // Organizations / precincts
  if (lower.includes('cpd')) entities.push('cpd')
  if (lower.match(/14th\s*(precinct|district)?/)) entities.push('14th')

  // Time markers (specific to our cases)
  if (lower.match(/tuesday/)) entities.push('tuesday')
  if (lower.match(/thursday/)) entities.push('thursday')
  if (lower.match(/april\s*12|4\/12|the 12th/)) entities.push('april_12')
  if (lower.match(/3:15|3:30|pickup\s*hours?/)) entities.push('pickup_time')

  // Red jacket
  if (lower.includes('red') && (lower.includes('jacket') || lower.includes('puffer') || lower.includes('north face'))) {
    entities.push('red_jacket')
  }

  // Silver vehicle
  if (lower.includes('silver') && (lower.includes('van') || lower.includes('minivan') || lower.includes('vehicle') || lower.includes('pacifica'))) {
    entities.push('silver_vehicle')
  }

  // URLs
  const urls = text.match(/\b[\w-]+\.(?:net|com|org)\b/g)
  if (urls) entities.push(...urls.map(u => u.toLowerCase()))

  return [...new Set(entities)]
}

export function validateEntityOverlap(corpus: SyntheticCorpus): void {
  const errors: string[] = []
  const warnings: string[] = []
  const itemMap = new Map(corpus.items.map(i => [i.id, i]))

  // Hard items may rely on geographic proximity / semantic match rather than exact entity match
  const minOverlap: Record<string, number> = {
    'easy': 3,
    'medium': 2,
    'hard': 0,
    'very-hard': 0,
  }

  for (const bc of corpus.groundTruth.buriedConnections) {
    const caseItem = itemMap.get(bc.caseItemId)!
    const caseEntities = quickExtractEntities(caseItem.text)

    for (const conn of bc.connections) {
      const connItem = itemMap.get(conn.connectedItemId)!
      const connEntities = quickExtractEntities(connItem.text)
      const shared = caseEntities.filter(e => connEntities.some(ce => ce.includes(e) || e.includes(ce)))
      const required = minOverlap[conn.difficulty]

      if (shared.length < required) {
        errors.push(`${conn.connectedItemId} (${conn.difficulty}): found ${shared.length} shared entities, need ≥${required}. Case entities: [${caseEntities.slice(0, 5).join(', ')}], conn entities: [${connEntities.slice(0, 5).join(', ')}]`)
      }
    }
  }

  // Verify scam identifiers appear verbatim
  for (const sp of corpus.groundTruth.scamPatterns) {
    for (const id of sp.itemIds) {
      const item = itemMap.get(id)!
      if (!item.text.includes(sp.sharedEntity.canonical)) {
        errors.push(`Scam item ${id} missing verbatim identifier "${sp.sharedEntity.canonical}"`)
      }
    }
  }

  // Check distractors don't accidentally match too well
  for (const did of corpus.groundTruth.distractors) {
    const dItem = itemMap.get(did)!
    const dEntities = quickExtractEntities(dItem.text)
    for (const bc of corpus.groundTruth.buriedConnections) {
      const caseItem = itemMap.get(bc.caseItemId)!
      const caseEntities = quickExtractEntities(caseItem.text)
      const shared = caseEntities.filter(e => dEntities.some(de => de.includes(e) || e.includes(de)))
      if (shared.length >= 3) {
        warnings.push(`Distractor ${did} shares ${shared.length} entities with case ${bc.caseItemId}: [${shared.join(', ')}]`)
      }
    }
  }

  if (warnings.length > 0) {
    console.log(`  Pass 2 warnings:\n    ${warnings.join('\n    ')}`)
  }
  if (errors.length > 0) {
    throw new Error(`Entity overlap validation failed:\n${errors.join('\n')}`)
  }
  console.log(`  Pass 2: entity overlap validation OK`)
}

export type JudgeResult = {
  scores: Array<{ itemId: string; realism: number; coherence: number; onTopic: number }>
  flagged: string[]
  avgRealism: number
}

export async function runLLMJudge(
  client: OpenAI,
  corpus: SyntheticCorpus,
  costTracker: CostTracker,
  sampleSize = 35,
): Promise<JudgeResult> {
  // Sample items (skip hand-crafted — they're deterministic)
  const handCraftedIds = new Set([
    ...corpus.groundTruth.buriedConnections.map(b => b.caseItemId),
    ...corpus.groundTruth.buriedConnections.flatMap(b => b.connections.map(c => c.connectedItemId)),
  ])
  const candidates = corpus.items.filter(i => !handCraftedIds.has(i.id))
  const sampled = candidates.sort(() => 0.5 - Math.random()).slice(0, sampleSize)

  const input = sampled.map((item, i) => ({ index: i, text: item.text }))

  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: JUDGE_SYSTEM },
      { role: 'user', content: judgeUserPrompt(input) },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'judge_scores',
        schema: judgeSchema,
        strict: true,
      },
    },
  })

  costTracker.track(response.usage)
  const parsed = JSON.parse(response.output_text) as { scores: Array<{ index: number; realism: number; coherence: number; onTopic: number }> }

  const scores = parsed.scores.map(s => ({
    itemId: sampled[s.index].id,
    realism: s.realism,
    coherence: s.coherence,
    onTopic: s.onTopic,
  }))

  const avgRealism = scores.reduce((sum, s) => sum + s.realism, 0) / scores.length
  const flagged = scores.filter(s => s.realism < 2).map(s => s.itemId)

  console.log(`  Pass 3: LLM judge — avg realism: ${avgRealism.toFixed(2)}, flagged: ${flagged.length}`)

  return { scores, flagged, avgRealism }
}

export async function autoFix(
  client: OpenAI,
  corpus: SyntheticCorpus,
  flaggedIds: string[],
  costTracker: CostTracker,
): Promise<CorpusItem[]> {
  if (flaggedIds.length === 0) return corpus.items

  console.log(`  Pass 4: auto-fixing ${flaggedIds.length} items...`)
  const maxRetries = 2
  const items = [...corpus.items]

  for (const flaggedId of flaggedIds.slice(0, 20)) {
    const idx = items.findIndex(i => i.id === flaggedId)
    if (idx === -1) continue
    const original = items[idx]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await client.responses.create({
        model: 'gpt-5.4-mini',
        temperature: 0,
        input: [
          { role: 'developer', content: 'You rewrite Reddit comments to sound more natural and realistic. Preserve the core meaning and any specific details (names, numbers, locations). Output only the rewritten text.' },
          { role: 'user', content: `This comment was flagged as unrealistic. Rewrite it to sound like a genuine Reddit user wrote it:\n\n"${original.text}"` },
        ],
      })

      costTracker.track(response.usage)
      const newText = response.output_text.replace(/^["']|["']$/g, '').trim()

      if (newText.length >= 10 && newText.length <= 2000) {
        items[idx] = { ...original, text: newText }
        break
      }
    }
  }

  console.log(`  Pass 4: auto-fix complete`)
  return items
}
