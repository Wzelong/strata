import type OpenAI from 'openai'
import type { StoredItem, Alert, AlertConnection, AlertStatus } from '../../engine/types.js'
import { cosine } from '../../engine/embed.js'

export interface ChatToolDeps {
  openai: OpenAI
  getAllItems: () => Promise<StoredItem[]>
  getItem: (id: string) => Promise<StoredItem | null>
  getEmbedding: (id: string) => number[] | null
  clusterLabelById: Map<number, string>
  listAlerts: (opts: { status?: AlertStatus; limit?: number }) => Promise<{ alerts: Alert[]; nextCursor: number | null }>
  getAlert: (id: string) => Promise<Alert | null>
  getAlertConnections: (id: string) => Promise<AlertConnection[]>
}

export type ToolSideEffect =
  | { type: 'select_alert'; alert_id: string }
  | { type: 'select_topic'; cluster_id: string; label: string }
  | { type: 'select_post'; post_id: string }
  | { type: 'select_comment'; comment_id: string; thread_root_id: string }
  | { type: 'highlight'; ids: string[] }

export interface DispatchResult {
  result: unknown
  summary: string
  preview?: string
  sideEffect?: ToolSideEffect
}

export interface SearchHit {
  id: string
  kind: 'post' | 'comment'
  snippet: string
  cluster_label: string | null
  created_at: number
  score: number
}

export interface ClusterSummary {
  label: string
  size: number
  time_range: { earliest: number; latest: number }
  top_terms: string[]
  sampled_items: Array<{ id: string; title: string | null; snippet: string; created_at: number }>
}

export interface ThreadResult {
  post: { id: string; title: string | null; text: string; author: string; created_at: number }
  comments: Array<{ id: string; text: string; author: string; created_at: number }>
}

export interface AlertDetailResult {
  id: string
  mode: 'surface' | 'flag'
  status: AlertStatus
  confidence: 'high' | 'review'
  flag_type: string | null
  reasoning: string | null
  anchor: { id: string; type: 'post' | 'comment'; title: string | null; text: string; author: string }
  connections: Array<{
    item_id: string
    author: string
    type: 'post' | 'comment'
    title: string | null
    snippet: string
    classification: string
    confidence: string
    reasoning: string
    created_at: number
  }>
  created_at: number
}

export interface ItemDetailResult {
  id: string
  kind: 'post' | 'comment'
  title: string | null
  text: string
  author: string
  created_at: number
  thread_root_id: string
  parent_id: string | null
  cluster_label: string | null
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','of','in','on','at','to','for','with','by','from','as','is','are','was','were','be','been','being','it','its','this','that','these','those','i','you','he','she','we','they','my','your','his','her','our','their','what','which','who','whom','how','when','where','why','not','no','do','does','did','have','has','had','will','would','can','could','should','may','might','just','about','like','so','too','very','more','most','some','any','all','only','also','than','then','here','there','out','up','down','one','two',
])

function snippet(text: string, max = 200): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max) + '…' : t
}

function windowCutoff(window?: string): number | null {
  if (!window) return null
  const now = Date.now()
  if (window === 'today') return now - 24 * 60 * 60_000
  if (window === '7d') return now - 7 * 24 * 60 * 60_000
  if (window === '30d') return now - 30 * 24 * 60 * 60_000
  return null
}

function clusterLabelFor(item: StoredItem, map: Map<number, string>): string | null {
  if (item.clusterId === undefined || item.clusterId === -1) return null
  return map.get(item.clusterId) ?? null
}

function clusterIdForLabel(label: string, map: Map<number, string>): string | null {
  for (const [id, l] of map) if (l === label) return `cluster:${id}`
  return null
}

