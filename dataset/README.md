# Dataset

Demo dataset for Strata, built from real r/boston posts (April-May 2026) plus 16 planted items that tell a hit-and-run investigation story.

See [DESIGN.md](DESIGN.md) for the full narrative design and planted item specifications.

## Files

| File | Committed | Purpose |
|------|-----------|---------|
| `seed.json.gz` | Yes | 5,388 items with embeddings + entities (loaded via demo backfill) |
| `signal-items.ts` | Yes | 16 planted items — 4 witnesses, 4 decoys, 4 brigade, 4 flag |
| `labeled-cases.ts` | Yes | Ground truth labels for benchmark evaluation |
| `build-seed.ts` | Yes | Builds seed.json from raw Reddit data |
| `DESIGN.md` | Yes | Dataset design document |
| `r_boston_posts.jsonl` | No (too large) | Raw Reddit posts (~16MB) |
| `r_boston_comments.jsonl` | No (too large) | Raw Reddit comments (~171MB) |

## Rebuild

Requires `OPENAI_API_KEY` in `.env` and the raw JSONL files in this directory.

```bash
npm run seed
```

This produces `seed.json` (~50MB uncompressed). Gzip it to `seed.json.gz` for the committed version:

```bash
gzip -k dataset/seed.json
```
