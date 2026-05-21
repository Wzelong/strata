import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import type { RawItem, RuleInput, FlagResult } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const RULES: RuleInput[] = [
  { id: 'rule-1', shortName: 'No doxxing', description: 'Do not post personal information including home addresses, phone numbers, or full names of private individuals', priority: 1 },
  { id: 'rule-2', shortName: 'No spam', description: 'No self-promotion, affiliate links, or repetitive posting of the same content', priority: 2 },
  { id: 'rule-3', shortName: 'Be civil', description: 'No personal attacks, harassment, or hate speech toward other users', priority: 3 },
  { id: 'rule-4', shortName: 'No witch-hunting', description: 'Do not post vague vehicle or person descriptions asking the community to identify or track someone without verified evidence such as a police case number or news report', priority: 4 },
]

const REMOVED_ITEMS: RawItem[] = [
  { id: 'removed-1', type: 'post', text: 'PSA: silver Honda on Beacon St keeps running the red at Mass Ave intersection. I don\'t have the plate but someone needs to stop this guy before he kills someone. He\'s there every morning around 8am.', authorId: 'u-removed-1', authorName: 'WatchDog1', createdAt: Date.now() - 20 * 86400000, threadRootId: 'removed-1', parentId: null },
  { id: 'removed-2', type: 'post', text: 'There\'s a white pickup that parks illegally on Cambridge St every night and I\'m pretty sure the driver is dealing. Can we get some eyes on this? License starts with 4R something.', authorId: 'u-removed-2', authorName: 'WatchDog2', createdAt: Date.now() - 15 * 86400000, threadRootId: 'removed-2', parentId: null },
  { id: 'removed-3', type: 'post', text: 'HEADS UP — blue minivan with NH plates keeps circling my block in Allston. I\'ve seen it 4 days in a row now just slowly driving past. This has to be casing houses right? Should I call police?', authorId: 'u-removed-3', authorName: 'WatchDog3', createdAt: Date.now() - 10 * 86400000, threadRootId: 'removed-3', parentId: null },
]

const BRIGADE_ITEMS: RawItem[] = [
  { id: 'brigade-1', type: 'comment', text: 'This is getting out of hand. You people are ready to ruin someone\'s life over a description that could match hundreds of green SUVs in Cambridge. This is a witch hunt.', authorId: 'u-brigade-1', authorName: 'BostonDriver2026_1', createdAt: Date.now() - 3600000, threadRootId: 'thread-case', parentId: 'thread-case' },
  { id: 'brigade-2', type: 'comment', text: 'Classic reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? This post should be taken down before someone gets hurt.', authorId: 'u-brigade-2', authorName: 'BostonDriver2026_2', createdAt: Date.now() - 3000000, threadRootId: 'thread-case', parentId: 'thread-case' },
  { id: 'brigade-3', type: 'comment', text: 'I drive past Cambridgeside garage every day and there\'s no damaged Subaru there. That commenter is either lying or confused. Stop spreading misinformation.', authorId: 'u-brigade-3', authorName: 'BostonDriver2026_3', createdAt: Date.now() - 2400000, threadRootId: 'thread-case', parentId: 'thread-case' },
  { id: 'brigade-4', type: 'comment', text: 'Has anyone verified this story is even real? No news articles, no police confirmation, just an anonymous reddit post. Maybe pump the brakes before destroying someone\'s reputation.', authorId: 'u-brigade-4', authorName: 'BostonDriver2026_4', createdAt: Date.now() - 1800000, threadRootId: 'thread-case', parentId: 'thread-case' },
]

const TEST_RULE_VIOLATION: RawItem = {
  id: 'test-rule', type: 'post',
  text: 'That jerk from the neighborhood meeting is Sarah Johnson, 45 Maple Dr unit 2A, Cambridge MA 02139. Her cell is 617-555-0199. Somebody should give her a piece of their mind about what she said.',
  authorId: 'u-test-1', authorName: 'TestViolator',
  createdAt: Date.now(), threadRootId: 'test-rule', parentId: null,
}

const TEST_PATTERN_MATCH: RawItem = {
  id: 'test-pattern', type: 'post',
  text: 'There\'s a black BMW that keeps speeding down my street in Somerville. No plate number but it has a dent on the rear bumper. Can someone help me identify the owner? This person needs to be stopped before they kill a kid. I\'ve seen them doing 50+ in a 25 zone every single day.',
  authorId: 'u-test-2', authorName: 'SomervilleWatcher',
  createdAt: Date.now(), threadRootId: 'test-pattern', parentId: null,
}

