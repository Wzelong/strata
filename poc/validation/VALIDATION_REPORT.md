# Strata Validation Report

Generated: 2026-05-18T16:00:03.212Z
Total cost: $0.0158

## Summary

| Hypothesis | Target | Actual | Status |
|---|---|---|---|
| H1: Entity Canonicalization | ≥80% | 83.8% | PASS |
| H2: Retrieval Recall@5 | ≥70% | 83.3% | PASS |
| H3: Classification Accuracy | ≥85% | 95.2% | PASS |
| H4: Cross-Item Pattern Detection | ≥70% | 100.0% | PASS |
| H5: Recommendation Agreement | ≥80% | 100.0% | PASS |

**Overall: 5/5 hypotheses confirmed.**

---

## H1: Entity Canonicalization

**Score: 83.8% (31/37 matched)**

### Mismatches
| Test Case | Type | Expected | Got |
|---|---|---|---|
| scam_url | url | safecityclaims.net | safecityclaims.net, city_website |
| t3_case_a->t1_conn_a1 | location | birchwood_ave | birchwood |
| t3_case_b->t1_conn_b2 | time | tuesday | last_tuesday |
| t3_case_b->t1_conn_b2 | time | tuesday | last_tuesday |
| t3_case_b->t1_conn_b2 | product | white_honda_civic | white_sedan |
| t3_case_c->t1_conn_c1 | product | silver_chrysler_pacifica | silver_minivan |

---

## H2: Two-Stage Retrieval Recall@5

**Score: 83.3%**

| Case | Recall | Easy | Medium | Hard | Very-Hard |
|---|---|---|---|---|---|
| t3_case_a | 100% | Y | Y | Y | Y |
| t3_case_b | 75% | Y | Y | Y | N |
| t3_case_c | 75% | Y | Y | Y | N |

---

## H3: Relationship Classification

**Score: 95.2% (20/21 correct)**

### Confusion Matrix
| | CONFIRMS | CONTRADICTS | UPDATES | TEMPORAL | UNRELATED |
|---|---|---|---|---|---|
| **CONFIRMS** | 3 | 0 | 1 | 1 | 0 |
| **CONTRADICTS** | 0 | 0 | 0 | 0 | 0 |
| **UPDATES** | 0 | 0 | 4 | 0 | 0 |
| **TEMPORAL** | 0 | 0 | 2 | 1 | 0 |
| **UNRELATED** | 0 | 0 | 0 | 0 | 9 |

### Misclassifications
| A | B | Expected | Predicted |
|---|---|---|---|
| t3_case_a | t1_conn_a4 | CONFIRMS | TEMPORAL |

---

## H4: Cross-Item Pattern Detection

**Score: 100.0% brigade recall (target ≥70%)**

### Brigade Detection
- Detected: YES
- Recall: 100% (6/6 items found)

| Item | In Cluster? |
|---|---|
| t1_brigade_1 | YES |
| t1_brigade_2 | YES |
| t1_brigade_3 | YES |
| t1_brigade_4 | YES |
| t1_brigade_5 | YES |
| t1_brigade_6 | YES |

### Baseline: Rule-Embedding Proximity
- Avg violation-to-rule cosine: 0.3031
- Avg neutral-to-rule cosine: 0.2489
- Separation: 0.0542 (violations closer to rules — signal exists)

---

## H5: Recommendation Agreement

**Score: 100.0% (20/20 correct)**

| Category | Tested | Correct | Accuracy |
|---|---|---|---|
| violation | 10 | 10 | 100% |
| standout | 5 | 5 | 100% |
| neutral | 5 | 5 | 100% |

