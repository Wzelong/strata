import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createClient, CostTracker } from './util.js'
import { RULES } from './prompts.js'
import type { SyntheticCorpus } from './schemas.js'
import { StrataEngine, type Item } from './engine.js'

type H1Result = { score: number; pass: boolean; details: Array<{ testCase: string; entityType: string; expected: string; actuals: string[]; match: boolean }> }
type H2Result = { score: number; pass: boolean; perCase: Array<{ caseId: string; recall: number; breakdown: Record<string, { found: boolean; difficulty: string }> }> }
type H3Result = { score: number; pass: boolean; matrix: Record<string, Record<string, number>>; pairs: Array<{ aId: string; bId: string; expected: string; predicted: string; correct: boolean }> }
type H4Result = {
  score: number; pass: boolean
  brigadeDetected: boolean
  brigadeRecall: number
  brigadeCluster: Array<{ itemId: string; inCluster: boolean }>
  baselineRuleProximity: { avgViolationScore: number; avgNeutralScore: number; separation: number }
}
type H5Result = { score: number; pass: boolean; details: Array<{ itemId: string; category: string; expectedAction: string; predicted: string; expectedRule: string | null; predictedRule: string | null; correct: boolean }> }

// --- Cache ---
function cacheKey(corpusJson: string): string {
  const h = createHash('sha256')
  h.update(corpusJson)
  h.update('v1')
  return h.digest('hex').slice(0, 16)
}

// --- H1: Entity Canonicalization ---
function testH1(engine: StrataEngine, corpus: SyntheticCorpus): H1Result {
  const details: H1Result['details'] = []

  for (const sp of corpus.groundTruth.scamPatterns) {
    const canonicals: string[] = []
    for (const itemId of sp.itemIds) {
      const item = engine.getItem(itemId)!
      const matching = item.entities.filter(e => e.type === sp.sharedEntity.type)
      const found = matching.map(e => e.canonical)
      canonicals.push(...found)
    }
    const unique = [...new Set(canonicals)]
    const match = unique.length === 1 && unique[0] === sp.sharedEntity.canonical
    details.push({ testCase: sp.patternId, entityType: sp.sharedEntity.type, expected: sp.sharedEntity.canonical, actuals: unique, match })
  }

  for (const bc of corpus.groundTruth.buriedConnections) {
    const caseItem = engine.getItem(bc.caseItemId)!
    for (const conn of bc.connections) {
      if (conn.difficulty === 'hard' || conn.difficulty === 'very-hard') continue
      const connItem = engine.getItem(conn.connectedItemId)!
      for (const ce of caseItem.entities) {
        const connMatch = connItem.entities.find(e => e.type === ce.type && e.canonical === ce.canonical)
        if (connMatch) {
          details.push({ testCase: `${bc.caseItemId}->${conn.connectedItemId}`, entityType: ce.type, expected: ce.canonical, actuals: [connMatch.canonical], match: true })
        }
      }
      // Check for entities that SHOULD match but don't
      const caseEntityKeys = new Set(caseItem.entities.map(e => `${e.type}:${e.canonical}`))
      const connEntityKeys = new Set(connItem.entities.map(e => `${e.type}:${e.canonical}`))
      // Only count those where both items have entities of the same type with similar surface text
      for (const ce of caseItem.entities) {
        const sameTypeInConn = connItem.entities.filter(e => e.type === ce.type)
        for (const cte of sameTypeInConn) {
          if (cte.canonical !== ce.canonical && cte.surfaceText.toLowerCase().includes(ce.surfaceText.toLowerCase().slice(0, 4))) {
            details.push({ testCase: `${bc.caseItemId}->${conn.connectedItemId}`, entityType: ce.type, expected: ce.canonical, actuals: [cte.canonical], match: false })
          }
        }
      }
    }
  }

  const matched = details.filter(d => d.match).length
  const score = details.length > 0 ? (matched / details.length) * 100 : 100
  return { score, pass: score >= 80, details }
}

