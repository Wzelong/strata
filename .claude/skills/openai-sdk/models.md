# GPT-5.5 Models Reference

## Model Selection Policy (this project)

Use a two-model split:

- **Complex tasks → `gpt-5.5`**: reasoning, code, multi-step agents, grounded assistants, long-context retrieval, tool-heavy workflows, customer-facing generation.
- **Simple tasks → `gpt-5.4-mini`**: high-volume, narrow, well-bounded tasks — extraction, classification, routing, short transforms, tight-latency calls where reasoning isn't the bottleneck.

Pick the model by task character, not per-request cost. If you're unsure, start with `gpt-5.5` and downshift to `gpt-5.4-mini` once the task is proven narrow.

## Model Variants

| Variant | Best for |
|---------|----------|
| `gpt-5.5` | Complex reasoning, code, multi-step agents, grounded assistants, long-context workflows |
| `gpt-5.4-mini` | High-volume simple tasks, extraction, classification, routing, tight-latency calls |
| `gpt-5.4-nano` | Narrowest well-bounded tasks — closed outputs (labels, enums, short JSON) |

## Key Parameters

### Reasoning Effort

```python
response = client.responses.create(
    model="gpt-5.5",
    input="...",
    reasoning={"effort": "medium"},  # none|low|medium|high|xhigh
)
```

GPT-5.5 defaults to `medium`. GPT-5.5 reaches strong results with fewer reasoning tokens than prior models, so re-evaluate `low` and `medium` before escalating. Supported values by model:

- GPT-5: minimal, low, medium (default), high
- GPT-5.2: none (default), low, medium, high
- GPT-5.4: none (default), low, medium, high, xhigh
- GPT-5.5: none, low, medium (default), high, xhigh

| Effort | When to use |
|--------|-------------|
| `none` | Latency-critical, no multi-step tool chaining (voice turns, fast retrieval, classification) |
| `low` | Latency-sensitive workflows where tool use, planning, search, or decision-making still matters |
| `medium` | Default. Balanced point on the latency/performance curve for most production workloads |
| `high` | Complex agentic tasks that require hard reasoning; latency matters less |
| `xhigh` | Hardest async agentic tasks or evals at the intelligence frontier |

Higher effort isn't automatically better. With conflicting instructions, weak stopping criteria, or open-ended tool access, high effort can cause overthinking, unnecessary searching, or output-quality regressions. Escalate only when evals show a measurable quality gain.

### Verbosity

```python
response = client.responses.create(
    model="gpt-5.5",
    input="...",
    text={"verbosity": "low"},  # low|medium|high
)
```

API default: `medium`. GPT-5.5's default style is already more concise and direct than 5.4, so `low` is often a better starting point — responses at `low` on 5.5 are proportionally tighter than `low` on 5.4. Use `high` for thorough explanations or multi-file refactoring.

### Parameter Compatibility

`temperature`, `top_p`, `logprobs` only work with `reasoning.effort="none"`. For other efforts, use `reasoning.effort`, `text.verbosity`, and `max_output_tokens` instead.

### Image Inputs (changed in 5.5)

GPT-5.5 preserves more visual detail by default. When `image_detail` is unset or `auto`, the model uses `original` behavior — images aren't resized up to 10,240,000 pixels or a 6,000-pixel dimension limit. `high` preserves up to 2,500,000 pixels / 2,048-pixel limit. `low` is newly aggressive about resizing above 512 px for context efficiency.

## 1M Context Window

GPT-5.5 supports up to 1M tokens. Separate pricing tiers for requests under/over 272K tokens.

## Phase Parameter

For long-running or tool-heavy flows, use `phase` on assistant messages:

```python
response = client.responses.create(
    model="gpt-5.5",
    input=[
        {"role": "assistant", "phase": "commentary", "content": "Analyzing..."},
        {"role": "assistant", "phase": "final_answer", "content": "Result here."},
        {"role": "user", "content": "Next question"},
    ],
)
```

- `commentary`: intermediate updates, preambles before tool calls
- `final_answer`: completed answer
- Do not add `phase` to user messages
- Use `previous_response_id` to avoid manual phase management

## Preambles

GPT-5.5 can explain intent before tool calls. Improves perceived responsiveness in streaming UIs:

```python
response = client.responses.create(
    model="gpt-5.5",
    instructions="Before any tool calls for a multi-step task, send a short user-visible update that acknowledges the request and states the first step. Keep it to one or two sentences.",
    tools=tools,
    input="...",
)
```

## Migration Guide

Treat GPT-5.5 as a new model family to tune for, not a drop-in replacement. Start migration with a fresh baseline instead of carrying over every instruction from an older prompt stack.

