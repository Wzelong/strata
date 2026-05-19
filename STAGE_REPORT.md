# Strata — Stage Report

## Status: E2E Demo Working

Post the case post on r/strata_hackathon_dev → trigger fires → engine finds 4 buried connections from 3,011 items → modmail delivered to mod inbox. Full pipeline runs on Devvit.

---

## What Strata Is

One engine. Two modes.

- **Surface** — when something important happens, find everything the community already knows but hasn't connected
- **Flag** — when something looks wrong, catch what's slipping past current tools

---

## The Demo Story

A cyclist is hit on Mass Ave in Cambridge. Driver flees. Her roommate posts desperately on r/boston.

What nobody knows: **4 strangers already posted about this car** over the past 3 weeks — buried in completely unrelated threads. A near-miss pedestrian. A dashcam owner with footage. A garage neighbor who sees the damaged car every morning. An earwitness who heard the crash.

Strata surfaces all 4 in one modmail, seconds after the case post appears.

---

## Architecture

```
Post arrives → onPostSubmit trigger
  → Fetch full post text via Reddit API
  → engine.ingest(): normalize → embed (256-dim) → extract entities
  → engine.findSimilar(): cosine scan all 3K stored embeddings → top 15
  → engine.classifyBatch(): one gpt-5.5 call classifies all candidates
  → Filter UNRELATED → send modmail with connections
```

### Key Design Decisions

| Decision | Why |
|---|---|
| **Embedding is primary retrieval** | Entity canonical matching is brittle ("dark green SUV" ≠ "dark_green_subaru_outback"). Embedding finds all 4 fragments regardless of wording. |
| **Batch classification (gpt-5.5, reasoning:low)** | One LLM call classifies all candidates together. Faster (7s vs 20s), cheaper ($0.001 vs $0.01), better reasoning (sees all candidates in context). |
| **256-dim embeddings** | Higher dims make scores WORSE for this use case. 256-dim compresses the space and pushes related items closer. Validated empirically. |
| **Embedded seed data (gzip+base64 in server bundle)** | Devvit blocks `raw.githubusercontent.com` fetch despite allowlist. Solution: compress 16MB → 4.6MB base64, embed in CJS bundle. Decompresses at runtime. |
| **hScan pagination for embeddings** | `hGetAll` on 8MB hash exceeds Devvit's 5MB response limit. `hScan` with count=500 paginates safely. |

### Classification Prompt

```
Classify each candidate's relationship to the case post.

Relationships:
- CONFIRMS: Corroborates the same event from a different angle
- UPDATES: Adds new facts, evidence, or leads about the same situation
- TEMPORAL: Describes a prior incident that establishes a pattern
- CONTRADICTS: Conflicts with claims in the case post
- UNRELATED: No meaningful connection

Two items are connected when they share a specific identifier — the same person,
vehicle, phone number, address, username, or physical description. Shared location
or topic alone is not enough; shared specific details are.

A moderator investigating the case post would find a connected item useful as
evidence, context, or a lead. That is the test.
```

---

## Validation Results

### Full Dataset Test (3,011 items, 8 hypotheses)

```
H1 (All 4 surface items in top 10):       PASS ✓
H2 (Signals rank above noise):            PASS ✓
H3 (Surface items classified as related):  PASS ✓
H4 (Noise classified as unrelated):        PASS ✓
H5 (2+ removed items found for precedent): PASS ✓
H6 (Precedent similarity > 0.6):           PASS ✓
H7 (Brigade detected):                    PASS ✓
H8 (Contradiction detected):              PASS ✓

8/8 passed. Cost: $0.01.
```

### Live E2E Test (Devvit, r/strata_hackathon_dev)

```
Post case post → trigger fires → 4 connections found:
1. UPDATES (0.683) — DashcamDave_617: has dashcam footage
2. CONFIRMS (0.672) — InmanSq_Walker: heard the crash, found the bike
3. TEMPORAL (0.671) — ThursdayCommuter: almost hit by same car weeks earlier
4. UPDATES (0.582) — CambridgeSide_Resident: sees damaged car in garage daily

Modmail delivered. All noise correctly filtered as UNRELATED.
```

### Batch Classification Test (gpt-5.5 vs gpt-5.4-mini)

```
gpt-5.4-mini: 8/8 correct, 5.8s, $0.0013
gpt-5.5:     8/8 correct, 7.9s, $0.0009 (tighter reasoning, fewer tokens)
```

---

## Dataset

- **Source**: r/boston April 1 – May 17, 2026 (3,700 posts + 93,080 comments)
- **Sampled**: 3,000 items (deterministic seed)
- **Planted**: 8 backfill signal items + 3 marked as removed
- **Total seed**: 3,011 items, 15.7MB
- **Live items**: 7 (case post + brigade + contradiction + pattern match)

---

## Cost Summary

| Operation | Cost |
|---|---|
| Boston 3K ingestion | $3.79 |
| Signal items processing | $0.02 |
| Full validation (8 hypotheses) | $0.01 |
| Architecture tests | $0.05 |
| Live E2E (per trigger) | ~$0.01 |
| **Total development spend** | **~$3.88** |

---

## Known Issues

1. **Author shows as "undefined" in modmail** — trigger payload field name mismatch. Cosmetic fix needed.
2. **Seed takes ~30s on first load** — decompresses 4.6MB + writes 3K items to Redis. One-time cost.
3. **No custom panel UI yet** — results shown via modmail only. React iframe panel is next.

---

## What's Next

1. Fix author name in trigger payload
2. Build React panel UI (iframe custom post) showing connections visually
3. Implement Flag mode (brigade detection, contradiction, precedent match) in triggers
4. Record 1-minute demo video
5. Write submission post
6. Deploy to r/strata_hackathon (public, for judges to test)
