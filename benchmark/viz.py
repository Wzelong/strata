"""Render the 4 benchmark plots from results.json.

Plots match the original style: recall-precision curve, retrieval ranked bars,
2x2 classifier confusion matrix, plus the new channels heatmap.
"""
import json
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results.json"

# Role -> color (kept consistent with the old style: signal blue, noise gray,
# related orange, brigade red)
ROLE_COLORS = {
    "anchor":          "#1f77b4",
    "buried":          "#1f77b4",
    "decoy":           "#d62728",
    "brigade":         "#d62728",
    "thread":          "#cccccc",
    "removed":         "#ff8800",
    "pattern":         "#ff8800",
    "corpus":          "#e0e0e0",
}


def load():
    with open(RESULTS) as f:
        return json.load(f)


# ----------------------------------------------------------------------------
# 1. recall-precision.png  — recall + precision vs K, mean across trials
# ----------------------------------------------------------------------------
def plot_recall_precision(data):
    trials = data["trials"]
    K_range = list(range(1, 26))
    n_total = 4

    all_buried = np.array([t["surface"]["buried_at_K"] for t in trials])
    recall = all_buried / n_total
    precision = all_buried / np.array(K_range).reshape(1, -1)

    recall_mean, recall_lo, recall_hi = recall.mean(0), recall.min(0), recall.max(0)
    prec_mean = precision.mean(0)

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.fill_between(K_range, recall_lo, recall_hi, color="#1f77b4", alpha=0.18)
    ax.plot(K_range, recall_mean, color="#1f77b4", linewidth=2.5, marker="o", markersize=6,
            label="Recall — fraction of witnesses found")
    ax.plot(K_range, prec_mean, color="#888", linewidth=2, marker="s", markersize=5,
            label="Precision — fraction of results that are witnesses")
    ax.axhline(1.0, color="#2ca02c", linestyle="--", linewidth=1, alpha=0.6)

    # Annotation if recall hits 1.0
    k_full = next((k for k, r in zip(K_range, recall_mean) if r >= 0.999), None)
    if k_full:
        ax.annotate(f"All 4 witnesses found\nby reviewing just {k_full} items",
                    xy=(k_full, 1.0), xytext=(k_full + 4, 0.85),
                    fontsize=11, color="#2ca02c", fontweight="bold",
                    bbox=dict(boxstyle="round,pad=0.5", facecolor="white",
                              edgecolor="#2ca02c", linewidth=1.5),
                    arrowprops=dict(arrowstyle="->", color="#2ca02c", linewidth=1.5))

    ax.set_xlabel("K — number of items a moderator reviews", fontsize=11)
    ax.set_ylabel("Score (0 to 1)", fontsize=11)
    ax.set_title("How many items must a mod review to find all witnesses?",
                 fontweight="bold", fontsize=13)
    ax.set_ylim(-0.02, 1.08)
    ax.set_xlim(0.5, 25.5)
    ax.legend(loc="center right", fontsize=10)
    ax.grid(alpha=0.3)
    ax.text(0.5, -0.12,
            "Recall = witnesses found / 4 total.  Precision = witnesses / items shown to mod.",
            transform=ax.transAxes, ha="center", fontsize=9, color="#666", style="italic")

    plt.tight_layout()
    out = ROOT / "recall-precision.png"
    plt.savefig(out, dpi=140, bbox_inches="tight")
    plt.close()
    print(f"  wrote {out}")


# ----------------------------------------------------------------------------
# 2. retrieval.png — ranked candidates with witnesses colored
# ----------------------------------------------------------------------------
def plot_retrieval(data):
    candidates = data["trials"][0]["surface"]["candidates"][:40]
    fig, ax = plt.subplots(figsize=(13, 9))

    scores = [c["score"] for c in candidates]
    colors = [ROLE_COLORS.get(c["role"], "#999") for c in candidates]
    y = list(range(len(candidates), 0, -1))

    ax.barh(y, scores, color=colors, edgecolor="none", height=0.85)
    for i, c in enumerate(candidates):
        if c["role"] == "corpus":
            continue
        ax.text(scores[i] + 0.0008, y[i], f"  {c['label']}",
                va="center", fontsize=10, color="#222")

    ax.set_yticks([y[i] for i in range(0, len(candidates), 5)])
    ax.set_yticklabels([f"#{i+1}" for i in range(0, len(candidates), 5)], fontsize=10)
    ax.set_xlabel(f"Surface score (RRF-fused)", fontsize=11)
    ax.set_ylabel(f"Rank (out of {data['config']['corpus_size']:,} items)", fontsize=11)
    ax.set_title(f"Retrieval: finding buried witnesses among {data['config']['corpus_size']:,} community posts",
                 fontweight="bold", fontsize=13)
    ax.set_xlim(0, max(scores) * 1.4)
    ax.grid(axis="x", alpha=0.3)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)

    legend_items = [
        ("Community posts (10K+)",      "#e0e0e0"),
        ("Buried witnesses (signal)",   "#1f77b4"),
        ("Related signals",             "#ff8800"),
        ("Adversarial / brigade",       "#d62728"),
    ]
    handles = [mpatches.Patch(color=c, label=l) for l, c in legend_items]
    ax.legend(handles=handles, loc="lower right", fontsize=10, framealpha=0.95)

    plt.tight_layout()
    out = ROOT / "retrieval.png"
    plt.savefig(out, dpi=140, bbox_inches="tight")
    plt.close()
    print(f"  wrote {out}")


