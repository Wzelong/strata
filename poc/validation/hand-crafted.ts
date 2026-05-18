import type { CorpusItem, BuriedConnection } from './schemas.js'

// --- CASE A: Hit-and-Run at 5th and Main ---

const caseA: CorpusItem = {
  id: 't3_case_a',
  type: 'post',
  text: `Hit-and-run on 5th and Main, Saturday 4/12 around 7pm — anyone see anything?\n\nMy friend was crossing 5th and Main last Saturday (April 12) around 7pm when a dark-colored SUV ran a red light and clipped her. The driver didn't stop. She's okay but has a broken wrist. We think the vehicle was a dark blue or black Ford Explorer, maybe 2018-2020 model year. It turned east onto Birchwood Ave after the intersection. If anyone has dashcam footage or saw anything, please reach out. We've filed a report with CPD (case #2024-04871).`,
  authorId: 'user_case_a',
  authorName: 'LindsayM_downtown',
  createdAt: 0, // assigned later
  threadRootId: 't3_case_a',
  parentId: null,
}

const connA1: CorpusItem = {
  id: 't1_conn_a1',
  type: 'comment',
  text: `I was at the Walgreens on 5th and Main around 7pm on April 12th and saw a dark SUV blow through the red. Looked like a newer Ford Explorer, navy blue. It almost hit a pedestrian in the crosswalk. I didn't get the plate but it turned down Birchwood heading east. Hope CPD follows up — that intersection is terrible.`,
  authorId: 'user_witness_a1',
  authorName: 'WalgreensRegular',
  createdAt: 0,
  threadRootId: '', // assigned to a neutral thread later
  parentId: null,
}

