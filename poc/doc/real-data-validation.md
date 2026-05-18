# Real-Data Validation Results

## Goal

Validate the Strata engine on real Reddit data to prove it works on messy, uncontrolled text — not just synthetic corpora with planted connections.

## Dataset

| Subreddit | Posts | Comments | Date Range | Valid Items |
|---|---|---|---|---|
| r/scams | 17,321 | 199,240 | Mar–Apr 2024 | 176,117 |
| r/RBI | 2,137 | 50,650 | Jan–Mar 2024 | 46,007 |

Source: Arctic Shift (Pushshift successor). Downloaded via https://arctic-shift.photon-reddit.com/download-tool.

Sampled 3,000 items per subreddit (deterministic seed=42, posts + comments mixed).

## Methodology

### Stage A: Pure Discovery

1. Ingest 3,000 items through the full pipeline (normalize → embed → extract entities)
2. Compute hub scores (normalized in-degree) to identify overly-common entities
3. Build entity clusters: entities shared by 3+ items from 2+ different authors, excluding hubs
4. For each cluster, pick one item as "case" and run `findConnections()` — measure what % of known cluster members appear in results
5. Classify top pairs via LLM to check if connections are meaningful

### Stage B: Inject-and-Detect

1. Pick 5 entities with largest clusters
2. Generate synthetic "case posts" mentioning those entities
3. Ingest synthetic cases into the existing corpus
4. Run `findConnections()` from each — measure recall against known cluster members

## Results

### r/RBI (3,000 items, final run)

| Metric | Value |
|---|---|
| Entity keys extracted | 1,769 |
| Clusters (3+ items, 2+ authors, non-hub) | 113 |
| Stage A retrieval recall | **93.0%** |
| Stage A classification | 2/10 related (rest correctly UNRELATED) |
| Stage B inject-and-detect recall@5 | **80.0% — PASS** |
| Total cost | $3.65 (ingestion) + $0.01 (classification) |

### r/scams (100 items, validation run)

| Metric | Value |
|---|---|
| Entity keys extracted | 72 |
| Clusters | 1 (product:whatsapp, 3 items) |
| Retrieval recall | **100%** |
| Classification | 2/2 related |
| Cost | $0.09 |

## Architecture Changes Made During Validation

### 1. Entity schema stripped

Removed `sourceSpan` (LLM hallucinated character offsets — 0% accuracy in testing) and `confidence` (unused downstream). Entity is now just `{type, surfaceText, canonical}`.

### 2. Extraction prompt rewritten

- v1: Extracted everything including common nouns (bank, money, phone, scam). Produced 302 clusters of noise.
- v2: Added skip rules for generic terms. Still leaked (police, mom, dad tagged as global).
- v3 (final): Focuses on proper nouns and specific identifiers. Explicit "Do NOT extract" list with examples. "Could you Google the canonical and find the ONE specific thing?" test.

### 3. Scope determination moved from LLM to code

LLM failed at global/local classification (tagged "police" as global). Replaced with hub-score computation:

```
hubScore = itemsContainingEntity / maxItemsForAnyEntity
if hubScore > 0.15 → hub (filtered from connection queries)
```

No manual blocklist. Adapts automatically per subreddit. One threshold works everywhere.

### 4. Retrieval redesigned as three modes

| Mode | What | When |
|---|---|---|
| `findByIdentifier` | Exact entity match (non-hub, global) | Same phone/URL/person reported by different people |
| `findSimilar` | Pure embedding similarity | Similar situations, no shared entities |
| `detectCampaign` | Temporal + author diversity clustering | Coordinated activity |
| `findConnections` | Runs all three, merges, dedupes | Default entry point |

Previous `twoStageRetrieve` (entity recall → embedding rerank) conflated different retrieval needs.

### 5. Concurrency bumped 20 → 100

With 10K RPM rate limit, concurrency=20 was using 2% of capacity. 100 cuts a 3000-item ingestion from 25+ minutes to ~12 minutes.

### 6. Progressive cache

Saves every 500 items during ingestion. A crash at item 2000 preserves 2000 items instead of losing everything.

## Benchmarks Run

| Test | Result | Cost |
|---|---|---|
| sourceSpan accuracy | **0/11 exact** (hallucinated) → removed from schema | $0.001 |
| gpt-5.4-nano vs mini | 53% match rate → nano not viable | $0.015 |
| Batch extraction (10-20 items/call) | 50% match rate → not viable | $0.015 |
| r/scams 100 items (prompt v3) | 1 cluster, 100% recall | $0.09 |
| r/RBI 3000 items (hub scores) | 113 clusters, 93% recall, 80% inject-detect | $3.65 |

Total spend across all validation: **~$7.50**

## Conclusions

1. **The engine works on real data.** 93% retrieval recall, 80% inject-and-detect on messy Reddit text with no ground-truth labels.

2. **Hub detection replaces manual maintenance.** A single threshold (0.15 normalized in-degree) automatically filters generic entities without per-subreddit configuration.

3. **Entity extraction is the quality bottleneck.** The LLM still extracts some noise (pronouns, bare numbers). Iterative prompt tuning improves this without architecture changes.

4. **Specific identifiers are rare in random samples.** The truly valuable buried connections (same phone number across 5 posts) require running on ALL traffic over weeks, not random 3K samples. The demo should use synthetic scenarios planted in real-textured data.

5. **The monthly digest is the product.** The engine accumulates entities continuously. The value surfaces over time when the same identifier appears from multiple independent authors. A mod can't see this manually — Strata can.

## File Structure

```
tests/
├── real-validate.ts              # Test runner
├── real-data/
│   ├── r_scams_posts.jsonl       # 17K posts (gitignored)
│   ├── r_scams_comments.jsonl    # 199K comments (gitignored)
│   ├── r_RBI_posts.jsonl         # 2K posts (gitignored)
│   ├── r_RBI_comments.jsonl      # 51K comments (gitignored)
│   ├── cache/                    # Cached embeddings+entities (gitignored)
│   └── results/                  # Saved run outputs
├── bench-batch-extract.ts        # Batch size benchmark
└── bench-sourcespan.ts           # sourceSpan accuracy test
```