| From | GPT-5.5 Start |
|------|--------------|
| `gpt-5.4` | Same slug family, but re-tune: many workflows drop an effort tier, and `text.verbosity="low"` yields tighter output |
| `gpt-5.2` / `gpt-5.3-codex` | `reasoning.effort="medium"` (the new default), re-evaluate `low` |
| `gpt-4.1` / `gpt-4o` | `reasoning.effort="none"` or `low`, depending on task |
| `o3` | `reasoning.effort="medium"` or `"high"` |
| `o4-mini` / `gpt-4.1-mini` | Use `gpt-5.4-mini` |
| `gpt-4.1-nano` | Use `gpt-5.4-nano` |

Migration checklist:

1. Update the model slug to `gpt-5.5`.
2. Use the Responses API for any reasoning, tool-calling, or multi-turn use case.
3. Re-tune `reasoning.effort` — escalate to `high`/`xhigh` only when evals justify it.
4. Set `text.verbosity="low"` for concise responses.
5. Remove step-by-step process guidance; state outcomes and success criteria.
6. Remove output-schema definitions from prompts; use Structured Outputs.
7. Drop "current date" from system instructions (5.5 knows UTC).
8. Reorder prompts for caching: static content first, dynamic content last.
9. For tool-heavy flows, verify `phase`, preambles, and assistant-item replay still work.
10. Re-benchmark on accuracy, token consumption, and end-to-end latency.

## GPT-5.5 Strengths

- Efficient reasoning — strong results with fewer reasoning tokens than prior models
- Outcome-first task execution: turns product intent into concrete next steps
- Precise tool selection and argument use on large tool surfaces
- Long-running agentic workflows, multi-step service workflows
- Long-context retrieval and grounded answers
- Coding workflows that need planning, codebase navigation, verification, and multi-step execution
- Polished customer-facing response quality with minimal scaffolding

## Prompting GPT-5.5

GPT-5.5 is a reasoning model. Prefer shorter, outcome-first prompts:

- State the expected outcome and success criteria; avoid prescribing every step.
- Reserve absolute rules (`ALWAYS`, `NEVER`, `must`) for true invariants. For judgment calls, use decision rules instead.
- Add explicit stopping conditions for long-running or tool-heavy tasks.
- For customer-facing assistants, add a short personality block — 5.5's default tone is direct and task-oriented.
- Keep prompts simple and direct; avoid chain-of-thought prompts (reasoning is internal).
- Use delimiters (markdown, XML) for clarity.
- Try zero-shot first, then few-shot if needed.
- Use `developer` role for system rules, `user` for inputs.

### Prompt Patterns

Outcome-first goal:
```text
Resolve the customer's issue end to end.

Success means:
- the eligibility decision is made from the available policy and account data
- any allowed action is completed before responding
- the final answer includes completed_actions, customer_message, and blockers
- if evidence is missing, ask for the smallest missing field
```

Retrieval budget (stopping rules for search):
```text
For ordinary Q&A, start with one broad search using short, discriminative keywords. If the top results contain enough citable support for the core request, answer from those results instead of searching again.

Make another retrieval call only when a required fact, parameter, owner, date, ID, or source is missing; the user asked for exhaustive coverage; or the answer would otherwise contain an important unsupported factual claim.
```

Validation loop for coding agents:
```text
After making changes, run the most relevant validation available:
- targeted unit tests for changed behavior
- type checks or lint checks when applicable
- build checks for affected packages
- a minimal smoke test when full validation is too expensive

If validation cannot be run, explain why and describe the next best check.
```

Creative drafting guardrails:
```text
For creative or generative requests, distinguish source-backed facts from creative wording.
- Use retrieved or provided facts for concrete product, customer, metric, roadmap, date, capability, and competitive claims, and cite those claims.
- Do not invent specific names, metrics, roadmap status, customer outcomes, or product capabilities.
- If there is little citable support, write a useful generic draft with placeholders or clearly labeled assumptions.
```

### Suggested Prompt Structure

```text
Role: [1-2 sentences defining the model's function, context, and job]

# Personality
[tone, demeanor, and collaboration style]

# Goal
[user-visible outcome]

# Success criteria
[what must be true before the final answer]

# Constraints
[policy, safety, business, evidence, and side-effect limits]

# Output
[sections, length, and tone]

# Stop rules
[when to retry, fallback, abstain, ask, or stop]
```

## Mini and Nano Guidance

**gpt-5.4-mini**: More literal, less assumption-making. Put critical rules first. Specify full execution order. Use numbered steps and decision rules. Good default for the "simple task" half of the complex/simple split.

**gpt-5.4-nano**: Only for narrow, well-bounded tasks. Prefer closed outputs (labels, enums, short JSON). Route anything requiring real planning to `gpt-5.5`.
