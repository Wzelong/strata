# Strata — Hypothesis Validation Prompt

## Context

I have an existing Devvit POC at `poc/` that validated platform primitives (embed, store, search, custom posts, triggers) for a moderation app called **Strata**. The findings are in `poc/FINDINGS.md`.

Now I'm validating the **architectural hypotheses** before committing to the full build. The hypotheses are about the quality of the LLM-driven pipeline (entity extraction, retrieval, classification, recommendation) — not about platform mechanics. So this validation runs in **pure Node.js with no Devvit dependency**, against synthetic data, in an isolated subdirectory.

You are building a validation harness, not the product. Output is a markdown report stating pass/fail per hypothesis with metrics.

## Working directory

Create and work inside `poc/validation/`. Do not modify anything outside this folder. The existing Devvit POC code stays untouched.

## Stack and dependencies

- Node.js (same version as the existing POC)
- TypeScript
- `openai` npm package (Claude Code already has this from the POC; reuse the dependency)
- No Devvit, no Redis. Use an in-memory `Map<string, Item>` as the store.
- Set `OPENAI_API_KEY` from environment (instruct me to set it before running).

## Models (do not substitute)

- Embeddings: `text-embedding-3-small` with `dimensions: 256`
- LLM (normalization, extraction, classification, recommendation): `gpt-5.4-mini`
- These are the models the production substrate will use. Validation must use the same.

---

## Phase 1 — Build the synthetic corpus

Create `poc/validation/corpus.json` containing ~200 items with ground-truth labels.

**Theme of the synthetic subreddit:** call it `r/citysafety` — a community where people report local incidents, ask for help identifying suspects/missing items, and discuss safety. This theme cleanly supports all the scenarios we need to test.

### Subreddit rules (5 rules)

Define these rules in the corpus:

1. **No personal information** — no full names, addresses, license plates, or contact info of private individuals.
2. **No vigilantism** — don't encourage finding/confronting alleged perpetrators.
3. **Stay on topic** — must relate to city safety.
4. **No misinformation** — claims should be sourced or qualified.
5. **Be civil** — no harassment or hostile language.

### Scenarios to plant

**A. Buried connections (3 cases × 4 planted connections = 12 connection-items + 3 case posts):**

For each case, write one parent "case post" describing a situation (e.g., "Looking for info about an incident near 5th and Main last Saturday"). Then write 4 separate comments scattered across other unrelated threads in the corpus, each containing partial information that connects to the case. Vary the surface form deliberately:
- Connection 1: shares 3+ entities with the case post, clear connection (easy)
- Connection 2: shares 2 entities, plausible connection (medium)
- Connection 3: shares 2 entities, weak/ambiguous connection (hard)
- Connection 4: shares 1 entity + semantic similarity, edge case (very hard)

Also include 5-10 **distractor items** that share single entities with case posts but aren't related (e.g., a comment also mentioning "5th and Main" but about a coffee shop, not the incident).

**B. Scam pattern (2 patterns × 4 items each = 8 items):**

For each pattern, write 4 separate comments from different authors in different threads, all reporting (in different words) the same scammer using the same exact identifier — one pattern shares a phone number, the other shares a URL. The identifier should appear verbatim in all 4. These items also stay coherent as standalone Reddit comments.

**C. Rule violations (20 items, 4 per rule, across rules 1-5):**

Write 4 items per rule that clearly violate that rule. Examples:
- Rule 1 violation: a comment naming a specific person and listing their home address.
- Rule 5 violation: a comment with hostile/insulting language toward another user.

Each violation item gets ground-truth labels: `{ violatesRule: 'rule_1' | ... | 'rule_5' }`.

**D. Standout comments (10 items):**

Write 10 high-quality, on-topic, substantive comments that a mod would want to recognize. These are items where someone provided helpful information, made a thoughtful argument, or contributed expertise.

**E. Background neutral content (~150 items):**

Generate the rest as realistic neutral activity: questions, discussions, casual comments, helpful but not standout-quality replies, mixed in across different threads. Make 8-12 thread roots (posts) with comments threaded under each.

### Ground-truth schema for `corpus.json`

```typescript
type SyntheticCorpus = {
  subredditName: 'citysafety'
  rules: Array<{ id: string; shortName: string; description: string; priority: number }>
  items: Array<{
    id: string                        // synthetic id, e.g. 't1_001'
    type: 'post' | 'comment'
    text: string
    authorId: string                  // synthetic user id
    authorName: string
    createdAt: number                 // unix ms, span the corpus over ~30 days
    threadRootId: string              // for comments, references a 'post' id
    parentId: string | null
  }>
  groundTruth: {
    buriedConnections: Array<{
      caseItemId: string
      connections: Array<{
        connectedItemId: string
        difficulty: 'easy' | 'medium' | 'hard' | 'very-hard'
        expectedRelationship: 'CONFIRMS' | 'UPDATES' | 'TEMPORAL'
      }>
    }>
    scamPatterns: Array<{
      patternId: string
      sharedEntity: { type: string; canonical: string }
      itemIds: string[]
    }>
    ruleViolations: Array<{
      itemId: string
      violatesRule: string             // rule id
    }>
    standouts: string[]                // item ids
    distractors: string[]              // item ids that look related but aren't
  }
}
```