function topTerms(texts: string[], k = 6): string[] {
  const counts = new Map<string, number>()
  for (const t of texts) {
    for (const raw of t.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 4 || STOPWORDS.has(raw)) continue
      counts.set(raw, (counts.get(raw) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([w]) => w)
}

export function buildToolSchemas() {
  return [
    {
      type: 'function' as const,
      name: 'semantic_search',
      description: 'Search posts and comments by meaning. Use when the moderator asks about content or themes ("complaints about X", "anything about Y"). Once per turn unless results are off-topic. Always follow up with mark_relevant on the subset that actually answers the question.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          top_k: { type: 'integer', description: 'How many results to return (default 8).' },
          time_window: { type: ['string', 'null'], enum: ['today', '7d', '30d', null], description: 'Restrict to recent items.' },
        },
        required: ['query', 'top_k', 'time_window'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'list_alerts',
      description: 'List moderation alerts in the queue. Use for triage questions ("what needs attention", "today\'s brigade flags"). Prefer over semantic_search when the question is about flagged items, not content meaning.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          status: { type: ['string', 'null'], enum: ['pending', 'resolved', 'dismissed', null], description: 'Filter by alert status.' },
          confidence: { type: ['string', 'null'], enum: ['high', 'review', null], description: 'high = act now, review = mod judgment.' },
          mode: { type: ['string', 'null'], enum: ['surface', 'flag', null], description: 'surface = case-builder, flag = rule/pattern/brigade.' },
          flag_type: { type: ['string', 'null'], enum: ['rule', 'pattern', 'brigade', null], description: 'Only when mode=flag.' },
          limit: { type: 'integer', description: 'Default 10, max 30.' },
        },
        required: ['status', 'confidence', 'mode', 'flag_type', 'limit'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'get_alert',
      description: 'Get full alert detail — anchor item, reasoning, all connections. Use for "why was this flagged?" (with an alert in current view) or to expand a specific alert from list_alerts. The moderator\'s UI will navigate to this alert automatically.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          alert_id: { type: 'string', description: 'Alert id, from list_alerts or the current view block.' },
        },
        required: ['alert_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'get_topic',
      description: 'Get topic (cluster) metadata — size, time range, top terms, sampled members. Use when the answer refers to a topic, or after semantic_search surfaces a cluster_label worth describing. The moderator\'s UI will navigate to this topic.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Topic label as returned by list_topics, semantic_search, or get_alert.' },
          sample_k: { type: 'integer', description: 'How many sampled items to include (default 8).' },
        },
        required: ['label', 'sample_k'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'list_topics',
      description: 'List topics (semantic clusters) ranked by size, each with member count, recent (7d) activity, last-activity time, and top terms. Use for "biggest topic", "most active topics", "what are people discussing" — anything that needs to find a topic rather than name one. Then call get_topic(label) to summarize a specific one.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many topics to return, ranked by size (default 10, max 30).' },
        },
        required: ['limit'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'get_thread',
      description: 'Get a post with its full comment thread. Use when the answer needs the post text plus its comments. Pass a post id (kind = "post"), not a comment id. The moderator\'s UI will navigate to this post.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Post id, e.g. t3_abc123.' },
        },
        required: ['post_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'get_item',
      description: 'Fetch a single post or comment by id (no thread expansion). Cheaper than get_thread when comments aren\'t needed. The moderator\'s UI will navigate to this item (or its parent thread if it\'s a comment).',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Post id (t3_*) or comment id (t1_*).' },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function' as const,
      name: 'mark_relevant',
      description: 'After semantic_search (or any time you reference multiple items in your answer), call this with the subset of item ids that actually answer the question. The graph will highlight those items and surface their topic labels. Mix of posts and comments OK — comments are added to the graph dynamically.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Item ids (post or comment) to highlight in the 3D graph.' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
    },
  ]
}

