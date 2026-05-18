import { writeFileSync } from 'node:fs'
import OpenAI from 'openai'
import type { SyntheticCorpus, CorpusItem, GroundTruth } from './schemas.js'
import {
  distractorSchema, scamPatternSchema, ruleViolationSchema,
  standoutSchema, threadSchema,
} from './schemas.js'
import {
  RULES, DISTRACTOR_SYSTEM, distractorUserPrompt,
  SCAM_SYSTEM, scamPhonePrompt, scamUrlPrompt,
  ruleViolationSystem, ruleViolationUserPrompt,
  STANDOUT_SYSTEM, STANDOUT_USER,
  neutralThreadSystem, neutralThreadUserPrompt, AUTHOR_POOL,
} from './prompts.js'
import { casePosts, connectionItems, buriedConnectionsGT, connectionThreadAssignments } from './hand-crafted.js'
import { NEUTRAL_THREADS, computeTimeline } from './thread-topology.js'
import { createClient, CostTracker, nextCommentId, resetCommentCounter } from './util.js'
import { validateStructure, validateEntityOverlap, runLLMJudge, autoFix } from './validate.js'

async function generate(client: OpenAI, cost: CostTracker, systemPrompt: string, userPrompt: string, schema: Record<string, unknown>, schemaName: string) {
  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        schema,
        strict: true,
      },
    },
  })
  cost.track(response.usage)
  return JSON.parse(response.output_text)
}