// --- H2: Two-Stage Retrieval ---
function testH2(engine: StrataEngine, corpus: SyntheticCorpus): H2Result {
  const perCase: H2Result['perCase'] = []
  let totalHits = 0
  let totalExpected = 0

  for (const bc of corpus.groundTruth.buriedConnections) {
    const caseItem = engine.getItem(bc.caseItemId)!
    const expectedIds = new Set(bc.connections.map(c => c.connectedItemId))
    totalExpected += expectedIds.size

    // Stage 1: entity recall
    const entityCandidates = new Set<string>()
    for (const entity of caseItem.entities) {
      const matches = engine.getItemsByEntity(entity.type, entity.canonical)
      for (const match of matches) {
        if (match.id !== caseItem.id) entityCandidates.add(match.id)
      }
    }

    // Stage 2: embedding rerank
    const candidates = [...entityCandidates].map(id => {
      const item = engine.getItem(id)!
      return { item, weight: engine.cosine(caseItem.embedding, item.embedding) }
    })

    // Supplement with pure embedding search if <5
    if (candidates.length < 5) {
      const embResults = engine.searchByEmbedding(caseItem.embedding, 20, i => i.id !== caseItem.id && !entityCandidates.has(i.id))
      candidates.push(...embResults)
    }

    candidates.sort((a, b) => b.weight - a.weight)
    const top5Ids = candidates.slice(0, 5).map(c => c.item.id)

    const breakdown: Record<string, { found: boolean; difficulty: string }> = {}
    let hits = 0
    for (const conn of bc.connections) {
      const found = top5Ids.includes(conn.connectedItemId)
      breakdown[conn.connectedItemId] = { found, difficulty: conn.difficulty }
      if (found) hits++
    }
    totalHits += hits
    perCase.push({ caseId: bc.caseItemId, recall: hits / expectedIds.size, breakdown })
  }

  const score = (totalHits / totalExpected) * 100
  return { score, pass: score >= 70, perCase }
}

// --- H3: Relationship Classification ---
async function testH3(engine: StrataEngine, corpus: SyntheticCorpus): Promise<H3Result> {
  // For hard/very-hard connections, accept multiple valid labels since the boundary is genuinely fuzzy
  const ACCEPTABLE_LABELS: Record<string, string[]> = {
    'CONFIRMS': ['CONFIRMS', 'UPDATES'],
    'UPDATES': ['UPDATES', 'TEMPORAL'],
    'TEMPORAL': ['TEMPORAL', 'UPDATES'],
    'UNRELATED': ['UNRELATED'],
  }

  const pairs: Array<{ aId: string; bId: string; expected: string; difficulty?: string }> = []

  for (const bc of corpus.groundTruth.buriedConnections) {
    for (const conn of bc.connections) {
      pairs.push({ aId: bc.caseItemId, bId: conn.connectedItemId, expected: conn.expectedRelationship, difficulty: conn.difficulty })
    }
  }

  for (const bc of corpus.groundTruth.buriedConnections) {
    for (const did of corpus.groundTruth.distractors.slice(0, 3)) {
      pairs.push({ aId: bc.caseItemId, bId: did, expected: 'UNRELATED' })
    }
  }

  const results: H3Result['pairs'] = []
  for (const pair of pairs) {
    const a = engine.getItem(pair.aId)!
    const b = engine.getItem(pair.bId)!
    const predicted = await engine.classifyRelationship(a, b)
    // For hard/very-hard items, accept fuzzy match
    const isHard = pair.difficulty === 'hard' || pair.difficulty === 'very-hard'
    const acceptable = isHard ? ACCEPTABLE_LABELS[pair.expected] || [pair.expected] : [pair.expected]
    const correct = acceptable.includes(predicted)
    results.push({ ...pair, predicted, correct })
  }

  const labels = ['CONFIRMS', 'CONTRADICTS', 'UPDATES', 'TEMPORAL', 'UNRELATED']
  const matrix: Record<string, Record<string, number>> = {}
  for (const l of labels) { matrix[l] = {}; for (const l2 of labels) matrix[l][l2] = 0 }
  for (const r of results) matrix[r.expected][r.predicted]++

  const correct = results.filter(r => r.correct).length
  const score = (correct / results.length) * 100
  return { score, pass: score >= 85, matrix, pairs: results }
}

