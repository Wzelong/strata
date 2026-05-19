# Strata Demo Dataset Design

## The System

Strata is one engine with two modes:

- **Surface** — when something important happens, find everything the community already knows but hasn't connected
- **Flag** — when something looks wrong, catch what's slipping past current tools

Same pipeline. Same data. Two directions.

---

## The Story: Hit-and-Run on Mass Ave

A cyclist named Sarah is struck on Mass Ave near Central Square, Cambridge. The driver flees. Sarah is in the ICU. Her roommate posts desperately on r/boston.

**Surface finds**: Three strangers already posted about this car — buried in unrelated threads over the past 3 weeks. A near-miss pedestrian. A dashcam owner with footage. A garage neighbor who sees the car every morning.

**Flag catches**: After the case post goes viral, fresh accounts flood the thread defending the driver. Strata flags the coordination. Meanwhile, the driver's roommate posts a statement that contradicts their own comment from 2 weeks ago. Strata catches the lie.

One incident. One engine. Both modes demonstrated.

---

## Why This Wins

- **Life or death** — someone's in the ICU, not just annoyed about a scam
- **The witnesses don't know they're witnesses** — that's the goosebump moment
- **The dashcam person literally offered footage** and nobody connected it
- **The garage neighbor can locate the car TODAY** — actionable justice
- **Every city sub mod has seen hit-and-run posts** — judges will think about THEIR subreddit
- **Mirrors the YouTube cold case stories** (Linda Pagano, Susan Rainwater, Grateful Doe) — scattered fragments, years apart, finally connected. But Strata does it in seconds, not years.

---

## The Pitch (one line)

> "The fragments are already posted. The witnesses already spoke. Nobody connected them — until now."

---

## Dataset: Real r/boston + Planted Signals

**Source**: r/boston April 1 – May 17, 2026 (3,700 posts, 93,080 comments)

**Process**:
1. Sample ~3,000 items from the real data (deterministic seed)
2. Inject 12 hand-crafted signal items into the corpus
3. Run through the engine (embed + extract entities)
4. Cache the result as the backfill seed

**Two slices**:
| Slice | Content | How processed |
|---|---|---|
| **Backfill** (Apr 1 – May 10) | ~3,000 real items + 9 planted fragments | `ingestBatch()` on install |
| **Live** (May 11+) | The case post + 2 supporting items | `ingest()` one-by-one via trigger |

---

## All Planted Items

Everything below is one interconnected story. The hit-and-run is the center. Everything radiates from it.

---

### ACT 1: BEFORE THE CRASH (Backfill — Surface signals)

These are the buried fragments that Surface will find.

---

#### SURFACE-1 — The Near-Miss Pedestrian

**Day**: Apr 8 (backfill)  
**Thread**: "Best bike routes that avoid traffic?" (real thread about cycling)  
**Position**: Comment #11 in a 24-comment thread  
**Author**: ThursdayCommuter  

```
Honestly stay off Mass Ave near Central if you can. Last Tuesday around 6pm some asshole in a dark green Subaru Outback blew through the crosswalk at Prospect while I was mid-crossing. Had to jump back onto the curb. Didn't get the plate but the car had a cracked taillight and one of those "26.2" marathon stickers on the back window. Reported it to Cambridge PD non-emergency but they basically said without a plate there's nothing they can do.
```

---

#### SURFACE-2 — The Dashcam Owner

**Day**: Apr 14 (backfill)  
**Thread**: Own post, low engagement (4 upvotes, 6 comments)  
**Author**: DashcamDave_617  

**Title**: "Dashcam caught a car jump the curb on Mass Ave near Central — should I report this?"

```
Driving home Tuesday evening around 6:15pm on Mass Ave heading toward Harvard Square. Right near the Prospect St intersection a dark green SUV (looked like a Subaru maybe Outback or Forester) swerved hard into the bike lane, clipped the curb, then accelerated away fast toward Inman. I have clear footage from my dashcam — you can see the car pretty well including what looks like a marathon bumper sticker. Wasn't sure if something happened or the driver was just wasted. Should I bother reporting this to Cambridge PD? I still have the footage saved.
```

---

#### SURFACE-3 — The Garage Neighbor

**Day**: Apr 20 (backfill)  
**Thread**: "Monthly parking rant thread" (real recurring thread)  
**Position**: Comment #18 in a 40+ comment thread  
**Author**: CambridgeSide_Resident  

```
Not exactly a rant but something that's been bugging me — someone on P3 of the Cambridgeside garage (near the elevator) has a dark green Subaru Outback that suddenly has gnarly front bumper damage and a cracked passenger headlight. Showed up maybe 2 weeks ago. The bumper is hanging off on one side. They park in the same spot every weekday morning. Part of me wonders if they hit something (someone?) and are just hoping nobody notices. I see it every morning when I park for work around 8:30. Am I being paranoid or should I say something?
```

---

#### SURFACE-4 — The Earwitness

**Day**: Apr 8 (backfill, same evening as SURFACE-1)  
**Thread**: Own post (8 upvotes)  
**Author**: InmanSq_Walker  

