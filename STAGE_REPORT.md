# Strata — Stage Report

## Status: Production Pipeline E2E Validated

Full pipeline running on Devvit: Ingest (OpenAI Batch API) → Scan (parallel classify) → Alerts persisted. Real-time trigger also wired. Tested E2E on r/strata_hackathon_dev.

---

## What Strata Is

One engine. Two modes.

- **Surface** — when something important happens, find everything the community already knows but hasn't connected
- **Flag** — when something looks wrong, catch what's slipping past current tools

---

## Production Flow

```
Mod installs app → Sets OpenAI API key → Clicks "Ingest"
  → Picks date range → Sees estimate → Confirms
  → Batch API processes items in background (~3 min for 10 items, ~60 min for 97K)
  → Mod clicks "Scan" → Bipartite entity graph → Parallel classify → Alerts created

New post arrives → onPostSubmit trigger
  → Embed + extract → Hybrid retrieve → Classify → Alert created (real-time, ~7s)
```

---

## Architecture

```
REAL-TIME (per post, ~7s):
  Post → Normalize → PARALLEL(Embed, Extract) → Embed entities
    → PARALLEL(Entity filter, Safety net) → RRF rerank
    → TOP 15 → Classify (gpt-5.5) → Drop UNRELATED → Create Alert

INGEST (bulk, Batch API, 50% cheaper):
  Date range → Fetch from Reddit API → Build JSONL
    → Submit embedding batch + extraction batch (parallel)
    → Poll every 2 min → Download results
    → Submit entity embedding batch → Store all to Redis

SCAN (backfill, parallel):
  Build entity→items map (strong types only, 2-5 items per entity)
    → Rank anchors by IDF score → Group connections per anchor
    → Classify 4 anchor groups in parallel per tick
    → Create alerts (one alert per anchor, multiple connections)
```

---

## Key Design Decisions

| Decision | Why |
|---|---|
| **Hybrid retrieval** | Entity filter finds shared details across different topics. Safety net catches narrative witnesses. Neither alone is sufficient. |
| **Dual entity matching** | String match for identifiers (#2026-04891). Embedding match for descriptions ("dark green Subaru"). |
| **RRF reranking** | Fuses two ranking spaces without tuning parameters. Both-path items get boosted. |
| **LLM-assigned confidence** | Classifier returns "high" or "review" per connection. Better than any deterministic formula — it sees both texts. |
| **Alert persistence** | Redis-backed alerts with connections. Mod reviews, resolves, or dismisses. Full text stored (survives post deletion). |
| **Batch API for ingest** | 50% cost reduction, separate rate limit pool, no timeout issues. Scheduler polls every 2 min. |
| **Parallel scan** | 4 anchor groups classified simultaneously per scheduler tick. 10 anchors done in 2-3 ticks. |
| **Strong-type entity filter for scan** | Only object, person, quantity, username, phone, email, url. Locations/orgs excluded — they cause noise. |
| **Selective extraction prompt** | Physical descriptions extracted even with qualifiers ("possibly", "looked like"). Combined into one entity, not split. 100% stability on vehicle extraction (10/10 runs). |
| **Int8 quantized embeddings** | 12.5x storage reduction, zero quality loss. 330K item capacity in 500MB Redis. |

---

## Alert System

```
strata:alerts                       zSet (score=createdAt, member=alertId)
strata:alert:{id}                   hash (mode, status, confidence, anchor info)
strata:alert:{id}:connections       hash (itemId → JSON connection)
```

**Connection fields**: author, text, permalink, classification, confidence, entities[], reasoning

**API**:
- `GET /api/alerts` — paginated list, filterable by status
- `GET /api/alerts/:id` — full detail with connections
- `POST /api/alerts/:id/action` — resolve or dismiss

**Confidence**: LLM-assigned at classification time.
- `high`: specific shared details, act immediately
- `review`: circumstantial, look closer

---

## Validation Results

### Hybrid Retrieval (5/5 passed)

```
C1 (All 4 signals in hybrid top-10): PASS — ranks 2, 3, 4, 7
C2 (Entity-only misses signal):      PASS — earwitness missed, proving safety net needed
C3 (Safety net catches earwitness):   PASS — found at rank 3
C4 (Hybrid < 15% of corpus):         PASS — 40 candidates = 1.3%
C5 (Worst-cases found):              PASS — 4/4 edge cases caught
```

### Extraction Stability (10/10)

```
Vehicle entity extracted: 100% (10/10 runs)
Case number extracted:    100%
Avg entities per item:    5.9
```

### Classification Confidence (3/3 stable)

```
Near-miss cyclist:  high (CONFIRMS/TEMPORAL)
Dashcam + case#:    high (UPDATES)
Garage neighbor:    review (UPDATES)
Earwitness:         high (CONFIRMS)
Noise:              UNRELATED (dropped)
```

### Batch API E2E (validated)

```
5 items: embedding + extraction + entity embedding = 129s total
All items stored with 256-dim embeddings + entities + quantized entity embeddings
```

### Scan E2E (validated on Devvit)

```
10 ingested items → 7 anchor groups → 2 ticks (4 parallel) → 2 alerts created
Strong-type filter eliminated noise (down from 8 to 2 alerts)
```

---

## Cost & Latency

| Operation | Cost | Time |
|---|---|---|
| Real-time per post | ~$0.002 | ~7s |
| Ingest 1K items (Batch API) | ~$0.11 | ~5 min |
| Ingest 97K items (Batch API) | ~$10.57 | ~60 min |
| Scan 10 anchors | ~$0.07 | ~20s |

---

## Storage

| Metric | Value |
|---|---|
| Per item | ~1.5KB |
| Capacity (500MB Redis) | ~330K items |
| Per alert | ~12KB |

---

## Mod UX (Menu Actions)

| Button | What it does |
|---|---|
| **Strata: Ingest** | Date range → estimate → confirm → Batch API processes in background |
| **Strata: Scan** | Bipartite entity scan → parallel classify → alerts created |
| **Strata: Surface** | Find connections to a specific post/comment |
| **Strata: Seed Demo Data** | Load pre-computed 3K items (dev/testing) |

---

## What's Next

1. Build web view dashboard (alerts list + detail + ingest progress)
2. Record demo video
3. Deploy to r/strata_hackathon
4. Write submission (tool overview, community impact, project description)