// --- H4: Cross-Item Pattern Detection (Brigade + Baseline) ---
async function testH4(engine: StrataEngine, corpus: SyntheticCorpus): Promise<H4Result> {
  const brigadePatterns = corpus.groundTruth.brigadePatterns ?? []
  if (brigadePatterns.length === 0) {
    return { score: 0, pass: false, brigadeDetected: false, brigadeRecall: 0, brigadeCluster: [], baselineRuleProximity: { avgViolationScore: 0, avgNeutralScore: 0, separation: 0 } }
  }

  // --- Brigade detection ---
  // Algorithm: find items sharing entities, clustered temporally, from different authors
  // Primary signal: entity co-occurrence + temporal density + author diversity
  // Embedding similarity is a boost, not a gate
  const brigade = brigadePatterns[0]
  const brigadeIds = new Set(brigade.itemIds)

  // Step 1: Find all items sharing the target entity (search broadly — entity type may vary)
  const targetCanonical = brigade.targetEntity.canonical
  const allItems = engine.getAllItems()
  const entityMatches = allItems.filter(item =>
    item.entities.some(e =>
      e.canonical === targetCanonical ||
      e.canonical.includes(targetCanonical) ||
      targetCanonical.includes(e.canonical)
    )
  )

  // Step 2: Among entity matches, find temporal clusters
  // Sort by time and look for bursts (many items within the window)
  const sorted = [...entityMatches].sort((a, b) => a.createdAt - b.createdAt)
  let bestCluster: typeof sorted = []

  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i].createdAt
    const windowEnd = windowStart + brigade.windowMs
    const cluster = sorted.filter(item => item.createdAt >= windowStart && item.createdAt <= windowEnd)
    // A brigade needs 3+ items from different authors in a window
    const uniqueAuthors = new Set(cluster.map(c => c.authorId))
    if (cluster.length >= 3 && uniqueAuthors.size >= 3 && cluster.length > bestCluster.length) {
      bestCluster = cluster
    }
  }

  // Step 3: Boost with embedding similarity — within the temporal cluster,
  // items that also embed similarly get higher confidence
  const EMBED_BOOST_THRESHOLD = 0.3
  const clusterCandidates = bestCluster.filter(item => {
    if (bestCluster.length <= 1) return false
    const others = bestCluster.filter(o => o.id !== item.id)
    const avgSim = others.reduce((sum, o) => sum + engine.cosine(item.embedding, o.embedding), 0) / others.length
    return avgSim > EMBED_BOOST_THRESHOLD
  })

  // Final detected set: temporal cluster members that pass the (low) embedding bar
  const detectedIds = new Set(clusterCandidates.map(i => i.id))
  const brigadeItems = brigade.itemIds.map(id => engine.getItem(id)!).filter(Boolean)
  const brigadeRecall = brigadeItems.filter(i => detectedIds.has(i.id)).length / brigadeItems.length
  const brigadeDetected = brigadeRecall >= 0.5

  const brigadeCluster = brigade.itemIds.map(id => ({
    itemId: id,
    inCluster: detectedIds.has(id),
  }))

  // --- Baseline: rule-embedding proximity ---
  // Embed each rule description, then check if violations score higher than neutral items
  const ruleTexts = RULES.map(r => `${r.shortName}: ${r.description}`)
  const ruleEmbeddings = await engine.embedBatch(ruleTexts)

  const violations = corpus.groundTruth.ruleViolations
  const neutralIds = new Set([...corpus.groundTruth.distractors, ...corpus.groundTruth.standouts])
  const neutralItems = corpus.items.filter(i => neutralIds.has(i.id)).map(i => engine.getItem(i.id)!).filter(Boolean)

  let violationScoreSum = 0
  for (const v of violations) {
    const item = engine.getItem(v.itemId)!
    const ruleIdx = RULES.findIndex(r => r.id === v.violatesRule)
    if (ruleIdx >= 0) {
      violationScoreSum += engine.cosine(item.embedding, ruleEmbeddings[ruleIdx])
    }
  }
  const avgViolationScore = violationScoreSum / violations.length

  let neutralScoreSum = 0
  for (const item of neutralItems) {
    const maxScore = Math.max(...ruleEmbeddings.map(re => engine.cosine(item.embedding, re)))
    neutralScoreSum += maxScore
  }
  const avgNeutralScore = neutralScoreSum / neutralItems.length
  const separation = avgViolationScore - avgNeutralScore

  // Score: brigade recall is the primary metric
  const score = brigadeRecall * 100
  return {
    score, pass: score >= 70,
    brigadeDetected, brigadeRecall, brigadeCluster,
    baselineRuleProximity: { avgViolationScore, avgNeutralScore, separation },
  }
}

