import type { RawItem } from '../src/engine/types.js'

const BASE = new Date('2026-04-01T00:00:00Z').getTime()
function day(d: number, hour = 12): number {
  return BASE + d * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000
}

// ============================================================
// BACKFILL — loaded into store before any live items
// ============================================================

export const BACKFILL_ITEMS: RawItem[] = [
  // --- SURFACE: Buried witnesses ---

  {
    id: 't1_strata_surface1',
    type: 'comment',
    title: 'Best bike routes in Cambridge?',
    text: 'Honestly stay off Mass Ave near Central if you can. Last Tuesday around 6pm some asshole in a dark green Subaru Outback blew through the crosswalk at Prospect while I was mid-crossing. Had to jump back onto the curb. Didn\'t get the plate but the car had a cracked taillight and one of those "26.2" marathon stickers on the back window. Reported it to Cambridge PD non-emergency but they basically said without a plate there\'s nothing they can do.',
    authorId: 't2_thursdaycommuter',
    authorName: 'ThursdayCommuter',
    createdAt: day(7, 19),
    threadRootId: 't3_bike_routes_real',
    parentId: 't1_some_cycling_comment',
  },

  {
    id: 't3_strata_surface2',
    type: 'comment',
    title: 'Cambridge PD is useless — rant',
    text: 'Three weeks and counting since I submitted dashcam footage to Cambridge PD for case #2026-04891. They told me a detective would follow up within 48 hours. Never heard back. Called twice, got "we\'ll pass along the message" both times. I have clear HD footage of the car they\'re looking for but apparently nobody cares. At this point should I just post it publicly? Is there a civilian oversight board or something I can escalate to?',
    authorId: 't2_dashcamdave',
    authorName: 'DashcamDave_617',
    createdAt: day(25, 14),
    threadRootId: 't3_cambridge_pd_rant',
    parentId: 't3_cambridge_pd_rant',
  },

  {
    id: 't1_strata_surface3',
    type: 'comment',
    title: 'Parking garage rants',
    text: 'Not exactly a rant but something that\'s been bugging me — someone on P3 of the Cambridgeside garage (near the elevator) has a dark green Subaru Outback that suddenly has gnarly front bumper damage and a cracked passenger headlight. Showed up maybe 2 weeks ago. The bumper is hanging off on one side. They park in the same spot every weekday morning. Part of me wonders if they hit something (someone?) and are just hoping nobody notices. I see it every morning when I park for work around 8:30. Am I being paranoid or should I say something?',
    authorId: 't2_cambridgeside',
    authorName: 'CambridgeSide_Resident',
    createdAt: day(19, 17),
    threadRootId: 't3_parking_rant_real',
    parentId: 't3_parking_rant_real',
  },

  {
    id: 't3_strata_surface4',
    type: 'post',
    title: 'What was that commotion on Mass Ave tonight?',
    text: 'Was walking down Prospect toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to Mass Ave there was a bicycle on the ground with the front wheel bent in half but no car and no person. A couple people were looking around confused. Someone said they saw the cyclist get up and stumble toward the CVS. Nobody seemed to have called 911 yet so I did. Ambulance showed up maybe 8 minutes later. The whole thing felt really wrong — like whoever hit them just floored it. If you were the cyclist I hope you\'re okay. This was right at the Prospect/Mass Ave intersection.',
    authorId: 't2_inmansq',
    authorName: 'InmanSq_Walker',
    createdAt: day(7, 18),
    threadRootId: 't3_strata_surface4',
    parentId: null,
  },

  // --- FLAG-2a: Contradiction setup (TKfromCambridge) ---

  {
    id: 't1_strata_flag2a',
    type: 'comment',
    title: 'Best bars near Lechmere?',
    text: 'I live right above the Cambridgeside garage, can vouch for Night Shift Brewing — great taproom, walkable from Lechmere. My roommate and I usually hit it on Tuesdays after his shift ends around 7. He drives so I can drink lol. We park on P3, never had issues finding a spot in the evening.',
    authorId: 't2_tkfromcambridge',
    authorName: 'TKfromCambridge',
    createdAt: day(24, 21),
    threadRootId: 't3_bars_lechmere_real',
    parentId: 't3_bars_lechmere_real',
  },

  // --- FLAG-3: Previously removed witch-hunting posts ---

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

// Metadata for FLAG-3 items (decision state to apply during seed build)
export const REMOVED_ITEMS: Record<string, { decision: 'removed'; decisionBy: string; decisionReason: string }> = {
  't3_strata_flag3a': { decision: 'removed', decisionBy: 'mod_team', decisionReason: 'witch-hunting / no evidence' },
  't3_strata_flag3b': { decision: 'removed', decisionBy: 'mod_team', decisionReason: 'witch-hunting / no evidence' },
  't3_strata_flag3c': { decision: 'removed', decisionBy: 'mod_team', decisionReason: 'witch-hunting / no evidence' },
}

// ============================================================
// LIVE — arrive after backfill (simulate triggers during demo)
// ============================================================

export const LIVE_ITEMS: RawItem[] = [
  // --- CASE POST ---

  {
    id: 't3_strata_casepost',
    type: 'post',
    title: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP',
    text: 'I don\'t know what else to do. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop.\n\nSarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out.\n\nCambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.\n\nShe doesn\'t deserve this. Someone knows something. Please.',
    authorId: 't2_sarahsroommate',
    authorName: 'SarahsRoommate2026',
    createdAt: day(40, 10),
    threadRootId: 't3_strata_casepost',
    parentId: null,
  },

  // --- FLAG-1: Brigade (4 comments within 2h defending the driver) ---

  {
    id: 't1_strata_brigade1',
    type: 'comment',
    title: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP',
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
    title: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP',
    text: 'Classic reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? My neighbor has one. Are we going to harass every Subaru owner now? This post should be taken down before someone gets hurt.',
    authorId: 't2_brigade_2',
    authorName: 'BostonDriver2026_2',
    createdAt: day(41, 14.5),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },

  {
    id: 't1_strata_brigade3',
    type: 'comment',
    title: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP',
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
    title: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP',
    text: 'Has anyone verified this story is even real? No news articles, no police confirmation, just an anonymous reddit post. I\'m not saying nothing happened but maybe pump the brakes before destroying someone\'s reputation based on a color and a car brand.',
    authorId: 't2_brigade_4',
    authorName: 'BostonDriver2026_4',
    createdAt: day(41, 15.5),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },

  // --- FLAG-2b: Contradiction reveal (same author as FLAG-2a) ---

  {
    id: 't1_strata_flag2b',
    type: 'comment',
    title: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP',
    text: 'I live near Cambridgeside and I can tell you my roommate was home all evening Tuesday. He doesn\'t even drive to work anymore, he takes the Green Line. People in this thread need to stop playing detective and let the police handle it.',
    authorId: 't2_tkfromcambridge',
    authorName: 'TKfromCambridge',
    createdAt: day(41, 16),
    threadRootId: 't3_strata_casepost',
    parentId: 't3_strata_casepost',
  },

  // --- FLAG-4: New post matching removed pattern ---

  {
    id: 't3_strata_flag4',
    type: 'post',
    text: 'WARNING: dark green SUV has been seen blowing through red lights on Mass Ave near Central multiple times over the past month. I\'ve personally witnessed it twice now. Someone is going to get seriously hurt. Can the mods pin this? We need community eyes on this — has anyone gotten a plate number?',
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

export const BRIGADE_IDS = new Set([
  't1_strata_brigade1',
  't1_strata_brigade2',
  't1_strata_brigade3',
  't1_strata_brigade4',
])
