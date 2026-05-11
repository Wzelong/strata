# Responses API Reference

## Basic Text Generation

```python
from openai import OpenAI
client = OpenAI()

response = client.responses.create(
    model="gpt-5.5",
    input="Write a haiku about code.",
)
print(response.output_text)
```

The `output_text` property aggregates all text outputs. The raw `output` array can contain multiple items: messages, tool calls, reasoning items.

## Instructions Parameter

High-level instructions that take priority over `input`. Only applies to current request (not persisted across `previous_response_id` turns).

```python
response = client.responses.create(
    model="gpt-5.5",
    instructions="You are a concise technical writer.",
    input="Explain REST APIs",
)
```

## Message Roles

```python
response = client.responses.create(
    model="gpt-5.5",
    input=[
        {"role": "developer", "content": "System rules and business logic"},
        {"role": "user", "content": "User's question"},
    ],
)
```

Priority: `developer` > `user` > `assistant`. Developer messages are like function definitions; user messages are like arguments.

## Reasoning Control

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Complex problem",
    reasoning={"effort": "medium"},
)
```

Supported efforts by model:
- GPT-5: minimal, low, medium (default), high
- GPT-5.2: none (default), low, medium, high
- GPT-5.4: none (default), low, medium, high, xhigh
- GPT-5.5: none, low, medium (default), high, xhigh

### Reasoning Summaries

```python
response = client.responses.create(
    model="gpt-5.5",
    input="What is the capital of France?",
    reasoning={"effort": "low", "summary": "auto"},
)

for item in response.output:
    if item.type == "reasoning":
        for s in item.summary:
            print(s.text)
```

### Encrypted Reasoning (Zero Data Retention)

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Question",
    reasoning={"effort": "medium"},
    include=["reasoning.encrypted_content"],
    store=False,
)
# Pass reasoning items with encrypted_content to next request
```

### Keeping Reasoning Items in Context

For function calling with reasoning models, pass all reasoning items from previous responses back. Use `previous_response_id` or manually include all output items as input.

```python
# Automatic via previous_response_id
response2 = client.responses.create(
    model="gpt-5.5",
    previous_response_id=response.id,
    input=[{"role": "user", "content": "Follow-up"}],
)

# Manual: pass all output items back
next_input = list(response.output) + [
    {"role": "user", "content": "Follow-up"}
]
response2 = client.responses.create(
    model="gpt-5.5",
    input=next_input,
)
```

## Verbosity Control

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Explain quantum computing",
    text={"verbosity": "low"},  # low|medium|high
)
```

## Reusable Prompts

```python
response = client.responses.create(
    model="gpt-5.5",
    prompt={
        "id": "pmpt_abc123",
        "version": "2",
        "variables": {
            "customer_name": "Jane Doe",
            "product": "Widget",
        },
    },
)
```

## Handling Incomplete Responses

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Complex task",
    reasoning={"effort": "medium"},
    max_output_tokens=300,
)

if response.status == "incomplete":
    reason = response.incomplete_details.reason
    if reason == "max_output_tokens":
        if response.output_text:
            print("Partial:", response.output_text)
        else:
            print("Ran out of tokens during reasoning")
```

Reserve at least 25,000 tokens for reasoning and outputs when starting.

## Phase Parameter (GPT-5.4+)

For long-running or tool-heavy flows, use `phase` on assistant messages to distinguish commentary from final answers.

```python
response = client.responses.create(
    model="gpt-5.5",
    input=[
        {
            "role": "assistant",
            "phase": "commentary",
            "content": "Inspecting logs for root cause.",
        },
        {
            "role": "assistant",
            "phase": "final_answer",
            "content": "Root cause: cache invalidation race.",
        },
        {"role": "user", "content": "Give me a fix plan."},
    ],
)
```

Do not add `phase` to user messages. Missing or dropped `phase` can cause preambles to be treated as final answers.

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
    elif event.type == "response.completed":
        print("\n[Done]")
```

Key event types:
- `response.created`
- `response.output_text.delta`
- `response.completed`
- `response.output_item.added` (for tool calls)
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `error`