# ----------------------------------------------------------------------------
# 3. confusion.png — 2x2 classifier accuracy in the original style
# ----------------------------------------------------------------------------
def plot_confusion(data):
    c = data["classification"]
    tp, fp, fn, tn = c["tp"], c["fp"], c["fn"], c["tn"]
    n_signal = tp + fn
    n_noise = fp + tn

    fig, ax = plt.subplots(figsize=(9, 7))

    pct_tp = tp / n_signal if n_signal > 0 else 0
    pct_fn = 1 - pct_tp
    pct_tn = tn / n_noise if n_noise > 0 else 0
    pct_fp = 1 - pct_tn

    # Cell colors: TP = peach (correct positive), TN = dark red (correct negative)
    # FP/FN = light peach
    cell_colors = [
        ["#ffb380", "#ffead9"],
        ["#ffead9", "#c62828"],
    ]
    cell_text_colors = [["#222", "#222"], ["#222", "white"]]

    for i in range(2):
        for j in range(2):
            ax.add_patch(plt.Rectangle((j - 0.5, i - 0.5), 1, 1,
                                       facecolor=cell_colors[i][j],
                                       edgecolor="white", linewidth=4))

    # Green outlines on the diagonal (correct cells)
    for d in [(0, 0), (1, 1)]:
        ax.add_patch(plt.Rectangle((d[1] - 0.5, d[0] - 0.5), 1, 1,
                                   facecolor="none", edgecolor="#2ca02c", linewidth=5))

    labels = [
        [f"{tp}\n{pct_tp*100:.0f}%", f"{fn}\n{pct_fn*100:.0f}%"],
        [f"{fp}\n{pct_fp*100:.0f}%", f"{tn}\n{pct_tn*100:.0f}%"],
    ]
    for i in range(2):
        for j in range(2):
            ax.text(j, i, labels[i][j], ha="center", va="center",
                    fontsize=22, fontweight="bold", color=cell_text_colors[i][j])

    ax.set_xticks([0, 1])
    ax.set_yticks([0, 1])
    ax.set_xticklabels(["Classified as\nRelated", "Classified as\nUnrelated"], fontsize=11)
    ax.set_yticklabels([f"Signal items\n(n={n_signal})", f"Noise items\n(n={n_noise})"], fontsize=11)
    ax.set_xlabel("GPT-5.5 classification output", fontsize=11, labelpad=10)
    ax.set_ylabel("Ground truth", fontsize=11, labelpad=10)
    ax.set_title("Classification accuracy on top-15 retrieved candidates",
                 fontweight="bold", fontsize=13, pad=15)

    ax.set_xlim(-0.5, 1.5)
    ax.set_ylim(1.5, -0.5)
    ax.tick_params(length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)

    plt.tight_layout()
    out = ROOT / "confusion.png"
    plt.savefig(out, dpi=140, bbox_inches="tight")
    plt.close()
    print(f"  wrote {out}")


# ----------------------------------------------------------------------------
# 4. channels.png — channel x item heatmap (new, design-intent verification)
# ----------------------------------------------------------------------------
def plot_channels(data):
    rows = data["static"]["channels"]["rows"]
    cols = data["static"]["channels"]["cols"]
    matrix = np.array(data["static"]["channels"]["matrix"])

    fig, ax = plt.subplots(figsize=(11, 6.5))

    im = ax.imshow(matrix, cmap="YlOrRd", vmin=0, vmax=1, aspect="auto")

    ax.set_xticks(range(len(cols)))
    ax.set_xticklabels(cols, fontsize=11)
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels([r["label"] for r in rows], fontsize=10)

    label_role_colors = {"buried": "#1f77b4", "decoy": "#d62728"}
    for i, r in enumerate(rows):
        ax.get_yticklabels()[i].set_color(label_role_colors.get(r["role"], "#000"))
        ax.get_yticklabels()[i].set_fontweight("bold")

    THRESHOLD = 0.90
    for i in range(len(rows)):
        for j in range(len(cols)):
            v = matrix[i, j]
            color = "white" if v > 0.55 else "#222"
            text = f"{v:.2f}"
            if cols[j] in ("Case#", "Plate -K77") and 0.0 < v < THRESHOLD:
                text = f"{v:.2f}\n(< thr)"
            ax.text(j, i, text, ha="center", va="center",
                    fontsize=10, color=color, fontweight="bold")

    ax.set_xlabel("Channel", fontsize=11)
    ax.set_ylabel("Item (buried witnesses blue, decoys red)", fontsize=11)
    ax.set_title("Channel x item match matrix - witnesses match primary + secondary; decoys attack one",
                 fontweight="bold", fontsize=12)

    cbar = plt.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    cbar.set_label("Match score to reference (0 = no match, 1 = exact)", fontsize=10)
    cbar.ax.axhline(THRESHOLD, color="#222", linewidth=1.5)
    cbar.ax.text(2.3, THRESHOLD, " 0.9 thr", fontsize=8, va="center", color="#222")

    ax.set_xticks(np.arange(-0.5, len(cols), 1), minor=True)
    ax.set_yticks(np.arange(-0.5, len(rows), 1), minor=True)
    ax.grid(which="minor", color="white", linewidth=2)
    ax.tick_params(which="minor", length=0)

    plt.tight_layout()
    out = ROOT / "channels.png"
    plt.savefig(out, dpi=140, bbox_inches="tight")
    plt.close()
    print(f"  wrote {out}")


def main():
    if not RESULTS.exists():
        raise SystemExit(f"results.json not found at {RESULTS}")
    data = load()
    print(f"Loaded {RESULTS}  ({len(data['trials'])} trials, {data['config']['corpus_size']:,} items)")
    plot_recall_precision(data)
    plot_retrieval(data)
    plot_confusion(data)
    plot_channels(data)


if __name__ == "__main__":
    main()
