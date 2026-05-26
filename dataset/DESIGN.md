# Strata Demo Dataset Design

## The System

Strata is one engine with two modes:

- **Surface** — when something important happens, find everything the community already knows but hasn't connected.
- **Flag** — when something looks wrong, catch what's slipping past current tools.

Same pipeline. Same data. Two directions.

---

## The Story: Hit-and-Run on Mass Ave

A cyclist named Sarah is struck on Mass Ave near the Prospect St intersection in Central Square, Cambridge. The driver flees. Sarah is in MGH ICU. Five weeks later, her roommate posts on r/boston asking for help finding witnesses.

**Surface finds**: Four people already posted about this incident — buried in unrelated threads over the prior month. A cyclist near-missed by the same vehicle the morning of the crash. A dashcam owner complaining that Cambridge PD never followed up on his footage. A garage resident whose mirror was clipped in P3 by the same partial plate. An earwitness who heard the crash near Central but kept walking.

**Flag catches**: After the case post goes viral, fresh accounts flood the thread defending "the driver." Strata flags the coordination. A user defending the driver in the thread contradicts a post they made themselves two weeks earlier. Strata catches the lie.

One incident. One engine. Both modes demonstrated.

---

## Why This Wins

- Life or death stakes — someone's in the ICU.
- The witnesses don't know they're witnesses — fragments scattered across four unrelated threads over four weeks.
- Each witness left exactly one piece of usable evidence — a vehicle description, a case number, a partial plate, a sound. Together they're a case.
- Every city-subreddit mod has seen hit-and-run posts — judges will think about *their* subreddit.

---

## The Pitch (one line)

> "The fragments are already posted. The witnesses already spoke. Nobody connected them — until now."

---

## Dataset

**Source**: r/boston April 1 – May 17, 2026.

**Process**:
1. Sample ~3,000 items from the real data, sorted by recency.
2. Inject 16 planted items into the corpus.
3. Run through the engine (embed + extract entities) so the planted items are indistinguishable from real ones at retrieval time.
4. Mark FLAG-3 items as previously removed by mods, so the algorithm sees them as decision history.

---

## Design Principles

The 16 planted items follow five rules:

1. **Sparse anchor.** The case post carries the incident + case# + partial plate + people/places, but no vehicle description and no sticker. The witnesses must be discovered by their own clues, not re-confirmed by quoting the case post.
2. **One primary channel per witness.** Each SURFACE links to the case via one primary mechanism + one weak secondary. The primary is what's being tested; the secondary is so a single embedding/extraction miss doesn't lose the item.
3. **Inter-witness overlap.** Witnesses cluster among themselves on shared rare entities (S1↔S3 on vehicle paraphrase). The case post joins post-hoc via the secondary entity overlap + narrative cosine.
4. **Adversarial decoys.** Each DECOY attacks the primary channel of one SURFACE — same vehicle in a different incident, same case-number format with a different number, same `K77` token with a different head noun, same "heard a crash" narrative at a different time and place. If scan rejects all four, the algorithm has demonstrated genuine discrimination.
5. **Voice realism.** Every item passes the "would I see this on r/boston" test.

---

## All Planted Items

### CASE POST (LIVE) — sparse trigger

**`t3_strata_casepost`** — posted Day 40 by Sarah's roommate.

> Title: **My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891**
>
> Posting on behalf of my roommate Sarah. She was riding home on Mass Ave near the Prospect St intersection in Central around 5:30pm Tuesday when a driver ran the light, hit her, and took off. She's at MGH — broken pelvis, broken collarbone, internal bleeding. Stable but it's bad.
>
> Cambridge PD opened it as case #2026-04891. They have a partial plate ending in -K77 but it isn't enough on its own. If anyone was driving through Central around 5:30 Tuesday with a dashcam, or saw anything weird around the Prospect light, please reach out — Cambridge PD non-emergency, or DM me here. Not trying to start a witch hunt. She just deserves to know what happened.

**Carries**: `Sarah` (person), `Mass Ave near the Prospect St intersection / Central` (location), `MGH / Cambridge PD` (organization), `#2026-04891` (quantity), `partial plate ending in -K77` (object).

**Deliberately omits**: vehicle make/color/model, marathon sticker, victim helmet, time of injury, hospital ward.

---

### SURFACE-1 (BACKFILL) — vehicle paraphrase channel

**`t1_strata_surface1`** — posted Day 7 morning in a daily bike-commute thread.