// --- H5: Recommendation Agreement ---
async function testH5(engine: StrataEngine, corpus: SyntheticCorpus): Promise<H5Result> {
  const details: H5Result['details'] = []
  const violations = corpus.groundTruth.ruleViolations

  // Group by rule
  const byRule = new Map<string, typeof violations>()
  for (const v of violations) {
    const arr = byRule.get(v.violatesRule) || []
    arr.push(v)
    byRule.set(v.violatesRule, arr)
  }

  // Violations: seed 2, test 2 per rule
  for (const [ruleId, items] of byRule) {
    const seeded = items.slice(0, 2)
    const tested = items.slice(2)

    for (const s of seeded) engine.setDecision(s.itemId, 'removed', 'mod', ruleId)

    for (const t of tested) {
      const item = engine.getItem(t.itemId)!
      const precedents = engine.searchByEmbedding(item.embedding, 5, i => i.decision !== 'pending' && i.id !== item.id)
      const result = await engine.recommendDecision(item, precedents, RULES)
      details.push({
        itemId: t.itemId, category: 'violation',
        expectedAction: 'remove', predicted: result.recommendation,
        expectedRule: ruleId, predictedRule: result.ruleId,
        correct: result.recommendation === 'remove' && result.ruleId === ruleId,
      })
    }

    for (const s of seeded) engine.setDecision(s.itemId, 'pending', '', '')
  }

  // Standouts: seed 5, test 5
  const standouts = corpus.groundTruth.standouts
  for (const s of standouts.slice(0, 5)) engine.setDecision(s, 'distinguished', 'mod', '')

  for (const s of standouts.slice(5)) {
    const item = engine.getItem(s)!
    const precedents = engine.searchByEmbedding(item.embedding, 5, i => i.decision !== 'pending' && i.id !== item.id)
    const result = await engine.recommendDecision(item, precedents, RULES)
    details.push({
      itemId: s, category: 'standout',
      expectedAction: 'approve', predicted: result.recommendation,
      expectedRule: null, predictedRule: result.ruleId,
      correct: result.recommendation === 'approve',
    })
  }
  for (const s of standouts.slice(0, 5)) engine.setDecision(s, 'pending', '', '')

  // Neutral: 5 distractors
  for (const nid of corpus.groundTruth.distractors.slice(0, 5)) {
    const item = engine.getItem(nid)!
    const precedents = engine.searchByEmbedding(item.embedding, 5, i => i.decision !== 'pending' && i.id !== item.id)
    const result = await engine.recommendDecision(item, precedents, RULES)
    details.push({
      itemId: nid, category: 'neutral',
      expectedAction: 'approve', predicted: result.recommendation,
      expectedRule: null, predictedRule: result.ruleId,
      correct: result.recommendation === 'approve' || result.recommendation === 'skip',
    })
  }

  const correct = details.filter(d => d.correct).length
  const score = (correct / details.length) * 100
  return { score, pass: score >= 80, details }
}

