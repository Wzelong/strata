import type { Rule } from './schemas.js'

export const RULES: Rule[] = [
  { id: 'rule_1', shortName: 'No personal information', description: 'No full names, addresses, license plates, or contact info of private individuals.', priority: 1 },
  { id: 'rule_2', shortName: 'No vigilantism', description: 'Do not encourage finding or confronting alleged perpetrators.', priority: 2 },
  { id: 'rule_3', shortName: 'Stay on topic', description: 'Must relate to city safety.', priority: 3 },
  { id: 'rule_4', shortName: 'No misinformation', description: 'Claims should be sourced or qualified.', priority: 4 },
  { id: 'rule_5', shortName: 'Be civil', description: 'No harassment or hostile language.', priority: 5 },
]

export const DISTRACTOR_SYSTEM = `You generate realistic Reddit comments for r/citysafety, a local safety incident reporting community.

Rules:
1. Each comment mentions a specific location from the provided list.
2. The comment must be about a mundane, non-safety topic at that location (restaurant, coffee shop, parking, construction, community event, business opening).
3. Each comment is 2-4 sentences, sounds like a natural Reddit comment.
4. Use casual Reddit tone — contractions, sentence fragments are fine.
5. Do NOT write about safety incidents, crimes, or anything alarming at these locations.`

export function distractorUserPrompt(locations: string[]): string {
  return `Generate 8 distractor comments. Each must mention one of these locations: ${locations.map(l => `"${l}"`).join(', ')}.

Distribute locations roughly evenly (some can repeat). Comments should discuss: restaurant quality, parking difficulty, a new store opening, construction noise, a farmers market, a coffee shop, etc. Keep them grounded and specific.`
}

export const SCAM_SYSTEM = `You generate realistic Reddit comments for r/citysafety where community members report suspicious scams.

Rules:
1. Each comment is a first-person report from a different community member.
2. All comments in a batch report the SAME scam using the SAME exact identifier (phone number or URL).
3. The identifier must appear verbatim and unmodified in each comment.
4. Each comment uses different wording, context, and personal details.
5. Each comment is 2-5 sentences.
6. Casual Reddit tone — these are real people warning their neighbors.`

export function scamPhonePrompt(phoneNumber: string): string {
  return `Generate 4 comments from different community members all reporting the same locksmith/repair scam. The scammer quotes a low price on the phone then demands 3-5x more once they arrive.

The shared phone number is: ${phoneNumber}

Each comment must:
- Include the phone number "${phoneNumber}" verbatim at least once
- Describe a slightly different personal experience (different service, different time, different amount demanded)
- Sound like an authentic annoyed Reddit user warning others`
}

export function scamUrlPrompt(url: string): string {
  return `Generate 4 comments from different community members all reporting the same phishing website. The site pretends to be a city program for filing insurance claims after incidents, but it harvests personal information.

The shared URL is: ${url}

Each comment must:
- Include "${url}" verbatim at least once
- Describe how they encountered the link (texted to them, found on flyer, shared in a Facebook group, etc.)
- Mention what tipped them off it was fake
- Sound like an authentic Reddit user warning others`
}

export function ruleViolationSystem(): string {
  return `You generate Reddit comments for r/citysafety that violate a specific community rule. Each comment should clearly and unambiguously violate the stated rule while still being a plausible thing someone might post in a city safety community.

Rules:
1. Each comment violates ONLY the specified rule (not multiple rules).
2. Each comment is 2-4 sentences.
3. Vary the severity across the 4 comments: one mild, two moderate, one egregious.
4. Comments should feel like real angry/careless/misguided Reddit users, not obviously fake.
5. Casual Reddit tone.`
}

export function ruleViolationUserPrompt(rule: Rule): string {
  const examples: Record<string, string> = {
    'rule_1': 'Posting someone\'s full name + home address, sharing a license plate number, revealing private phone numbers of non-public figures.',
    'rule_2': 'Encouraging others to track down a suspect, suggesting people confront or follow someone, organizing vigilante patrols to "handle" someone.',
    'rule_3': 'Completely off-topic content: political rants unrelated to safety, sports discussions, personal relationship drama, product reviews with no safety angle.',
    'rule_4': 'Stating unverified claims as fact: "I heard crime is up 500%", making up statistics, spreading debunked conspiracy theories about local events.',
    'rule_5': 'Name-calling other users, personal attacks, threatening language, hostile sarcasm directed at specific community members.',
  }

  return `Generate exactly 4 comments that violate Rule: "${rule.shortName}" — ${rule.description}

Violation examples for this rule: ${examples[rule.id]}

Requirements:
- Comment 1: mild violation (borderline, a reasonable person might debate whether it crosses the line)
- Comments 2-3: moderate violations (clearly breaks the rule, would be removed by most mods)
- Comment 4: egregious violation (flagrant, no ambiguity)
- Each should be topically related to city safety in some way (a safety discussion gone wrong) EXCEPT for rule_3 violations which should be off-topic by definition`
}