> Almost ate it this morning at the Mass Ave / Prospect light — dark green Subaru wagon came flying through the red heading east. Plate started with a K, that's all I caught before he was gone. Driver looked right at me then floored it. If you cycle through there in the evenings, just assume nothing.

**Primary channel**: object-entity embedding (`dark green Subaru wagon` ↔ S3's same wording).
**Secondary**: location string match (`Mass Ave / Prospect` ↔ casepost).
**Does not carry**: case#, partial plate, sticker, Sarah.

---

### SURFACE-2 (BACKFILL) — identifier channel

**`t3_strata_surface2`** — posted Day 28 as a comment in a "Cambridge PD black hole" rant thread.

> Submitted my dashcam clip to case #2026-04891 close to three weeks ago. Detective on the desk said "we'll be in touch within 48 hours" and that was the last contact. Called twice; both times got "we'll pass it along." Stretched or not, a five-minute callback would matter — just want to know the clip didn't go in the trash.

**Primary channel**: quantity string-exact match (`#2026-04891` ↔ casepost).
**Secondary**: weak `Cambridge PD` organization (via thread title).
**Does not carry**: vehicle, location of incident, Sarah.

---

### SURFACE-3 (BACKFILL) — rare plate-fragment channel

**`t1_strata_surface3`** — posted Day 19 as a comment in a Cambridgeside garage rant.

> Whoever's parking a dark green Subaru wagon in P3 — your friend or whoever clipped my side mirror last Tuesday around 5:30 and just bounced. Partial plate ended in -K77 if anyone has dashcam from P3. Cracked mirror, paint transfer on my door. Genuinely just want their insurance info, not trying to start a thing.

**Primary channel**: object-entity match on partial plate (`-K77` ↔ casepost).
**Secondary**: vehicle paraphrase (`dark green Subaru wagon` ↔ S1).
**Does not carry**: case#, Sarah, Mass Ave / Prospect.

---

### SURFACE-4 (BACKFILL) — full-text safety net

**`t3_strata_surface4`** — posted Day 7 evening as a top-level "what was that crash" post.

> Title: **Tuesday around 5:30 near Central — what was that crash?**
>
> Was walking down to dinner Tuesday evening and heard a real bad bang from up the street, then someone screaming. By the time I got close it had already cleared out — cops weren't there yet. Kept walking like a coward. Been thinking about it all week. If anyone knows what happened, I'd like to know.

**Primary channel**: text-embedding cosine (no entity-blocking help).
**Secondary**: weak `Central` location.
**Does not carry**: vehicle, plate, case#, Sarah, Mass Ave / Prospect.

---

### DECOY-1 (BACKFILL) — paraphrase attack

**`t3_strata_decoy1`** — posted Day 21. Same vehicle, different incident.

> Title: **Lost cat hit by a green Subaru on Beacon St last Friday — please**
>
> Reposting from Nextdoor with no luck. Our cat Mango got hit on Beacon St near the Park / Marlboro intersection Friday evening. Neighbor said the car was a dark green Subaru hatchback. He had a tag with my number, the driver didn't stop. If anyone on Beacon has a doorbell or dashcam from around then, please reach out — we mostly just need closure.

**Why it must not cluster with the case**: Beacon St ≠ Mass Ave/Prospect, Friday ≠ Tuesday, cat ≠ cyclist. Vehicle cluster {S1, S3, D1} forms — but after `mergeClustersByItemOverlap`, D1 shares only the vehicle. It has no overlap with the plate cluster, the case# cluster, or the Mass-Ave location cluster, so it stays separate from the case anchor group.

---

### DECOY-2 (BACKFILL) — identifier attack

**`t1_strata_decoy2`** — posted Day 33. Same case# format, different number.

> If anyone has leads on a missing red Trek 7.2 stolen from outside Davis last Wednesday, the case is filed as #2026-04123 with Cambridge PD. $200 finder's reward, no questions asked. I just want it back.

**Why it must not cluster**: `#2026-04891` vs `#2026-04123` has string Dice ≈ 0.70, below the 0.90 threshold. The quantity match is rejected. Cambridge PD as a shared organization is a weak link that fails the IDF + thread-count gates.

---

### DECOY-3 (BACKFILL) — plate-fragment attack

**`t1_strata_decoy3`** — posted Day 15. `K77` appears, but with a different head noun.

> Lost my CharlieCard, I think it was the K77 series — does the MBTA recover the balance if you have the serial code? The older numbered series got transitioned and I can't find my replacement card. Already tried the Park St customer service window.

**Why it must not cluster**: The atomize+head-noun extraction rule yields `object: K77 series CharlieCard` (head noun: CharlieCard) for D3 vs `object: partial plate ending in -K77` (head noun: plate) for S3 and casepost. Different head nouns → low embedding cosine → no cluster.

---

### DECOY-4 (BACKFILL) — narrative attack

**`t3_strata_decoy4`** — posted Day 29. "Heard a crash" structure, different time and place.

> Title: **Davis Saturday 11pm — anyone know what the big crash was?**
>
> Was walking through Davis around 11pm Saturday night and heard this huge crash, then fire trucks for about an hour up the road. Tried to look it up the next morning, nothing on the news. Anyone know what actually happened?

**Why it must not cluster**: Davis ≠ Central, Saturday 11pm ≠ Tuesday 5:30pm. Text-embedding cosine to casepost will be elevated by the narrative similarity but stays below the safety-net threshold because location/time tokens disambiguate.

---

### FLAG-1 BRIGADE (LIVE) — coordination detection

Four fresh accounts (created within a week of the case post), commenting in the case thread within a 2-hour window. All defend "the driver" using the vehicle description that surfaced inside the thread, with similar phrasing about "witch hunt" and "hundreds of green Subarus in Cambridge."

`t1_strata_brigade1`, `t1_strata_brigade2`, `t1_strata_brigade3`, `t1_strata_brigade4`.

---

### FLAG-3 REMOVED PRECEDENTS (BACKFILL) — decision history

Three prior posts removed by mods for witch-hunting (no plate, no police involvement, no specific incident): `t3_strata_flag3a` (silver Honda), `t3_strata_flag3b` (white pickup), `t3_strata_flag3c` (blue minivan casing). These establish the "we remove witch-hunt posts when there's no investigation" precedent.

---

### FLAG-4 PATTERN MATCH (LIVE) — pattern match against removed items

**`t3_strata_flag4`** — posted Day 42, same week as case post.

> WARNING: dark green SUV running reds on Mass Ave near Central. Multiple sightings. Can the mods pin this? Has anyone gotten a plate?

Strata flags it as *"matches a pattern you have previously removed for witch-hunting."* This time the case post + investigation exist — the mod makes the call with full context instead of auto-removing.

---

## Channel × Item × Mechanism Matrix

| Channel | Witness | Decoy | Mechanism the algorithm has to get right |
|---|---|---|---|
| Vehicle paraphrase | S1, S3 | D1 | `object` embedding cosine ≥ 0.70, witness cluster forms without anchor present |
| Identifier (exact) | S2 | D2 | string Dice ≥ 0.90 on `quantity`, fuzzy but not too fuzzy |
| Rare plate fragment | S3 | D3 | head-noun rule isolates `plate -K77` from `CharlieCard K77 series`; IDF wins ranking |
| Full-text safety net | S4 | D4 | text-embedding cosine survives same-narrative decoy via location/time disambiguation |
| Cluster merging | S1↔S3 (vehicle), S1↔casepost (location), S3↔casepost (plate), S2↔casepost (case#) | n/a | `mergeClustersByItemOverlap` joins four size-2 clusters into the signal anchor group via casepost in three of them |
| Coordination | brigade1-4 | n/a | account age + timing cluster |
| Removed-pattern match | flag3a-c → flag4 | n/a | pattern match against removed-item index |

---

## Item Count

**14 planted items**: 1 case post, 4 SURFACE, 4 DECOY, 4 BRIGADE, 3 REMOVED precedents, 1 PATTERN MATCH.

Plus 12 in-thread comments under the case post (sympathy, debate, mod, off-topic) for thread-depth realism — these are not part of the signal, they're the negatives the scan must not confuse with cross-thread witnesses.

---

## Expected Outcomes

**Scan top anchor group (rank #1)**: signal cluster of `{casepost, surface1, surface2, surface3, surface4}` plus same-thread context (brigades, case-thread chatter). No decoys in this group.

**Surface(casepost) top results**: a mix of in-thread chatter (brigades, sympathy, mod) and cross-thread witnesses (S1, S2, S3, S4) by entity match + narrative cosine. Decoys absent.

**Flag pipeline output**: brigade coordination alert, flag4 pattern-match alert.

If all of the above hold, the algorithm has demonstrated each mechanism it claims, under adversarial pressure.