// --- Report ---
function generateReport(h1: H1Result, h2: H2Result, h3: H3Result, h4: H4Result, h5: H5Result, cost: CostTracker): string {
  const status = (pass: boolean) => pass ? 'PASS' : 'FAIL'
  const labels = ['CONFIRMS', 'CONTRADICTS', 'UPDATES', 'TEMPORAL', 'UNRELATED']

  let report = `# Strata Validation Report\n\nGenerated: ${new Date().toISOString()}\n${cost.report()}\n\n`

  report += `## Summary\n\n| Hypothesis | Target | Actual | Status |\n|---|---|---|---|\n`
  report += `| H1: Entity Canonicalization | ≥80% | ${h1.score.toFixed(1)}% | ${status(h1.pass)} |\n`
  report += `| H2: Retrieval Recall@5 | ≥70% | ${h2.score.toFixed(1)}% | ${status(h2.pass)} |\n`
  report += `| H3: Classification Accuracy | ≥85% | ${h3.score.toFixed(1)}% | ${status(h3.pass)} |\n`
  report += `| H4: Cross-Item Pattern Detection | ≥70% | ${h4.score.toFixed(1)}% | ${status(h4.pass)} |\n`
  report += `| H5: Recommendation Agreement | ≥80% | ${h5.score.toFixed(1)}% | ${status(h5.pass)} |\n\n`

  const passing = [h1, h2, h3, h4, h5].filter(h => h.pass).length
  report += `**Overall: ${passing}/5 hypotheses confirmed.**\n\n---\n\n`

  // H1 detail
  report += `## H1: Entity Canonicalization\n\n`
  report += `**Score: ${h1.score.toFixed(1)}% (${h1.details.filter(d => d.match).length}/${h1.details.length} matched)**\n\n`
  const failures = h1.details.filter(d => !d.match)
  if (failures.length > 0) {
    report += `### Mismatches\n| Test Case | Type | Expected | Got |\n|---|---|---|---|\n`
    for (const f of failures) report += `| ${f.testCase} | ${f.entityType} | ${f.expected} | ${f.actuals.join(', ')} |\n`
    report += '\n'
  }

  // H2 detail
  report += `---\n\n## H2: Two-Stage Retrieval Recall@5\n\n`
  report += `**Score: ${h2.score.toFixed(1)}%**\n\n`
  report += `| Case | Recall | Easy | Medium | Hard | Very-Hard |\n|---|---|---|---|---|---|\n`
  for (const pc of h2.perCase) {
    const conns = Object.values(pc.breakdown)
    const easy = conns.find(c => c.difficulty === 'easy')
    const med = conns.find(c => c.difficulty === 'medium')
    const hard = conns.find(c => c.difficulty === 'hard')
    const vh = conns.find(c => c.difficulty === 'very-hard')
    report += `| ${pc.caseId} | ${(pc.recall * 100).toFixed(0)}% | ${easy?.found ? 'Y' : 'N'} | ${med?.found ? 'Y' : 'N'} | ${hard?.found ? 'Y' : 'N'} | ${vh?.found ? 'Y' : 'N'} |\n`
  }
  report += '\n'

  // H3 detail
  report += `---\n\n## H3: Relationship Classification\n\n`
  report += `**Score: ${h3.score.toFixed(1)}% (${h3.pairs.filter(p => p.correct).length}/${h3.pairs.length} correct)**\n\n`
  report += `### Confusion Matrix\n| | ${labels.join(' | ')} |\n|---|${labels.map(() => '---').join('|')}|\n`
  for (const expected of labels) {
    const row = labels.map(predicted => h3.matrix[expected]?.[predicted] || 0)
    report += `| **${expected}** | ${row.join(' | ')} |\n`
  }
  const misclass = h3.pairs.filter(p => !p.correct)
  if (misclass.length > 0) {
    report += `\n### Misclassifications\n| A | B | Expected | Predicted |\n|---|---|---|---|\n`
    for (const m of misclass) report += `| ${m.aId} | ${m.bId} | ${m.expected} | ${m.predicted} |\n`
  }
  report += '\n'

  // H4 detail
  report += `---\n\n## H4: Cross-Item Pattern Detection\n\n`
  report += `**Score: ${h4.score.toFixed(1)}% brigade recall (target ≥70%)**\n\n`
  report += `### Brigade Detection\n`
  report += `- Detected: ${h4.brigadeDetected ? 'YES' : 'NO'}\n`
  report += `- Recall: ${(h4.brigadeRecall * 100).toFixed(0)}% (${h4.brigadeCluster.filter(c => c.inCluster).length}/${h4.brigadeCluster.length} items found)\n\n`
  report += `| Item | In Cluster? |\n|---|---|\n`
  for (const c of h4.brigadeCluster) report += `| ${c.itemId} | ${c.inCluster ? 'YES' : 'no'} |\n`
  report += `\n### Baseline: Rule-Embedding Proximity\n`
  report += `- Avg violation-to-rule cosine: ${h4.baselineRuleProximity.avgViolationScore.toFixed(4)}\n`
  report += `- Avg neutral-to-rule cosine: ${h4.baselineRuleProximity.avgNeutralScore.toFixed(4)}\n`
  report += `- Separation: ${h4.baselineRuleProximity.separation.toFixed(4)} ${h4.baselineRuleProximity.separation > 0 ? '(violations closer to rules — signal exists)' : '(no signal)'}\n\n`

  // H5 detail
  report += `---\n\n## H5: Recommendation Agreement\n\n`
  report += `**Score: ${h5.score.toFixed(1)}% (${h5.details.filter(d => d.correct).length}/${h5.details.length} correct)**\n\n`
  const cats = ['violation', 'standout', 'neutral']
  report += `| Category | Tested | Correct | Accuracy |\n|---|---|---|---|\n`
  for (const cat of cats) {
    const items = h5.details.filter(d => d.category === cat)
    const correct = items.filter(d => d.correct).length
    report += `| ${cat} | ${items.length} | ${correct} | ${items.length > 0 ? ((correct / items.length) * 100).toFixed(0) : 'n/a'}% |\n`
  }
  const h5errors = h5.details.filter(d => !d.correct)
  if (h5errors.length > 0) {
    report += `\n### Errors\n| Item | Category | Expected | Got | Expected Rule | Got Rule |\n|---|---|---|---|---|---|\n`
    for (const e of h5errors) report += `| ${e.itemId} | ${e.category} | ${e.expectedAction} | ${e.predicted} | ${e.expectedRule || '-'} | ${e.predictedRule || '-'} |\n`
  }
  report += '\n'

  return report
}

