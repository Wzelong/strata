# Function Calling Reference

## Defining Functions

```python
tools = [
    {
        "type": "function",
        "name": "get_weather",
        "description": "Retrieves current weather for the given location.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City and country e.g. Bogota, Colombia",
                },
                "units": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                },
            },
            "required": ["location", "units"],
            "additionalProperties": False,
        },
        "strict": True,
    },
]
```

Always set `strict: True` for reliable schema adherence. With strict mode, all fields must be in `required` and `additionalProperties` must be `False`. Mark optional fields with `"type": ["string", "null"]`.

## Complete Flow (Responses API)

```python
from openai import OpenAI
import json

client = OpenAI()

input_list = [
    {"role": "user", "content": "What's the weather in Paris?"}
]

response = client.responses.create(
    model="gpt-5.5",
    tools=tools,
    input=input_list,
)

input_list += response.output

for item in response.output:
    if item.type == "function_call":
        result = call_my_function(item.name, json.loads(item.arguments))
        input_list.append({
            "type": "function_call_output",
            "call_id": item.call_id,
            "output": json.dumps(result),
        })

response = client.responses.create(
    model="gpt-5.5",
    tools=tools,
    input=input_list,
)
print(response.output_text)
```

For reasoning models, pass back all reasoning items from response.output alongside function call outputs.

## Tool Choice

```python
# Auto (default): model decides
tool_choice="auto"

# Required: must call at least one
tool_choice="required"

# Specific function
tool_choice={"type": "function", "name": "get_weather"}

# None: no tools
tool_choice="none"

# Allowed tools subset
tool_choice={
    "type": "allowed_tools",
    "mode": "auto",
    "tools": [
        {"type": "function", "name": "get_weather"},
        {"type": "function", "name": "search_docs"},
    ],
}
```

## Parallel Tool Calls

Model may call multiple functions per turn. Disable with:

```python
response = client.responses.create(
    model="gpt-5.5",
    tools=tools,
    input=input_list,
    parallel_tool_calls=False,
)
```

## Namespaces

Group related tools by domain:

```python
tools = [
    {
        "type": "namespace",
        "name": "crm",
        "description": "CRM tools for customer lookup.",
        "tools": [
            {
                "type": "function",
                "name": "get_customer_profile",
                "description": "Fetch customer profile by ID.",
                "parameters": {
                    "type": "object",
                    "properties": {"customer_id": {"type": "string"}},
                    "required": ["customer_id"],
                    "additionalProperties": False,
                },
            },
        ],
    },
]
```

## Tool Search (GPT-5.4+)

Available on GPT-5.5. Especially useful on 5.5 given its precise tool-selection behavior.

Defer large tool surfaces until runtime. The model loads only definitions it needs:

```python
response = client.responses.create(
    model="gpt-5.5",
    tools=[
        {"type": "tool_search"},
        *deferred_tools,
    ],
    input="Help me with...",
)
```

## Custom Tools

Send freeform text (not JSON) as tool input:

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Write a Python hello world",
    tools=[{
        "type": "custom",
        "name": "code_exec",
        "description": "Executes arbitrary Python code.",
    }],
)
# output contains custom_tool_call with .input as plain text
```

### Context-Free Grammars

Constrain custom tool output with Lark or regex grammar:

```python
grammar = """
start: expr
expr: term ("+" term)*
term: INT
%import common.INT
"""

response = client.responses.create(
    model="gpt-5.5",
    input="Add four plus four",
    tools=[{
        "type": "custom",
        "name": "math_exp",
        "description": "Creates mathematical expressions",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": grammar,
        },
    }],
)
```

Regex grammar:

```python
response = client.responses.create(
    model="gpt-5.5",
    input="Save timestamp for August 7th 2025 at 10AM",
    tools=[{
        "type": "custom",
        "name": "timestamp",
        "description": "Saves a timestamp",
        "format": {
            "type": "grammar",
            "syntax": "regex",
            "definition": r"^(?P<month>January|February|...)\\s+(?P<day>\\d{1,2})...$",
        },
    }],
)
```

## Built-in Tools

```python
# Web search
tools=[{"type": "web_search_preview"}]

# File search
tools=[{"type": "file_search", "vector_store_ids": ["vs_abc"]}]

# Remote MCP
tools=[{
    "type": "mcp",
    "server_label": "my_server",
    "server_url": "https://example.com/sse",
    "require_approval": "never",
}]
```

## Best Practices

1. Write clear function names and parameter descriptions
2. Use enums and object structure to prevent invalid states
3. Don't make the model fill arguments you already know
4. Combine functions that are always called in sequence
5. Aim for fewer than 20 functions available at start of turn
6. Use tool search to defer large tool surfaces
7. Use strict mode always
