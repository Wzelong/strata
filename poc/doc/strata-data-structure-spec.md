# Strata — Core Data Structure Specification (Locked)

## Mental model

Strata is a semantic substrate over a single subreddit's content. The substrate exposes a small set of primitive operations. Every application — precedent panel, buried connections, risk radar, standout board, Atlas — composes these primitives. The substrate is decoupled from Devvit: it runs as a pure Node.js engine against a key-value store and an embedding API, and can be tested entirely in isolation from Reddit.

Three design rules drive every decision below:

1. **One node type.** Items (posts and comments). Everything else is an attribute, a derived index, or a side table.
2. **Embeddings are coordinates, not edges.** Items have a position in semantic space. Real Reddit relationships (reply, authorship, thread membership) are the actual edges, stored as fields and queryable as indices.
3. **Provenance is mandatory.** Every extracted entity carries its source span. Every decision carries its actor and timestamp. Nothing in the structure is unauditable.

---

## Type definitions

```typescript
// =============================================================
// The node
// =============================================================

type Item = {
  // Identity
  id: string                          // Reddit thing ID, e.g. 't1_abc' or 't3_xyz'
  type: 'post' | 'comment'

  // Content (display + grounding)
  text: string                        // original surface text
  textNormalized: string              // LLM-normalized description used for embedding

  // Author (denormalized; needed for isolation testing)
  authorId: string
  authorName: string

  // Time (every temporal query)
  createdAt: number                   // unix ms; falls back to ingestion time

  // Real edges (stored as fields, queried via indices)
  threadRootId: string                // post that anchors the conversation
  parentId: string | null             // comment's parent comment (null for top-level)

  // Spatial coordinate
  embedding: Float32Array             // 256d via text-embedding-3-small

  // Structured extraction
  entities: Entity[]

  // Decision context (null until a mod acts)
  decision: 'pending' | 'approved' | 'removed' | 'distinguished'
  decisionAt: number | null
  decisionBy: string | null           // mod userId
  decisionReason: string | null       // rule id (Rule.id), only set when decision == 'removed'

  // Cluster membership (assigned by periodic HDBSCAN, may be null)
  clusterId: string | null
}

// =============================================================
// Entity (carried inside Item.entities[])
// =============================================================

type Entity = {
  type: string                        // 'person' | 'location' | 'time' | ... | custom registry types
  surfaceText: string                 // exact text from source
  canonical: string                   // normalized form (lowercase, deduped variants); the index key
  confidence: 'high' | 'medium' | 'low'
  sourceSpan: [number, number]        // [start, end] character offsets in Item.text
}

// =============================================================
// Side tables
// =============================================================

type Rule = {
  id: string                          // stable per-subreddit, e.g. 'rule_3'
  shortName: string                   // "No off-topic posts"
  description: string
  embedding: Float32Array             // 256d, same space as items (cold-start anchor)
  priority: number                    // display order
}

type ClusterSnapshot = {
  takenAt: number                     // unix ms
  clusters: Array<{
    id: string                        // unique per snapshot
    label: string                     // LLM-generated topic label
    centroidEmbedding: Float32Array   // 256d
    itemCount: number
    representativeItemIds: string[]   // 3 items closest to centroid
  }>
}

type EntityRegistry = {
  // Always present, hardcoded
  universal: string[]                 // ['person', 'location', 'time', 'username', 'url', 'organization', 'monetary_amount', 'quantity', 'phone', 'email', 'product']

  // Mod-approved custom types for this install
  custom: Array<{
    name: string
    description: string               // when to use this type
    canonicalRule: string             // instruction for normalization
    examples: string[]                // 3-5 surface text samples for few-shot
    approvedAt: number
    approvedBy: string                // mod userId
  }>

  // Awaiting mod review (proposed by runtime learning loop)
  pending: Array<{
    proposedName: string
    description: string
    sampleSurfaceText: string[]
    sampleItemIds: string[]
    proposedAt: number
    proposalSize: number              // how many items would gain this type
  }>
}
```

---

## Redis layout

All keys namespaced by `strata:`. Per-install (Devvit installs are already data-isolated, no need to namespace by subreddit).

### Primary records

```
strata:item:<itemId>                  → hash (serialized Item)
strata:rule:<ruleId>                  → hash (serialized Rule)
strata:snapshot:<yyyy-mm-dd>          → hash (serialized ClusterSnapshot)
strata:registry                       → hash (serialized EntityRegistry)
```

### Indices (sorted sets unless noted)

```
strata:items:by-time                  → score=createdAt, value=itemId
strata:items:by-decision:pending      → score=createdAt, value=itemId
strata:items:by-decision:approved     → score=decisionAt, value=itemId
strata:items:by-decision:removed      → score=decisionAt, value=itemId
strata:items:by-decision:distinguished→ score=decisionAt, value=itemId
strata:items:by-author:<authorId>     → score=createdAt, value=itemId
strata:items:by-thread:<threadRootId> → score=createdAt, value=itemId
strata:entity:<type>:<canonical>      → score=createdAt, value=itemId
strata:cases                          → score=flaggedAt, value=itemId  (mod-marked cases)
```