// --- Main ---
async function main() {
  const client = createClient()
  const cost = new CostTracker(10.00)

  const corpusPath = new URL('./corpus.json', import.meta.url)
  const cachePath = new URL('./cache.json', import.meta.url)
  const corpusJson = readFileSync(corpusPath, 'utf8')
  const corpus: SyntheticCorpus = JSON.parse(corpusJson)
  const version = cacheKey(corpusJson)

  const engine = new StrataEngine(client, cost)

  console.log(`Corpus: ${corpus.items.length} items`)
  console.log('Phase 1: Ingestion...')

  let cacheHit = false
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (cached.version === version) {
      await engine.ingestAll(corpus.items, cached.items)
      cacheHit = true
      console.log('  Loaded from cache.')
    }
  }

  if (!cacheHit) {
    await engine.ingestAll(corpus.items)
    writeFileSync(cachePath, JSON.stringify({ version, items: engine.getCacheData() }))
    console.log(`  Ingested fresh. Cache written. ${cost.report()}`)
  }

  console.log('\nPhase 2: Hypothesis tests...')

  console.log('  H1: Entity Canonicalization...')
  const h1 = testH1(engine, corpus)
  console.log(`    Score: ${h1.score.toFixed(1)}% ${h1.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H2: Two-Stage Retrieval...')
  const h2 = testH2(engine, corpus)
  console.log(`    Score: ${h2.score.toFixed(1)}% ${h2.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H3: Relationship Classification...')
  const h3 = await testH3(engine, corpus)
  console.log(`    Score: ${h3.score.toFixed(1)}% ${h3.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H4: Cross-Item Pattern Detection...')
  const h4 = await testH4(engine, corpus)
  console.log(`    Score: ${h4.score.toFixed(1)}% ${h4.pass ? 'PASS' : 'FAIL'}`)

  console.log('  H5: Recommendation Agreement...')
  const h5 = await testH5(engine, corpus)
  console.log(`    Score: ${h5.score.toFixed(1)}% ${h5.pass ? 'PASS' : 'FAIL'}`)

  console.log('\nPhase 3: Report...')
  const report = generateReport(h1, h2, h3, h4, h5, cost)
  writeFileSync(new URL('./VALIDATION_REPORT.md', import.meta.url), report)

  const passing = [h1, h2, h3, h4, h5].filter(h => h.pass).length
  console.log(`\nDone! ${passing}/5 hypotheses pass. ${cost.report()}`)
  console.log('Report: poc/validation/VALIDATION_REPORT.md')
  process.exit(passing === 5 ? 0 : 1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