### How to generate the corpus

Write `poc/validation/generate-corpus.ts`. It should:
- Use `gpt-5.4-mini` with structured output mode to generate batches of items per scenario.
- Use a fixed random seed so reruns produce identical corpora.
- For each scenario, generate items with explicit ground-truth labels embedded in the prompt's response.
- Assemble all batches into the final `corpus.json` with consistent ids and timestamps.
- Validate the corpus shape against the schema before writing.

Run it once. Output goes to `poc/validation/corpus.json`. Estimated cost: ~$2-3 total. If cost projection exceeds $5, pause and ask.

---

## Phase 2 — Build the substrate engine in isolation

Create `poc/validation/engine.ts` exposing these functions (no Devvit imports anywhere):

```typescript
interface Engine {
  normalize(text: string, contextText?: string): Promise<string>
  extractEntities(normalized: string, registry: EntityRegistry): Promise<Entity[]>
  embed(text: string): Promise<Float32Array>
  ingest(rawItem: RawItem): Promise<Item>       // does all the above + indexes in memory

  cosine(a: Float32Array, b: Float32Array): number
  searchByEmbedding(emb: Float32Array, k: number, filter?: (i: Item) => boolean): Array<{ item: Item; weight: number }>
  getItemsByEntity(type: string, canonical: string): Item[]
  getItemsByDecision(decision: string): Item[]
  
  classifyRelationship(a: Item, b: Item): Promise<'CONFIRMS' | 'CONTRADICTS' | 'UPDATES' | 'TEMPORAL' | 'UNRELATED'>
  recommendDecision(item: Item, precedents: Array<{ item: Item; weight: number }>, rules: Rule[]): Promise<{
    recommendation: 'remove' | 'approve' | 'skip'
    rationale: string
    ruleId: string | null
  }>
}
```

Implement entity extraction using the universal types: `person`, `location`, `time`, `username`, `url`, `organization`, `monetary_amount`, `quantity`, `phone`, `email`, `product`. Use structured output mode for `gpt-5.4-mini` so the entity array shape is guaranteed.

The extraction prompt is the highest-leverage code in this validation. Spend time on it. Make canonicalization rules explicit in the prompt (e.g., for location: "lowercase, strip articles, normalize 'and' between street names").

Store ingested items in an in-memory `Map<string, Item>` plus separate `Map<string, Set<string>>` for the entity inverted indices and decision indices. No Redis.

---

## Phase 3 — Run each hypothesis test

Create one test file per hypothesis. Each one ingests the corpus once (or shares an ingested store), then runs the specific evaluation.

### `hypothesis-1.test.ts` — Entity canonicalization consistency

For each pair of items in the ground-truth `scamPatterns` (4 items per pattern, all should share the canonical scammer entity):
- Extract entities from each item independently.
- Check whether all 4 items produce the same canonical for the planted shared entity.

Also do the same for buried-connection pairs that ground-truth says share specific entities.

**Metric:** % of intentionally-shared entities that produce matching canonicals across items.
**Pass threshold:** ≥80%.
**Diagnostic on fail:** list the surface forms that failed to canonicalize together; this informs prompt iteration.

### `hypothesis-2.test.ts` — Two-stage retrieval recall@5

For each case post in the ground-truth `buriedConnections`:
- Run the two-stage algorithm (entity recall → embedding rerank), return top-5.
- Check what fraction of ground-truth connections appear in the top-5.

**Metric:** recall@5, averaged across all cases, broken down by difficulty (easy/medium/hard/very-hard).
**Pass threshold:** ≥70% recall@5 overall. Reasonable to expect easy=≥95%, hard=≥50%, very-hard=≥30%.
**Diagnostic on fail:** list missed connections + which stage failed (entity recall missed it, or embedding rerank pushed it out of top-5).

### `hypothesis-3.test.ts` — Relationship classification accuracy

Build a labeled pair set: take all ground-truth (caseItemId, connectedItemId) pairs with their `expectedRelationship`, plus the planted distractor pairs which should classify as `UNRELATED`.

For each pair, call `classifyRelationship` and compare to ground truth.

**Metric:** classification accuracy + confusion matrix.
**Pass threshold:** ≥85% accuracy. UNRELATED precision is especially important — false positives kill trust.
**Diagnostic on fail:** show confusion matrix, list misclassifications, propose prompt fixes.

