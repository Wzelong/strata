import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort, redis, reddit, context, settings } from '@devvit/web/server';
import type { MenuItemRequest, UiResponse, OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import OpenAI from 'openai';

const app = new Hono();

// --- OpenAI helper (Spike 3) ---
let openaiClient: OpenAI | null = null;

async function getOpenAI(): Promise<OpenAI> {
  if (!openaiClient) {
    const apiKey = await settings.get('openaiApiKey');
    if (!apiKey) throw new Error('OpenAI API key not configured. Run: npx devvit settings set openaiApiKey');
    openaiClient = new OpenAI({ apiKey: apiKey as string });
  }
  return openaiClient;
}

async function embed(text: string): Promise<number[]> {
  const client = await getOpenAI();
  const start = Date.now();
  const response = await client.embeddings.create({
    input: text.replace(/\n/g, ' ').slice(0, 8000),
    model: 'text-embedding-3-small',
  });
  const latency = Date.now() - start;
  const vec = response.data[0].embedding;
  console.log(`[Spike 3] Embedding: ${vec.length} dims, ${latency}ms, ${response.usage.total_tokens} tokens`);
  return vec;
}

// --- Redis storage helpers (Spike 4) ---
async function storeEmbedding(commentId: string, embedding: number[], body: string): Promise<void> {
  await redis.hSet('strata:embeddings', { [commentId]: JSON.stringify(embedding) });
  await redis.hSet('strata:metadata', { [commentId]: JSON.stringify({ body: body.slice(0, 200), storedAt: Date.now() }) });
  await redis.zAdd('strata:embedded-ids', { member: commentId, score: Date.now() });
}

async function retrieveEmbedding(commentId: string): Promise<number[] | null> {
  const raw = await redis.hGet('strata:embeddings', commentId);
  if (!raw) return null;
  return JSON.parse(raw) as number[];
}

// --- Spike 1+2+3+4: Inspect Comment ---
app.post('/internal/menu/inspect-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const commentId = context.commentId || request.targetId;

  if (!commentId) {
    return c.json<UiResponse>({ showToast: 'No comment context found.' });
  }

  const start = Date.now();
  const comment = await reddit.getCommentById(commentId);
  const redditLatency = Date.now() - start;

  console.log('[Spike 1] Comment body:', comment.body);
  console.log('[Spike 1] Author:', comment.authorName);
  console.log('[Spike 1] Parent ID:', comment.parentId);
  console.log('[Spike 1] Created:', comment.createdUtc);
  console.log('[Spike 1] Reddit API latency:', redditLatency, 'ms');

  const count = await redis.incrBy('strata:inspections:total', 1);
  console.log('[Spike 2] Total inspections:', count);

  // Spike 3: Embed
  const embedding = await embed(comment.body);

  // Spike 4: Store and verify round-trip
  await storeEmbedding(commentId, embedding, comment.body);
  const retrieved = await retrieveEmbedding(commentId);
  const lossless = retrieved !== null && retrieved.length === embedding.length && retrieved.every((v, i) => v === embedding[i]);
  console.log(`[Spike 4] Stored ${commentId}, round-trip lossless: ${lossless}, size: ${JSON.stringify(embedding).length} bytes`);

  return c.json<UiResponse>({
    showToast: {
      text: `#${count}: embedded ${embedding.length}d, ${lossless ? 'lossless' : 'LOSSY!'} (${JSON.stringify(embedding).length}B)`,
      appearance: 'success',
    },
  });
});

// --- Spike 5: Find Similar ---
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

app.post('/internal/menu/find-similar', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const commentId = context.commentId || request.targetId;

  if (!commentId) {
    return c.json<UiResponse>({ showToast: 'No comment context found.' });
  }

  const comment = await reddit.getCommentById(commentId);
  const queryEmbedding = await embed(comment.body);

  const start = Date.now();
  const allIds = await redis.zRange('strata:embedded-ids', 0, -1);
  console.log(`[Spike 5] Searching over ${allIds.length} stored embeddings`);

  const scores: { id: string; score: number; body: string }[] = [];
  for (const { member } of allIds) {
    if (member === commentId) continue;
    const stored = await retrieveEmbedding(member);
    if (!stored) continue;
    const sim = cosineSimilarity(queryEmbedding, stored);
    const metaRaw = await redis.hGet('strata:metadata', member);
    const meta = metaRaw ? JSON.parse(metaRaw) : { body: '(unknown)' };
    scores.push({ id: member, score: sim, body: meta.body });
  }

  scores.sort((a, b) => b.score - a.score);
  const top3 = scores.slice(0, 3);
  const searchLatency = Date.now() - start;
  console.log(`[Spike 5] Search latency: ${searchLatency}ms, results:`, top3.map(s => `${s.score.toFixed(4)}`));

  if (top3.length === 0) {
    return c.json<UiResponse>({ showToast: 'No other embeddings stored yet. Inspect more comments first.' });
  }

  return c.json<UiResponse>({
    showForm: {
      name: 'similarResults',
      form: {
        title: `Top ${top3.length} Similar (searched ${allIds.length} in ${searchLatency}ms)`,
        fields: top3.map((item, i) => ({
          name: `result${i}`,
          label: `#${i + 1} (${item.score.toFixed(4)})`,
          type: 'paragraph' as const,
          defaultValue: `${item.body}\n\nID: ${item.id}`,
        })),
      },
    },
  });
});

app.post('/internal/forms/similar-results', async (c) => {
  return c.json<UiResponse>({ showToast: 'Done.' });
});