### Snapshots index

```
strata:snapshots                      → sorted set, score=takenAt, value=yyyy-mm-dd
```

### Storage budget at 50K items

| Component | Per-item size | Total |
|---|---|---|
| Item hash (without embedding) | ~1.5 KB | 75 MB |
| Embedding (256d float32) | ~1 KB | 50 MB |
| Entities (avg 5 per item) | ~0.5 KB | 25 MB |
| Indices (total) | ~0.3 KB | 15 MB |
| **Subtotal per item** | **~3.3 KB** | **~165 MB** |

Cluster snapshots: ~30 KB × 365 = ~11 MB/year.

Comfortably under the 500 MB Devvit Redis cap. Headroom for 100K+ items.

---

## Operation API

The substrate exposes exactly these operations. Every application is a composition of them.

```typescript
interface Strata {
  // === Ingestion ===
  ingest(raw: RawContent): Promise<Item>
    // Full pipeline: normalize → extract entities → embed → store → index → update KNN cache lazily

  recordDecision(itemId: string, decision: Decision): Promise<void>
    // Update decision context, move item between by-decision indices

  // === Retrieval primitives ===
  getItem(id: string): Promise<Item | null>

  getNeighbors(
    id: string,
    k?: number,
    opts?: {
      filterByDecision?: ('approved' | 'removed' | 'distinguished')[]
      recencyWeighted?: boolean
      maxAge?: number  // ms
    }
  ): Promise<Array<{ item: Item; weight: number }>>

  searchByEmbedding(
    embedding: Float32Array,
    k?: number,
    opts?: { /* same as getNeighbors */ }
  ): Promise<Array<{ item: Item; weight: number }>>

  // === Index-based queries ===
  getItemsByDecision(
    decision: Item['decision'],
    timeRange?: [number, number]
  ): Promise<Item[]>

  getItemsByAuthor(
    authorId: string,
    timeRange?: [number, number]
  ): Promise<Item[]>

  getItemsInTimeWindow(start: number, end: number): Promise<Item[]>

  getItemsByEntity(
    type: string,
    canonical: string,
    timeRange?: [number, number]
  ): Promise<Item[]>

  getItemsInThread(threadRootId: string): Promise<Item[]>

  // === Aggregates ===
  getClusters(snapshotDate?: string): Promise<ClusterSnapshot>

  getRules(): Promise<Rule[]>

  // === Case management ===
  flagAsCase(itemId: string): Promise<void>
  getCases(timeRange?: [number, number]): Promise<Item[]>

  // === Entity registry ===
  getEntityRegistry(): Promise<EntityRegistry>
  approveProposedType(name: string, modUserId: string): Promise<void>
  rejectProposedType(name: string): Promise<void>

  // === LLM operations (called by applications, not stored) ===
  classifyRelationship(
    a: Item,
    b: Item
  ): Promise<'CONFIRMS' | 'CONTRADICTS' | 'UPDATES' | 'TEMPORAL' | 'UNRELATED'>

  recommendDecision(
    item: Item,
    precedents: Array<{ item: Item; weight: number }>,
    rules: Rule[]
  ): Promise<{ recommendation: 'remove' | 'approve' | 'skip'; rationale: string; ruleId: string | null }>
}
```

Sixteen operations. Five are ingest/decision state mutations; eight are retrieval; three are LLM-grounded reasoning helpers.

---

## Application bindings (how the headline apps compose)

### Buried connections

```typescript
async function findBuriedConnections(caseItemId: string, window: number) {
  const caseItem = await strata.getItem(caseItemId)

  // Stage 1: entity recall
  const candidateIds = new Set<string>()
  for (const entity of caseItem.entities) {
    const items = await strata.getItemsByEntity(entity.type, entity.canonical, [Date.now() - window, Date.now()])
    items.forEach(i => candidateIds.add(i.id))
  }
  const candidates = (await Promise.all([...candidateIds].map(id => strata.getItem(id))))
    .filter(i => i.id !== caseItemId)
    .filter(i => entityOverlap(i, caseItem) >= 2)

  // Stage 2: embedding rerank
  const ranked = candidates
    .map(c => ({ item: c, weight: cosine(caseItem.embedding, c.embedding) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20)

  // Stage 3: LLM verify and classify
  const verified = await Promise.all(
    ranked.map(async ({ item }) => ({
      item,
      relationship: await strata.classifyRelationship(caseItem, item),
    }))
  )

  return verified.filter(v => v.relationship !== 'UNRELATED').slice(0, 5)
}
```