async function main() {
  const client = createClient()
  const cost = new CostTracker(5.00)
  resetCommentCounter()

  console.log('Phase 1: Loading hand-crafted items...')
  const timeline = computeTimeline()

  // Assign timestamps to case posts
  for (const cp of casePosts) {
    cp.createdAt = timeline.casePostTimes[cp.id as keyof typeof timeline.casePostTimes]
  }

  // Assign timestamps + thread placement to connections
  for (const conn of connectionItems) {
    const caseId = buriedConnectionsGT.find(b => b.connections.some(c => c.connectedItemId === conn.id))!.caseItemId
    const caseTime = timeline.casePostTimes[caseId as keyof typeof timeline.casePostTimes]
    conn.createdAt = timeline.connectionTime(caseTime)
    conn.threadRootId = connectionThreadAssignments[conn.id]
  }

  console.log('Phase 2: Generating LLM batches in parallel...')

  // Fire all generation calls in parallel
  const [distractorResult, scamPhone, scamUrl, ...rest] = await Promise.all([
    // Distractors
    generate(client, cost, DISTRACTOR_SYSTEM, distractorUserPrompt(['5th and Main', 'Oakdale Street', 'Lincoln Elementary', 'Birchwood Ave', '14th Precinct']), distractorSchema, 'distractors'),
    // Scam patterns
    generate(client, cost, SCAM_SYSTEM, scamPhonePrompt('555-0183'), scamPatternSchema, 'scam_phone'),
    generate(client, cost, SCAM_SYSTEM, scamUrlPrompt('safecityclaims.net'), scamPatternSchema, 'scam_url'),
    // Rule violations (5 in parallel)
    ...RULES.map(rule => generate(client, cost, ruleViolationSystem(), ruleViolationUserPrompt(rule), ruleViolationSchema, `violations_${rule.id}`)),
    // Standouts
    generate(client, cost, STANDOUT_SYSTEM, STANDOUT_USER, standoutSchema, 'standouts'),
    // Neutral threads (10 in parallel)
    ...NEUTRAL_THREADS.map((thread, i) => {
      const authors = [AUTHOR_POOL[i * 4 % AUTHOR_POOL.length], ...AUTHOR_POOL.slice(i * 3, i * 3 + 8)]
      return generate(client, cost, neutralThreadSystem(), neutralThreadUserPrompt(thread.topic, thread.commentSlots, authors), threadSchema, `thread_${i}`)
    }),
  ])

  const [v1, v2, v3, v4, v5, standoutResult, ...threadResults] = rest

  console.log(`  API calls complete. ${cost.report()}`)

  console.log('Phase 3: Assembling corpus...')
  const allItems: CorpusItem[] = [...casePosts, ...connectionItems]
  const groundTruth: GroundTruth = {
    buriedConnections: buriedConnectionsGT,
    scamPatterns: [],
    ruleViolations: [],
    standouts: [],
    distractors: [],
  }

  // Distractors
  for (const d of distractorResult.items as Array<{ text: string; mentionedEntity: string; authorName: string }>) {
    const id = nextCommentId()
    const threadIdx = Math.floor(Math.random() * NEUTRAL_THREADS.length)
    allItems.push({
      id, type: 'comment', text: d.text,
      authorId: `user_${d.authorName.toLowerCase().replace(/\W/g, '_')}`,
      authorName: d.authorName,
      createdAt: 0, // assigned below
      threadRootId: NEUTRAL_THREADS[threadIdx].id,
      parentId: null,
    })
    groundTruth.distractors.push(id)
  }

  // Scam patterns
  const scamPhoneIds: string[] = []
  for (const s of scamPhone.items as Array<{ text: string; authorName: string }>) {
    const id = nextCommentId()
    const threadIdx = Math.floor(Math.random() * NEUTRAL_THREADS.length)
    allItems.push({
      id, type: 'comment', text: s.text,
      authorId: `user_scam_${s.authorName.toLowerCase().replace(/\W/g, '_')}`,
      authorName: s.authorName,
      createdAt: 0,
      threadRootId: NEUTRAL_THREADS[threadIdx].id,
      parentId: null,
    })
    scamPhoneIds.push(id)
  }
  groundTruth.scamPatterns.push({ patternId: 'scam_phone', sharedEntity: { type: 'phone', canonical: '555-0183' }, itemIds: scamPhoneIds })

  const scamUrlIds: string[] = []
  for (const s of scamUrl.items as Array<{ text: string; authorName: string }>) {
    const id = nextCommentId()
    const threadIdx = Math.floor(Math.random() * NEUTRAL_THREADS.length)
    allItems.push({
      id, type: 'comment', text: s.text,
      authorId: `user_scam_${s.authorName.toLowerCase().replace(/\W/g, '_')}`,
      authorName: s.authorName,
      createdAt: 0,
      threadRootId: NEUTRAL_THREADS[threadIdx].id,
      parentId: null,
    })
    scamUrlIds.push(id)
  }
  groundTruth.scamPatterns.push({ patternId: 'scam_url', sharedEntity: { type: 'url', canonical: 'safecityclaims.net' }, itemIds: scamUrlIds })

  // Rule violations
  const violationBatches = [v1, v2, v3, v4, v5]
  for (let ruleIdx = 0; ruleIdx < RULES.length; ruleIdx++) {
    const batch = violationBatches[ruleIdx] as { items: Array<{ text: string; authorName: string }> }
    for (const v of batch.items) {
      const id = nextCommentId()
      const threadIdx = Math.floor(Math.random() * NEUTRAL_THREADS.length)
      allItems.push({
        id, type: 'comment', text: v.text,
        authorId: `user_${v.authorName.toLowerCase().replace(/\W/g, '_')}`,
        authorName: v.authorName,
        createdAt: 0,
        threadRootId: NEUTRAL_THREADS[threadIdx].id,
        parentId: null,
      })
      groundTruth.ruleViolations.push({ itemId: id, violatesRule: RULES[ruleIdx].id })
    }
  }

  // Standouts
  for (const s of (standoutResult as { items: Array<{ text: string; authorName: string }> }).items) {
    const id = nextCommentId()
    const threadIdx = Math.floor(Math.random() * NEUTRAL_THREADS.length)
    allItems.push({
      id, type: 'comment', text: s.text,
      authorId: `user_${s.authorName.toLowerCase().replace(/\W/g, '_')}`,
      authorName: s.authorName,
      createdAt: 0,
      threadRootId: NEUTRAL_THREADS[threadIdx].id,
      parentId: null,
    })
    groundTruth.standouts.push(id)
  }

  // Neutral threads
  for (let i = 0; i < threadResults.length; i++) {
    const thread = threadResults[i] as { post: { text: string; authorName: string }; comments: Array<{ text: string; authorName: string; replyToIndex: number | null }> }
    const threadDef = NEUTRAL_THREADS[i]

    // Post
    allItems.push({
      id: threadDef.id, type: 'post', text: thread.post.text,
      authorId: `user_${thread.post.authorName.toLowerCase().replace(/\W/g, '_')}`,
      authorName: thread.post.authorName,
      createdAt: timeline.threadPostTimes[i],
      threadRootId: threadDef.id,
      parentId: null,
    })

    // Comments
    const commentIds: string[] = []
    const commentTimes = timeline.commentTimesForThread(timeline.threadPostTimes[i], thread.comments.length)
    for (let j = 0; j < thread.comments.length; j++) {
      const c = thread.comments[j]
      const id = nextCommentId()
      commentIds.push(id)
      const parentId = c.replyToIndex !== null && c.replyToIndex < commentIds.length - 1
        ? commentIds[c.replyToIndex]
        : null
      allItems.push({
        id, type: 'comment', text: c.text,
        authorId: `user_${c.authorName.toLowerCase().replace(/\W/g, '_')}`,
        authorName: c.authorName,
        createdAt: commentTimes[j],
        threadRootId: threadDef.id,
        parentId,
      })
    }
  }

  // Assign timestamps to items that don't have one yet (distractors, scam, violations, standouts)
  const needsTimestamp = allItems.filter(i => i.createdAt === 0 && i.type === 'comment')
  const fillerTimes = timeline.commentTimesForThread(timeline.baseTime, needsTimestamp.length)
  // Spread across the full 30-day window instead
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  for (let i = 0; i < needsTimestamp.length; i++) {
    needsTimestamp[i].createdAt = timeline.baseTime + Math.floor((i + 1) / (needsTimestamp.length + 1) * thirtyDays)
  }

  // Sort all items by createdAt for consistency
  allItems.sort((a, b) => a.createdAt - b.createdAt)

  const corpus: SyntheticCorpus = {
    subredditName: 'citysafety',
    rules: RULES,
    items: allItems,
    groundTruth,
  }

  console.log('Phase 4: Validation...')
  validateStructure(corpus)
  validateEntityOverlap(corpus)

  const judgeResult = await runLLMJudge(client, corpus, cost)

  if (judgeResult.flagged.length > 0) {
    corpus.items = await autoFix(client, corpus, judgeResult.flagged, cost)
  }

  // Final write
  writeFileSync(new URL('./corpus.json', import.meta.url), JSON.stringify(corpus, null, 2))

  console.log('\nDone!')
  console.log(`  Items: ${corpus.items.length}`)
  console.log(`  Posts: ${corpus.items.filter(i => i.type === 'post').length}`)
  console.log(`  Comments: ${corpus.items.filter(i => i.type === 'comment').length}`)
  console.log(`  Ground truth: ${groundTruth.buriedConnections.length} cases, ${groundTruth.scamPatterns.length} scam patterns, ${groundTruth.ruleViolations.length} violations, ${groundTruth.standouts.length} standouts, ${groundTruth.distractors.length} distractors`)
  console.log(`  ${cost.report()}`)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