app.post('/internal/forms/probe-results', async (c) => {
  return c.json<UiResponse>({ showToast: 'Done.' });
});

// --- Spike 10: Remove with Reason ---
async function ensureRemovalReasons(subredditName: string): Promise<{ id: string; title: string }[]> {
  let reasons = await reddit.getSubredditRemovalReasons(subredditName);
  if (reasons.length === 0) {
    console.log('[Spike 10] No removal reasons found, creating them...');
    const rules = await reddit.getRules(subredditName);
    for (const rule of rules) {
      const id = await reddit.addSubredditRemovalReason(subredditName, {
        title: rule.shortName || 'Rule violation',
        message: `Your content was removed for violating: ${rule.shortName}. ${rule.description || ''}`,
      });
      console.log(`[Spike 10] Created removal reason: ${id} for rule "${rule.shortName}"`);
    }
    reasons = await reddit.getSubredditRemovalReasons(subredditName);
  }
  return reasons.map((r: any) => ({ id: r.id, title: r.title }));
}

app.post('/internal/menu/remove-with-reason', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const commentId = context.commentId || request.targetId;
  const subredditName = context.subredditName;

  if (!commentId || !subredditName) {
    return c.json<UiResponse>({ showToast: 'No comment/subreddit context.' });
  }

  try {
    const comment = await reddit.getCommentById(commentId);
    const reasons = await ensureRemovalReasons(subredditName);
    console.log(`[Spike 10] Available reasons:`, reasons);

    return c.json<UiResponse>({
      showForm: {
        name: 'removeWithReason',
        form: {
          title: 'Remove Comment with Reason',
          fields: [
            {
              name: 'commentBody',
              label: 'Comment to remove',
              type: 'paragraph' as const,
              defaultValue: `${comment.body}\n\nBy: ${comment.authorName} | ID: ${commentId}`,
            },
            {
              name: 'reasonId',
              label: 'Removal reason',
              type: 'select' as const,
              options: reasons.map(r => ({ label: r.title, value: r.id })),
              defaultValue: [reasons[0]?.id || ''],
            },
            {
              name: 'targetId',
              label: 'Target ID (do not edit)',
              type: 'string' as const,
              defaultValue: commentId,
            },
          ],
        },
      },
    });
  } catch (err) {
    console.error('[Spike 10] Error:', err);
    return c.json<UiResponse>({ showToast: `Failed: ${err}` });
  }
});

app.post('/internal/forms/remove-with-reason', async (c) => {
  const body = await c.req.json<any>();
  const commentId = body.targetId;
  const reasonId = Array.isArray(body.reasonId) ? body.reasonId[0] : body.reasonId;

  if (!commentId) {
    return c.json<UiResponse>({ showToast: 'No comment ID.' });
  }

  try {
    const start = Date.now();
    await reddit.remove(commentId, false);
    console.log(`[Spike 10] Removed ${commentId} in ${Date.now() - start}ms`);

    if (reasonId) {
      try {
        await reddit.addRemovalNote({ itemIds: [commentId], reasonId, modNote: 'Removed via Strata' });
        console.log(`[Spike 10] Removal note added with reason: ${reasonId}`);
      } catch (err) {
        console.error('[Spike 10] addRemovalNote failed:', err);
      }
    }

    await redis.incrBy('strata:removals:count', 1);
    await redis.hSet('strata:metadata', { [commentId]: JSON.stringify({ ...(JSON.parse(await redis.hGet('strata:metadata', commentId) || '{}')), decision: 'removed', reasonId, decidedAt: Date.now() }) });

    return c.json<UiResponse>({ showToast: { text: `Removed with reason. ID: ${commentId}`, appearance: 'success' } });
  } catch (err) {
    console.error('[Spike 10] Remove failed:', err);
    return c.json<UiResponse>({ showToast: `Remove failed: ${err}` });
  }
});