Uses: `getItem`, `getItemsByEntity`, `classifyRelationship`. Three operations, one algorithm.

### Risk radar

```typescript
async function generateRiskDigest(lookback: number) {
  const pending = await strata.getItemsByDecision('pending', [Date.now() - lookback, Date.now()])
  const risks = []
  for (const item of pending) {
    const neighbors = await strata.getNeighbors(item.id, 10, {
      filterByDecision: ['removed'],
      recencyWeighted: true,
    })
    if (neighbors.length >= 3) {
      const weightedScore = neighbors.reduce((s, n) => s + n.weight, 0)
      if (weightedScore > RISK_THRESHOLD) {
        risks.push({ item, neighbors: neighbors.slice(0, 3), weightedScore })
      }
    }
  }
  return risks.sort((a, b) => b.weightedScore - a.weightedScore).slice(0, 20)
}
```

Uses: `getItemsByDecision`, `getNeighbors`. Two operations.

### Standout board

Identical to risk radar, swap `filterByDecision: ['removed']` for `filterByDecision: ['distinguished']`. One parameter difference. Same operations.

---

## Isolation testing strategy

The substrate has no Devvit dependency. Test it as a pure module against synthetic corpora.

### Test harness layout

```
strata/
├── src/
│   ├── engine/              # the pure substrate, no Devvit imports
│   │   ├── index.ts
│   │   ├── ingest.ts
│   │   ├── embedding.ts     # OpenAI calls (mockable)
│   │   ├── entities.ts      # extraction prompts
│   │   ├── search.ts        # nearest neighbor, indices
│   │   ├── clustering.ts    # HDBSCAN wrapper
│   │   └── storage/
│   │       ├── interface.ts # KV store contract
│   │       ├── redis.ts     # production impl (Devvit Redis)
│   │       └── memory.ts    # in-memory impl (testing)
│   ├── apps/                # application compositions
│   │   ├── buried.ts
│   │   ├── risk.ts
│   │   ├── standout.ts
│   │   └── precedent.ts
│   └── devvit/              # Devvit adapter — only this folder imports @devvit/*
│       ├── triggers.ts
│       ├── menus.ts
│       └── webview.ts
└── test/
    ├── fixtures/            # synthetic corpora
    │   ├── small-sub.json   # 100 items, hand-labeled
    │   ├── scam-pattern.json
    │   └── case-thread.json
    ├── seed-llm.ts          # LLM-generated synthetic data
    └── apps/
        ├── buried.test.ts
        ├── risk.test.ts
        └── standout.test.ts
```

The engine talks to storage through a `KVStore` interface. Production binds it to Devvit Redis; tests bind it to an in-memory map. Same engine code, two backends.

### Synthetic corpus generation

Generate test data with an LLM, label it deterministically, then validate.

```typescript
// test/seed-llm.ts
async function generateSyntheticSubreddit(spec: {
  size: number
  rules: Rule[]
  scenarios: Array<'normal' | 'scam' | 'brigade' | 'case' | 'standout'>
}): Promise<{ items: RawContent[]; groundTruth: GroundTruth }> {
  // Use LLM to generate diverse comments matching the rules/scenarios.
  // Inject labeled scenarios:
  //   - 5 scammer-pattern threads (shared phone number across 3 authors)
  //   - 2 case posts with 4 buried connections each
  //   - 8 standout-quality comments
  //   - 12 rule-violating comments (3 each, 4 rules)
  //   - rest: normal content
  // Return both the items and the ground-truth labels.
}
```

### Validation tests per application

Each application has a synthetic-corpus test that asserts measurable behavior:

- **Risk radar**: feed 100 items where 12 are flagged as rule-violators, run risk radar, assert it surfaces at least 9 of the 12 in its top-20 with the correct dominant rule.
- **Standout board**: feed corpus with 8 ground-truth standout comments, assert standout board surfaces at least 6 of them.
- **Buried connections**: feed corpus with 2 case posts having 4 buried connections each, run on each case, assert 3 of 4 connections appear in top-5 results with correct relationship classification.

These tests run in seconds in CI, against a deterministic corpus, with no Reddit involvement and no API key (mock the OpenAI client or use cached fixtures).

### Demo data generation

For the live demo, generate a fixed corpus of ~500 items with all the scenarios pre-baked. Save it as a JSON fixture. On demo day, the Devvit adapter loads this fixture via a one-time menu action ("Strata: Load Demo Corpus") that simulates `onCommentSubmit` for each item. The demo flow then runs against this controlled corpus regardless of what Reddit's anti-abuse system is doing.

This is the strategy that makes the whole project ban-proof: nothing about the demo depends on real Reddit traffic, real user reports, or real mod actions. The substrate runs against simulated content the same way the production substrate would run against real content.

---

## Field-by-field justification

