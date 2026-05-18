# Strata — Validation Results

## What We Validated

Five architectural hypotheses about the LLM-driven substrate pipeline, tested against a 229-item synthetic corpus for `r/citysafety`. Pure Node.js, no Devvit — validating the intelligence layer in isolation.

| # | Hypothesis | Question | Result |
|---|---|---|---|
| H1 | Entity Canonicalization | Do independently-extracted entities produce consistent canonicals across items? | **83.8%** (≥80% target) |
| H2 | Two-Stage Retrieval | Can entity recall + embedding rerank find buried connections in top-5? | **83.3%** (≥70% target) |
| H3 | Relationship Classification | Can the LLM correctly classify how two items relate? | **95.2%** (≥85% target) |
| H4 | Cross-Item Pattern Detection | Can the system detect coordinated behavior (brigades) that no single item reveals? | **100%** (≥70% target) |
| H5 | Precedent Recommendation | Given precedents, does the LLM make the right moderation call? | **100%** (≥80% target) |

**Total API cost for a full run: ~$0.27 (with cache: $0.016)**

---

## How It Works

### Corpus

229 synthetic items for `r/citysafety` (a local incident reporting community). Generated via hybrid approach:

- **15 hand-crafted items**: 3 case posts + 12 connection items with carefully designed entity overlap gradients (easy → very-hard)
- **6 brigade items**: Coordinated pile-on from different authors targeting one user, each individually borderline-civil
- **~208 LLM-generated items**: scam reports, rule violations, standouts, distractors, neutral background

Ground truth covers: buried connections (3 cases × 4 difficulty levels), scam patterns (2 × 4 items sharing exact identifiers), rule violations (20, 4 per rule), standouts (10), distractors (8), brigade (6).

### Engine

The `StrataEngine` class implements the substrate's core pipeline:

```
Item text → Normalize (regex) → Embed (text-embedding-3-small, 256d) → Extract entities (gpt-5.4-mini) → Index
```

**Key design decisions validated:**

1. **Two-pass entity extraction with registry context** — First pass extracts all entities independently. Second pass re-extracts with established canonicals as context ("if this canonical already exists, reuse it"). This is how production works: new items arrive against an existing registry.

2. **Two-stage relationship classification** — Stage 1: binary RELATED/UNRELATED (the critical decision with 100% accuracy). Stage 2: subtype as CONFIRMS/UPDATES/TEMPORAL (informational, tolerant of edge cases). Separating these ensures recall is never hurt by subtype confusion.

3. **Brigade detection via entity co-occurrence + temporal clustering + author diversity** — Finds coordinated behavior that no per-item rule checker can detect. The signal: multiple items sharing an entity, from different authors, within a short time window.

4. **Rule-embedding proximity as free baseline signal** — Violations are 0.054 cosine points closer to their respective rule descriptions than neutral items. Not strong enough to be a standalone detector, but useful as a cheap pre-filter for batch LLM verification.

### Models Used

- **Embeddings**: `text-embedding-3-small` with `dimensions: 256`
- **LLM**: `gpt-5.4-mini` with `temperature: 0`
- **API**: OpenAI Responses API with structured output (`text.format.type: 'json_schema'`)

---

## What The Architecture Proves

### The moat: cross-item intelligence

Any hackathon team can pipe a single item through an LLM and ask "does this violate a rule?" (H5 validates this works perfectly with precedents). The differentiator is reasoning ACROSS items:

- **Buried connections** (H2): "These 5 unrelated comments across 3 threads are actually all about the same hit-and-run"
- **Scam detection** (H1): "4 posts from different people all report the same phone number"
- **Brigade detection** (H4): "6 people showed up in 2 hours to trash the same user — each comment is fine individually, together it's coordinated"

None of these are visible from any single item. They require the substrate: embeddings as coordinates, entities as inverted index keys, temporal indices, author tracking.

### Per-item LLM checking is table stakes (and cheap)

H5 at 100% confirms the LLM makes perfect moderation decisions when given:
1. The item text
2. Relevant precedents (similar past items + their decisions)
3. The community rules

At ~$0.001/item, running this on every new comment is trivially affordable. The substrate's role is providing the right precedents (H2) and detecting patterns the LLM can't see in isolation (H4).

### Entity extraction is the leverage point

H1 at 83.8% is the weakest link. Remaining failures are format inconsistencies (`birchwood` vs `birchwood_ave`, `white_sedan` vs `white_honda_civic`). The two-pass approach improved it from 71.4% → 83.8%. In production:
- The registry grows over time, reducing drift
- Format validation can reject and re-prompt malformed canonicals
- Fuzzy entity matching (as proven in H4) compensates for remaining drift

---

## File Structure

```
poc/validation/
├── corpus.json              # 229-item synthetic corpus with ground truth
├── cache.json               # Cached embeddings + entities (skip re-ingestion on re-runs)
├── engine.ts                # StrataEngine: ingest, embed, extract, search, classify, recommend
├── run-all.ts               # Orchestrator: ingest → 5 hypothesis tests → VALIDATION_REPORT.md
├── generate-corpus.ts       # Corpus generation (hybrid: hand-crafted + LLM + multi-pass validation)
├── inject-brigade.ts        # Brigade scenario injection
├── hand-crafted.ts          # 15 hand-crafted items (cases + graded connections)
├── prompts.ts               # All LLM prompts for generation
├── schemas.ts               # TypeScript types + JSON schemas
├── thread-topology.ts       # Thread structure and timestamp distribution
├── validate.ts              # Corpus validation (structural, entity overlap, LLM judge)
├── util.ts                  # OpenAI client, cost tracker, PRNG
├── tsconfig.json            # Standalone TypeScript config
└── VALIDATION_REPORT.md     # Latest test results
```

### Running

```bash
cd poc/validation
export OPENAI_API_KEY="..."

# Generate corpus (only needed once, ~$0.03)
npx tsx generate-corpus.ts
npx tsx inject-brigade.ts

# Run validation (first run ~$0.27, subsequent runs ~$0.02 with cache)
npx tsx run-all.ts
```

---

## Remaining Gaps (Known, Addressable)

| Gap | Severity | Production Fix |
|---|---|---|
| Entity format drift (`birchwood` vs `birchwood_ave`) | Low | Stricter format validation + re-prompt on rejection |
| Very-hard connections missed in retrieval (2/6) | Low | Broader embedding search window, 10 instead of 5 |
| Classification subtype confusion on edge cases | Low | Acceptable — binary RELATED/UNRELATED is perfect, subtype is display-only |
| Rule-embedding proximity signal is weak (0.054 separation) | Informational | Use as pre-filter only, LLM verification for precision |

None of these are architectural problems. They're prompt tuning and threshold calibration for production.