export function createToolDispatcher(deps: ChatToolDeps) {
  const { openai, getAllItems, getItem, getEmbedding, clusterLabelById } = deps

  async function embedQuery(text: string): Promise<number[]> {
    const res = await openai.embeddings.create({
      input: text,
      model: 'text-embedding-3-small',
      dimensions: 256,
    })
    return res.data[0].embedding
  }

  async function semanticSearch(args: { query: string; top_k: number; time_window: string | null }): Promise<{ hits: SearchHit[] }> {
    const top_k = Math.max(1, Math.min(args.top_k || 8, 20))
    const cutoff = windowCutoff(args.time_window ?? undefined)
    const queryVec = await embedQuery(args.query)
    const all = await getAllItems()
    const scored: Array<{ item: StoredItem; score: number }> = []
    for (const item of all) {
      if (cutoff !== null && item.createdAt < cutoff) continue
      const emb = getEmbedding(item.id)
      if (!emb) continue
      scored.push({ item, score: cosine(queryVec, emb) })
    }
    scored.sort((a, b) => b.score - a.score)
    const hits: SearchHit[] = scored.slice(0, top_k).map(({ item, score }) => ({
      id: item.id,
      kind: item.type,
      snippet: snippet(item.title ? `${item.title} — ${item.text}` : item.text, 180),
      cluster_label: clusterLabelFor(item, clusterLabelById),
      created_at: item.createdAt,
      score: Number(score.toFixed(4)),
    }))
    return { hits }
  }

  async function listAlertsTool(args: { status: string | null; confidence: string | null; mode: string | null; flag_type: string | null; limit: number }) {
    const limit = Math.max(1, Math.min(args.limit || 10, 30))
    const status = args.status as AlertStatus | undefined
    const { alerts } = await deps.listAlerts({ status, limit: 100 })
    let filtered = alerts
    if (args.confidence) filtered = filtered.filter(a => a.confidence === args.confidence)
    if (args.mode) filtered = filtered.filter(a => a.mode === args.mode)
    if (args.flag_type) filtered = filtered.filter(a => a.flagType === args.flag_type)
    filtered = filtered.slice(0, limit)
    return {
      alerts: filtered.map(a => ({
        id: a.id,
        mode: a.mode,
        status: a.status,
        confidence: a.confidence,
        flag_type: a.flagType ?? null,
        anchor_id: a.anchorId,
        anchor_type: a.anchorType,
        anchor_title: a.anchorTitle ?? null,
        anchor_snippet: snippet(a.anchorText, 160),
        anchor_author: a.anchorAuthor,
        connection_count: a.connectionCount,
        created_at: a.createdAt,
      })),
    }
  }

  async function getAlertTool(args: { alert_id: string }): Promise<AlertDetailResult | { error: string }> {
    const alert = await deps.getAlert(args.alert_id)
    if (!alert) return { error: `Alert not found: ${args.alert_id}` }
    const connections = await deps.getAlertConnections(args.alert_id)
    return {
      id: alert.id,
      mode: alert.mode,
      status: alert.status,
      confidence: alert.confidence,
      flag_type: alert.flagType ?? null,
      reasoning: alert.reasoning ?? null,
      anchor: {
        id: alert.anchorId,
        type: alert.anchorType,
        title: alert.anchorTitle ?? null,
        text: alert.anchorText,
        author: alert.anchorAuthor,
      },
      connections: connections.map(c => ({
        item_id: c.itemId,
        author: c.author,
        type: c.type,
        title: c.title ?? null,
        snippet: snippet(c.text, 160),
        classification: c.classification,
        confidence: c.confidence,
        reasoning: c.reasoning,
        created_at: c.createdAt,
      })),
      created_at: alert.createdAt,
    }
  }

  async function getItemTool(args: { item_id: string }): Promise<ItemDetailResult | { error: string }> {
    const item = await getItem(args.item_id)
    if (!item) return { error: `Item not found: ${args.item_id}` }
    return {
      id: item.id,
      kind: item.type,
      title: item.title ?? null,
      text: item.text,
      author: item.authorName,
      created_at: item.createdAt,
      thread_root_id: item.threadRootId,
      parent_id: item.parentId,
      cluster_label: clusterLabelFor(item, clusterLabelById),
    }
  }

  async function getTopic(args: { label: string; sample_k: number }): Promise<ClusterSummary | { error: string }> {
    const sample_k = Math.max(1, Math.min(args.sample_k || 8, 20))
    const all = await getAllItems()
    const members = all.filter(i => clusterLabelFor(i, clusterLabelById) === args.label)
    if (members.length === 0) return { error: `No topic named "${args.label}".` }
    const earliest = Math.min(...members.map(m => m.createdAt))
    const latest = Math.max(...members.map(m => m.createdAt))
    const texts = members.map(m => `${m.title ?? ''} ${m.text}`)
    const sampled = [...members]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, sample_k)
      .map(m => ({ id: m.id, title: m.title ?? null, snippet: snippet(m.text, 140), created_at: m.createdAt }))
    return {
      label: args.label,
      size: members.length,
      time_range: { earliest, latest },
      top_terms: topTerms(texts),
      sampled_items: sampled,
    }
  }

  async function listTopics(args: { limit: number }): Promise<{ topics: Array<{ label: string; size: number; recent_count: number; last_activity: number; top_terms: string[] }> }> {
    const limit = Math.max(1, Math.min(args.limit || 10, 30))
    const all = await getAllItems()
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60_000
    const byLabel = new Map<string, StoredItem[]>()
    for (const it of all) {
      const label = clusterLabelFor(it, clusterLabelById)
      if (!label) continue
      const arr = byLabel.get(label)
      if (arr) arr.push(it)
      else byLabel.set(label, [it])
    }
    const topics = [...byLabel.entries()].map(([label, members]) => ({
      label,
      size: members.length,
      recent_count: members.filter(m => m.createdAt >= recentCutoff).length,
      last_activity: Math.max(...members.map(m => m.createdAt)),
      top_terms: topTerms(members.map(m => `${m.title ?? ''} ${m.text}`)),
    }))
    topics.sort((a, b) => b.size - a.size)
    return { topics: topics.slice(0, limit) }
  }

  async function getThread(args: { post_id: string }): Promise<ThreadResult | { error: string }> {
    const post = await getItem(args.post_id)
    if (!post || post.type !== 'post') return { error: `Post not found: ${args.post_id}` }
    const all = await getAllItems()
    const comments = all
      .filter(i => i.type === 'comment' && i.threadRootId === post.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(c => ({ id: c.id, text: c.text, author: c.authorName, created_at: c.createdAt }))
    return {
      post: { id: post.id, title: post.title ?? null, text: post.text, author: post.authorName, created_at: post.createdAt },
      comments,
    }
  }

  async function markRelevant(args: { ids: string[] }): Promise<{ ok: true; ids: string[] }> {
    return { ok: true, ids: args.ids }
  }

  async function dispatch(name: string, rawArgs: string): Promise<DispatchResult> {
    const args = rawArgs ? JSON.parse(rawArgs) : {}

    if (name === 'semantic_search') {
      const out = await semanticSearch(args)
      const preview = out.hits.slice(0, 5).map(h => {
        const label = h.cluster_label ? ` · ${h.cluster_label}` : ''
        return `${h.id}${label} — ${h.snippet.slice(0, 90)}`
      }).join('\n')
      return { result: out, summary: `${out.hits.length} hits`, preview }
    }

    if (name === 'list_alerts') {
      const out = await listAlertsTool(args)
      const preview = out.alerts.slice(0, 5).map(a => {
        const tag = a.mode === 'flag' ? (a.flag_type ?? 'flag') : 'surface'
        const title = a.anchor_title ?? a.anchor_snippet
        return `${tag} · ${title.slice(0, 70)}`
      }).join('\n')
      return { result: out, summary: `${out.alerts.length} alerts`, preview }
    }

    if (name === 'get_alert') {
      const out = await getAlertTool(args)
      if ('error' in out) return { result: out, summary: out.error }
      const title = out.anchor.title ?? out.anchor.text.slice(0, 80)
      const flag = out.flag_type ?? out.mode
      const reasoning = out.reasoning ? `\n${out.reasoning.slice(0, 160)}` : ''
      const conn = out.connections.slice(0, 3).map(c => `→ ${c.author} (${c.classification})`).join('\n')
      const preview = [`${flag} · ${title}`, reasoning, conn].filter(Boolean).join('\n')
      return {
        result: out,
        summary: `${out.connections.length} connections`,
        preview,
        sideEffect: { type: 'select_alert', alert_id: out.id },
      }
    }

    if (name === 'get_topic') {
      const out = await getTopic(args)
      if ('error' in out) return { result: out, summary: out.error }
      const clusterId = clusterIdForLabel(out.label, clusterLabelById)
      const terms = out.top_terms.join(', ')
      const preview = `${out.size} items · ${terms}`
      return {
        result: out,
        summary: `${out.size} items`,
        preview,
        sideEffect: clusterId ? { type: 'select_topic', cluster_id: clusterId, label: out.label } : undefined,
      }
    }

    if (name === 'list_topics') {
      const out = await listTopics(args)
      const preview = out.topics.slice(0, 5).map(t => `${t.label} · ${t.size} items`).join('\n')
      return { result: out, summary: `${out.topics.length} topics`, preview }
    }

    if (name === 'get_thread') {
      const out = await getThread(args)
      if ('error' in out) return { result: out, summary: out.error }
      const title = out.post.title ?? out.post.text.slice(0, 80)
      const last = out.comments[out.comments.length - 1]
      const lastLine = last ? `\nlast: ${last.author} — ${last.text.slice(0, 70)}` : ''
      const preview = `${title} · u/${out.post.author}${lastLine}`
      return {
        result: out,
        summary: `${out.comments.length} comments`,
        preview,
        sideEffect: { type: 'select_post', post_id: out.post.id },
      }
    }

    if (name === 'get_item') {
      const out = await getItemTool(args)
      if ('error' in out) return { result: out, summary: out.error }
      const title = out.title ?? out.text.slice(0, 80)
      const cluster = out.cluster_label ? ` · ${out.cluster_label}` : ''
      const preview = `${title} · u/${out.author}${cluster}`
      const sideEffect: ToolSideEffect = out.kind === 'post'
        ? { type: 'select_post', post_id: out.id }
        : { type: 'select_comment', comment_id: out.id, thread_root_id: out.thread_root_id }
      return { result: out, summary: out.kind, preview, sideEffect }
    }

    if (name === 'mark_relevant') {
      const out = await markRelevant(args)
      const preview = out.ids.map(id => `- ${id}`).join('\n')
      return {
        result: out,
        summary: `${out.ids.length} items`,
        preview,
        sideEffect: { type: 'highlight', ids: out.ids },
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  }

  return { dispatch }
}
