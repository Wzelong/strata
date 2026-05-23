import type { RawItem } from '../src/engine/types.js'

const BASE = new Date('2026-04-01T00:00:00Z').getTime()
function day(d: number, hour = 12): number {
  return BASE + d * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000
}

// ============================================================
// BACKFILL — loaded into store before live items.
// Each SURFACE links via ONE primary channel + a weak secondary.
// Each DECOY attacks the same primary channel as one SURFACE.
// ============================================================

export const BACKFILL_ITEMS: RawItem[] = [
  // SURFACE-1 — vehicle paraphrase (links to S3); location secondary (links to casepost).
  {
    id: 't1_strata_surface1',
    type: 'comment',
    title: 'Cambridge bike commute - daily thread',
    text: 'Almost ate it this morning at the Mass Ave / Prospect light — dark green Subaru wagon came flying through the red heading east. Plate started with a K, that\'s all I caught before he was gone. Driver looked right at me then floored it. If you cycle through there in the evenings, just assume nothing.',
    authorId: 't2_thursdaycommuter',
    authorName: 'ThursdayCommuter',
    createdAt: day(7, 8),
    threadRootId: 't3_bike_commute_daily',
    parentId: 't3_bike_commute_daily',
  },

  // SURFACE-2 — identifier (exact case#); pure topic-disjoint context (PD response times rant).
  {
    id: 't3_strata_surface2',
    type: 'comment',
    title: 'Cambridge PD black hole - anyone actually had a detective call back?',
    text: 'Submitted my dashcam clip to case #2026-04891 close to three weeks ago. Detective on the desk said "we\'ll be in touch within 48 hours" and that was the last contact. Called twice; both times got "we\'ll pass it along." Stretched or not, a five-minute callback would matter — just want to know the clip didn\'t go in the trash.',
    authorId: 't2_dashcamdave',
    authorName: 'DashcamDave_617',
    createdAt: day(28, 14),
    threadRootId: 't3_cambridge_pd_blackhole',
    parentId: 't3_cambridge_pd_blackhole',
  },

  // SURFACE-3 — partial plate -K77 (links to casepost); vehicle paraphrase secondary (links to S1).
  {
    id: 't1_strata_surface3',
    type: 'comment',
    title: 'Cambridgeside garage parking complaints',
    text: 'Whoever\'s parking a dark green Subaru wagon in P3 — your friend or whoever clipped my side mirror last Tuesday around 5:30 and just bounced. Partial plate ended in -K77 if anyone has dashcam from P3. Cracked mirror, paint transfer on my door. Genuinely just want their insurance info, not trying to start a thing.',
    authorId: 't2_cambridgeside',
    authorName: 'CambridgeSide_Resident',
    createdAt: day(19, 17),
    threadRootId: 't3_cambridgeside_garage_rants',
    parentId: 't3_cambridgeside_garage_rants',
  },

  // SURFACE-4 — narrative cosine safety net. No entity overlap with casepost.
  {
    id: 't3_strata_surface4',
    type: 'post',
    title: 'Tuesday around 5:30 near Central — what was that crash?',
    text: 'Was walking down to dinner Tuesday evening and heard a real bad bang from up the street, then someone screaming. By the time I got close it had already cleared out — cops weren\'t there yet. Kept walking like a coward. Been thinking about it all week. If anyone knows what happened, I\'d like to know.',
    authorId: 't2_inmansq',
    authorName: 'InmanSq_Walker',
    createdAt: day(7, 19),
    threadRootId: 't3_strata_surface4',
    parentId: null,
  },

  // DECOY-1 — vehicle paraphrase attack: same vehicle, different incident.
  {
    id: 't3_strata_decoy1',
    type: 'post',
    title: 'Lost cat hit by a green Subaru on Beacon St last Friday — please',
    text: 'Reposting from Nextdoor with no luck. Our cat Mango got hit on Beacon St near the Park / Marlboro intersection Friday evening. Neighbor said the car was a dark green Subaru hatchback. He had a tag with my number, the driver didn\'t stop. If anyone on Beacon has a doorbell or dashcam from around then, please reach out — we mostly just need closure.',
    authorId: 't2_mangosguy',
    authorName: 'MangosHumanCarl',
    createdAt: day(21, 11),
    threadRootId: 't3_strata_decoy1',
    parentId: null,
  },

  // DECOY-2 — identifier attack: same case# format, different number (Dice ≈ 0.70, below 0.90).
  {
    id: 't1_strata_decoy2',
    type: 'comment',
    title: 'Stolen Trek 7.2 in Davis — anyone seen it?',
    text: 'If anyone has leads on a missing red Trek 7.2 stolen from outside Davis last Wednesday, the case is filed as #2026-04123 with Cambridge PD. $200 finder\'s reward, no questions asked. I just want it back.',
    authorId: 't2_bikegrief',
    authorName: 'BikeGriefDavis',
    createdAt: day(33, 16),
    threadRootId: 't3_stolen_trek_davis',
    parentId: 't3_stolen_trek_davis',
  },

  // DECOY-3 — plate-fragment attack: K77 token in a CharlieCard context (head noun ≠ plate).
  {
    id: 't1_strata_decoy3',
    type: 'comment',
    title: 'CharlieCard transfer / serial number recovery?',
    text: 'Lost my CharlieCard, I think it was the K77 series — does the MBTA recover the balance if you have the serial code? The older numbered series got transitioned and I can\'t find my replacement card. Already tried the Park St customer service window.',
    authorId: 't2_charlielost',
    authorName: 'CharlieCardLost',
    createdAt: day(15, 10),
    threadRootId: 't3_charliecard_issues',
    parentId: 't3_charliecard_issues',
  },

  // DECOY-4 — narrative attack: "heard a crash" structure, different time and place.
  {
    id: 't3_strata_decoy4',
    type: 'post',
    title: 'Davis Saturday 11pm — anyone know what the big crash was?',
    text: 'Was walking through Davis around 11pm Saturday night and heard this huge crash, then fire trucks for about an hour up the road. Tried to look it up the next morning, nothing on the news. Anyone know what actually happened?',
    authorId: 't2_davisbystander',
    authorName: 'DavisLateWalker',
    createdAt: day(29, 14),
    threadRootId: 't3_strata_decoy4',
    parentId: null,
  },

  // FLAG-2a — contradiction setup. TKfromCambridge says his roommate drives every Tuesday
  // and they park at P3 Cambridgeside. FLAG-2b will contradict this from inside the case thread.
  {
    id: 't1_strata_flag2a',
    type: 'comment',
    title: 'Best bars near Lechmere?',
    text: 'I live right above the Cambridgeside garage — can vouch for Night Shift, great taproom, walk from Lechmere. My roommate and I always hit it Tuesdays after his shift ends around 7. He drives, I drink, nobody gets a DUI lol. We park P3, always plenty of space evenings.',
    authorId: 't2_tkfromcambridge',
    authorName: 'TKfromCambridge',
    createdAt: day(24, 21),
    threadRootId: 't3_bars_lechmere_real',
    parentId: 't3_bars_lechmere_real',
  },

  // FLAG-3 — previously removed witch-hunting posts (context the algorithm learns from).
  {
    id: 't3_strata_flag3a',
    type: 'post',
    title: 'PSA: silver Honda running reds on Beacon St',
    text: 'I don\'t have the plate but someone needs to stop this guy before he kills someone. He\'s there every morning around 8am. Can we get some community eyes on this?',
    authorId: 't2_beaconwatcher',
    authorName: 'BeaconStWatcher',
    createdAt: day(2, 9),
    threadRootId: 't3_strata_flag3a',
    parentId: null,
  },
  {
    id: 't3_strata_flag3b',
    type: 'post',
    title: 'Suspicious white pickup on Cambridge St every night',
    text: 'There\'s a white pickup that parks illegally on Cambridge St every night and I\'m pretty sure the driver is dealing. Can we get some eyes on this? License starts with 4R something. This has been going on for weeks.',
    authorId: 't2_cambst_concerned',
    authorName: 'CambStConcerned',
    createdAt: day(5, 22),
    threadRootId: 't3_strata_flag3b',
    parentId: null,
  },
  {
    id: 't3_strata_flag3c',
    type: 'post',
    title: 'Blue minivan circling my block in Allston — casing?',
    text: 'I\'ve seen it 4 days in a row now just slowly driving past. This has to be casing houses right? Should I call police or is that overreacting? Someone please tell me I\'m not crazy.',
    authorId: 't2_allston_alert',
    authorName: 'AllstonAlert88',
    createdAt: day(9, 15),
    threadRootId: 't3_strata_flag3c',
    parentId: null,
  },
]