**Title**: "What was that commotion on Mass Ave tonight?"

```
Was walking down Prospect toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to Mass Ave there was a bicycle on the ground with the front wheel bent in half but no car and no person. A couple people were looking around confused. Someone said they saw the cyclist get up and stumble toward the CVS. Nobody seemed to have called 911 yet so I did. Ambulance showed up maybe 8 minutes later. The whole thing felt really wrong — like whoever hit them just floored it. If you were the cyclist I hope you're okay. This was right at the Prospect/Mass Ave intersection.
```

Note: No vehicle description. Embedding-only retrieval.

---

### ACT 2: THE CRASH (Live — triggers Surface)

---

#### CASE POST — The Roommate's Plea

**Day**: May 11 (LIVE — you post this during the demo)  
**Author**: SarahsRoommate2026  

**Title**: "My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP"

```
I don't know what else to do. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop.

Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out.

Cambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.

She doesn't deserve this. Someone knows something. Please.
```

**What Surface returns**: SURFACE-1, 2, 3, 4 — all found in under 2 seconds.

---

### ACT 3: THE AFTERMATH (Live — triggers Flag)

After the case post gains traction, two things happen that Flag catches:

---

#### FLAG-1 — The Brigade (Coordination Detection)

**Day**: May 12 (LIVE — 6 hours after case post)  
**Thread**: The case post's comment section  
**Authors**: 4 brand-new accounts, all posting within a 2-hour window  

**BostonDriver2026_1**:
```
This is getting out of hand. I know the owner of that car and he's a good dude who works two jobs. You people are ready to ruin someone's life over a description that could match hundreds of green SUVs in Cambridge. This is a witch hunt.
```

**BostonDriver2026_2**:
```
Classic reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? My neighbor has one. Are we going to harass every Subaru owner now? This post should be taken down before someone gets hurt.
```

**BostonDriver2026_3**:
```
I drive past Cambridgeside garage every day and there's no damaged Subaru there. That commenter is either lying or confused. Stop spreading misinformation that could get an innocent person targeted.
```

**BostonDriver2026_4**:
```
Has anyone verified this story is even real? No news articles, no police confirmation, just an anonymous reddit post. I'm not saying nothing happened but maybe pump the brakes before destroying someone's reputation based on a color and a car brand.
```

**What Flag catches**: 
- 4 items, same thread, 2-hour window
- 4 different authors (all new)
- High semantic uniformity (all defending the driver, dismissing evidence)
- `detectCampaign` fires on entity overlap + temporal density + author diversity

---

#### FLAG-2 — The Self-Contradiction

**Day**: Apr 25 (backfill) — This comment exists BEFORE the crash  
**Thread**: "Best bars near Cambridgeside/Lechmere?"  
**Author**: TKfromCambridge  

```
I live right above the Cambridgeside garage, can vouch for Night Shift Brewing — great taproom, walkable from Lechmere. My roommate and I usually hit it on Tuesdays after his shift ends around 7. He drives so I can drink lol. We park on P3, never had issues finding a spot in the evening.
```

**Day**: May 12 (LIVE — after the case post goes viral)  
**Thread**: The case post's comment section  
**Author**: TKfromCambridge (SAME PERSON)  

```
I live near Cambridgeside and I can tell you my roommate was home all evening Tuesday. He doesn't even drive to work anymore, he takes the Green Line. People in this thread need to stop playing detective and let the police handle it.
```

**What Flag catches**:
- Same author, same entity (`location:cambridgeside_garage_p3`, `person:roommate`)
- Statement 1: "He drives... we park on P3... Tuesdays after his shift"
- Statement 2: "He doesn't even drive to work anymore, he was home all evening Tuesday"
- `classifyRelationship` → **CONTRADICTS**

This is the "oh shit" moment for the submission writeup: Strata didn't just find witnesses — it caught the suspect's roommate lying to cover for them.

---

### ACT 4: PATTERN RECOGNITION (Backfill — Flag signals)

These demonstrate Flag's other capability: catching items that match previously-removed patterns.

---

#### FLAG-3 — Prior Removed Posts (establishes precedent)

Three posts from weeks 1-2, already marked `decision: 'removed'` in the seed data:

**Day 3** (removed, reason: "witch-hunting / no evidence"):
```
PSA: silver Honda on Beacon St keeps running the red at Mass Ave intersection. I don't have the plate but someone needs to stop this guy before he kills someone. He's there every morning around 8am.
```

**Day 6** (removed, reason: "witch-hunting / no evidence"):
```
There's a white pickup that parks illegally on Cambridge St every night and I'm pretty sure the driver is dealing. Can we get some eyes on this? License starts with 4R something.
```

**Day 10** (removed, reason: "witch-hunting / no evidence"):
```
HEADS UP — blue minivan with NH plates keeps circling my block in Allston. I've seen it 4 days in a row now just slowly driving past. This has to be casing houses right? Should I call police?
```

#### FLAG-4 — New Item Matching Removed Pattern

**Day**: May 13 (LIVE)  
**Thread**: Own post  
**Author**: MassAveSafety  

