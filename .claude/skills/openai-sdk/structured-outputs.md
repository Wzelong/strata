# Structured Outputs Reference

Ensures model output adheres to a JSON Schema. No need to validate or retry.

## Responses API with Pydantic

```python
from pydantic import BaseModel
from openai import OpenAI

client = OpenAI()

class Step(BaseModel):
    explanation: str
    output: str

class MathReasoning(BaseModel):
    steps: list[Step]
    final_answer: str

response = client.responses.parse(
    model="gpt-5.5",
    input=[
        {"role": "system", "content": "You are a helpful math tutor."},
        {"role": "user", "content": "how can I solve 8x + 7 = -23"},
    ],
    text_format=MathReasoning,
)

for output in response.output:
    if output.type != "message":
        continue
    for item in output.content:
        if item.type == "refusal":
            print(item.refusal)
        elif item.parsed:
            print(item.parsed)
```

## Chat Completions API with Pydantic

```python
completion = client.chat.completions.parse(
    model="gpt-4o-2024-08-06",
    messages=[
        {"role": "system", "content": "You are a helpful math tutor."},
        {"role": "user", "content": "how can I solve 8x + 7 = -23"},
    ],
    response_format=MathReasoning,
)

message = completion.choices[0].message
if message.refusal:
    print(message.refusal)
else:
    print(message.parsed)
```

## Handling Refusals

The model may refuse for safety reasons. Check for refusal before accessing parsed content:

- Responses API: check `item.type == "refusal"` in content items
- Chat Completions: check `message.refusal`

## When to Use

| Use case | Approach |
|----------|----------|
| Connecting model to tools/functions | Function calling with `strict: True` |
| Structuring model's response to user | `text_format` (Responses) or `response_format` (Chat Completions) |

## Structured Outputs vs JSON Mode

| | Structured Outputs | JSON Mode |
|---|---|---|
| Valid JSON | Yes | Yes |
| Adheres to schema | Yes | No |
| Models | gpt-4o-mini, gpt-4o-2024-08-06+ | gpt-3.5-turbo, gpt-4-*, gpt-4o-* |

Always prefer Structured Outputs over JSON mode.

## JSON Mode (Legacy)

```python
response = client.responses.create(
    model="gpt-5.5",
    input=[
        {"role": "user", "content": "Return a JSON object with name and age"},
    ],
    text={"format": {"type": "json_object"}},
)
```

The string "JSON" must appear somewhere in the prompt. JSON mode does not guarantee schema adherence.

## Tips

- Use Pydantic/zod SDK support to prevent schema divergence
- Handle user-generated input: include instructions for incompatible inputs
- Structured Outputs can still contain mistakes; adjust instructions or split into subtasks
