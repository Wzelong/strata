# Benchmark Report — 10K Corpus

10 trials of the full Strata pipeline on **10,044 r/boston items** (10K real + 34 planted per `dataset/DESIGN.md`). Five pipeline checks per trial: 50/50 pass (**100%**).

```
============================================================
 STABILITY SUMMARY (10 trials on 10,044 items)
============================================================
  surface               10/10
  scan                  10/10
  flag contradiction    10/10
  flag pattern          10/10
  flag brigade          10/10

  Total                 50/50 (100%)
```

Across runs we have seen occasional contradiction misses (LLM returning `CONSISTENT` instead of `CONTRADICTS` for the bar-rec vs case-thread pair). Empirically ~9-10 out of 10 with the focused `classifyContradictions` prompt. Other pipelines are fully deterministic across trials.

---

## What each check verifies

### Surface — buried-witness retrieval

For the case post `t3_strata_casepost`, return the top-15 candidates and count how many of the 4 buried witnesses (SURFACE-1..4) appear.

| Pass criterion | Result | Per-trial |
|---|---|---|
| `buried_recall@15 >= 3/4` | 10/10 | S1, S2, S3 always; S4 never |

**SURFACE-4 is honestly missing**: the pure-narrative earwitness (no shared entity with case post, single weak `Central` location) sits at text-cosine rank ~150+ on the 10K corpus where r/boston has many comparably-similar safety posts. Surface() degrades gracefully — finds 3 of 4 channels reliably. See the recall curve below.

### Scan — system-wide buried-connection discovery

Without a query, scan returns up to 30 anchor groups by clustering shared entities and merging via connected components. The signal cluster anchored on `brigade2` consistently contains casepost + S1 + S2 + S3.

| Pass criterion | Result | Per-trial |
|---|---|---|
| `buried_recall (any anchor group) >= 3/4` | 10/10 | 3/4 every trial |
| Signal cluster found in returned anchors | 10/10 | rank #12 every trial |

The signal cluster ranks #12 not #1 because r/boston naturally has larger topic clusters (Orange Line, transit) which beat it on `threadCount`. The downstream LLM classifier rejects those topic clusters during alert creation, so it's a cosmetic ranking issue, not a correctness one.

### Flag — three independent hypothesis tests

| Check | Trigger item | Detection | Pass rate |
|---|---|---|---|
| Contradiction | `flag2b` | refs `flag2a` (TKfromCambridge's prior post) | 10/10 |
| Pattern match | `flag4` | matches `flag3a/b/c` removed precedents | 10/10 |
| Brigade | `brigade2` | 6 distinct authors in 4h window, cosine >= 0.45 | 10/10 |

---

## Plots

### `recall-precision.png` — how many items must a mod review

![](recall-precision.png)

Recall climbs to 0.5 by K=3 (S1 + S2 at #2-3), then to 0.75 by K=11 when S3 surfaces. S4 never enters top-25 (narrative-only, no entity scaffolding). Precision drops as more results add r/boston background.

### `retrieval.png` — what the mod actually sees in top-40

![](retrieval.png)

Surface ranking: `flag4` (pattern-match alert) ranks #1, then `S1 near-miss` and `S2 case#` at #2-3, `S3 garage -K77` at #11. `D2 bike case#` decoy ranks #5 (shares Cambridge PD organization). `D1 cat` and `flag3b` cluster around rank #27-28.

### `confusion.png` — GPT-5.5 classifier on the top-15

![](confusion.png)

Of the 3 buried witnesses that made the top-15, all 3 were classified as RELATED. Of the 12 noise items (r/boston background + 1 decoy that snuck in), 11 correctly classified UNRELATED. One false positive — acceptable on this scale.

### `channels.png` — design verification

![](channels.png)

Each row is one planted item; each column is one of the 4 design channels. The pattern verifies the design intent:

- **S1 near-miss**: matches Vehicle (1.0) + Narrative (0.61) — primary + secondary
- **S2 case#**: only Case# (1.0) — pure identifier channel
- **S3 garage**: Vehicle (1.0) + Plate (1.0) + Narrative (0.61) — three channels
- **S4 earwitness**: only Narrative (0.51) — pure-narrative case
- **D1 cat**: Vehicle (0.95) only — paraphrase attack on one channel
- **D2 bike case#**: Case# 0.50 (< 0.90 threshold) — fuzzy ID correctly rejected
- **D3 CharlieCard**: Vehicle 0.07 — head-noun rule worked, `K77 series` doesn't match `-K77`
- **D4 Davis crash**: only Narrative 0.38 — low cosine, gets ignored

---

## Latency

```
Pipeline             Min     Median  P95     Max
surface               322    423     558     558
scan                 9327   9517    9947    9947
flag contradiction   2468   6582   15764   15764
flag pattern         1124   1289    1853    1853
flag brigade         1073   1360    3895    3895
                                                  (all values in ms)
```

- **Surface ~0.4s** — one OpenAI embedding call + vector math, no chat.
- **Scan ~9.5s** — pure algorithmic on 10K items (loading entity embeddings + connected components + narrative satellites + 4-signal RRF). No LLM in the inner loop.
- **Flag** runs the 4 checks in parallel; wall-clock is the slowest one. Contradiction is the tail (one chat call, gpt-5.5 with reasoning).

---

## Cost

```
Per ingestion (text embed + entity extract + entity batch embed):  ~$0.0005
Per surface() call (1 embedding):                                  ~$0.00001
Per scan() (no LLM):                                                $0
Per flag() (up to 3 chat calls in parallel):                       ~$0.005
Server post-surface (classifyBatch over top-15):                   ~$0.003
                                                          ---------------
Total per new item: less than $0.01.
```

10-trial benchmark run cost: **~$0.35** in OpenAI calls.

---

## Honest limits

- **SURFACE-4 doesn't surface on 10K.** Pure-narrative earwitness with no entity scaffolding. The text-cosine safety-net path can't discriminate it from r/boston safety-post background at cosine ~0.5. By design, not a bug. The pitch should call this out: *"3 of 4 witnesses found; the earwitness who heard but didn't see is genuinely hard."*
- **Signal cluster ranks #12 in scan**, not #1. Topic chains beat it on `threadCount`. The LLM classifier in production drops topic clusters when no relationships are confirmed, so this doesn't produce false alerts — just a cosmetic ranking issue.
- **Contradiction has tail-latency variance** (2.5-16s). Empirically ~9-10 of 10 detect rate with the focused `classifyContradictions` prompt; before the focused prompt it was 1/10. Rare misses return `CONSISTENT` instead of `CONTRADICTS` for the bar-rec vs case-thread pair.

---

## How to reproduce

```bash
# rebuild benchmark seed (one-time, ~$5, ~20 min)
SEED_LIMIT=10000 SEED_OUTPUT=benchmark/benchmark-seed.json \
LIVE_OUTPUT=benchmark/benchmark-live-items.json npm run seed

# run 10-trial stability + plots (~10 min, ~$0.35)
TRIALS=10 npx tsx benchmark/stability-10x.ts
python3 benchmark/viz.py
```