### `hypothesis-4.test.ts` — Risk radar recall@20

Use `ruleViolations` as ground truth. Among the corpus, treat all violation items as "should be flagged."

For the algorithm: for each item, count its top-10 nearest neighbors (filtered by ground-truth-removed items — note: we need to seed some removed items first; do this by treating 50% of ground-truth violations as "already removed" and running the radar to find the other 50%).

**Metric:** what fraction of the held-out 50% of violations appear in the top-20 risk-ranked items.
**Pass threshold:** recall@20 ≥ 0.70 of held-out violations.
**Diagnostic on fail:** list missed violations + their actual nearest neighbors to understand why they didn't cluster correctly.

### `hypothesis-5.test.ts` — Precedent recommendation agreement

For each ground-truth violation item:
- Seed the corpus with the OTHER violations of the same rule marked as `removed` (with `decisionReason: <ruleId>`).
- Run `recommendDecision` on the held-out item.
- Compare: does it recommend `remove` with the correct ruleId?

Also test on standout items: seed previous standouts as `distinguished`, run on held-out standouts, check if they get a positive recommendation.

Also test on neutral items: should recommend `approve` or `skip`.

**Metric:** % of items where the recommendation matches ground truth (correct action + correct rule citation when applicable).
**Pass threshold:** ≥80% agreement.
**Diagnostic on fail:** show miscalibrated cases, especially where the model recommended the wrong rule.

---

## Phase 4 — Produce the validation report

Create `poc/validation/run-all.ts` that runs every hypothesis test sequentially and writes `poc/validation/VALIDATION_REPORT.md` in this format:

```markdown
# Strata Validation Report

## Summary
[1-paragraph verdict: are all five hypotheses passing? Which fail? Severity.]

## Corpus
- Generated: <timestamp>
- Total items: N
- Planted scenarios: <counts of each type>

## Hypothesis Results

### H1 — Entity canonicalization consistency
- **Status**: PASS / FAIL
- **Metric**: X% of shared entities canonicalized identically
- **Threshold**: 80%
- **Diagnostic** (if FAIL): [list of surface forms that diverged]

### H2 — Two-stage retrieval recall@5
- **Status**: PASS / FAIL
- **Overall recall@5**: X%
- **By difficulty**: easy=X% medium=X% hard=X% very-hard=X%
- **Threshold**: 70% overall
- **Diagnostic** (if FAIL): [missed connections, which stage caused the miss]

### H3 — Relationship classification accuracy
- **Status**: PASS / FAIL
- **Accuracy**: X%
- **Confusion matrix**: [5x5 table]
- **Threshold**: 85%
- **Diagnostic** (if FAIL): [misclassification patterns]

### H4 — Risk radar recall@20
- **Status**: PASS / FAIL
- **Recall@20**: X%
- **Threshold**: 70%
- **Diagnostic** (if FAIL): [missed violations and why]

### H5 — Recommendation agreement
- **Status**: PASS / FAIL
- **Agreement**: X% (action correct), X% (action + rule correct)
- **Threshold**: 80%
- **Diagnostic** (if FAIL): [common miscalibrations]

## Total cost
- OpenAI usage: <approximate $>

## Recommendations
[For each failed hypothesis: what prompt or algorithmic change would most likely fix it, ordered by leverage]
```

---

## Constraints and behavior

- Spend the most time on the entity extraction prompt — it's the leverage point for H1 and downstream effects on H2, H3, H4.
- All tests must be deterministic given the same corpus. Use `temperature: 0` for all `gpt-5.4-mini` calls.
- Cache LLM calls during a single run so re-runs of failing tests don't re-burn budget on items that succeeded.
- If total OpenAI cost projection exceeds $10, pause and ask me before continuing.
- Don't refactor across hypotheses. Each test file can be self-contained. Sprawling code is fine here.
- Don't write Devvit code. Don't import `@devvit/*` anywhere.

## Stop and ask if

- The corpus generator produces obviously bad items (incoherent, repetitive, off-theme) — flag before running all tests against it.
- An entire hypothesis fails catastrophically (≤30% of threshold) — pause so we can discuss whether to iterate the prompt or rethink the architecture.
- You're tempted to make a "small" change to the architecture or schema to make a test pass — don't; the architecture is locked, the prompts are the only thing to tune.

## Completion criteria

1. `poc/validation/corpus.json` exists with the full planted-scenario structure.
2. `poc/validation/engine.ts` runs end-to-end on the corpus.
3. All five hypothesis tests run successfully (regardless of pass/fail outcome).
4. `poc/validation/VALIDATION_REPORT.md` contains all five hypotheses with metrics, diagnostics, and recommendations.
5. Final chat message: a one-paragraph summary of which hypotheses pass and which need work, plus the single most impactful prompt change to make next.

This is a validation pass, not a production build. Speed and clarity over polish.