const connA2: CorpusItem = {
  id: 't1_conn_a2',
  type: 'comment',
  text: `Update for anyone tracking hit-and-runs: my neighbor's Ring camera on Birchwood Ave caught a dark SUV speeding past at 7:04pm on Saturday the 12th. It was heading east and the right front bumper had fresh damage. I told him to send it to CPD.`,
  authorId: 'user_witness_a2',
  authorName: 'BirchwoodNeighbor',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connA3: CorpusItem = {
  id: 't1_conn_a3',
  type: 'comment',
  text: `That dark Explorer has been parking on Birchwood near 6th for weeks with no plates. I reported it to non-emergency last month but nothing happened. Typical CPD response.`,
  authorId: 'user_witness_a3',
  authorName: 'FrustratedResident88',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connA4: CorpusItem = {
  id: 't1_conn_a4',
  type: 'comment',
  text: `I was rear-ended at that same intersection two weeks before — driver ran the light coming from the west side. My insurance company said there have been three claims this year at 5th and Main, all from red-light runners heading east. Something is seriously wrong with that signal timing.`,
  authorId: 'user_witness_a4',
  authorName: 'CommuterDaveK',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

// --- CASE B: Package Theft Ring on Oakdale ---

const caseB: CorpusItem = {
  id: 't3_case_b',
  type: 'post',
  text: `Multiple package thefts on Oakdale between 2nd and 4th — happening every Tuesday\n\nIn the past month, at least 6 households on Oakdale Street between 2nd Ave and 4th Ave have had packages stolen. It always happens on Tuesdays between 11am and 1pm. A neighbor's camera caught a white Honda Civic (partial plate: 7M3-something) with two people — one drives slowly while the other jumps out and grabs boxes. They hit three porches in under 2 minutes. I've reported to CPD and they said to contact Detective Morrison if you're a victim. Case numbers: 2024-05102, 2024-05103.`,
  authorId: 'user_case_b',
  authorName: 'OakdaleBlockWatch',
  createdAt: 0,
  threadRootId: 't3_case_b',
  parentId: null,
}

const connB1: CorpusItem = {
  id: 't1_conn_b1',
  type: 'comment',
  text: `Just got hit today (Tuesday again). I live on Oakdale between 3rd and 4th. My Amazon package was taken at around 11:30am. My doorbell cam got a clear shot — white Civic, plate starts with 7M3. Two guys, one stayed in the car. I'm calling Detective Morrison tomorrow morning. This is the third time this month.`,
  authorId: 'user_witness_b1',
  authorName: 'OakdaleVictim3',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connB2: CorpusItem = {
  id: 't1_conn_b2',
  type: 'comment',
  text: `I actually think the package thieves moved to Elm Street now. Last Tuesday I saw a white sedan (maybe a Civic?) cruising slowly on Elm near 3rd Ave around noon. The passenger was scanning porches. Could be the same pair from the Oakdale reports.`,
  authorId: 'user_witness_b2',
  authorName: 'ElmStWatcher',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connB3: CorpusItem = {
  id: 't1_conn_b3',
  type: 'comment',
  text: `The porch pirate situation is getting ridiculous. My coworker on 3rd Ave lost two packages last week, both mid-day. She said the cops told her there's a case open with some detective but they haven't made an arrest. Meanwhile Amazon keeps leaving stuff without signatures.`,
  authorId: 'user_witness_b3',
  authorName: 'AmazonFrustrated',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connB4: CorpusItem = {
  id: 't1_conn_b4',
  type: 'comment',
  text: `Two guys got pulled over on Route 9 yesterday for expired tags — white Civic. The officer found a bunch of opened Amazon and UPS boxes in the back seat. No charges yet but my buddy at the precinct says they're connecting it to open theft cases.`,
  authorId: 'user_witness_b4',
  authorName: 'Route9Commuter',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

// --- CASE C: Suspicious Person at Lincoln Elementary ---

const caseC: CorpusItem = {
  id: 't3_case_c',
  type: 'post',
  text: `Suspicious man photographing kids at Lincoln Elementary pickup — happened Wednesday and Thursday this week\n\nTwo parents reported a man in a red jacket standing across from Lincoln Elementary during afternoon pickup (around 3:15pm) on both Wednesday 4/16 and Thursday 4/17. He was taking photos with a phone and had no children with him. He's described as white, mid-40s, heavyset, wearing a red North Face puffer and dark jeans. He was standing next to a silver minivan (possibly Chrysler Pacifica). School admin notified Officer Delgado at the 14th Precinct. If you see this person, do NOT approach — call the precinct directly at 555-0147.`,
  authorId: 'user_case_c',
  authorName: 'LincolnParentAlert',
  createdAt: 0,
  threadRootId: 't3_case_c',
  parentId: null,
}

const connC1: CorpusItem = {
  id: 't1_conn_c1',
  type: 'comment',
  text: `I can confirm this — I pick up my daughter from Lincoln Elementary and saw the same guy on Thursday. Red puffy jacket, stocky build, standing by a silver minivan across the street. He was definitely taking pictures toward the school. I took a photo of the van's plate and gave it to Officer Delgado. Really unsettling.`,
  authorId: 'user_witness_c1',
  authorName: 'LincolnMom2024',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connC2: CorpusItem = {
  id: 't1_conn_c2',
  type: 'comment',
  text: `I spoke to Delgado at the 14th Precinct community meeting last night. He said they're aware of the situation near the school and they've increased patrol during pickup hours (3-3:30pm). He asked anyone who has photos of the silver vehicle to email them to the precinct tip line.`,
  authorId: 'user_witness_c2',
  authorName: 'CommunityMtgRegular',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connC3: CorpusItem = {
  id: 't1_conn_c3',
  type: 'comment',
  text: `My kid goes to Washington Middle School (two blocks from Lincoln) and said a "creepy van" has been parked on their street during dismissal this week too. She said it was silver. Not sure if it's the same person everyone's talking about but the timing is suspicious.`,
  authorId: 'user_witness_c3',
  authorName: 'WashingtonMSparent',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

const connC4: CorpusItem = {
  id: 't1_conn_c4',
  type: 'comment',
  text: `Not sure if this is relevant but my Nextdoor group for the 14th district has been blowing up about someone taking pictures at parks too. Multiple reports from Riverside Park this past week, same description — heavyset guy in a red jacket. The posts there say he drives a Chrysler.`,
  authorId: 'user_witness_c4',
  authorName: 'NextdoorLurker',
  createdAt: 0,
  threadRootId: '',
  parentId: null,
}

// --- Exports ---

export const casePosts: CorpusItem[] = [caseA, caseB, caseC]

export const connectionItems: CorpusItem[] = [
  connA1, connA2, connA3, connA4,
  connB1, connB2, connB3, connB4,
  connC1, connC2, connC3, connC4,
]

export const buriedConnectionsGT: BuriedConnection[] = [
  {
    caseItemId: 't3_case_a',
    connections: [
      { connectedItemId: 't1_conn_a1', difficulty: 'easy', expectedRelationship: 'CONFIRMS' },
      { connectedItemId: 't1_conn_a2', difficulty: 'medium', expectedRelationship: 'UPDATES' },
      { connectedItemId: 't1_conn_a3', difficulty: 'hard', expectedRelationship: 'TEMPORAL' },
      { connectedItemId: 't1_conn_a4', difficulty: 'very-hard', expectedRelationship: 'CONFIRMS' },
    ],
  },
  {
    caseItemId: 't3_case_b',
    connections: [
      { connectedItemId: 't1_conn_b1', difficulty: 'easy', expectedRelationship: 'CONFIRMS' },
      { connectedItemId: 't1_conn_b2', difficulty: 'medium', expectedRelationship: 'UPDATES' },
      { connectedItemId: 't1_conn_b3', difficulty: 'hard', expectedRelationship: 'TEMPORAL' },
      { connectedItemId: 't1_conn_b4', difficulty: 'very-hard', expectedRelationship: 'CONFIRMS' },
    ],
  },
  {
    caseItemId: 't3_case_c',
    connections: [
      { connectedItemId: 't1_conn_c1', difficulty: 'easy', expectedRelationship: 'CONFIRMS' },
      { connectedItemId: 't1_conn_c2', difficulty: 'medium', expectedRelationship: 'UPDATES' },
      { connectedItemId: 't1_conn_c3', difficulty: 'hard', expectedRelationship: 'TEMPORAL' },
      { connectedItemId: 't1_conn_c4', difficulty: 'very-hard', expectedRelationship: 'UPDATES' },
    ],
  },
]

// Map connection IDs to which neutral thread they'll be placed in
export const connectionThreadAssignments: Record<string, string> = {
  't1_conn_a1': 't3_post_05', // streetlights thread (traffic/intersection context)
  't1_conn_a2': 't3_post_07', // neighborhood watch (camera footage context)
  't1_conn_a3': 't3_post_03', // car break-ins (parking/vehicle complaint)
  't1_conn_a4': 't3_post_10', // traffic calming (intersection safety)
  't1_conn_b1': 't3_post_03', // car break-ins (general theft)
  't1_conn_b2': 't3_post_01', // doorbell cameras (camera discussion)
  't1_conn_b3': 't3_post_09', // home security assessment (crime context)
  't1_conn_b4': 't3_post_06', // bike theft (theft/arrest)
  't1_conn_c1': 't3_post_02', // park safety (school/kid safety)
  't1_conn_c2': 't3_post_07', // neighborhood watch (community policing)
  't1_conn_c3': 't3_post_02', // park safety (school safety adjacent)
  't1_conn_c4': 't3_post_01', // doorbell cameras (cross-platform report)
}