// --- Spike 11: Precedent Panel ---
app.post('/internal/menu/precedent-panel', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const commentId = context.commentId || request.targetId;
  const subredditName = context.subredditName;

  if (!commentId || !subredditName) {
    return c.json<UiResponse>({ showToast: 'No comment/subreddit context.' });
  }

  const totalStart = Date.now();

  try {
    const comment = await reddit.getCommentById(commentId);
    const queryEmbedding = await embed(comment.body);

    const allIds = await redis.zRange('strata:embedded-ids', 0, -1);
    const scores: { id: string; score: number; body: string; decision?: string }[] = [];

    for (const { member } of allIds) {
      if (member === commentId) continue;
      const stored = await retrieveEmbedding(member);
      if (!stored) continue;
      const sim = cosineSimilarity(queryEmbedding, stored);
      const metaRaw = await redis.hGet('strata:metadata', member);
      const meta = metaRaw ? JSON.parse(metaRaw) : { body: '(unknown)' };
      scores.push({ id: member, score: sim, body: meta.body, decision: meta.decision });
    }

    scores.sort((a, b) => b.score - a.score);
    const top3 = scores.slice(0, 3);

    const rules = await reddit.getRules(subredditName);
    const actionOptions = [
      ...rules.map((r: any, i: number) => ({ label: `Remove — ${r.shortName}`, value: `remove:${i}` })),
      { label: 'Approve', value: 'approve' },
      { label: 'Skip (no action)', value: 'skip' },
    ];

    const removedCount = scores.filter(s => s.decision === 'removed').length;
    const approvedCount = scores.filter(s => s.decision === 'approved').length;
    const recommendation = removedCount > approvedCount
      ? `${removedCount} similar items were removed. Recommend: Remove.`
      : approvedCount > 0
        ? `${approvedCount} similar items were approved. Recommend: Approve.`
        : 'No prior decisions found. Use your judgment.';

    const totalLatency = Date.now() - totalStart;
    console.log(`[Spike 11] Precedent panel built in ${totalLatency}ms. ${top3.length} precedents, ${scores.length} total searched.`);

    return c.json<UiResponse>({
      showForm: {
        name: 'precedentPanel',
        form: {
          title: `Precedent Panel (${totalLatency}ms)`,
          acceptLabel: 'Execute Action',
          fields: [
            {
              name: 'targetComment',
              label: '📋 Comment under review',
              type: 'paragraph' as const,
              defaultValue: comment.body,
            },
            {
              name: 'precedent0',
              label: `#1 (${top3[0]?.score.toFixed(3) || 'N/A'}) ${top3[0]?.decision || 'no decision'}`,
              type: 'paragraph' as const,
              defaultValue: top3[0]?.body || '(none)',
            },
            {
              name: 'precedent1',
              label: `#2 (${top3[1]?.score.toFixed(3) || 'N/A'}) ${top3[1]?.decision || 'no decision'}`,
              type: 'paragraph' as const,
              defaultValue: top3[1]?.body || '(none)',
            },
            {
              name: 'precedent2',
              label: `#3 (${top3[2]?.score.toFixed(3) || 'N/A'}) ${top3[2]?.decision || 'no decision'}`,
              type: 'paragraph' as const,
              defaultValue: top3[2]?.body || '(none)',
            },
            {
              name: 'recommendation',
              label: '🤖 Recommendation',
              type: 'string' as const,
              defaultValue: recommendation,
            },
            {
              name: 'action',
              label: 'Action',
              type: 'select' as const,
              options: actionOptions,
              defaultValue: [removedCount > approvedCount ? actionOptions[0].value : 'skip'],
            },
            {
              name: 'targetId',
              label: 'Target (do not edit)',
              type: 'string' as const,
              defaultValue: commentId,
            },
          ],
        },
      },
    });
  } catch (err) {
    console.error('[Spike 11] Error:', err);
    return c.json<UiResponse>({ showToast: `Panel failed: ${err}` });
  }
});