```
WARNING: dark green SUV has been seen blowing through red lights on Mass Ave near Central multiple times over the past month. I've personally witnessed it twice now. Someone is going to get seriously hurt. Can the mods pin this? Can we get a plate?
```

**What Flag catches**:
- High embedding similarity to the 3 previously-removed posts (all are "I saw a dangerous vehicle, here's a vague description, someone do something")
- Strata flags it: "This matches a pattern you've previously removed for witch-hunting. Recommended action: review with context."
- BUT — now there's the case post, the witnesses, the police case number. This time it's real. The mod can make an informed decision instead of auto-removing.

---

## Summary: What Each Item Demonstrates

| Item | Mode | What it proves |
|---|---|---|
| SURFACE 1-4 | Surface | Buried witnesses found across unrelated threads |
| CASE POST | Surface trigger | New post instantly surfaces historical connections |
| FLAG-1 (brigade) | Flag | Coordinated inauthentic behavior detected in real-time |
| FLAG-2 (contradiction) | Flag | Same user's statements across time contradict — caught |
| FLAG-3 (removed precedents) | Flag setup | Establishes what mods have already decided is bad |
| FLAG-4 (pattern match) | Flag | New item flagged as matching previously-removed pattern |

**Total planted items**: 13 (4 Surface + 1 case post + 4 brigade + 2 contradiction + 3 removed precedents + 1 pattern match)

All from one story. All exercising the same engine.

---

## Technical: Loading Strategy

### Offline (before demo)

```
dataset/
├── DESIGN.md                 # This file
├── r_boston_posts.jsonl       # Real data (3,700 posts)
├── r_boston_comments.jsonl    # Real data (93,080 comments)
├── signal-items.json         # The 12 planted items (hand-crafted)
├── build-corpus.ts           # Sample 3K real + inject signals → corpus.json
├── corpus.json               # Final merged corpus
├── embed-and-extract.ts      # Run engine pipeline → cache.json  
├── cache.json                # Cached embeddings + entities (gitignored)
└── seed.json                 # Ready-to-load Redis payload
```

### On Devvit (runtime)

1. `onAppInstall` or "Seed Data" menu action loads `seed.json` into Redis
2. Live items arrive via `onCommentSubmit` / `onPostSubmit` triggers → `ingest()` each one
3. Mod clicks "Find Connections" → engine runs against the full backfill store

### Redis key patterns (matches `RedisKVStore`)

```
strata:items              (hSet: id → JSON StoredItem)
strata:embeddings         (hSet: id → JSON number[256])
strata:idx:time           (zAdd: member=id, score=createdAt)
strata:idx:author:{id}    (zAdd: member=itemId, score=createdAt)
strata:idx:thread:{id}    (zAdd: member=itemId, score=createdAt)
strata:idx:decision:{d}   (zAdd: member=itemId, score=decisionAt)
strata:idx:entity:{t}:{c} (zAdd: member=itemId, score=createdAt)
strata:canonicals          (hSet: type → JSON string[])
strata:rules               (hSet: id → JSON StoredRule)
```

### Redis budget
- 3,000 items × ~2.7KB each = ~8MB total
- Well within Devvit's 500MB limit

---

## The 1-Minute Demo Script

```
0:00 — "A cyclist was hit on Mass Ave. The driver fled.
        Her roommate posted this."
        [Show case post]

0:08 — "Strata has been watching r/boston for 30 days.
        3,000 posts and comments processed."

0:13 — [Mod clicks "Strata: Surface" on the case post]
        [Results appear instantly]

0:18 — "33 days ago — buried in a cycling thread — someone
        was almost hit by the same car at the same intersection."

0:25 — "27 days ago — a post with 4 upvotes — someone has
        DASHCAM FOOTAGE. They asked if they should report it.
        Nobody answered."

0:32 — "21 days ago — in a parking rant thread — someone sees
        this car EVERY MORNING in a garage. Fresh damage."

0:38 — "And that same night — someone heard the crash and
        found the bike. No one ever connected it."

0:44 — "Four witnesses. Three weeks. Four unrelated threads.
        The dashcam has footage. The garage neighbor knows where
        the car parks. Strata found what no human could."

0:55 — "The fragments are already posted. Strata finds them."
        [Strata logo]
```

---

## How It Works (validated)

The pipeline we tested (`validate-hitrun.ts`, `validate-entity-embed-v2.ts`):

1. **Embedding similarity** finds all 4 fragments in the top 5 out of 3,000 items (proven: H3 PASS)
2. **Type-isolated entity embedding** catches cross-phrasing: "dark green SUV" ↔ "dark green Subaru Outback" scores 0.76+ within the product type bucket (proven: H1 PASS in v2)
3. **LLM classification** correctly labels all 4 as UPDATES/CONFIRMS and rejects noise like "selling my Subaru" as UNRELATED (proven: H5 PASS)
4. **Brigade detection** fires on 4+ items, same thread, 2-hour window, high semantic uniformity
5. **Contradiction detection** finds same author + shared entities + `classifyRelationship` → CONTRADICTS

Total validation cost: $0.03. All hypotheses pass.
