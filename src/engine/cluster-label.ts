import type OpenAI from 'openai'

const LABEL_MODEL = 'gpt-5.4-mini'
const BATCH_SIZE = 12
const PARALLEL = 10
const SAMPLES_PER_CLUSTER = 6

const SYSTEM_PROMPT = `Name each Reddit topic cluster with a short, scannable label.

Goal: produce labels a moderator can read at a glance and know what conversation lives inside the cluster.

Each input cluster includes sample items (posts and comments). Choose a label that reflects the dominant subject across the samples, not just one item.

Style invariants:
- 2 to 5 words.
- Title Case: capitalize the first letter of every word, including short connectives.
- No quotes, no trailing punctuation, no emoji.
- Concrete nouns and named entities. Avoid generic words ("Discussion", "Thread", "Posts") unless paired with something specific.
- Prefer the topic over the stance. "Cambridge Shooting Case" not "Outrage Over Cambridge Shooting".

If the samples genuinely span multiple unrelated topics, label the largest visible one.

Output one entry per input cluster, keyed by the cluster_id you receive.`

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cluster_id: { type: 'integer' },
          label: { type: 'string' },
        },
        required: ['cluster_id', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
} as const

export interface LabelSample {
  title?: string
  text: string
}

export interface LabelTarget {
  clusterId: number
  samples: LabelSample[]
}

export function titleCase(s: string): string {
  return s
    .trim()
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function buildBatchPrompt(targets: LabelTarget[]): string {
  return `Label the following clusters.\n\n${targets
    .map(({ clusterId, samples }) => {
      const lines = samples.slice(0, SAMPLES_PER_CLUSTER).map((s, i) => {
        const title = s.title ? `[${s.title}] ` : ''
        const text = s.text.slice(0, 220).replace(/\s+/g, ' ').trim()
        return `  ${i + 1}. ${title}${text}`
      })
      return `## Cluster ${clusterId}\n${lines.join('\n')}`
    })
    .join('\n\n')}`
}

async function labelOneBatch(client: OpenAI, targets: LabelTarget[]): Promise<Map<number, string>> {
  const response = await client.responses.create({
    model: LABEL_MODEL,
    reasoning: { effort: 'low' },
    input: [
      { role: 'developer', content: SYSTEM_PROMPT },
      { role: 'user', content: buildBatchPrompt(targets) },
    ],
    text: { format: { type: 'json_schema', name: 'cluster_labels', schema: LABEL_SCHEMA as Record<string, unknown>, strict: true } },
  })
  const parsed = JSON.parse(response.output_text) as { labels: Array<{ cluster_id: number; label: string }> }
  const out = new Map<number, string>()
  for (const { cluster_id, label } of parsed.labels) {
    if (!Number.isFinite(cluster_id) || typeof label !== 'string') continue
    out.set(cluster_id, titleCase(label))
  }
  return out
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= tasks.length) return
        results[i] = await tasks[i]()
      }
    }),
  )
  return results
}

export interface LabelClustersUsage {
  inputTokens: number
  outputTokens: number
}

export async function labelClusters(
  client: OpenAI,
  targets: LabelTarget[],
  opts?: { batchSize?: number; parallel?: number },
): Promise<{ labels: Map<number, string>; usage: LabelClustersUsage }> {
  if (targets.length === 0) return { labels: new Map(), usage: { inputTokens: 0, outputTokens: 0 } }
  const batchSize = opts?.batchSize ?? BATCH_SIZE
  const parallel = opts?.parallel ?? PARALLEL

  const batches: LabelTarget[][] = []
  for (let i = 0; i < targets.length; i += batchSize) batches.push(targets.slice(i, i + batchSize))

  const labels = new Map<number, string>()
  const tasks = batches.map(b => async () => labelOneBatch(client, b))
  const results = await runWithConcurrency(tasks, parallel)
  for (const m of results) for (const [k, v] of m) labels.set(k, v)

  return { labels, usage: { inputTokens: 0, outputTokens: 0 } }
}

export const CLUSTER_LABEL_MODEL = LABEL_MODEL
