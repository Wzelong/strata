# Scan Pipeline — Current State & Next Steps

## What works

- **Surface pipeline**: When a new post arrives, `surface()` uses text embedding similarity + entity embedding matching (hybridRetrieve with RRF fusion) to find the top-15 related items, then GPT-5.5 classifies them. This reliably finds our planted signal items (100% recall, 91% noise rejection). ~15s per post.

- **Text embedding clustering**: LSH + union-find on full 256d text embeddings at threshold 0.65 correctly groups the case post with 3 signal items and 0 noise items in a clean 4-item cluster. Runs in ~3s for 10K items.

- **Entity extraction prompt (improved)**: Rewrote `src/engine/prompts.ts` to be much stricter. Now correctly returns empty arrays for generic posts ("IPAs", "a red shirt", "rent") while keeping specific identifiers ("dark green Subaru Outback", "#2026-04891", "@keepeastieclean"). Not yet tested at scale.

## What doesn't work

- **Scan's entity-only clustering**: The current `buildScanPairs()` tries to cluster items by entity similarity alone. This fails because:
  1. Entity embeddings for short strings can't distinguish "same entity, different words" from "different entity, similar topic" (e.g., "green Subaru" chains to "green line" at 0.70 cosine)
  2. Location entities dominate in a geo-focused subreddit (5,504 of 16,692 total) and are useless for linking
  3. The old extraction prompt produced too many generic entities, drowning real signal in noise

- **Scan ranking**: Even when the signal cluster forms, it ranks #24 out of 540 clusters because entity overlap scoring rewards raw count (transit clusters with 129 shared entity strings outrank our case with 4 shared entities)

## Root causes identified

1. **Extraction quality**: GPT-5.4-mini was extracting generic nouns ("IPAs", "the T", "apartment", "rent") that match thousands of posts. The seed dataset has 16,692 entities — most are noise. Fixed the prompt but the seed data is still generated with the old prompt.

2. **Quantization is fine**: Int8 scalar quantization was NOT the problem. The actual full-precision similarity between "dark green SUV, possibly a Subaru..." and "dark green Subaru Outback" is 0.742 — same as quantized. The 0.82 from early testing was a different embedding call (isolated vs batched). Quantization stays.

3. **Entity embeddings can't do identity matching for all types**: Tested empirically:
   - `object`, `organization`: embedding matching works (0.82 same vs 0.57 different)
   - `location`: doesn't work (0.65 same-city different-place vs 0.72 same-place)
   - `quantity`: doesn't work (0.96 between different case numbers!)
   - `url`, `username`, `phone`, `email`: string matching is sufficient and correct

4. **Single-linkage chaining**: Union-find with a threshold creates transitive chains. "dark green Subaru" → "green Subaru" → "green SUV" → "green line" → "Red line" merges unrelated clusters through shared tokens in embedding space.

## Proposed architecture (not yet implemented)

**Pipeline: text clustering → entity ranking → GPT-5.5 classification**

1. **Cluster on full text embeddings** (LSH + union-find, threshold 0.65)
   - Already proven to find signal cluster correctly (4 items, 0 noise)
   - 3s for 10K items, scales with LSH
   - Skip clusters > 50 items (mega-blob filter)

2. **Rank clusters** by signals that indicate "worth investigating":
   - Cross-thread ratio (items from different threads = suspicious)
   - Shared specific entities (using the improved extraction)
   - Author diversity
   - Cluster tightness (avg pairwise similarity)

3. **Top-K clusters → GPT-5.5** for final classification

## Key blocking issue

The seed dataset (`benchmark/benchmark-seed.json`) was generated with the OLD extraction prompt. All the entity data is garbage (16K generic entities). To properly test the new pipeline, need to either:
- Regenerate the seed with the new prompt (~$5-10 API cost, ~30min)
- Or test ranking using text-clustering-only (without entity ranking) to validate the architecture first

## Files changed this session

- `src/engine/scan.ts` — rewritten multiple times, current state: LSH+union-find with entity blocking + text confirmation
- `src/engine/prompts.ts` — extraction prompt significantly improved
- `src/engine/classify.ts` — reverted to original (GPT-5.5, top-15, classify all)
- `benchmark/benchmark.ts` — added API latency measurement, entity embedding loading
- `benchmark/benchmark-viz.py` — removed latency chart, fixed text overlays, 200 DPI
- `benchmark/BENCHMARK-REPORT.md` — rewritten with real measured data
- `benchmark/build-entity-embeddings.ts` — generates entity embeddings for seed
- `benchmark/cluster-*.ts` — experimental scripts testing clustering approaches
- `benchmark/scan-explore.ts` — runs scan + GPT-5.5 classification on results
- `benchmark/test-extraction*.ts` — tests extraction prompt quality

## Numbers to remember

- Dataset: 10,015 items, 256d embeddings, 16,692 entities (old prompt)
- Surface: 100% signal recall, 91% noise accuracy, 15s classify latency
- Text clustering at 0.65: 539 clusters, signal at rank #24 (with naive scoring)
- Text clustering at 0.64: signal cluster = 4 items, 0 noise, perfectly clean
- LSH speedup: 14-21x over brute force
- Entity embedding threshold: 0.70 works for object/org after dequantize (0.742 for our case)
- GPT-5.5 classify: 15s for 15 items, $0.015/call
- GPT-5.4-mini extract: 1.4s per item
