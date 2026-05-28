# Strata: Community Memory

> The community already knows. Now it remembers.

Strata is a **cross-thread intelligence engine** for Reddit moderators. It ingests every post and comment, extracts linkable entities, and surfaces buried connections, coordinated brigades, and repeat patterns — all inside a native Devvit custom post.

- **Demo video** — *[[YouTube link](https://www.youtube.com/watch?v=rApVnA2rZDo)]*
- **App listing** — *[[developers.reddit.com/apps/strata-hackathon](https://developers.reddit.com/apps/strata-hackathon)]*
- **Live test post** — *[[r/strata_hackathon_dev](https://www.reddit.com/r/strata_hackathon_dev/)]*

---

## What it does

| Mode | What it catches | Where it shows up |
|------|----------------|-------------------|
| **Surface** | Cross-thread connections — multiple people mentioning the same entity (phone number, vehicle, username, location) in unrelated threads | Dashboard alert with highlighted entities + ModMail digest |
| **Flag: Brigade** | Coordinated accounts pushing the same narrative in a short time window | Dashboard flag alert |
| **Flag: Pattern** | New posts matching previously-removed content | Reddit mod queue with reason + precedent IDs |
| **Flag: Rule** | Direct rule violations detected by embedding + LLM | Reddit mod queue with rule citation |
| **Explore** | Community topic structure over time | Interactive 3D graph + topic list |
| **Chat** | Natural-language questions about community content | AI assistant inside dashboard |

---

## Getting started

### Install from App Directory

1. Install **Strata** from the Devvit App Directory to your subreddit
2. Mod Action → **"Strata: Dashboard"** — creates a pinned custom post as your moderator dashboard
3. Open the dashboard post → enter your **OpenAI API key** (encrypted, stored per-subreddit in Redis)
4. **Backfill** (recommended) — ingest your subreddit's recent history to build the community memory. Select a date range and start. Progress shows in real-time.
5. Once seeded, Strata runs automatically on every new post and comment.

### How alerts reach you

- **Surface alerts** → dashboard + ModMail notification with a digest of connections found
- **Brigade flags** → dashboard with participating accounts and coordinated narrative identified
- **Rule/Pattern flags** → Reddit's native mod queue with a formatted reason string

### Configuration

| Setting | Where | Description |
|---------|-------|-------------|
| OpenAI API key | Dashboard → Settings | Required. Encrypted at rest. Powers embeddings, extraction, classification, and chat. |
| Community context | Dashboard → Settings | Optional free-text description of your community — improves classification and chat relevance. |
| Mod content toggle | Dashboard → Settings | Whether moderators' own posts get ingested (default: on for testing, off for production). |

---

## Demo flow

The demo uses a planted scenario on r/strata_hackathon_dev — a hit-and-run case thread — but the system works on any content with linkable entities: scam reports sharing phone numbers, missing persons cases sharing locations, repeat offenders across throwaway accounts.

1. **Case post arrives** — a roommate posts about a hit-and-run, mentioning a partial plate, intersection, case number, and time.
2. **Pipeline fires** — Strata extracts entities, searches the full community memory, finds four corroborating posts from different threads (a near-miss report, a dashcam submission, a parking garage complaint, an earwitness account).
3. **Alert delivered** — ModMail notification + dashboard alert with all connections, each annotated with classification (CONFIRMS/UPDATES/TEMPORAL), confidence, and a one-line reason.
4. **Mod acts** — reviews the alert, then publishes a community story post synthesizing the timeline — turning scattered evidence into collective action.
5. **Brigade detected** — fresh accounts flood the case thread with coordinated dismissals. Strata detects semantic uniformity + temporal density and flags the brigade.

---

## Benchmark

Evaluated on a 10,044-item corpus with planted signals and adversarial decoys across 10 trials:

| Metric | Value |
|--------|-------|
| Corpus size | 10,044 items |
| Recall@15 | 75% (3/4 buried witnesses retrieved consistently) |
| False positive rate | 0% (no decoys classified as related) |
| Consistency | 10/10 trials pass all checks |

Full breakdown (precision/recall curves, retrieval ranking, confusion matrix, channel analysis) in the `benchmark/` directory.

### Reproduce

```bash
# Regenerate graphs from committed results
npm run benchmark:viz

# Full run (requires OPENAI_API_KEY, ~$4-7 API cost)
npm run benchmark:seed && npm run benchmark && npm run benchmark:viz
```

---

## Architecture

```
Reddit event (post/comment submit)
        │
        ▼
┌─────────────────────────┐
│  Devvit Trigger Handler │
│  (server/index.ts)      │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  StrataEngine.ingest()  │
│  ┌────────┐ ┌─────────┐│
│  │ Embed  │ │ Extract ││  ← parallel
│  │ (256d) │ │(entities)││
│  └───┬────┘ └────┬────┘│
│      └─────┬─────┘     │
│            ▼            │
│      Store: Redis       │
└───────────┬─────────────┘
            │
      ┌─────┴─────┐
      ▼           ▼
┌──────────┐ ┌──────────┐
│ Surface  │ │   Flag   │
│ (posts)  │ │  (all)   │
└─────┬────┘ └────┬─────┘
      │           │
      ▼           ▼
   Alerts      Mod Queue
   ModMail     Dashboard
```

### Pipeline stages

1. **Normalize** — canonical whitespace and unicode
2. **Embed** — `text-embedding-3-small` (256d, int8 quantized)
3. **Extract** — `gpt-5.4-mini` structured entity extraction (9 types)
4. **Entity embed** — separate 256d vectors for semantic entity matching
5. **Retrieve** — hybrid entity (IDF-weighted) + cosine safety net → RRF
6. **Classify** — `gpt-5.5` batch classification with strict JSON schema
7. **Alert** — entity bridging + alert creation + ModMail digest

### Storage (Redis-only)

| Key | Content |
|-----|---------|
| `strata:items` | Stored items (hash) |
| `strata:embeddings` | Quantized 256d vectors (hash) |
| `strata:idx:time` | Time-sorted index (sorted set) |
| `strata:alerts` | Alert index (sorted set) |
| `strata:entity-emb:{type}` | Entity embeddings per type (hash) |
| `strata:cluster:*` | Cluster metadata + assignments |

Storage is capped at 500MB (~330K items). A sliding memory window automatically evicts the oldest items when approaching capacity — the community memory stays fresh without manual intervention.

---

## Local development

### Prerequisites

- Node.js ≥ 22.2.0
- Devvit CLI (`npm install -g devvit`)
- OpenAI API key

### Setup

```bash
git clone https://github.com/Wzelong/strata.git
cd strata
npm install
```

### Develop

```bash
# Client dev server (hot reload at localhost:5173)
npm run dev:client

# Build for Devvit
npm run dev

# Upload to Devvit (deploys to your test subreddit)
devvit upload

# Publish to App Directory
devvit publish
```

### Playtest on Reddit

```bash
devvit playtest r/strata_hackathon_dev
```

This creates a live tunnel to your local build. Open your test subreddit, run **Strata: Dashboard** from the mod menu, and interact with the live app.

---

## Repo structure

```
strata/
├── src/
│   ├── client/          React + Tailwind + Three.js dashboard
│   │   ├── components/  UI components (dashboard, alerts, graph, chat)
│   │   ├── hooks/       Data fetching hooks
│   │   └── lib/         API client, utilities
│   ├── engine/          Core intelligence (embed, extract, classify, search, cluster)
│   │   └── storage/     Redis + in-memory store implementations
│   └── server/          Hono HTTP server (triggers, API, scheduler jobs, chat)
├── benchmark/           10K-item eval corpus + stability tests
├── devvit.json          Devvit app configuration (triggers, scheduler, permissions)
├── vite.config.ts       Build configuration
└── package.json
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Platform | Devvit (Reddit Developer Platform) |
| Server | Hono (HTTP framework inside Devvit runtime) |
| Client | React 19 + Tailwind 4 + Three.js (3D graph) |
| Storage | Devvit Redis (KV + sorted sets) |
| AI | OpenAI — text-embedding-3-small, gpt-5.4-mini, gpt-5.5 |
| Build | Vite 7 + TypeScript 5.9 |

---

## License

MIT
