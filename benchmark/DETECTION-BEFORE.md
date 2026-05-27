# Strata Detection Benchmark

- Date: 2026-05-27T03:06:09.540Z
- Corpus: 5398 items (`dataset/seed.json.gz` + planted live items)
- Trials: 10
- Probes: anchor `t3_strata_casepost`, pattern `t3_strata_flag4`, brigade `t1_strata_brigade2`

## Summary

| Check | Pass | Rate | Criterion |
| --- | --- | --- | --- |
| Surface (recall) | 10/10 | 100% | ≥3 of 4 buried witnesses retrieved AND classified RELATED |
| Surface (precision) | 10/10 | — | 0 decoys mis-classified RELATED (total decoy FPs: 0) |
| Scan | 10/10 | 100% | ≥3 of 4 buried witnesses in scan anchor groups |
| Flag · pattern | 10/10 | 100% | 'pattern' flag fires on FLAG-4 post |
| Flag · brigade | 10/10 | 100% | 'brigade' flag fires on a brigade comment |

## Surface witness survival (per channel)

Each buried witness links to the case post through a different channel. "Retrieved" = reached top-15 candidates; "Related" = also survived the classifier (not marked UNRELATED).

| Witness | Channel | Retrieved | Classified RELATED |
| --- | --- | --- | --- |
| S1 | vehicle paraphrase | 10/10 | 10/10 |
| S2 | exact case# | 10/10 | 10/10 |
| S3 | plate -K77 | 10/10 | 10/10 |
| S4 | narrative only | 10/10 | 9/10 |

## Latency (mean)

| Check | Mean ms |
| --- | --- |
| Surface | 21426 |
| Scan (pair build) | 3644 |
| Flag · pattern | 3627 |
| Flag · brigade | 1367 |

## Per-trial

| # | Surface (buried@15) | Scan (buried / signal@) | Pattern (precedents) | Brigade (authors) |
| --- | --- | --- | --- | --- |
| 1 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 2 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 3 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 4 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 5 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 6 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 7 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 8 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 9 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |
| 10 | PASS (undefined/4) | PASS (3/4 / #16) | PASS (3) | PASS (5) |

> Surface/scan/flag use real OpenAI calls; surface S4 is narrative-cosine only and is the
> hardest channel, so occasional surface misses at top-15 are expected and reported, not hidden.
