---
name: openai-sdk
description: OpenAI Python SDK reference. Use when writing code that imports openai, creates an OpenAI client, calls the Responses API, Chat Completions API, generates embeddings, uses function calling, structured outputs, streaming, reasoning models, or works with GPT-5.5/GPT-5.4/GPT-5/GPT-4.1 models.
---

# OpenAI Python SDK Quick Reference

## Client Setup

```python
from openai import OpenAI
client = OpenAI()  # reads OPENAI_API_KEY from env
```

## Model Selection Policy

Use a two-model split for this project:

- **Complex tasks → `gpt-5.5`** — reasoning, code, multi-step agents, grounded assistants, long-context retrieval, tool-heavy workflows, customer-facing generation.
- **Simple tasks → `gpt-5.4-mini`** — high-volume, narrow, well-bounded tasks: extraction, classification, routing, short transforms, tight-latency calls.

Examples below default to `gpt-5.5`. For the simple half, swap the `model=` field to `gpt-5.4-mini`; most other parameters carry over unchanged. See [models.md](models.md) for full selection guidance.

## Responses API (Recommended)

Primary API for all new projects. Supports reasoning, tools, structured outputs, and conversation state.

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Your prompt here",
    instructions="System-level instructions",
    reasoning={"effort": "medium"},    # none|low|medium|high|xhigh (default: medium)
    text={"verbosity": "low"},         # low|medium|high (API default: medium; low is often better on 5.5)
)
print(response.output_text)
```

Multi-turn with message roles:

```python
response = client.responses.create(
    model="gpt-5.5",
    input=[
        {"role": "developer", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello"},
    ],
)
```

Conversation state via `previous_response_id`:

```python
response2 = client.responses.create(
    model="gpt-5.5",
    previous_response_id=response.id,
    input=[{"role": "user", "content": "Follow-up question"}],
)
```

For detailed patterns, see [responses-api.md](responses-api.md).

## Chat Completions API (Legacy)

```python
completion = client.chat.completions.create(
    model="gpt-5.5",
    messages=[
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hello"},
    ],
)
print(completion.choices[0].message.content)
```

## Embeddings

```python
response = client.embeddings.create(
    input="Your text here",
    model="text-embedding-3-small",  # or text-embedding-3-large
    dimensions=256,                   # optional, reduce dimensions
)
vector = response.data[0].embedding
```

Models: `text-embedding-3-small` (1536d, cheaper), `text-embedding-3-large` (3072d, better). Max input: 8192 tokens. Use `cl100k_base` encoding with tiktoken.

For detailed patterns, see [embeddings.md](embeddings.md).

## Function Calling

```python
tools = [{
    "type": "function",
    "name": "get_weather",
    "description": "Get weather for a location",
    "parameters": {
        "type": "object",
        "properties": {
            "location": {"type": "string"},
        },
        "required": ["location"],
        "additionalProperties": False,
    },
    "strict": True,
}]

response = client.responses.create(
    model="gpt-5.5",
    tools=tools,
    input=[{"role": "user", "content": "Weather in Paris?"}],
)

for item in response.output:
    if item.type == "function_call":
        result = call_function(item.name, json.loads(item.arguments))
        # Return result to model
```

For tool_choice, parallel calls, custom tools, namespaces, and CFGs, see [function-calling.md](function-calling.md).

## Structured Outputs

With Pydantic (Responses API):

```python
from pydantic import BaseModel

class CalendarEvent(BaseModel):
    name: str
    date: str
    participants: list[str]

response = client.responses.parse(
    model="gpt-5.5",
    input=[{"role": "user", "content": "Extract: Alice and Bob meet Tuesday"}],
    text_format=CalendarEvent,
)
```

For Chat Completions, refusals, and JSON mode, see [structured-outputs.md](structured-outputs.md).

## Streaming

```python
stream = client.responses.create(
    model="gpt-5.5",
    input="Tell me a story",
    stream=True,
)

for event in stream:
    if event.type == "response.output_text.delta":
        print(event.delta, end="")
```

Key events: `response.created`, `response.output_text.delta`, `response.completed`, `error`.

## Reasoning Models

GPT-5.5 is a reasoning model. Control reasoning with `reasoning.effort`. Default is `medium` — re-evaluate `low` and `medium` before escalating, since GPT-5.5 reaches strong results with fewer reasoning tokens than prior models.

| Effort | Use case |
|--------|----------|
| `none` | Latency-critical, no multi-step tool chaining (voice turns, fast retrieval, classification) |
| `low` | Latency-sensitive workflows where tool use or planning still matters |
| `medium` | Default. Balanced quality/latency/cost for most production workloads |
| `high` | Complex agentic tasks where extra latency is acceptable |
| `xhigh` | Hardest async agentic tasks or evals at the intelligence frontier |

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Complex problem here",
    reasoning={"effort": "medium", "summary": "auto"},
)
```

Higher effort isn't automatically better — with conflicting instructions, weak stopping criteria, or open-ended tool access, high effort can cause overthinking. Escalate only when evals show a measurable quality gain. Pass reasoning items back between turns via `previous_response_id` for better performance and lower token usage.

## Built-in Tools

```python
# Web search
response = client.responses.create(
    model="gpt-5.5",
    tools=[{"type": "web_search_preview"}],
    input="Latest news about...",
)

# File search
response = client.responses.create(
    model="gpt-5.5",
    tools=[{"type": "file_search", "vector_store_ids": ["vs_abc"]}],
    input="Find in documents...",
)

# Remote MCP
response = client.responses.create(
    model="gpt-5.5",
    tools=[{
        "type": "mcp",
        "server_label": "my_server",
        "server_url": "https://example.com/sse",
        "require_approval": "never",
    }],
    input="Use the MCP tool",
)
```

## GPT-5.5 Specifics

- Default reasoning: `medium` (re-evaluate `low`/`medium` before escalating)
- Default style is efficient, direct, and task-oriented; use `text={"verbosity": "low"}` for shorter answers, add personality blocks for customer-facing UX
- Outcome-first prompts beat step-by-step process guidance; state success criteria and stopping rules
- Image inputs preserve more visual detail by default (`auto` behavior = `original`, up to 10.24M px / 6000 px dim); specify `low` to be aggressive about resizing
- 1M token context window
- `temperature`/`top_p`/`logprobs` only with `reasoning.effort="none"`
- Phase parameter for long-running agents: `"commentary"` vs `"final_answer"`
- Tool search (`tool_search`) for large tool surfaces
- Native compaction for long trajectories
- Model is aware of the current UTC date — don't add the date to instructions unless you need a non-UTC reference

## Migration from GPT-5.4

Treat GPT-5.5 as a new model family to tune for, not a drop-in swap:

- Update the model slug to `gpt-5.5`.
- Re-evaluate `reasoning.effort` — many flows that used `medium`/`high` now perform well at `low`/`medium`.
- Set `text.verbosity="low"` for concise responses; at `low`, 5.5 is noticeably more terse than 5.4 was at `low`.
- Drop output-schema descriptions from prompts; use Structured Outputs instead.
- Drop "current date" from system instructions.
- Remove detailed step-by-step process guidance; state the outcome and success criteria instead.
- For tool-heavy flows, verify `phase`, preambles, and assistant-item replay still work correctly.
- Re-benchmark on accuracy, token consumption, and end-to-end latency — don't trust legacy prompts to transfer.

For model variants, detailed migration, and prompting patterns, see [models.md](models.md).

## Additional Resources

- [responses-api.md](responses-api.md) — Responses API detailed patterns
- [embeddings.md](embeddings.md) — Embedding models and use cases
- [function-calling.md](function-calling.md) — Function calling, custom tools, tool search
- [structured-outputs.md](structured-outputs.md) — Structured outputs and JSON mode
- [models.md](models.md) — GPT-5.5 family, reasoning, migration, prompting guidance
