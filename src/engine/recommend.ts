import type OpenAI from 'openai'
import type { Item, Hit, Rule, Recommendation, CostTracker } from './types.js'

export const RECOMMENDATION_SYSTEM = `Given a pending item, similar precedents with their moderation decisions, and community rules, recommend a moderation action.

Actions:
- remove: Item violates a rule. You MUST specify which ruleId.
- approve: Item follows all rules and is acceptable.
- skip: Borderline or insufficient confidence.

Process:
1. Check if the item directly violates any rule (independent of precedents).
2. If similar items were removed for a rule violation and this item shows the same pattern, recommend removal citing that rule.
3. If evidence is mixed or borderline, recommend skip.`

export const RECOMMENDATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', enum: ['remove', 'approve', 'skip'] },
    rationale: { type: 'string' },
    ruleId: { type: ['string', 'null'] },
  },
  required: ['recommendation', 'rationale', 'ruleId'],
  additionalProperties: false,
}

export async function recommendDecision(
  client: OpenAI,
  item: Item,
  precedents: Hit[],
  rules: Rule[],
  cost?: CostTracker,
): Promise<Recommendation> {
  const rulesText = rules.map(r => `- ${r.id}: ${r.shortName} — ${r.description}`).join('\n')
  const precedentsText = precedents.map(p =>
    `[weight: ${p.weight.toFixed(3)}] Decision: ${p.item.decision} | Rule: ${p.item.decisionReason || 'n/a'}\nText: "${p.item.text.slice(0, 200)}"`
  ).join('\n\n')

  const systemPrompt = RECOMMENDATION_SYSTEM + `\n\nRules:\n${rulesText}`
  const userPrompt = `## Pending Item\nID: ${item.id}\nText: "${item.text}"\n\n## Precedents (sorted by relevance)\n${precedentsText}\n\nWhat moderation action do you recommend?`

  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    text: { format: { type: 'json_schema', name: 'recommendation', schema: RECOMMENDATION_SCHEMA, strict: true } },
  })
  cost?.track(response.usage)
  return JSON.parse(response.output_text) as Recommendation
}
