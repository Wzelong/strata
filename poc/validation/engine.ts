import OpenAI from 'openai'
import type { CostTracker } from './util.js'
import type { CorpusItem, Rule } from './schemas.js'

export type Entity = {
  type: string
  surfaceText: string
  canonical: string
  confidence: 'high' | 'medium' | 'low'
  sourceSpan: [number, number]
}

export type Item = {
  id: string
  type: 'post' | 'comment'
  text: string
  textNormalized: string
  authorId: string
  authorName: string
  createdAt: number
  threadRootId: string
  parentId: string | null
  embedding: Float32Array
  entities: Entity[]
  decision: 'pending' | 'approved' | 'removed' | 'distinguished'
  decisionAt: number | null
  decisionBy: string | null
  decisionReason: string | null
  clusterId: string | null
}

const ENTITY_EXTRACTION_SYSTEM = `You extract named entities from community safety forum text.

Entity types: person, location, time, username, url, organization, monetary_amount, quantity, phone, email, product

Canonicalization rules:
1. Always lowercase the canonical.
2. Use underscores to join multi-word canonicals (never spaces).
3. Intersections: numbered street first, format "Xth_and_street" (e.g., "5th_and_main", "3rd_and_elm").
4. Streets: "oakdale_street", "birchwood_ave", "elm_street". Include the street type suffix.
5. Phone numbers: digits and hyphens only, normalize any format to "555-0183" style.
6. URLs: domain only, lowercase, no protocol or trailing slash: "safecityclaims.net".
7. Vehicles (type=product): "brand_model" or "color_brand_model" when color is identifying: "ford_explorer", "white_honda_civic", "silver_chrysler_pacifica".
8. Partial plates (type=product): confirmed characters only, lowercase: "7m3".
9. Organizations: common abbreviation if one exists: "cpd". Otherwise lowercase with underscores: "14th_precinct".
10. People: "title_lastname" when titled: "officer_delgado", "detective_morrison". Otherwise just lowercase name.
11. Case/report numbers: type=quantity, canonical is the number string: "2024-04871".
12. If the same entity appears multiple times with wording variations, use the SAME canonical for all.

Confidence levels:
- high: explicitly and unambiguously stated
- medium: clearly referenced but slight ambiguity
- low: implied or uncertain`

const ENTITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['person', 'location', 'time', 'username', 'url', 'organization', 'monetary_amount', 'quantity', 'phone', 'email', 'product'] },
          surfaceText: { type: 'string' },
          canonical: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          sourceSpan: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        },
        required: ['type', 'surfaceText', 'canonical', 'confidence', 'sourceSpan'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities'],
  additionalProperties: false,
}

const CLASSIFICATION_STAGE1_SYSTEM = `Determine if two community forum items are meaningfully connected.

RELATED: B has a substantive connection to A — same event, same pattern, same ongoing situation, or provides useful context for investigating A.
UNRELATED: No meaningful connection despite surface similarity (shared location but different topic, coincidental entity overlap).

Rules:
- Shared location alone does NOT make items related.
- If B could plausibly help a moderator investigating A's situation, it is RELATED.
- Default to UNRELATED unless a specific substantive connection exists.`

const CLASSIFICATION_STAGE1_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    connected: { type: 'string', enum: ['RELATED', 'UNRELATED'] },
    reasoning: { type: 'string' },
  },
  required: ['connected', 'reasoning'],
  additionalProperties: false,
}

const CLASSIFICATION_STAGE2_SYSTEM = `Given two related items, classify the specific relationship of B to A.

- CONFIRMS: B corroborates the SAME event in A without adding new facts. Another eyewitness, another victim of the same scam, same story from a different angle.
- CONTRADICTS: B conflicts with A's claims.
- UPDATES: B adds NEW information advancing A's situation — new evidence, arrest, investigation progress, expansion to new area. If B contains facts NOT in A that move things forward, this is UPDATES.
- TEMPORAL: B describes PRIOR or HISTORICAL incidents providing time-based context. "This has happened before," ongoing pattern predating A, separate earlier events at same location.

Tiebreakers:
- CONFIRMS vs UPDATES: Does B add any new factual detail? New location, new evidence, arrest, sighting expansion → UPDATES. Pure corroboration of existing facts → CONFIRMS.
- UPDATES vs TEMPORAL: Same ongoing situation evolving → UPDATES. Separate historical precedent → TEMPORAL.`

const CLASSIFICATION_STAGE2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    relationship: { type: 'string', enum: ['CONFIRMS', 'CONTRADICTS', 'UPDATES', 'TEMPORAL'] },
    reasoning: { type: 'string' },
  },
  required: ['relationship', 'reasoning'],
  additionalProperties: false,
}

const RECOMMENDATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', enum: ['remove', 'approve', 'skip'] },
    rationale: { type: 'string' },
    ruleId: { type: ['string', 'null'] },
  },
  required: ['recommendation', 'rationale', 'ruleId'],
  additionalProperties: false,
}