export const REMOVED_ITEMS: Record<string, { decision: 'removed'; decisionBy: string; decisionReason: string }> = {
  't3_strata_flag3a': { decision: 'removed', decisionBy: 'mod_team', decisionReason: 'witch-hunting / no evidence' },
  't3_strata_flag3b': { decision: 'removed', decisionBy: 'mod_team', decisionReason: 'witch-hunting / no evidence' },
  't3_strata_flag3c': { decision: 'removed', decisionBy: 'mod_team', decisionReason: 'witch-hunting / no evidence' },
}

// ============================================================
// LIVE — arrive after backfill, simulate triggers during the demo.
// CASE POST is intentionally sparse: it carries the incident, the case#,
// the partial plate, and Sarah/MGH — but no vehicle description and no
// sticker. Witnesses must be found through their own clues, not by
// re-quoting the case post.
// ============================================================

export const LIVE_ITEMS: RawItem[] = [
  {
    id: 't3_strata_casepost',
    type: 'post',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'Posting on behalf of my roommate Sarah. She was riding home on Mass Ave near the Prospect St intersection in Central around 5:30pm Tuesday when a driver ran the light, hit her, and took off. She\'s at MGH — broken pelvis, broken collarbone, internal bleeding. Stable but it\'s bad.\n\nCambridge PD opened it as case #2026-04891. They have a partial plate ending in -K77 but it isn\'t enough on its own. If anyone was driving through Central around 5:30 Tuesday with a dashcam, or saw anything weird around the Prospect light, please reach out — Cambridge PD non-emergency, or DM me here. Not trying to start a witch hunt. She just deserves to know what happened.',
    authorId: 't2_sarahsroommate',
    authorName: 'SarahsRoommate2026',
    createdAt: day(40, 10),
    threadRootId: 't3_strata_casepost',
    parentId: null,
  },

  // FLAG-1 — brigade. Four fresh accounts react to the surfaced vehicle description
  // inside the case thread within a 2-hour window.
  {
    id: 't1_strata_brigade1',
    type: 'comment',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'This is getting out of hand. I know the owner of that car and he\'s a good dude who works two jobs. You people are ready to ruin someone\'s life over a description that could match hundreds of green SUVs in Cambridge. This is a witch hunt.',
    authorId: 't2_brigade_1',
    authorName: 'BostonDriver2026_1',
    createdAt: day(41, 14),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },
  {
    id: 't1_strata_brigade2',
    type: 'comment',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'Classic Reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? My neighbor has one. Are we going to harass every Subaru owner in Cambridge now? This post should be taken down before someone gets hurt.',
    authorId: 't2_brigade_2',
    authorName: 'BostonDriver2026_2',
    createdAt: day(41, 14.5),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },
  {
    id: 't1_strata_brigade3',
    type: 'comment',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'I drive past Cambridgeside garage every day and there\'s no damaged Subaru there. That commenter is either lying or confused. Stop spreading misinformation that could get an innocent person targeted.',
    authorId: 't2_brigade_3',
    authorName: 'BostonDriver2026_3',
    createdAt: day(41, 15),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },
  {
    id: 't1_strata_brigade4',
    type: 'comment',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'Has anyone verified this story is even real? No news articles, no police confirmation, just an anonymous Reddit post. I\'m not saying nothing happened but maybe pump the brakes before destroying someone\'s reputation based on a color and a car brand.',
    authorId: 't2_brigade_4',
    authorName: 'BostonDriver2026_4',
    createdAt: day(41, 15.5),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },

  // FLAG-2b — TKfromCambridge contradicts his prior post (FLAG-2a).
  {
    id: 't1_strata_flag2b',
    type: 'comment',
    title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    text: 'I live near Cambridgeside and my roommate was home with me Tuesday night. He doesn\'t even drive to work anymore, he takes the Green Line. People in this thread need to stop playing detective and let the police actually handle it.',
    authorId: 't2_tkfromcambridge',
    authorName: 'TKfromCambridge',
    createdAt: day(41, 16),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },

  // FLAG-4 — new post matching the FLAG-3 removed pattern.
  {
    id: 't3_strata_flag4',
    type: 'post',
    title: 'WARNING: dark green SUV running reds on Mass Ave near Central',
    text: 'Posting because this needs eyes on it. There\'s a dark green SUV that\'s been seen blowing through red lights on Mass Ave near Central multiple times over the past month. I\'ve personally witnessed it twice. Someone is going to get seriously hurt. Can the mods pin this? Has anyone gotten a plate?',
    authorId: 't2_massavesafety',
    authorName: 'MassAveSafety',
    createdAt: day(42, 11),
    threadRootId: 't3_strata_flag4',
    parentId: null,
  },
]

export const ALL_SIGNAL_IDS = new Set([
  ...BACKFILL_ITEMS.map(i => i.id),
  ...LIVE_ITEMS.map(i => i.id),
])

export const SURFACE_IDS = new Set([
  't1_strata_surface1',
  't3_strata_surface2',
  't1_strata_surface3',
  't3_strata_surface4',
])

export const DECOY_IDS = new Set([
  't3_strata_decoy1',
  't1_strata_decoy2',
  't1_strata_decoy3',
  't3_strata_decoy4',
])

export const BRIGADE_IDS = new Set([
  't1_strata_brigade1',
  't1_strata_brigade2',
  't1_strata_brigade3',
  't1_strata_brigade4',
])
