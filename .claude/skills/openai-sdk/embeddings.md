# Embeddings Reference

## Create Embeddings

```python
from openai import OpenAI
client = OpenAI()

response = client.embeddings.create(
    input="Your text string goes here",
    model="text-embedding-3-small",
)
vector = response.data[0].embedding
```

## Batch Embeddings

```python
response = client.embeddings.create(
    input=["Text one", "Text two", "Text three"],
    model="text-embedding-3-small",
)
vectors = [item.embedding for item in response.data]
```

## Models

| Model | Dimensions | MTEB | Cost (pages/$) | Max Input |
|-------|-----------|------|----------------|-----------|
| text-embedding-3-small | 1536 | 62.3% | 62,500 | 8192 |
| text-embedding-3-large | 3072 | 64.6% | 9,615 | 8192 |
| text-embedding-ada-002 | 1536 | 61.0% | 12,500 | 8192 |

## Reducing Dimensions

Use `dimensions` parameter to shorten embeddings without losing concept-representing properties:

```python
response = client.embeddings.create(
    input="Your text",
    model="text-embedding-3-small",
    dimensions=256,
)
```

Manual dimension reduction (when changing after generation):

```python
import numpy as np

def normalize_l2(x):
    x = np.array(x)
    norm = np.linalg.norm(x)
    return x / norm if norm != 0 else x

response = client.embeddings.create(
    model="text-embedding-3-small",
    input="Testing 123",
    encoding_format="float",
)
cut_dim = response.data[0].embedding[:256]
norm_dim = normalize_l2(cut_dim)
```

## Token Counting

```python
import tiktoken

def num_tokens(text: str) -> int:
    encoding = tiktoken.get_encoding("cl100k_base")
    return len(encoding.encode(text))
```

Use `cl100k_base` encoding for text-embedding-3-* models.

## Distance Functions

OpenAI embeddings are normalized to length 1:
- Cosine similarity can be computed via dot product
- Cosine similarity and Euclidean distance produce identical rankings
- Cosine similarity is recommended

## Helper Pattern

```python
def get_embedding(text: str, model: str = "text-embedding-3-small") -> list[float]:
    text = text.replace("\n", " ")
    return client.embeddings.create(
        input=[text],
        model=model,
    ).data[0].embedding
```

## Use Cases

**Semantic search**: Embed query, compute cosine similarity against document embeddings, return top-k.

**Clustering**: Embed texts, apply KMeans or similar on the vectors.

**Classification**: Embed texts and labels, classify by highest cosine similarity.

**Recommendations**: Embed items, rank by cosine similarity to source.