export class StrataEngine {
  private client: OpenAI
  private cost: CostTracker
  private items = new Map<string, Item>()
  private entityIndex = new Map<string, Set<string>>()
  private decisionIndex = new Map<string, Set<string>>()

  constructor(client: OpenAI, cost: CostTracker) {
    this.client = client
    this.cost = cost
    for (const d of ['pending', 'approved', 'removed', 'distinguished']) {
      this.decisionIndex.set(d, new Set())
    }
  }

  normalize(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...')
  }

  async extractEntities(text: string, existingCanonicals?: Map<string, string[]>): Promise<Entity[]> {
    let registryContext = ''
    if (existingCanonicals && existingCanonicals.size > 0) {
      const lines: string[] = []
      for (const [type, canonicals] of existingCanonicals) {
        if (canonicals.length > 0) {
          lines.push(`${type}: ${canonicals.slice(0, 50).join(', ')}`)
        }
      }
      if (lines.length > 0) {
        registryContext = `\n\nExisting canonicals in the registry (reuse these if the entity matches, do NOT create a new canonical when one of these fits):\n${lines.join('\n')}`
      }
    }

    const response = await this.client.responses.create({
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM + registryContext },
        { role: 'user', content: text },
      ],
      text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
    })
    this.cost.track(response.usage)
    const parsed = JSON.parse(response.output_text) as { entities: Entity[] }
    return parsed.entities
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await this.client.embeddings.create({
      input: texts,
      model: 'text-embedding-3-small',
      dimensions: 256,
    })
    this.cost.track({ input_tokens: response.usage.total_tokens, output_tokens: 0 })
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(d => new Float32Array(d.embedding))
  }

  async ingestAll(corpusItems: CorpusItem[], cached?: Array<{ id: string; textNormalized: string; entities: Entity[]; embedding: number[] }>): Promise<void> {
    if (cached) {
      for (const c of cached) {
        const raw = corpusItems.find(i => i.id === c.id)!
        const item: Item = {
          ...raw,
          textNormalized: c.textNormalized,
          embedding: new Float32Array(c.embedding),
          entities: c.entities,
          decision: 'pending',
          decisionAt: null,
          decisionBy: null,
          decisionReason: null,
          clusterId: null,
        }
        this.items.set(item.id, item)
        this.indexItem(item)
      }
      return
    }

    const normalized = corpusItems.map(item => ({
      ...item,
      textNormalized: this.normalize(item.text),
    }))

    console.log('    Embedding all items...')
    const embeddings = await this.embedBatch(normalized.map(i => i.textNormalized))

    console.log('    Extracting entities pass 1 (concurrency=20)...')
    const CONCURRENCY = 20
    const entities: Entity[][] = new Array(normalized.length)

    // Pass 1: extract without registry context
    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const batch = normalized.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(item => this.extractEntities(item.textNormalized)))
      for (let j = 0; j < results.length; j++) {
        entities[i + j] = results[j]
      }
      process.stdout.write(`\r    Pass 1: ${Math.min(i + CONCURRENCY, normalized.length)}/${normalized.length}`)
    }
    console.log('')

    // Build canonical registry from pass 1 results
    const canonicalRegistry = new Map<string, string[]>()
    for (const entityList of entities) {
      for (const e of entityList) {
        if (!canonicalRegistry.has(e.type)) canonicalRegistry.set(e.type, [])
        const list = canonicalRegistry.get(e.type)!
        if (!list.includes(e.canonical)) list.push(e.canonical)
      }
    }

    // Pass 2: re-extract with registry context for consistency
    console.log('    Extracting entities pass 2 with registry (concurrency=20)...')
    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const batch = normalized.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(item => this.extractEntities(item.textNormalized, canonicalRegistry)))
      for (let j = 0; j < results.length; j++) {
        entities[i + j] = results[j]
      }
      process.stdout.write(`\r    Pass 2: ${Math.min(i + CONCURRENCY, normalized.length)}/${normalized.length}`)
    }
    console.log('')

    for (let i = 0; i < normalized.length; i++) {
      const item: Item = {
        id: normalized[i].id,
        type: normalized[i].type,
        text: normalized[i].text,
        textNormalized: normalized[i].textNormalized,
        authorId: normalized[i].authorId,
        authorName: normalized[i].authorName,
        createdAt: normalized[i].createdAt,
        threadRootId: normalized[i].threadRootId,
        parentId: normalized[i].parentId,
        embedding: embeddings[i],
        entities: entities[i],
        decision: 'pending',
        decisionAt: null,
        decisionBy: null,
        decisionReason: null,
        clusterId: null,
      }
      this.items.set(item.id, item)
      this.indexItem(item)
    }
  }

  private indexItem(item: Item) {
    for (const entity of item.entities) {
      const key = `${entity.type}:${entity.canonical}`
      if (!this.entityIndex.has(key)) this.entityIndex.set(key, new Set())
      this.entityIndex.get(key)!.add(item.id)
    }
    this.decisionIndex.get(item.decision)!.add(item.id)
  }

  cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
    return dot
  }

  searchByEmbedding(emb: Float32Array, k: number, filter?: (i: Item) => boolean): Array<{ item: Item; weight: number }> {
    const results: Array<{ item: Item; weight: number }> = []
    for (const item of this.items.values()) {
      if (filter && !filter(item)) continue
      results.push({ item, weight: this.cosine(emb, item.embedding) })
    }
    results.sort((a, b) => b.weight - a.weight)
    return results.slice(0, k)
  }

  getItemsByEntity(type: string, canonical: string): Item[] {
    const key = `${type}:${canonical}`
    const ids = this.entityIndex.get(key)
    if (!ids) return []
    return [...ids].map(id => this.items.get(id)!).filter(Boolean)
  }

  getItemsByDecision(decision: string): Item[] {
    const ids = this.decisionIndex.get(decision)
    if (!ids) return []
    return [...ids].map(id => this.items.get(id)!).filter(Boolean)
  }

  getItem(id: string): Item | undefined {
    return this.items.get(id)
  }

  getAllItems(): Item[] {
    return [...this.items.values()]
  }

  setDecision(itemId: string, decision: Item['decision'], by: string, reason: string) {
    const item = this.items.get(itemId)
    if (!item) return
    this.decisionIndex.get(item.decision)?.delete(itemId)
    item.decision = decision
    item.decisionAt = Date.now()
    item.decisionBy = by
    item.decisionReason = reason
    this.decisionIndex.get(decision)!.add(itemId)
  }

  async classifyRelationship(a: Item, b: Item): Promise<'CONFIRMS' | 'CONTRADICTS' | 'UPDATES' | 'TEMPORAL' | 'UNRELATED'> {
    const pairPrompt = `Item A (id: ${a.id}):\n"${a.text}"\n\nItem B (id: ${b.id}):\n"${b.text}"`

    // Stage 1: binary RELATED/UNRELATED
    const stage1 = await this.client.responses.create({
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: CLASSIFICATION_STAGE1_SYSTEM },
        { role: 'user', content: pairPrompt + '\n\nIs B meaningfully connected to A?' },
      ],
      text: { format: { type: 'json_schema', name: 'classification_stage1', schema: CLASSIFICATION_STAGE1_SCHEMA, strict: true } },
    })
    this.cost.track(stage1.usage)
    const s1 = JSON.parse(stage1.output_text) as { connected: string }

    if (s1.connected === 'UNRELATED') return 'UNRELATED'

    // Stage 2: classify the relationship subtype
    const stage2 = await this.client.responses.create({
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: CLASSIFICATION_STAGE2_SYSTEM },
        { role: 'user', content: pairPrompt + '\n\nThese items are confirmed to be related. What is the specific relationship of B to A?' },
      ],
      text: { format: { type: 'json_schema', name: 'classification_stage2', schema: CLASSIFICATION_STAGE2_SCHEMA, strict: true } },
    })
    this.cost.track(stage2.usage)
    const s2 = JSON.parse(stage2.output_text) as { relationship: string }
    return s2.relationship as 'CONFIRMS' | 'CONTRADICTS' | 'UPDATES' | 'TEMPORAL'
  }

  async recommendDecision(item: Item, precedents: Array<{ item: Item; weight: number }>, rules: Rule[]): Promise<{ recommendation: 'remove' | 'approve' | 'skip'; rationale: string; ruleId: string | null }> {
    const rulesText = rules.map(r => `- ${r.id}: ${r.shortName} — ${r.description}`).join('\n')
    const precedentsText = precedents.map(p =>
      `[weight: ${p.weight.toFixed(3)}] Decision: ${p.item.decision} | Rule: ${p.item.decisionReason || 'n/a'}\nText: "${p.item.text.slice(0, 200)}"`
    ).join('\n\n')

    const systemPrompt = `Given a pending item, similar precedents with their moderation decisions, and community rules, recommend a moderation action.

Actions:
- remove: Item violates a rule. You MUST specify which ruleId.
- approve: Item follows all rules and is acceptable.
- skip: Borderline or insufficient confidence.

Process:
1. Check if the item directly violates any rule (independent of precedents).
2. If similar items were removed for a rule violation and this item shows the same pattern, recommend removal citing that rule.
3. If evidence is mixed or borderline, recommend skip.

Rules:\n${rulesText}`

    const userPrompt = `## Pending Item\nID: ${item.id}\nText: "${item.text}"\n\n## Precedents (sorted by relevance)\n${precedentsText}\n\nWhat moderation action do you recommend?`

    const response = await this.client.responses.create({
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      text: { format: { type: 'json_schema', name: 'recommendation', schema: RECOMMENDATION_SCHEMA, strict: true } },
    })
    this.cost.track(response.usage)
    return JSON.parse(response.output_text) as { recommendation: 'remove' | 'approve' | 'skip'; rationale: string; ruleId: string | null }
  }

  getCacheData(): Array<{ id: string; textNormalized: string; entities: Entity[]; embedding: number[] }> {
    return [...this.items.values()].map(item => ({
      id: item.id,
      textNormalized: item.textNormalized,
      entities: item.entities,
      embedding: [...item.embedding],
    }))
  }
}