const TEST_BRIGADE_TRIGGER: RawItem = {
  id: 'test-brigade', type: 'comment',
  text: 'Everyone needs to calm down. This is literally a witch hunt based on a car color. Reddit detectives have ruined innocent lives before. Let the police do their job instead of harassing random Subaru owners.',
  authorId: 'u-brigade-5', authorName: 'BostonDriver2026_5',
  createdAt: Date.now() - 1200000, threadRootId: 'thread-case', parentId: 'thread-case',
}

const TEST_CLEAN: RawItem = {
  id: 'test-clean', type: 'post',
  text: 'What are the best parks for jogging near Porter Square? I usually run 5k in the morning before work and prefer paved paths with good lighting.',
  authorId: 'u-test-3', authorName: 'PorterRunner',
  createdAt: Date.now(), threadRootId: 'test-clean', parentId: null,
}

function printResult(label: string, results: FlagResult[]) {
  if (results.length === 0) {
    console.log(`  Result: NO FLAGS`)
  } else {
    for (const r of results) {
      console.log(`  Result: ${r.type} | confidence: ${r.confidence} | connections: ${r.connectionItems.length}`)
      console.log(`  Reasoning: ${r.reasoning.slice(0, 120)}`)
      if (r.ruleId) console.log(`  Rule: ${r.ruleId}`)
    }
  }
}

async function main() {
  console.log('=== Flag Pipeline Validation ===\n')
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client)
  let passed = 0, failed = 0

  // Setup
  console.log('Setup: Loading rules...')
  await engine.loadRules(RULES)
  console.log(`  ${(await engine.getRules()).length} rules loaded\n`)

  console.log('Setup: Seeding removed items...')
  for (const raw of REMOVED_ITEMS) {
    const item = await engine.ingest(raw)
    await engine.recordDecision(item.id, 'removed', 'moderator', 'witch-hunting / no evidence')
  }
  console.log(`  ${REMOVED_ITEMS.length} items ingested & marked removed\n`)

  console.log('Setup: Seeding brigade items...')
  for (const raw of BRIGADE_ITEMS) {
    await engine.ingest(raw)
  }
  console.log(`  ${BRIGADE_ITEMS.length} brigade items ingested\n`)

  // Test 1: Rule violation
  console.log('--- Test 1: Rule Violation ---')
  const ruleItem = await engine.ingest(TEST_RULE_VIOLATION)
  const ruleFlags = await engine.flag(ruleItem)
  printResult('rule', ruleFlags)
  const hasRule = ruleFlags.some(f => f.type === 'rule')
  console.log(`  ${hasRule ? 'PASS' : 'FAIL'}: expected type=rule\n`)
  hasRule ? passed++ : failed++

  // Test 2: Pattern match
  console.log('--- Test 2: Pattern Match ---')
  const patternItem = await engine.ingest(TEST_PATTERN_MATCH)
  const patternFlags = await engine.flag(patternItem)
  printResult('pattern', patternFlags)
  const hasPattern = patternFlags.some(f => f.type === 'pattern')
  console.log(`  ${hasPattern ? 'PASS' : 'FAIL'}: expected type=pattern\n`)
  hasPattern ? passed++ : failed++

  // Test 3: Brigade
  console.log('--- Test 3: Brigade ---')
  const brigadeItem = await engine.ingest(TEST_BRIGADE_TRIGGER)
  const brigadeFlags = await engine.flag(brigadeItem)
  printResult('brigade', brigadeFlags)
  const hasBrigade = brigadeFlags.some(f => f.type === 'brigade')
  console.log(`  ${hasBrigade ? 'PASS' : 'FAIL'}: expected type=brigade\n`)
  hasBrigade ? passed++ : failed++

  // Test 4: Clean item
  console.log('--- Test 4: Clean Item ---')
  const cleanItem = await engine.ingest(TEST_CLEAN)
  const cleanFlags = await engine.flag(cleanItem)
  printResult('clean', cleanFlags)
  const isClean = cleanFlags.length === 0
  console.log(`  ${isClean ? 'PASS' : 'FAIL'}: expected no flags\n`)
  isClean ? passed++ : failed++

  // Summary
  console.log(`=== ${passed}/${passed + failed} PASSED ===`)
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
