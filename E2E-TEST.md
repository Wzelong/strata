# Strata E2E Hands-On Test (Reddit UI)

A manual end-to-end test you run in the Reddit UI, from connecting an OpenAI key
through backfill, scan, the dashboard, alert actions, AI chat, mobile, and reset.

## Notes from the implementation that shape this test
- The app is **chromeless** (no header) during Connect-OpenAI, Backfill, and Progress.
  The header (Scan / settings / theme) only appears once data exists.
- **No auto-scan after backfill** — you click **Scan** in the header.
- **Demo data spans 2026-04-03 → 2026-05-17.** The 7-day preset captures **0 items**;
  widen the range and verify the **Items** estimate is non-zero before starting.
- The **"Strata: Seed Data" menu is deprecated** (it wipes and tells you to use the
  in-dashboard demo backfill). Use the dashboard backfill.
- Saving the OpenAI key requires the app global setting **`strataEncryptionKey`** and
  the key is **validated against OpenAI** (bad keys are rejected).
- **"Strata: Reset Data" menu** wipes everything **including the API key**.
  **Danger Zone → Reset Strata** wipes data but **keeps the API key**.

---

## Phase 0 — Preconditions
- [ ] App installed (or `devvit playtest`) on a test subreddit where you are a moderator.
- [ ] App global setting "Encryption key for per-subreddit OpenAI keys" (`strataEncryptionKey`) is set.
- [ ] You have a valid OpenAI API key.
- [ ] Note today's date and the demo data span (Apr 3 – May 17, 2026).

## Phase 1 — Create dashboard post & first load
1. Subreddit → **… menu → "Strata: Dashboard"**. → *Verify:* a Strata post is created.
2. Open the post. → *Verify:* webview loads, **"Connect OpenAI"** screen (no header chrome).
- [ ] (Optional) Open as non-mod / logged out → *Verify:* public landing, not the dashboard.

## Phase 2 — Connect OpenAI
3. Paste a wrong key (e.g. `sk-bad`), **Validate & connect**. → *Verify:* "That key was rejected by OpenAI."
4. Paste the real key, **Validate & connect**. → *Verify:* "Saved. Loading…", advances to **"Backfill your subreddit"**.

## Phase 3 — Backfill demo data
5. → *Verify:* **"Use demo data"** toggle is **ON**.
6. Set the range:
   - Quick/cheap: custom **2026-05-10 → 2026-05-17** (~one week).
   - Full: **Last 90 days** (all ~5,388 items).
   → *Verify:* the **Items** metric is **> 0**.
7. Leave mode on **Fast**. Click **Start backfill**.
8. → *Verify:* progress screen with stages, advancing bar, elapsed timer.
- [ ] (Optional) Click **Cancel backfill** mid-run → *Verify:* cancelled state.
9. Let it finish. → *Verify:* transitions to the **dashboard** (header visible; Posts/Topics populated, Alerts empty).

## Phase 4 — Scan for alerts
10. → *Verify:* a **"Scan"** button is in the header.
11. Click **Scan**. → *Verify:* settings opens to Scan; progress shows anchors processed; header shows running count.
12. Wait for completion. → *Verify:* the **Alerts** tab has alerts (surface + flag/brigade).

## Phase 5 — Dashboard exploration (desktop, ≥1024px)
13. **Alerts** → click an alert → *Verify:* **Overview** detail; confidence badge, anchor, connections.
14. Detail **Explore** tab → *Verify:* 3D graph highlights the alert's items.
15. **Posts** → click a post → post + comments. **Topics** → click a topic → cluster summary.
16. **Filters** (Type/Status/Confidence) filter the list. **Search** (Posts) filters results.
17. Right **AI chat** pane present at ≥1280px.

## Phase 6 — Alert actions
18. Surface alert → **Confirm** → "Confirm this surface?" → confirm → a **community post draft** is generated.
19. Edit the draft, **Publish**. → *Verify:* alert **resolved**, draft shows "Published".
20. Brigade alert → **Remove**/**Approve** a comment; then **Remove all**, **Lock thread**, **Dismiss** (separate alerts). → *Verify:* dialogs match and alerts resolve.
21. Alerts list → select multiple via checkboxes → bulk **resolve/dismiss**. → *Verify:* selected alerts update.

## Phase 7 — AI chat
22. Open chat → *Verify:* welcome shows **4 square suggestion buttons**.
23. **"What needs my attention right now?"** → *Verify:* rotating shimmer thinking verb, **tool steps** fade in, answer reveals **line by line**.
24. **"Summarize the biggest active topic"** → *Verify:* runs **list_topics** then **get_topic** and summarizes — not a "0 hits" dead end.
25. A tool answer referencing an alert/post/topic → *Verify:* the main view **navigates** to it.
- Note: a pause before the answer is expected (Devvit buffers the model response), then it reveals smoothly.

## Phase 8 — Mobile (< 1024px, ideally the iOS app)
26. → *Verify:* single panel; toolbar shows **Alerts · Posts · Topics · Graph · AI**.
27. Tap an item → *Verify:* detail **replaces the content in place** (no drill-in); **filters/search hidden** in detail.
28. **Graph** and **AI** tabs swap content; no stray **right border** at the screen edge.
29. **AI** tab → *Verify:* welcome is **centered, not scrollable**; input is a **square box pinned at the bottom**, grows as you type, no jump on focus.
30. On the **AI** tab, trigger tools → *Verify:* it **stays on the AI tab** while tools run.

## Phase 9 — Settings (gear icon)
31. → *Verify:* Storage gauges, Backfill history, Scan history + "Run scan", Rules → Reload from subreddit, Community context (save a note), Clusters (Recluster + sliders), Usage, Danger zone.
32. **Danger zone → Delete all alerts** (or **Reset Strata**) → *Verify:* confirmation, data clears, dashboard reflects it. (Reset keeps the API key.)

## Phase 10 — Item-level menus (Reddit … menu on a post/comment)
33. **… → "Strata: Surface"** → *Verify:* analyzes and returns buried connections.
34. **… → "Strata: Similar prior decisions"** → *Verify:* checks against previously removed items.

## Phase 11 — Full reset
35. Subreddit **… → "Strata: Reset Data"** → *Verify:* toast "API key removed"; reopening the post shows **Connect OpenAI** (true first-install).

---

## Negative / edge checklist
- [ ] Invalid OpenAI key rejected (Phase 2).
- [ ] 7-day demo window = 0 items (Phase 3).
- [ ] Backfill cancel works.
- [ ] Search with a nonsense term → empty state.
- [ ] AI chat with an off-topic query → graceful "refine" rather than a crash.
