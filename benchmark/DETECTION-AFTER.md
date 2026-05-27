# Strata Detection Benchmark

- Date: 2026-05-27T03:36:46.506Z
- Corpus: 5398 items (`dataset/seed.json.gz` + planted live items)
- Trials: 10
- Probes: anchor `t3_strata_casepost`, pattern `t3_strata_flag4`, brigade `t1_strata_brigade2`

## Summary

| Check | Pass | Rate | Criterion |
| --- | --- | --- | --- |
| Surface (recall) | 10/10 | 100% | ≥3 of 4 buried witnesses retrieved AND classified RELATED |
| Surface (precision) | 10/10 | — | 0 decoys mis-classified RELATED (total decoy FPs: 0) |
| Scan (E2E alerts) | 10/10 | 100% | ≥3 buried witnesses land in created alert connections AND 0 decoy connections |
| Flag · pattern | 10/10 | 100% | 'pattern' flag fires on FLAG-4 post |
| Flag · brigade | 10/10 | 100% | 'brigade' flag fires on a brigade comment |

## Surface witness survival (per channel)

Each buried witness links to the case post through a different channel. "Retrieved" = reached top-15 candidates; "Related" = also survived the classifier (not marked UNRELATED).

| Witness | Channel | Retrieved | Classified RELATED |
| --- | --- | --- | --- |
| S1 | vehicle paraphrase | 10/10 | 10/10 |
| S2 | exact case# | 10/10 | 10/10 |
| S3 | plate -K77 | 10/10 | 10/10 |
| S4 | narrative only | 10/10 | 10/10 |

## Latency (mean)

| Check | Mean ms |
| --- | --- |
| Surface | 11997 |
| Scan (E2E build+classify+create) | 33365 |
| Flag · pattern | 1590 |
| Flag · brigade | 1298 |

## Per-trial

| # | Surface (related/4) | Scan (alerts, buried/4, decoyFP) | Pattern (precedents) | Brigade (authors) |
| --- | --- | --- | --- | --- |
| 1 | PASS (4/4) | PASS (7, 3/4, 0) | PASS (3) | PASS (5) |
| 2 | PASS (4/4) | PASS (9, 3/4, 0) | PASS (3) | PASS (5) |
| 3 | PASS (4/4) | PASS (10, 3/4, 0) | PASS (3) | PASS (5) |
| 4 | PASS (4/4) | PASS (8, 3/4, 0) | PASS (3) | PASS (5) |
| 5 | PASS (4/4) | PASS (8, 3/4, 0) | PASS (3) | PASS (5) |
| 6 | PASS (4/4) | PASS (8, 3/4, 0) | PASS (3) | PASS (5) |
| 7 | PASS (4/4) | PASS (10, 3/4, 0) | PASS (3) | PASS (5) |
| 8 | PASS (4/4) | PASS (11, 3/4, 0) | PASS (3) | PASS (5) |
| 9 | PASS (4/4) | PASS (8, 3/4, 0) | PASS (3) | PASS (5) |
| 10 | PASS (4/4) | PASS (8, 3/4, 0) | PASS (3) | PASS (5) |

> Surface/scan/flag use real OpenAI calls; surface S4 is narrative-cosine only and is the
> hardest channel, so occasional surface misses at top-15 are expected and reported, not hidden.
