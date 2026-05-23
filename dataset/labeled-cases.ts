import type { RawItem } from '../src/engine/types.js'

const BASE = new Date('2026-04-01T00:00:00Z').getTime()
const day = (d: number, hour = 12): number => BASE + d * 86400000 + hour * 3600000

export type LabeledCase = {
  id: string
  description: string
  anchorId: string
  buriedWitnessIds: string[]
  inThreadIds: string[]
  decoyIds: string[]
}

const CASE = 't3_strata_casepost'
const TITLE = 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891'

const caseThread = (id: string, text: string, author: string, t: number): RawItem => ({
  id, type: 'comment', title: TITLE, text,
  authorId: `t2_${author.toLowerCase()}`, authorName: author,
  createdAt: t, threadRootId: CASE, parentId: CASE,
})

// Realistic case-thread chatter under the case post — sympathy, debate, mod,
// brigade-adjacent. These are in-thread "negatives" the scan must not confuse
// with cross-thread buried witnesses (S1..S4).
const caseThreadItems: RawItem[] = [
  caseThread('t1_strata_thread_sympathyA',
    "oh my god this is so awful. hope sarah pulls through. cambridge has gotten genuinely dangerous for cyclists, the city has to do something.",
    'CarsAreCancer', day(40, 11.2)),

  caseThread('t1_strata_thread_sympathyB',
    "Is there a gofundme? Happy to chip in for medical costs. Also if you need anything practical (food delivery, errands while you're at MGH) DM me — I live in Cambridgeport.",
    'PorterSqDoula', day(40, 12.8)),

  caseThread('t1_strata_thread_debateA',
    "i bike mass ave every weekday and the bike lane is genuinely a joke — it's just paint, cars drift into it constantly. reported 4 separate close calls at the prospect intersection in the last two months. until the city installs actual barriers this WILL keep happening.",
    'BikeCommuterMA', day(40, 13.5)),

  caseThread('t1_strata_thread_debateB',
    "Was she wearing a helmet? Asking because it matters legally if a lawyer gets involved later.",
    'LegalEagle2026', day(40, 15.1)),

  caseThread('t1_strata_thread_inthreadA',
    "I was at Inman Sq Pizza Tuesday around 6:15 and heard sirens go up Mass Ave a little after 6pm. Didn't connect anything at the time. So sorry, I hope your roommate makes it through this.",
    'InmanRegular', day(40, 19.3)),

  caseThread('t1_strata_thread_modA',
    "Stickying this for visibility. Witnesses please contact Cambridge PD non-emergency at 617-349-3300 or message the mod team directly. DO NOT name specific individuals in this thread based on partial vehicle descriptions — we will remove comments that do so.",
    'mod_team', day(41, 9)),

  caseThread('t1_strata_thread_inthreadB',
    "i bike home from kendall every tuesday around the same time. didn't see the actual hit but there was a dude in a dark car driving like a maniac up mass ave around 6pm. he came up behind me past mit and almost clipped me at the cambridge st light. couldn't get a make sorry.",
    'PedalingPanic', day(41, 11.4)),

  caseThread('t1_strata_thread_brigadeA',
    "This is exactly the kind of thread Reddit shouldn't be doing. Let the police actually investigate. Crowdsourced manhunts just get innocent people targeted because they happen to drive the same color car.",
    'ReasonableTakes', day(41, 17.8)),

  caseThread('t1_strata_thread_closureA',
    "Mods, can you keep an eye on this? I've already seen multiple comments trying to ID people based on 'dark green Subaru' alone. That description fits hundreds of cars in Cambridge.",
    'NotTheVigilante', day(42, 13.4)),

  caseThread('t1_strata_thread_updateA',
    "UPDATE from OP: Sarah is out of surgery, condition is stable but she'll be in the ICU at least another few days. Thank you all so much — this community has been incredible. Will update again when I can.",
    'SarahsRoommate2026', day(42, 16.2)),

  caseThread('t1_strata_thread_offtopicA',
    "Boston needs to actually invest in protected bike lanes. Other US cities figured this out 20 years ago. We're stuck with paint and prayer.",
    'UrbanistRanter', day(43, 10.7)),

  caseThread('t1_strata_thread_offtopicB',
    "Anyone heard whether the Mass Ave redesign got pushed again? It was supposed to break ground in 2025, then 2026, and now I'm hearing 2027. Meanwhile this stuff keeps happening.",
    'CivicMemoryNerd', day(43, 19.5)),
]

export const LABELED_CASE_ITEMS: RawItem[] = caseThreadItems

export const LABELED_CASES: Record<string, LabeledCase> = {
  'case-a-cyclist': {
    id: 'case-a-cyclist',
    description: 'Hit-and-run cyclist case. Sparse case post anchors only the incident + case# + partial plate. Four witnesses each link via one orthogonal channel: vehicle paraphrase (S1), exact identifier (S2), rare plate fragment (S3), narrative cosine (S4). Four decoys each attack one channel without belonging to the case.',
    anchorId: 't3_strata_casepost',
    buriedWitnessIds: [
      't1_strata_surface1',
      't3_strata_surface2',
      't1_strata_surface3',
      't3_strata_surface4',
    ],
    inThreadIds: [
      't1_strata_brigade1', 't1_strata_brigade2', 't1_strata_brigade3', 't1_strata_brigade4',
      't1_strata_flag2b',
      ...caseThreadItems.map(i => i.id),
    ],
    decoyIds: [
      't3_strata_decoy1',
      't1_strata_decoy2',
      't1_strata_decoy3',
      't3_strata_decoy4',
    ],
  },
}
