---
name: writing-prompts
description: Guidelines for writing effective prompts for LLMs (OpenAI GPT-5.5/GPT-5.4, Anthropic Claude). Covers outcome-first prompting, stopping rules, retrieval budgets, personality blocks, and preambles. Use when authoring or refining system prompts, agent instructions, or prompt files for LLM-powered features.
---

# Writing effective LLM prompts

Distilled best practices from OpenAI and Anthropic. Apply when designing new prompts or diagnosing why an existing one underperforms.

## Core principles

**Assume the model is smart.** Don't explain common concepts, define obvious terms, or pad with context the model already has. Every token competes with user messages and other context.

**Be specific, not vague.** "Create a dashboard" → "Create an analytics dashboard with filters, charts, and a summary table. Include hover states and empty states."

**Explain *why*, not just *what*.** Context beats commands:
- Weak: `NEVER use ellipses`
- Strong: `Your response will be read aloud by a text-to-speech engine, so never use ellipses since the engine can't pronounce them.`

**Prefer positive instructions over negative ones.**
- Weak: `Do not use markdown`
- Strong: `Respond in flowing prose paragraphs.`

**Golden rule:** Show the prompt to someone with no context. If they'd be confused, the model will be too.

## Structure

Organize developer/system prompts with clear sections, usually in this order:

```
# Identity
Describe role, communication style, high-level goals.

# Instructions
Rules the model must follow. Use subsections for complex domains.

# Examples
Show input/output pairs. Wrap in <example> tags.

# Context
Data relevant to this specific request (put large context near the end for non-reasoning models; at the TOP for Claude with long documents).
```

Use Markdown headers for logical sections. Use XML tags (`<example>`, `<document>`, `<input>`) to delineate content types — the model parses them more reliably than prose boundaries.

## Over-prompting: when adding more rules makes it worse

Signs you're over-prompting:
- Multiple ALL-CAPS `CRITICAL:` / `MUST:` / `NEVER:` — the model starts tuning them out
- Contradictions between sections (e.g. "default to free-form" vs "default to multiple choice")
- Rules that redundantly restate the same idea
- Very long lists of edge cases that should be collapsed into a principle

Fix by:
- Dropping each rule you don't have a specific failure case for
- Consolidating redundant sections
- Replacing "CRITICAL: do X" with plain "Do X" — modern models (GPT-5, Claude 4.6) follow instructions without caps
- Resolving contradictions explicitly (state the default and the exception)

## Few-shot examples

Examples are one of the strongest steering levers. Use 3-5 when tone, format, or edge-case handling matters:

```
<example>
Input: "Built authentication system"
Output: "feat(auth): implement JWT-based authentication"
</example>
```

Make examples:
- **Relevant** — mirror your actual use case
- **Diverse** — cover edge cases
- **Structured** — wrap in tags so the model can distinguish them from instructions

Avoid examples so specific they anchor the model to narrow patterns. Avoid only showing one variation.

## Instructions vs user messages

Messages have priority: `developer` (system) > `user` > `assistant`. Put:
- Business logic, rules, tone → developer/system prompt
- Per-request data, arguments, user input → user message

Don't stuff per-request variables into the system prompt — it breaks prompt caching and bloats context.

## Prompt caching

OpenAI and Anthropic cache stable prefixes. To maximize cache hits:
- Put invariant content (rules, examples) at the start of the system prompt
- Put variable content (user data, current state) at the end or in the user message
- Pass API params in consistent order

A small, stable system prompt + dynamic tool-fetched context will usually outperform dumping everything into the prompt every turn.

## Reasoning vs GPT models

Different approaches work best:

**Reasoning models (o-series, GPT-5.5, Claude with thinking)**: Treat like a senior co-worker. Give high-level goals, trust them to work out details. Avoid prescriptive step-by-step instructions — their internal reasoning often exceeds what you'd write.

**GPT models (non-reasoning)**: Treat like a junior co-worker. Be explicit, provide examples, spell out edge cases.

Claude 4.6 sits in between — highly steerable, responsive to plain English instructions without CAPS. If prompts were tuned for older models, dial back the aggressive language.

## GPT-5.5 specifics

GPT-5.5 raises the baseline for outcome-first prompting. A few patterns are especially important:

**Outcome-first, not process-first.** Describe the destination, not every step. Give GPT-5.5 room to choose an efficient path.

```
Prefer:
Resolve the customer's issue end to end.
Success means: eligibility decision made from available data; allowed actions
completed before responding; final answer includes completed_actions,
customer_message, and blockers; if evidence is missing, ask for the smallest
missing field.

Avoid:
First inspect A, then inspect B, then compare every field, then think through
all possible exceptions, then decide which tool to call, then call the tool...
```

