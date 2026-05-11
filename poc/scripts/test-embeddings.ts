import OpenAI from 'openai';

const DIMS_TO_TEST = [256, 512, 768, 1536];

const TEST_CORPUS = [
  // Cluster A: Spam / self-promotion
  'Check out my new YouTube channel! I post daily gaming content, link in bio.',
  'I just launched my startup, would love feedback from this community. Visit example.com for more info.',
  'FREE cryptocurrency giveaway! Just follow the link and enter your wallet address to claim.',

  // Cluster B: Harassment / incivility
  'You are literally the dumbest person I have ever encountered on this website. Delete your account.',
  'People who think like you are what is wrong with this country. Absolute garbage human being.',
  'Imagine being this stupid and still posting your terrible opinions for everyone to see.',

  // Cluster C: Helpful technical discussion
  'The issue is your useEffect dependency array is missing the callback ref. Adding it will fix the stale closure.',
  'You should use a WeakMap here instead of a regular Map to avoid memory leaks when DOM nodes are removed.',
  'Consider using React.memo with a custom comparator — the default shallow compare won\'t catch nested object changes.',

  // Cluster D: Off-topic / low-effort
  'lol',
  'this',
  'first',

  // Cluster E: Nuanced edge cases (sarcasm, subtle violations)
  'Oh sure, another brilliant policy decision from our fearless leaders. What could possibly go wrong this time.',
  'I am totally not being sarcastic when I say this is the best moderation team on the entire platform.',
  'Wow, you must be so proud of yourself for that incredibly original and insightful comment.',

  // Cluster F: Moderation meta-discussion
  'The automod is catching too many false positives on the slur filter. We need to add exemptions for quoted academic text.',
  'I think we should implement a 24-hour cooldown for users who get 3+ reports in a single thread.',
  'New accounts under 7 days old should have their posts held for manual review before appearing in the sub.',
];

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedBatch(client: OpenAI, texts: string[], dims: number): Promise<number[][]> {
  const response = await client.embeddings.create({
    input: texts,
    model: 'text-embedding-3-small',
    dimensions: dims,
  });
  return response.data.map(d => d.embedding);
}

function getClusterLabel(idx: number): string {
  if (idx < 3) return 'spam';
  if (idx < 6) return 'harassment';
  if (idx < 9) return 'technical';
  if (idx < 12) return 'low-effort';
  if (idx < 15) return 'sarcasm';
  return 'mod-meta';
}