app.post('/internal/forms/precedent-panel', async (c) => {
  const body = await c.req.json<any>();
  const commentId = body.targetId;
  const action = Array.isArray(body.action) ? body.action[0] : body.action;
  const subredditName = context.subredditName;

  if (!commentId || !action) {
    return c.json<UiResponse>({ showToast: 'Missing data.' });
  }

  try {
    if (action === 'skip') {
      return c.json<UiResponse>({ showToast: 'Skipped — no action taken.' });
    }

    if (action === 'approve') {
      await reddit.approve(commentId);
      await redis.hSet('strata:metadata', { [commentId]: JSON.stringify({ ...(JSON.parse(await redis.hGet('strata:metadata', commentId) || '{}')), decision: 'approved', decidedAt: Date.now() }) });
      return c.json<UiResponse>({ showToast: { text: 'Comment approved.', appearance: 'success' } });
    }

    if (action.startsWith('remove:')) {
      const ruleIndex = parseInt(action.split(':')[1]);
      await reddit.remove(commentId, false);

      if (subredditName) {
        const reasons = await ensureRemovalReasons(subredditName);
        if (reasons[ruleIndex]) {
          try {
            await reddit.addRemovalNote({ itemIds: [commentId], reasonId: reasons[ruleIndex].id, modNote: 'Removed via Strata Precedent Panel' });
          } catch (err) {
            console.error('[Spike 11] addRemovalNote failed:', err);
          }
        }
      }

      await redis.hSet('strata:metadata', { [commentId]: JSON.stringify({ ...(JSON.parse(await redis.hGet('strata:metadata', commentId) || '{}')), decision: 'removed', ruleIndex, decidedAt: Date.now() }) });
      await redis.incrBy('strata:removals:count', 1);
      return c.json<UiResponse>({ showToast: { text: `Removed under rule ${ruleIndex + 1}.`, appearance: 'success' } });
    }

    return c.json<UiResponse>({ showToast: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[Spike 11] Action failed:', err);
    return c.json<UiResponse>({ showToast: `Action failed: ${err}` });
  }
});

// --- Seed Test Data (for testing Spike 5) ---
const TEST_COMMENTS = [
  // Topic A: Programming / code review
  'This function has a memory leak because the event listener is never removed when the component unmounts. You need to add a cleanup in useEffect.',
  'I think we should refactor this module to use dependency injection. The tight coupling between the database layer and the API handlers makes testing nearly impossible.',
  'The recursive approach here is elegant but will blow the stack for inputs over 10k. Consider converting to an iterative solution with an explicit stack.',
  // Topic B: Food / cooking
  'The secret to a good risotto is patience. You have to add the broth one ladle at a time and stir constantly for about 20 minutes.',
  'I switched from butter to ghee for high-heat cooking and the flavor difference is incredible. Works especially well with roasted vegetables.',
  'For sourdough, the key variable most people ignore is ambient temperature. Your starter behaves completely differently at 68F vs 78F.',
  // Topic C: Moderation / community management
  'We should add a rule against low-effort screenshot posts. They drown out discussion threads and the sub is becoming an image board.',
  'I banned three accounts today that were clearly coordinating vote manipulation. Same writing style, posted within minutes of each other, all upvoting the same comments.',
  'The automod regex for catching slurs needs updating. People are using unicode lookalikes to bypass the filter.',
];

app.post('/internal/menu/seed-test-data', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const postId = context.postId || request.targetId;

  if (!postId) {
    return c.json<UiResponse>({ showToast: 'No post context. Run this from a post menu.' });
  }

  try {
    console.log(`[Seed] Posting comments to: ${postId}`);
    const batchKey = 'strata:seed-offset';
    const offset = Number(await redis.get(batchKey) || '0');
    const batch = TEST_COMMENTS.slice(offset, offset + 3);

    if (batch.length === 0) {
      await redis.set(batchKey, '0');
      return c.json<UiResponse>({ showToast: 'All 9 comments already seeded. Reset offset.' });
    }

    let posted = 0;
    for (const body of batch) {
      try {
        if (posted > 0) await new Promise((r) => setTimeout(r, 6000));
        await reddit.submitComment({ id: postId, text: body });
        posted++;
        console.log(`[Seed] Posted comment ${offset + posted}/${TEST_COMMENTS.length}`);
      } catch (err) {
        console.error(`[Seed] Failed:`, err);
      }
    }

    await redis.set(batchKey, String(offset + posted));
    const remaining = TEST_COMMENTS.length - (offset + posted);

    return c.json<UiResponse>({
      showToast: { text: `Batch done (${offset + posted}/${TEST_COMMENTS.length}). ${remaining > 0 ? `Click again for next batch.` : 'All done!'}`, appearance: 'success' },
    });
  } catch (err) {
    console.error('[Seed] Error:', err);
    return c.json<UiResponse>({ showToast: `Seed failed: ${err}` });
  }
});

// --- Probe B: Backfill capability ---
app.post('/internal/menu/probe-backfill', async (c) => {
  const subredditName = context.subredditName;
  if (!subredditName) {
    return c.json<UiResponse>({ showToast: 'No subreddit context.' });
  }

  const results: string[] = [];

  try {
    const postsStart = Date.now();
    const posts = await reddit.getNewPosts({ subredditName, limit: 25 });
    const allPosts = await posts.all();
    results.push(`getNewPosts: ${allPosts.length} posts in ${Date.now() - postsStart}ms`);
    console.log(`[Probe B] Posts:`, allPosts.map(p => ({ id: p.id, title: p.title })));

    if (allPosts.length > 0) {
      const commentsStart = Date.now();
      const comments = await reddit.getComments({ postId: allPosts[0].id, limit: 50 });
      const allComments = await comments.all();
      results.push(`getComments: ${allComments.length} comments in ${Date.now() - commentsStart}ms`);
      console.log(`[Probe B] Comments on first post:`, allComments.length);
    }

    const modLogStart = Date.now();
    try {
      const modLog = await reddit.getModerationLog({ subredditName, limit: 25 });
      const allActions = await modLog.all();
      results.push(`getModerationLog: ${allActions.length} actions in ${Date.now() - modLogStart}ms`);
      if (allActions.length > 0) {
        const sample = allActions[0];
        console.log(`[Probe B] ModLog sample:`, JSON.stringify({
          action: sample.action,
          moderator: sample.moderatorName,
          target: sample.targetAuthor,
          details: sample.details,
        }));
        results.push(`ModLog fields: action=${sample.action}, mod=${sample.moderatorName}`);
      }
    } catch (err) {
      results.push(`getModerationLog: FAILED - ${err}`);
      console.error('[Probe B] ModLog error:', err);
    }
  } catch (err) {
    results.push(`Error: ${err}`);
    console.error('[Probe B] Error:', err);
  }

  console.log('[Probe B] Results:', results);
  return c.json<UiResponse>({
    showForm: {
      name: 'probeResults',
      form: {
        title: 'Probe B: Backfill Results',
        fields: results.map((r, i) => ({
          name: `result${i}`,
          label: `Result ${i + 1}`,
          type: 'string' as const,
          defaultValue: r,
        })),
      },
    },
  });
});

// --- Probe D: Redis capacity measurement ---
app.post('/internal/menu/probe-redis-size', async (c) => {
  const allIds = await redis.zRange('strata:embedded-ids', 0, -1);
  const count = allIds.length;

  if (count === 0) {
    return c.json<UiResponse>({ showToast: 'No embeddings stored yet.' });
  }

  let totalEmbeddingBytes = 0;
  let totalMetadataBytes = 0;
  let sampled = 0;

  for (const { member } of allIds.slice(0, 10)) {
    const embRaw = await redis.hGet('strata:embeddings', member);
    const metaRaw = await redis.hGet('strata:metadata', member);
    if (embRaw) totalEmbeddingBytes += embRaw.length;
    if (metaRaw) totalMetadataBytes += metaRaw.length;
    sampled++;
  }

  const avgEmbBytes = totalEmbeddingBytes / sampled;
  const avgMetaBytes = totalMetadataBytes / sampled;
  const avgTotal = avgEmbBytes + avgMetaBytes + 20; // 20 bytes sorted set overhead
  const maxItems = Math.floor((500 * 1024 * 1024) / avgTotal);

  const report = [
    `Sampled: ${sampled} items`,
    `Avg embedding: ${Math.round(avgEmbBytes)} bytes`,
    `Avg metadata: ${Math.round(avgMetaBytes)} bytes`,
    `Avg total per item: ${Math.round(avgTotal)} bytes`,
    `Max items in 500MB: ~${maxItems.toLocaleString()}`,
    `Current count: ${count}`,
    `Current estimated usage: ${Math.round((count * avgTotal) / 1024)}KB`,
  ];

  console.log('[Probe D]', report);
  return c.json<UiResponse>({
    showForm: {
      name: 'probeResults',
      form: {
        title: 'Probe D: Redis Capacity',
        fields: report.map((r, i) => ({
          name: `r${i}`,
          label: `${r.split(':')[0]}`,
          type: 'string' as const,
          defaultValue: r,
        })),
      },
    },
  });
});

// --- Spike 9: Fetch subreddit rules ---
app.post('/internal/menu/fetch-rules', async (c) => {
  const subredditName = context.subredditName;
  if (!subredditName) return c.json<UiResponse>({ showToast: 'No subreddit context.' });

  try {
    const start = Date.now();
    const rules = await reddit.getRules(subredditName);
    const latency = Date.now() - start;
    console.log(`[Spike 9] getRules: ${rules.length} rules in ${latency}ms`);
    console.log(`[Spike 9] Rules:`, JSON.stringify(rules, null, 2));

    let removalReasons: any[] = [];
    try {
      removalReasons = await reddit.getSubredditRemovalReasons(subredditName);
      console.log(`[Spike 9] Removal reasons:`, JSON.stringify(removalReasons, null, 2));
    } catch (err) {
      console.log(`[Spike 9] getSubredditRemovalReasons failed:`, err);
    }

    const fields = [
      ...rules.map((r: any, i: number) => ({
        name: `rule${i}`,
        label: `Rule ${i + 1}`,
        type: 'string' as const,
        defaultValue: `${r.shortName || r.violationReason || 'unnamed'}: ${r.description || '(no desc)'}`,
      })),
      {
        name: 'removalInfo',
        label: 'Removal Reasons',
        type: 'paragraph' as const,
        defaultValue: removalReasons.length > 0
          ? removalReasons.map((rr: any) => `${rr.id}: ${rr.title}`).join('\n')
          : '(none configured or API not available)',
      },
      {
        name: 'meta',
        label: 'Metadata',
        type: 'string' as const,
        defaultValue: `${rules.length} rules, ${removalReasons.length} removal reasons, ${latency}ms`,
      },
    ];

    return c.json<UiResponse>({
      showForm: { name: 'probeResults', form: { title: 'Spike 9: Subreddit Rules', fields } },
    });
  } catch (err) {
    console.error('[Spike 9] Error:', err);
    return c.json<UiResponse>({ showToast: `Failed: ${err}` });
  }
});

// --- Spike 13: onModAction trigger ---
app.post('/internal/triggers/mod-action', async (c) => {
  const input = await c.req.json<any>();
  console.log('[Spike 13] onModAction payload:', JSON.stringify(input, null, 2));

  const summary = {
    action: input.action,
    moderator: input.moderator?.name || input.moderator,
    targetComment: input.targetComment?.id,
    targetPost: input.targetPost?.id,
    targetUser: input.targetUser?.name || input.targetUser,
    details: input.details,
    description: input.description,
  };
  console.log('[Spike 13] Summary:', JSON.stringify(summary));
  await redis.set('strata:mod-actions:last', JSON.stringify(summary));
  await redis.incrBy('strata:mod-actions:count', 1);

  return c.json<TriggerResponse>({ status: 'ok' });
});

// --- Spike 14: onCommentReport trigger ---
app.post('/internal/triggers/comment-report', async (c) => {
  const input = await c.req.json<any>();
  console.log('[Spike 14] onCommentReport payload:', JSON.stringify(input, null, 2));

  const summary = {
    commentId: input.comment?.id,
    commentBody: input.comment?.body?.slice(0, 100),
    reason: input.reason,
    subreddit: input.subreddit?.name,
    reporter: input.reporter?.name || input.reporter || '(not exposed)',
  };
  console.log('[Spike 14] Summary:', JSON.stringify(summary));
  await redis.set('strata:reports:last', JSON.stringify(summary));
  await redis.incrBy('strata:reports:count', 1);

  return c.json<TriggerResponse>({ status: 'ok' });
});

// --- Spike 15: Send modmail ---
app.post('/internal/menu/test-modmail', async (c) => {
  const subredditName = context.subredditName;
  if (!subredditName) return c.json<UiResponse>({ showToast: 'No subreddit context.' });

  try {
    const start = Date.now();
    const result = await reddit.modMail.createConversation({
      subredditName,
      subject: '[Strata] Test Notification',
      body: `This is a test modmail from Strata POC.\n\nTimestamp: ${new Date().toISOString()}\n\nIf you see this, Spike 15 (programmatic modmail) works.`,
      to: null as any,
    });
    const latency = Date.now() - start;
    console.log(`[Spike 15] Modmail sent in ${latency}ms. Result:`, JSON.stringify(result));
    return c.json<UiResponse>({ showToast: { text: `Modmail sent in ${latency}ms!`, appearance: 'success' } });
  } catch (err) {
    console.error('[Spike 15] Modmail error:', err);
    return c.json<UiResponse>({ showToast: `Modmail failed: ${err}` });
  }
});

// --- Spike 16: Mod gating on /api/ ---
app.get('/api/stats', async (c) => {
  const userId = context.userId;
  if (!userId) {
    return c.json({ error: 'Not authenticated' }, 403);
  }

  const totalInspections = await redis.get('strata:inspections:total') || '0';
  const totalEmbeddings = await redis.zCard('strata:embedded-ids');
  const autoEmbedded = await redis.get('strata:auto-embedded:count') || '0';
  const modActionCount = await redis.get('strata:mod-actions:count') || '0';
  const reportCount = await redis.get('strata:reports:count') || '0';
  const autoFlags = await redis.get('strata:auto-flags:count') || '0';
  const removals = await redis.get('strata:removals:count') || '0';
  return c.json({ totalInspections, totalEmbeddings, autoEmbedded, modActionCount, reportCount, autoFlags, removals, userId });
});

// --- Spike 18: 256-dim embeddings ---
async function embed256(text: string): Promise<number[]> {
  const client = await getOpenAI();
  const start = Date.now();
  const response = await client.embeddings.create({
    input: text.replace(/\n/g, ' ').slice(0, 8000),
    model: 'text-embedding-3-small',
    dimensions: 256,
  });
  const latency = Date.now() - start;
  const vec = response.data[0].embedding;
  console.log(`[Spike 18] Embedding 256d: ${vec.length} dims, ${latency}ms, ${response.usage.total_tokens} tokens`);
  return vec;
}

app.post('/internal/menu/seed-256d', async (c) => {
  const allIds = await redis.zRange('strata:embedded-ids', 0, -1);
  if (allIds.length === 0) {
    return c.json<UiResponse>({ showToast: 'No embeddings to convert. Run Inspect on some comments first.' });
  }

  let converted = 0;
  const results: string[] = [];

  for (const { member } of allIds.slice(0, 10)) {
    const metaRaw = await redis.hGet('strata:metadata', member);
    if (!metaRaw) continue;
    const meta = JSON.parse(metaRaw);
    if (!meta.body) continue;

    const vec256 = await embed256(meta.body);
    await redis.hSet('strata:emb256:embeddings', { [member]: JSON.stringify(vec256) });
    await redis.zAdd('strata:emb256:ids', { member, score: Date.now() });
    converted++;
  }

  const sampleKey = allIds[0].member;
  const raw1536 = await redis.hGet('strata:embeddings', sampleKey);
  const raw256 = await redis.hGet('strata:emb256:embeddings', sampleKey);
  results.push(`Converted: ${converted} items`);
  results.push(`1536d size: ${raw1536?.length || 0} bytes`);
  results.push(`256d size: ${raw256?.length || 0} bytes`);
  results.push(`Ratio: ${raw1536 && raw256 ? (raw1536.length / raw256.length).toFixed(1) + 'x reduction' : 'N/A'}`);

  // Compare rankings for first item
  const queryMeta = JSON.parse((await redis.hGet('strata:metadata', sampleKey))!);
  const query1536 = await retrieveEmbedding(sampleKey);
  const query256Raw = await redis.hGet('strata:emb256:embeddings', sampleKey);
  const query256 = query256Raw ? JSON.parse(query256Raw) : null;

  if (query1536 && query256) {
    const scores1536: { id: string; score: number }[] = [];
    const scores256: { id: string; score: number }[] = [];

    for (const { member } of allIds) {
      if (member === sampleKey) continue;
      const emb1536 = await retrieveEmbedding(member);
      const emb256Raw = await redis.hGet('strata:emb256:embeddings', member);
      const emb256 = emb256Raw ? JSON.parse(emb256Raw) : null;
      if (emb1536) scores1536.push({ id: member, score: cosineSimilarity(query1536, emb1536) });
      if (emb256) scores256.push({ id: member, score: cosineSimilarity(query256, emb256) });
    }

    scores1536.sort((a, b) => b.score - a.score);
    scores256.sort((a, b) => b.score - a.score);

    const top3_1536 = scores1536.slice(0, 3).map(s => s.id);
    const top3_256 = scores256.slice(0, 3).map(s => s.id);
    const agreement = top3_1536.filter(id => top3_256.includes(id)).length;

    results.push(`Top-3 agreement: ${agreement}/3`);
    results.push(`1536d top3: ${scores1536.slice(0, 3).map(s => s.score.toFixed(4)).join(', ')}`);
    results.push(`256d top3: ${scores256.slice(0, 3).map(s => s.score.toFixed(4)).join(', ')}`);
  }

  console.log('[Spike 18] Results:', results);
  return c.json<UiResponse>({
    showForm: { name: 'comparisonResults', form: { title: 'Spike 18: 256d vs 1536d', fields: results.map((r, i) => ({ name: `r${i}`, label: r.split(':')[0], type: 'string' as const, defaultValue: r })) } },
  });
});

app.post('/internal/forms/comparison-results', async (c) => {
  return c.json<UiResponse>({ showToast: 'Done.' });
});

// --- Spike 12: Bulk Remove Timing Test ---
app.post('/internal/menu/bulk-remove-test', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const postId = context.postId || request.targetId;
  if (!postId) return c.json<UiResponse>({ showToast: 'No post context.' });

  try {
    const comments = await reddit.getComments({ postId, limit: 50 });
    const allComments = await comments.all();
    const removable = allComments.filter((cm: any) => !cm.removed);
    console.log(`[Spike 12] Found ${removable.length} removable comments on post ${postId}`);

    if (removable.length === 0) {
      return c.json<UiResponse>({ showToast: 'No comments to remove on this post.' });
    }

    const batchSize = Math.min(removable.length, 20);
    const latencies: number[] = [];
    let removed = 0;
    const totalStart = Date.now();

    for (let i = 0; i < batchSize; i++) {
      if (Date.now() - totalStart > 25000) {
        console.log(`[Spike 12] Aborting at ${i} — approaching 30s timeout`);
        break;
      }
      const start = Date.now();
      try {
        await reddit.remove(removable[i].id, false);
        const lat = Date.now() - start;
        latencies.push(lat);
        removed++;
      } catch (err) {
        console.error(`[Spike 12] Remove ${i} failed:`, err);
        latencies.push(-1);
      }
    }

    const totalTime = Date.now() - totalStart;
    const validLatencies = latencies.filter(l => l > 0);
    const avg = validLatencies.length > 0 ? Math.round(validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length) : 0;
    const max = Math.max(...validLatencies);
    const projected30s = avg > 0 ? Math.floor(25000 / avg) : 0;

    const report = [
      `Removed: ${removed}/${batchSize} in ${totalTime}ms`,
      `Avg latency per remove: ${avg}ms`,
      `Max single remove: ${max}ms`,
      `Projected max in 25s: ~${projected30s} items`,
      `Latencies: ${validLatencies.join(', ')}`,
    ];
    console.log('[Spike 12] Results:', report);

    return c.json<UiResponse>({
      showForm: { name: 'bulkRemoveTest', form: { title: 'Spike 12: Bulk Remove', fields: report.map((r, i) => ({ name: `r${i}`, label: r.split(':')[0], type: 'string' as const, defaultValue: r })) } },
    });
  } catch (err) {
    console.error('[Spike 12] Error:', err);
    return c.json<UiResponse>({ showToast: `Failed: ${err}` });
  }
});