**Reserve absolute rules for true invariants.** `ALWAYS` / `NEVER` / `must` for safety rules, required output fields, or actions that should never happen. For judgment calls (when to search, when to ask, when to keep iterating), use decision rules: "Make another retrieval call only when X, Y, or Z."

**Add explicit stopping conditions.** GPT-5.5 with open-ended tools can overthink. Tell it when to stop:

```
After each result, ask: "Can I answer the user's core request now with useful
evidence and citations?" If yes, answer.

Use the minimum evidence sufficient to answer correctly, cite it precisely,
then stop.
```

**Retrieval budgets are stopping rules for search.** Define when enough evidence is enough:

```
For ordinary Q&A, start with one broad search. If the top results contain
enough citable support, answer from those results instead of searching again.
Make another retrieval call only when a required fact/owner/date/ID/source is
missing, the user asked for exhaustive coverage, or the answer would otherwise
contain an unsupported factual claim.
```

**Personality blocks for customer-facing UX.** GPT-5.5's default tone is efficient, direct, and task-oriented — good for production, sparse for conversational products. Add a short personality block defining both tone (how it sounds) and collaboration style (how it works — when to ask, when to assume, how proactive).

```
# Personality
You are a capable collaborator: approachable, steady, and direct. Assume the
user is competent and acting in good faith. Prefer making progress over
stopping for clarification when the request is already clear enough to
attempt. Ask for clarification only when the missing information would
materially change the answer. Stay concise without becoming curt.
```

**Preambles improve streaming UX.** For multi-step or tool-heavy tasks, prompt a short visible acknowledgment before tool calls:

```
Before any tool calls for a multi-step task, send a short user-visible update
that acknowledges the request and states the first step. One or two sentences.
```

**Creative drafting needs guardrails.** For slides, launch copy, leadership blurbs, customer summaries: tell the model which claims must be source-backed and which parts may be creatively written. Use placeholders or labeled assumptions when citable support is missing, not invented specifics.

**Drop "the current date".** GPT-5.5 knows today's UTC date. Only add date context when you need a non-UTC reference (user-local, business timezone, policy-effective date).

**Don't describe the output schema in the prompt.** Use Structured Outputs (`text_format` on Responses, `response_format` on Chat Completions) instead — tighter adherence, fewer tokens.

**Re-evaluate reasoning effort before escalating.** GPT-5.5 reaches strong results with fewer reasoning tokens than prior models. `medium` is the new default; many flows that previously used `medium`/`high` perform well at `low`/`medium` on 5.5. Escalate only when evals show measurable gain.

**Set `text.verbosity="low"` for concise responses.** At `low`, 5.5 is proportionally tighter than 5.4 was at `low`.

### Suggested GPT-5.5 prompt structure

```
Role: [1-2 sentences defining the model's function and job]

# Personality
[tone, demeanor, collaboration style — skip for non-customer-facing tasks]

# Goal
[user-visible outcome]

# Success criteria
[what must be true before the final answer]

# Constraints
[policy, safety, business, evidence, side-effect limits]

# Output
[sections, length, tone]

# Stop rules
[when to retry, fallback, abstain, ask, or stop]
```

## Tool use prompts

When the model has tools available:
- State *when* to use each tool, not just what it does
- For expensive/destructive tools, describe when NOT to use them
- If tools can run in parallel, say so explicitly — modern models do this well with one sentence of guidance

Example: `Use get_material(name) before starting to improve an item. Don't guess at item contents.`

## Iterating on prompts

1. **Establish a baseline.** Run the prompt on 5-10 representative inputs. Note specific failures.
2. **Fix the actual failures.** Add instructions only for observed problems, not imagined ones.
3. **Test again on the same inputs.** Make sure the fix didn't break something that worked.
4. **Prune.** Remove any rule you can't trace to a specific failure case.

The best prompt is the shortest one that reliably produces the desired output. Start minimal, grow only when needed, prune regularly.

## Format matters

The format of your prompt influences the format of the output:
- Heavy markdown in the prompt → heavy markdown in responses
- Bullet points everywhere → the model will bullet-point its answers
- Prose-style prompt → more natural prose responses

Match your prompt style to the output style you want.

## Checklist

Before shipping a prompt:
- [ ] No redundant or contradictory rules
- [ ] No CAPS-LOCK `CRITICAL:` warnings unless absolutely necessary
- [ ] Rules explain *why*, not just *what* (especially non-obvious ones)
- [ ] Examples cover the tricky cases, not just easy ones
- [ ] Stable content at the start, variable content at the end (for caching)
- [ ] Tested against 5+ real inputs with measured failure rate
- [ ] Tried the "show to a colleague" test — would a smart stranger follow it?