export const STANDOUT_SYSTEM = `You generate exceptional Reddit comments for r/citysafety that a moderator would want to highlight or distinguish. These demonstrate genuine expertise, provide actionable community value, or show compassionate support.

Rules:
1. Each comment is 3-6 sentences.
2. Each demonstrates a distinct quality: expert knowledge, actionable advice, cited data, compassionate support, or insightful pattern analysis.
3. Comments should sound like real people with genuine expertise — not formal or academic.
4. Include specific details (names of programs, realistic statistics, concrete steps).
5. Vary the topics across safety domains: emergency prep, home security, traffic safety, personal safety, community organizing.`

export const STANDOUT_USER = `Generate 10 standout comments for r/citysafety. Each should embody one perspective:

1. A retired firefighter sharing emergency preparedness advice
2. A locksmith explaining door security upgrades with specific product recommendations
3. Someone citing actual crime statistics to put a fear-based post in perspective
4. A trauma counselor offering support to someone who witnessed a break-in
5. A cyclist sharing a data-backed analysis of which intersections are most dangerous
6. An insurance adjuster explaining exactly what to document after a theft
7. A neighborhood watch organizer sharing what actually works vs what doesn't
8. A former dispatcher explaining when to call 911 vs non-emergency
9. Someone sharing a detailed after-action review of how their home camera system caught a thief
10. A city council staffer explaining how to actually get a speed bump installed on your street`

export function neutralThreadSystem(): string {
  return `You generate realistic Reddit threads for r/citysafety, a community where people discuss local safety concerns, crime prevention, and emergency preparedness.

Rules:
1. The post (thread root) is 2-4 sentences setting up a discussion topic.
2. Comments are 1-3 sentences each.
3. Mix of: direct answers, follow-up questions, disagreements, personal anecdotes, helpful tips.
4. Natural conversation flow — some comments reply to each other.
5. Casual Reddit tone: contractions, sentence fragments, occasional humor.
6. Content is on-topic but neutral — no rule violations, not exceptionally high quality, not connected to any specific crime case.
7. Use the provided author names.`
}

export function neutralThreadUserPrompt(topic: string, commentCount: number, authorNames: string[]): string {
  return `Generate a thread about: "${topic}"

Create 1 post + ${commentCount} comments.
- The post author is "${authorNames[0]}".
- Assign remaining comments to authors from this pool (reuse is fine): ${authorNames.slice(1).map(n => `"${n}"`).join(', ')}
- For "replyToIndex": use null for top-level comments, or the 0-based index of the comment being replied to for nested replies. About 30-40% of comments should be replies to earlier comments.
- Keep discussion realistic and grounded — specific product names, local landmarks, practical advice.`
}

export const AUTHOR_POOL = [
  'SafetyFirst_2024', 'DowntownCommuter', 'EastSideResident', 'NightOwlRunner',
  'SuburbanDad42', 'BikeToWork_Amy', 'NewToTheArea', 'RetiredTeacher_M',
  'ConcernedRenter', 'DogWalkerSteve', 'NurseOnCall', 'TechBroSecurity',
  'GardenDistrictGal', 'UberDriverMike', 'StayAlertStaySafe', 'MidtownMom',
  'PorchLightOn', 'QuietStreetQuin', 'FirstResponderWife', 'CollegeKid_2025',
  'RetiredCop_Frank', 'YogaTeacher_Zen', 'DIY_HomeSec', 'MailCarrierJen',
  'EarlyMorningJogger', 'ApartmentDweller9', 'SmallBizOwner_T', 'ParkRanger_Nat',
  'TrafficEngineer101', 'OldTimerHank', 'SingleMomSara', 'BlockCaptainLee',
  'InsuranceGuyPete', 'WalkingSchoolBus', 'NeighborlyNick', 'CameraGeekRon',
  'PrepperLite_Jane', 'CrosswalkCrusader', 'LateNightWorker', 'CommunityGardenAl',
]

export const JUDGE_SYSTEM = `You evaluate synthetic Reddit comments for realism. Rate each comment on three dimensions (1-5 scale):

- realism: Does this sound like a real Reddit comment? (5 = indistinguishable from real, 1 = obviously AI-generated or nonsensical)
- coherence: Is the text internally consistent? (5 = perfectly clear, 1 = contradictory or confused)
- onTopic: Does this relate to city safety? (5 = clearly on topic, 1 = completely unrelated)

Be a tough but fair judge. Most real Reddit comments would score 3-4 on realism. A 5 should be genuinely hard to distinguish from a scraped comment.`

export function judgeUserPrompt(items: Array<{ index: number; text: string }>): string {
  const formatted = items.map(i => `[${i.index}] ${i.text}`).join('\n\n')
  return `Rate each of the following comments:\n\n${formatted}`
}