app.post('/internal/forms/bulk-remove-test', async (c) => {
  return c.json<UiResponse>({ showToast: 'Done.' });
});

// --- Spike 17: LLM Recommendation Panel ---
app.post('/internal/menu/llm-panel', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const commentId = context.commentId || request.targetId;
  const subredditName = context.subredditName;

  if (!commentId || !subredditName) {
    return c.json<UiResponse>({ showToast: 'No comment/subreddit context.' });
  }

  const totalStart = Date.now();

  try {
    const comment = await reddit.getCommentById(commentId);
    const queryEmbedding = await embed(comment.body);

    const allIds = await redis.zRange('strata:embedded-ids', 0, -1);
    const scores: { id: string; score: number; body: string; decision?: string }[] = [];

    for (const { member } of allIds) {
      if (member === commentId) continue;
      const stored = await retrieveEmbedding(member);
      if (!stored) continue;
      const sim = cosineSimilarity(queryEmbedding, stored);
      const metaRaw = await redis.hGet('strata:metadata', member);
      const meta = metaRaw ? JSON.parse(metaRaw) : { body: '(unknown)' };
      scores.push({ id: member, score: sim, body: meta.body, decision: meta.decision });
    }

    scores.sort((a, b) => b.score - a.score);
    const top3 = scores.slice(0, 3);
    const searchLatency = Date.now() - totalStart;

    const rules = await reddit.getRules(subredditName);
    const precedentSummary = top3.map((p, i) =>
      `${i + 1}. "${p.body}" (similarity: ${p.score.toFixed(3)}, outcome: ${p.decision || 'no action taken'})`
    ).join('\n');

    const rulesSummary = rules.map((r: any) => `- ${r.shortName}: ${r.description}`).join('\n');

    const llmStart = Date.now();
    const client = await getOpenAI();
    const llmResponse = await client.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a Reddit moderation assistant. Given a comment under review, similar past precedents with their outcomes, and community rules, recommend whether to remove or approve. Be concise (2-3 sentences). State which rule applies if recommending removal.',
        },
        {
          role: 'user',
          content: `Comment under review:\n"${comment.body}"\n\nSimilar precedents:\n${precedentSummary}\n\nCommunity rules:\n${rulesSummary}\n\nRecommend an action and explain briefly.`,
        },
      ],
      max_completion_tokens: 150,
      temperature: 0.3,
    });
    const llmLatency = Date.now() - llmStart;
    const recommendation = llmResponse.choices[0]?.message?.content || '(no recommendation)';
    const totalLatency = Date.now() - totalStart;

    console.log(`[Spike 17] LLM latency: ${llmLatency}ms, total: ${totalLatency}ms`);
    console.log(`[Spike 17] Recommendation: ${recommendation}`);
    await redis.incrBy('strata:llm:count', 1);

    const actionOptions = [
      ...rules.map((r: any, i: number) => ({ label: `Remove — ${r.shortName}`, value: `remove:${i}` })),
      { label: 'Approve', value: 'approve' },
      { label: 'Skip', value: 'skip' },
    ];

    return c.json<UiResponse>({
      showForm: {
        name: 'llmPanel',
        form: {
          title: `LLM Panel (${totalLatency}ms total, LLM: ${llmLatency}ms)`,
          acceptLabel: 'Execute Action',
          fields: [
            { name: 'targetComment', label: '📋 Comment', type: 'paragraph' as const, defaultValue: comment.body },
            { name: 'precedents', label: '📊 Precedents', type: 'paragraph' as const, defaultValue: precedentSummary },
            { name: 'llmRec', label: '🤖 AI Recommendation', type: 'paragraph' as const, defaultValue: recommendation },
            { name: 'action', label: 'Action', type: 'select' as const, options: actionOptions, defaultValue: ['skip'] },
            { name: 'targetId', label: 'Target', type: 'string' as const, defaultValue: commentId },
          ],
        },
      },
    });
  } catch (err) {
    console.error('[Spike 17] Error:', err);
    return c.json<UiResponse>({ showToast: `LLM Panel failed: ${err}` });
  }
});