Every field on Item, every side table, every index, mapped to the consumer that requires it.

| Field / Index | Required by | Notes |
|---|---|---|
| `Item.id` | Everything | Primary key |
| `Item.type` | Atlas (display), thread queries | Posts vs comments handled differently in UI |
| `Item.text` | Precedent panel display, LLM grounding | Original surface text for human reading |
| `Item.textNormalized` | Embedding, LLM grounding | Stored to avoid recomputing on every query; also useful debug surface |
| `Item.authorId` | Standout (per-author aggregation), self-contradiction, brigade detection | All author-level queries |
| `Item.authorName` | Precedent panel display | Denormalized to avoid Reddit roundtrip per render |
| `Item.createdAt` | Every temporal query (risk, trend, brigade, recency-weighted neighbors) | Falls back to ingestion time if Devvit's `createdUtc` is undefined |
| `Item.threadRootId` | Brigade detection, thread context retrieval | Required for "items in this thread" queries |
| `Item.parentId` | Comment thread traversal (parent chain display) | Walking up to thread root |
| `Item.embedding` | All similarity-based applications | 256d, the spatial coordinate |
| `Item.entities` | Buried connections, scam matcher, self-contradiction | Structured extraction is the core differentiator |
| `Item.decision` | Risk radar, standout board, precedent panel, Atlas coloring | The single most-queried field |
| `Item.decisionAt` | Recency-weighted precedent, audit | When the action happened |
| `Item.decisionBy` | Mod-attribution overlay in Atlas, audit trail | Which mod acted |
| `Item.decisionReason` | Risk radar (dominant rule), precedent panel ("removed under Rule X") | Rule citation |
| `Item.clusterId` | Atlas (cluster coloring), trend digest | Updated by nightly HDBSCAN job |
| `Entity.type` | Inverted index key part | Required to scope entity matches |
| `Entity.surfaceText` | UI display ("matched on '5th and Main'") | Provenance |
| `Entity.canonical` | Inverted index value, entity matching | The matching key |
| `Entity.confidence` | UX tiering (high → auto, low → hidden) | Honest uncertainty signal |
| `Entity.sourceSpan` | Provenance display ("click to see in original text") | Auditability |
| `Rule.embedding` | Cold-start precedent matching when no decision history exists | Phase 1 confirmed rule embeddings work as anchors |
| `ClusterSnapshot` | Trend digest (today vs week-ago comparison) | Temporal cluster state |
| `EntityRegistry.custom` | Per-install taxonomy (mod-approved) | The learning loop's output |
| `EntityRegistry.pending` | Runtime learning loop's queue for mod review | Where unknowns accumulate |
| `strata:items:by-time` | Time-windowed queries (risk, trend, brigade) | `ZRANGEBYSCORE` |
| `strata:items:by-decision:*` | All decision-filtered queries | One sorted set per decision value |
| `strata:items:by-author:*` | Author history queries | Self-contradiction, standout per-author |
| `strata:items:by-thread:*` | Brigade detection, thread reconstruction | Items in one conversation |
| `strata:entity:*:*` | Entity-grounded recall (buried connections, scam matcher) | One sorted set per entity canonical |
| `strata:cases` | "Mod-flagged for tracking" list | Buried connections entry point |

Anything not listed above is not in the structure.

---

## What's NOT in the structure (and why)

- **No `score` (upvotes) on Item.** Reddit's vote count is noisy and unused by any named application. Recompute from Reddit API at display time if a future feature needs it.
- **No `reportCount` on Item.** Reports trigger application workflows but the count isn't queried.
- **No `nearestNeighbors` cache on Item.** Precomputed kNN was a design hangover from when similarity was framed as edges. Vector search at query time over 100K items is ~50ms — fast enough without cache, and cache invalidation was the worst part of the old design.
- **No User node.** Users are attributes (`authorId`, `authorName`). User-level aggregates are filters over Items.
- **No materialized "similar to" edges.** Embeddings are coordinates; similarity is computed at query time.
- **No DecisionSource field (`'strata' | 'native' | 'automod'`).** Useful for analytics, not required by any named consumer. Can derive at display time from the `onModAction` payload if needed.
- **No standalone `Modmail` or `Report` records.** Modmail is an output surface (Strata sends modmail digests), not a stored entity. Reports trigger ingestion side-effects but aren't first-class records.
- **No cross-subreddit linkage.** Devvit installs are data-isolated. Out of scope for this version.

If a future consumer requires any of these, the substrate extends deliberately, with the new field justified by that named consumer.

---

## Locked. The substrate stops moving here.

Any change to the type definitions, Redis layout, or operation API requires a written justification naming the consumer that demands it. Everything from this point — the entity extraction prompt, the LLM grounding prompt, the application compositions, the Devvit adapter, the Atlas visualization — builds on this surface unchanged.
