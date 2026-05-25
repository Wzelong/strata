import json
import math
import os
from pathlib import Path
import numpy as np
import umap
import hdbscan

SEED = Path(__file__).parent / "seed.json"
OUT = Path(__file__).parent / "layout.json"
TYPE_FILTER = os.environ.get("LAYOUT_FILTER", "")  # "post", "comment", or "" for all

print("Loading seed...", flush=True)
data = json.loads(SEED.read_text())
items_by_id = {it["id"]: it for it in data["items"]}
all_ids = list(data["embeddings"].keys())
if TYPE_FILTER:
    ids = [i for i in all_ids if items_by_id.get(i, {}).get("type") == TYPE_FILTER]
    print(f"  filter: type=={TYPE_FILTER} -> {len(ids)} of {len(all_ids)} items", flush=True)
else:
    ids = all_ids
    print(f"  no filter, {len(ids)} items", flush=True)
matrix = np.array([data["embeddings"][i] for i in ids], dtype=np.float32)
N = len(ids)
print(f"  embedding shape {matrix.shape}", flush=True)

n_neighbors = max(10, min(50, int(math.sqrt(N))))
min_cluster_size = max(5, min(200, N // 200))
min_samples = max(2, min_cluster_size // 4)
print(f"  scale-adaptive params: n_neighbors={n_neighbors}, min_cluster_size={min_cluster_size}, min_samples={min_samples}", flush=True)

rng = np.random.default_rng(42)

min_dist = 0.5
spread = 2.0
print(f"UMAP -> 3D (cosine, n_neighbors={n_neighbors}, min_dist={min_dist}, spread={spread})...", flush=True)
reducer = umap.UMAP(
    n_components=3,
    n_neighbors=n_neighbors,
    min_dist=min_dist,
    spread=spread,
    metric="cosine",
    random_state=42,
)
coords = reducer.fit_transform(matrix)

N_REF = 200
target_radius = 10.0 * (N / N_REF) ** (1.0 / 3.0)
center = coords.mean(axis=0)
std = float(coords.std()) or 1.0
coords = (coords - center) / (std * 2.0) * target_radius
print(f"  normalized: target_radius={target_radius:.1f} (density-adaptive via cbrt(N/{N_REF}))", flush=True)

print(f"HDBSCAN on raw 256-d (cosine, min_cluster_size={min_cluster_size}, min_samples={min_samples}, leaf)...", flush=True)
clusterer = hdbscan.HDBSCAN(
    min_cluster_size=min_cluster_size,
    min_samples=min_samples,
    metric="cosine",
    cluster_selection_method="leaf",
    algorithm="generic",
)
labels = clusterer.fit_predict(matrix.astype(np.float64))

unit = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-10)
non_noise_ix = np.where(labels != -1)[0]
noise_ix_init = np.where(labels == -1)[0]

noise_top5_sims = np.zeros(len(noise_ix_init), dtype=np.float32)
noise_votes: list[tuple[int, int]] = []
for idx, ni in enumerate(noise_ix_init):
    sims_to_all = unit[non_noise_ix] @ unit[ni]
    top_k = np.argsort(-sims_to_all)[:5]
    noise_top5_sims[idx] = float(np.mean(sims_to_all[top_k]))
    votes: dict[int, int] = {}
    for ix in top_k:
        l = int(labels[non_noise_ix[ix]])
        votes[l] = votes.get(l, 0) + 1
    noise_votes.append((ni, max(votes.items(), key=lambda kv: kv[1])[0]))

sim_floor = float(np.percentile(noise_top5_sims, 25)) if len(noise_top5_sims) else 0.0
print(f"  adaptive sim_floor (p25 of noise top5-neighbor sims): {sim_floor:.3f}", flush=True)

reassigned = 0
for idx, (ni, best_label) in enumerate(noise_votes):
    if noise_top5_sims[idx] < sim_floor:
        continue
    labels[ni] = best_label
    reassigned += 1
print(f"  kNN-5 reassigned {reassigned} of {len(noise_ix_init)} noise points (kept {len(noise_ix_init) - reassigned} as orphan)", flush=True)

cluster_to_indices: dict[int, list[int]] = {}
for i, lab in enumerate(labels):
    cluster_to_indices.setdefault(int(lab), []).append(i)

positions = {ids[i]: [float(coords[i, 0]), float(coords[i, 1]), float(coords[i, 2])] for i in range(N)}

def diverse_sample(members: list[int], n_total: int) -> list[int]:
    if len(members) <= n_total:
        return list(members)
    mat = matrix[members]
    centroid = mat.mean(axis=0)
    norm = np.linalg.norm(centroid) + 1e-10
    centroid_unit = centroid / norm
    sims = mat @ centroid_unit
    half = n_total // 2
    top_local = np.argsort(-sims)[:half].tolist()
    top_set = set(top_local)
    remaining = [i for i in range(len(members)) if i not in top_set]
    if len(remaining) >= n_total - half:
        random_local = rng.choice(remaining, size=n_total - half, replace=False).tolist()
    else:
        random_local = remaining
    return [members[i] for i in (top_local + list(random_local))]

clusters_meta: list[dict] = []
for lab in sorted(c for c in cluster_to_indices.keys() if c != -1):
    members = cluster_to_indices[lab]
    n_samples = max(8, min(16, len(members) // 10))
    sample_indices = diverse_sample(members, n_samples)
    clusters_meta.append({
        "id": lab,
        "size": len(members),
        "memberIds": [ids[m] for m in members],
        "sampleItemIds": [ids[s] for s in sample_indices],
    })

noise_count = len(cluster_to_indices.get(-1, []))
sizes = sorted((c["size"] for c in clusters_meta), reverse=True)
print(f"  {len(clusters_meta)} clusters, {noise_count} noise points ({noise_count/N*100:.1f}%)", flush=True)
print(f"  size distribution: max={sizes[0] if sizes else 0}, median={sizes[len(sizes)//2] if sizes else 0}, min={sizes[-1] if sizes else 0}", flush=True)
print(f"  top 10 sizes: {sizes[:10]}", flush=True)

out = {
    "positions": positions,
    "clusters": clusters_meta,
    "noiseIds": [ids[m] for m in cluster_to_indices.get(-1, [])],
}
OUT.write_text(json.dumps(out))
print(f"  wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)", flush=True)