app.post('/internal/forms/llm-panel', async (c) => {
  const body = await c.req.json<any>();
  const commentId = body.targetId;
  const action = Array.isArray(body.action) ? body.action[0] : body.action;
  const subredditName = context.subredditName;

  if (!commentId || !action || action === 'skip') {
    return c.json<UiResponse>({ showToast: action === 'skip' ? 'Skipped.' : 'Missing data.' });
  }

  try {
    if (action === 'approve') {
      await reddit.approve(commentId);
      await redis.hSet('strata:metadata', { [commentId]: JSON.stringify({ ...(JSON.parse(await redis.hGet('strata:metadata', commentId) || '{}')), decision: 'approved', decidedAt: Date.now() }) });
      return c.json<UiResponse>({ showToast: { text: 'Approved.', appearance: 'success' } });
    }

    if (action.startsWith('remove:') && subredditName) {
      const ruleIndex = parseInt(action.split(':')[1]);
      await reddit.remove(commentId, false);
      const reasons = await ensureRemovalReasons(subredditName);
      if (reasons[ruleIndex]) {
        try { await reddit.addRemovalNote({ itemIds: [commentId], reasonId: reasons[ruleIndex].id, modNote: 'Removed via Strata LLM Panel' }); } catch {}
      }
      await redis.hSet('strata:metadata', { [commentId]: JSON.stringify({ ...(JSON.parse(await redis.hGet('strata:metadata', commentId) || '{}')), decision: 'removed', ruleIndex, decidedAt: Date.now() }) });
      await redis.incrBy('strata:removals:count', 1);
      return c.json<UiResponse>({ showToast: { text: `Removed under rule ${ruleIndex + 1}.`, appearance: 'success' } });
    }

    return c.json<UiResponse>({ showToast: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[Spike 17] Action failed:', err);
    return c.json<UiResponse>({ showToast: `Failed: ${err}` });
  }
});

// --- Spike 6 + Scenario C: Trigger on new comment (embed + auto-flag) ---
app.post('/internal/triggers/comment-submit', async (c) => {
  const input = await c.req.json<any>();
  const comment = input.comment;
  const subreddit = input.subreddit;

  if (!comment?.body || !comment?.id) {
    console.log('[Spike 6] Trigger fired but no comment body/id, skipping');
    return c.json<TriggerResponse>({ status: 'ok' });
  }

  console.log(`[Spike 6] Auto-embedding comment ${comment.id} by ${comment.author}`);
  const triggerStart = Date.now();

  try {
    const embedding = await embed(comment.body);
    await storeEmbedding(comment.id, embedding, comment.body);
    await redis.incrBy('strata:auto-embedded:count', 1);
    console.log(`[Spike 6] Embedded in ${Date.now() - triggerStart}ms`);

    // --- Scenario C: Auto-flag if similar to removed items ---
    const allIds = await redis.zRange('strata:embedded-ids', 0, -1);
    let removedMatches = 0;
    const matchedBodies: string[] = [];

    for (const { member } of allIds) {
      if (member === comment.id) continue;
      const metaRaw = await redis.hGet('strata:metadata', member);
      if (!metaRaw) continue;
      const meta = JSON.parse(metaRaw);
      if (meta.decision !== 'removed') continue;

      const stored = await retrieveEmbedding(member);
      if (!stored) continue;
      const sim = cosineSimilarity(embedding, stored);
      if (sim > 0.25) {
        removedMatches++;
        matchedBodies.push(`"${meta.body?.slice(0, 80)}..." (sim: ${sim.toFixed(3)})`);
      }
    }

    if (removedMatches >= 2 && subreddit?.name) {
      console.log(`[Scenario C] Auto-flag! ${removedMatches} removed matches for comment ${comment.id}`);
      try {
        await reddit.modMail.createConversation({
          subredditName: subreddit.name,
          subject: `[Strata Auto-Flag] Similar to ${removedMatches} removed items`,
          body: `A new comment matches ${removedMatches} previously removed items.\n\n**Comment:** "${comment.body}"\n**Author:** ${comment.author}\n**Link:** https://reddit.com${comment.permalink || ''}\n\n**Matched precedents:**\n${matchedBodies.map(b => `- ${b}`).join('\n')}\n\nReview via the Strata Precedent Panel.`,
          to: null as any,
        });
        await redis.incrBy('strata:auto-flags:count', 1);
        console.log(`[Scenario C] Modmail sent in ${Date.now() - triggerStart}ms total`);
      } catch (err) {
        console.error('[Scenario C] Modmail failed:', err);
      }
    }
  } catch (err) {
    console.error(`[Spike 6] Failed to embed ${comment.id}:`, err);
  }

  return c.json<TriggerResponse>({ status: 'ok' });
});

// --- Spike 7: Dashboard post ---
app.post('/internal/menu/create-dashboard', async (c) => {
  const subredditName = context.subredditName;
  if (!subredditName) {
    return c.json<UiResponse>({ showToast: 'No subreddit context.' });
  }

  try {
    const post = await reddit.submitCustomPost({
      subredditName,
      title: 'Strata Embedding Atlas',
      entry: 'default',
      styles: { height: 'REGULAR', backgroundColor: '#FFFFFFFF', backgroundColorDark: '#1A1A1BFF' },
    });
    console.log(`[Spike 7] Created dashboard post: ${post.id}`);
    return c.json<UiResponse>({ showToast: { text: 'Dashboard post created!', appearance: 'success' } });
  } catch (err) {
    console.error('[Spike 7] Error creating post:', err);
    return c.json<UiResponse>({ showToast: `Failed: ${err}` });
  }
});

// --- Triggers ---
app.post('/internal/triggers/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('[Trigger] App installed to subreddit: r/' + input.subreddit?.name);
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

// --- Server start ---
serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