function evaluateRanking(embeddings: number[][], dims: number) {
  const n = embeddings.length;
  let intraClusterTotal = 0;
  let intraClusterCount = 0;
  let interClusterTotal = 0;
  let interClusterCount = 0;
  let top3SameCluster = 0;
  let top3Total = 0;

  for (let i = 0; i < n; i++) {
    const myCluster = getClusterLabel(i);
    const scores: { idx: number; sim: number; cluster: string }[] = [];

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      const cluster = getClusterLabel(j);
      scores.push({ idx: j, sim, cluster });

      if (cluster === myCluster) {
        intraClusterTotal += sim;
        intraClusterCount++;
      } else {
        interClusterTotal += sim;
        interClusterCount++;
      }
    }

    scores.sort((a, b) => b.sim - a.sim);
    const top3 = scores.slice(0, 3);
    for (const t of top3) {
      top3Total++;
      if (t.cluster === myCluster) top3SameCluster++;
    }
  }

  const avgIntra = intraClusterTotal / intraClusterCount;
  const avgInter = interClusterTotal / interClusterCount;
  const separation = avgIntra - avgInter;
  const top3Precision = top3SameCluster / top3Total;

  return { dims, avgIntra, avgInter, separation, top3Precision, top3SameCluster, top3Total };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Set OPENAI_API_KEY environment variable');
    process.exit(1);
  }

  const client = new OpenAI({ apiKey });

  console.log(`\nTesting ${TEST_CORPUS.length} comments across 6 clusters (3 per cluster)`);
  console.log(`Clusters: spam, harassment, technical, low-effort, sarcasm, mod-meta`);
  console.log(`Dimensions to test: ${DIMS_TO_TEST.join(', ')}\n`);
  console.log('─'.repeat(80));

  const results: any[] = [];

  for (const dims of DIMS_TO_TEST) {
    const start = Date.now();
    const embeddings = await embedBatch(client, TEST_CORPUS, dims);
    const latency = Date.now() - start;
    const bytesPerItem = JSON.stringify(embeddings[0]).length;

    const eval_ = evaluateRanking(embeddings, dims);

    results.push({ ...eval_, latency, bytesPerItem });

    console.log(`\n${dims}d:`);
    console.log(`  Latency (batch of ${TEST_CORPUS.length}): ${latency}ms`);
    console.log(`  Bytes per item (JSON): ${bytesPerItem}`);
    console.log(`  Avg intra-cluster similarity: ${eval_.avgIntra.toFixed(4)}`);
    console.log(`  Avg inter-cluster similarity: ${eval_.avgInter.toFixed(4)}`);
    console.log(`  Separation (intra - inter): ${eval_.separation.toFixed(4)}`);
    console.log(`  Top-3 precision (same cluster): ${(eval_.top3Precision * 100).toFixed(1)}% (${eval_.top3SameCluster}/${eval_.top3Total})`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log('\nSummary Table:');
  console.log('─'.repeat(80));
  console.log(`${'Dims'.padEnd(6)} | ${'Bytes/item'.padEnd(11)} | ${'Items/500MB'.padEnd(11)} | ${'Intra'.padEnd(7)} | ${'Inter'.padEnd(7)} | ${'Sep'.padEnd(7)} | ${'Top3 Prec'.padEnd(10)} | ${'Latency'.padEnd(8)}`);
  console.log('─'.repeat(80));

  for (const r of results) {
    const maxItems = Math.floor(500 * 1024 * 1024 / r.bytesPerItem);
    console.log(
      `${String(r.dims).padEnd(6)} | ${String(r.bytesPerItem).padEnd(11)} | ${String('~' + Math.round(maxItems / 1000) + 'K').padEnd(11)} | ${r.avgIntra.toFixed(4).padEnd(7)} | ${r.avgInter.toFixed(4).padEnd(7)} | ${r.separation.toFixed(4).padEnd(7)} | ${(r.top3Precision * 100).toFixed(1).padEnd(8)}% | ${r.latency}ms`
    );
  }

  console.log('─'.repeat(80));

  // Ranking agreement: compare top-3 at each dim vs 1536d
  const baseline = results.find(r => r.dims === 1536);
  if (baseline) {
    console.log('\nRanking agreement vs 1536d baseline:');
    const baselineEmbeddings = await embedBatch(client, TEST_CORPUS, 1536);

    for (const dims of DIMS_TO_TEST.filter(d => d !== 1536)) {
      const testEmbeddings = await embedBatch(client, TEST_CORPUS, dims);
      let agreementTotal = 0;
      let checks = 0;

      for (let i = 0; i < TEST_CORPUS.length; i++) {
        const baseScores = TEST_CORPUS.map((_, j) => ({ j, sim: i === j ? -1 : cosineSimilarity(baselineEmbeddings[i], baselineEmbeddings[j]) }))
          .sort((a, b) => b.sim - a.sim).slice(0, 3).map(s => s.j);
        const testScores = TEST_CORPUS.map((_, j) => ({ j, sim: i === j ? -1 : cosineSimilarity(testEmbeddings[i], testEmbeddings[j]) }))
          .sort((a, b) => b.sim - a.sim).slice(0, 3).map(s => s.j);

        const overlap = baseScores.filter(idx => testScores.includes(idx)).length;
        agreementTotal += overlap;
        checks += 3;
      }

      console.log(`  ${dims}d: ${((agreementTotal / checks) * 100).toFixed(1)}% top-3 agreement with 1536d (${agreementTotal}/${checks} matches)`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
