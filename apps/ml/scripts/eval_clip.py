"""Measure the CLIP model through the service's own code: English and Hebrew text-to-image retrieval,
short keyword search, and zero-shot tagging with the sigmoid probability the server will threshold.

Data: the first 1,000 images of Crossmodal-3600 (XM3600) with two captions per image, translated by
native speakers into each language (huggingface.co/datasets/floschne/xm3600_1k). The parquet files
are downloaded into ML_CACHE_DIR/datasets on first use.

Keyword and tag relevance comes from regex matches on the English captions. Captions do not mention
everything in a photo, so some "false positives" are real; read precision as a lower bound.

    uv run python scripts/eval_clip.py                                   # the configured ML_CLIP_MODEL
    uv run python scripts/eval_clip.py --model ViT-B-16-SigLIP2__webli
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from ngp_ml.clip import embed_labels
from ngp_ml.config import Settings
from ngp_ml.download import RemoteFile, ensure_files
from ngp_ml.imaging import decode_image
from ngp_ml.service import ModelManager

ROOT = Path(__file__).resolve().parents[1]

_XM3600 = (
    "https://huggingface.co/datasets/floschne/xm3600_1k/resolve/"
    "c41eb1aba97b4772c41c7094488f3165a5b88521/data/{}-00000-of-00001.parquet"
)
DATA = {
    "en": RemoteFile(
        "xm3600_1k_en.parquet",
        (_XM3600.format("en"),),
        "c2b490cc1bdbd31bfe996b1ce99ef52d8e883fa8fba1a3669199c56423afe941",
        51886911,
    ),
    "he": RemoteFile(
        "xm3600_1k_he.parquet",
        (_XM3600.format("he"),),
        "30f9a5c9d78a69594febc810a5256267970cd07fc6fa846a616094daaacf4ff8",
        52090520,
    ),
}

# (English query, Hebrew query, regex over the English captions that marks an image as relevant)
KEYWORDS = [
    ("dog", "כלב", r"\b(dog|dogs|puppy|puppies)\b"),
    ("cat", "חתול", r"\b(cat|cats|kitten)\b"),
    ("beach", "חוף ים", r"\b(beach|seashore)\b"),
    ("snow", "שלג", r"\b(snow|snowy)\b"),
    ("car", "מכונית", r"\b(car|cars)\b"),
    ("food", "אוכל", r"\b(food|dish|meal)\b"),
    ("flowers", "פרחים", r"\b(flower|flowers)\b"),
    ("mountains", "הרים", r"\b(mountain|mountains)\b"),
    ("sunset", "שקיעה", r"\b(sunset)\b"),
    ("boat", "סירה", r"\b(boat|boats)\b"),
    ("bicycle", "אופניים", r"\b(bicycle|bicycles|bike|bikes)\b"),
    ("horse", "סוס", r"\b(horse|horses)\b"),
    ("bird", "ציפור", r"\b(bird|birds)\b"),
    ("trees", "עצים", r"\b(tree|trees)\b"),
    ("church", "כנסייה", r"\b(church)\b"),
    ("children", "ילדים", r"\b(child|children|kid|kids)\b"),
    ("baby", "תינוק", r"\b(baby|infant)\b"),
    ("cake", "עוגה", r"\b(cake|cakes)\b"),
    ("night", "לילה", r"\b(night)\b"),
    ("river", "נהר", r"\b(river)\b"),
    ("street", "רחוב", r"\b(street|streets)\b"),
    ("motorcycle", "אופנוע", r"\b(motorcycle|motorcycles|motorbike)\b"),
    ("train", "רכבת", r"\b(train|trains)\b"),
    ("airplane", "מטוס", r"\b(airplane|aeroplane|plane|aircraft)\b"),
    ("cow", "פרה", r"\b(cow|cows|cattle)\b"),
    ("bridge", "גשר", r"\b(bridge)\b"),
    ("statue", "פסל", r"\b(statue|sculpture)\b"),
    ("bus", "אוטובוס", r"\b(bus|buses)\b"),
    ("fruit", "פירות", r"\b(fruit|fruits)\b"),
    ("guitar", "גיטרה", r"\b(guitar)\b"),
]
MIN_RELEVANT = 3

SEARCH_STYLES = {
    "en": ("en", "{}"),
    "he": ("he", "{}"),
    "en, 'a photo of'": ("en", "a photo of {}"),
    "he, 'תמונה של'": ("he", "תמונה של {}"),
}
TAG_PROMPTS = {
    "label only": ("{}",),
    "a photo of": ("a photo of {}.",),
    "3 templates": ("a photo of {}.", "a photo of a {}.", "this is a photo of {}."),
}
THRESHOLDS = (0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5)


def pct(x: float) -> float:
    return round(100.0 * float(x), 1)


def recall_at_k(text_emb: np.ndarray, image_emb: np.ndarray, targets: np.ndarray) -> dict:
    sims = text_emb @ image_emb.T
    target = sims[np.arange(len(targets)), targets]
    ranks = (sims > target[:, None]).sum(axis=1)
    return {f"R@{k}": pct((ranks < k).mean()) for k in (1, 5, 10)}


def average_precision(scores: np.ndarray, relevant: np.ndarray) -> float:
    rel = relevant[np.argsort(-scores, kind="stable")].astype(np.float64)
    precision = np.cumsum(rel) / np.arange(1, len(rel) + 1)
    return float((precision * rel).sum() / max(rel.sum(), 1.0))


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def threshold_table(probs: np.ndarray, truth: np.ndarray) -> list[dict]:
    rows = []
    for t in THRESHOLDS:
        pred = probs >= t
        tp = int((pred & truth).sum())
        fp = int((pred & ~truth).sum())
        fn = int((~pred & truth).sum())
        precision = tp / max(tp + fp, 1)
        recall = tp / max(tp + fn, 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-9)
        rows.append(
            {
                "threshold": t,
                "precision": pct(precision),
                "recall": pct(recall),
                "f1": pct(f1),
                "tags_per_image": round(float(pred.sum(axis=1).mean()), 2),
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", help="CLIP model name (default: ML_CLIP_MODEL)")
    parser.add_argument("--images", type=int, default=1000)
    parser.add_argument(
        "--out", type=Path, help="JSON report (default: calibration/clip-<model>.json)"
    )
    args = parser.parse_args()

    overrides = {"faces_enabled": False, "preload": False}
    if args.model:
        overrides["clip_model"] = args.model
    settings = Settings(**overrides)
    data_dir = settings.cache_dir / "datasets" / "xm3600_1k"
    ensure_files(data_dir, list(DATA.values()), offline=settings.offline)
    rows = {
        lang: pq.read_table(data_dir / f.path).to_pylist()[: args.images]
        for lang, f in DATA.items()
    }
    assert [r["image_id"] for r in rows["en"]] == [r["image_id"] for r in rows["he"]]

    manager = ModelManager(settings)
    manager.load_now()
    clip = manager.get_clip()
    spec = manager.clip_spec
    assert spec is not None
    print(
        f"{spec.name} on {', '.join(manager.clip.providers)}: {len(rows['en'])} images", flush=True
    )

    started = time.perf_counter()
    image_emb = np.stack(
        [
            clip.encode_image(decode_image(r["image"]["bytes"], settings.max_image_side).image)
            for r in rows["en"]
        ]
    )
    ms_per_image = (time.perf_counter() - started) * 1000 / len(image_emb)

    report: dict = {
        "model": spec.name,
        "providers": manager.clip.providers,
        "images": len(image_emb),
        "ms_per_image": round(ms_per_image, 1),
        "retrieval": {},
    }
    for lang in ("en", "he"):
        captions = [(i, c) for i, r in enumerate(rows[lang]) for c in r["captions"]]
        started = time.perf_counter()
        text_emb = clip.encode_texts([c for _, c in captions])
        ms_per_text = (time.perf_counter() - started) * 1000 / len(captions)
        targets = np.array([i for i, _ in captions])
        report["retrieval"][lang] = {
            "captions": len(captions),
            **recall_at_k(text_emb, image_emb, targets),
            "ms_per_text": round(ms_per_text, 1),
        }
        print(f"captions {lang}: {report['retrieval'][lang]}", flush=True)

    english = [" ".join(r["captions"]).lower() for r in rows["en"]]
    truth_cols, used = [], []
    for keyword in KEYWORDS:
        relevant = np.array([bool(re.search(keyword[2], c)) for c in english])
        if relevant.sum() >= MIN_RELEVANT:
            truth_cols.append(relevant)
            used.append(keyword)
    truth = np.stack(truth_cols, axis=1)
    report["keywords"] = {
        "count": len(used),
        "relevant_images": {en: int(t.sum()) for (en, _, _), t in zip(used, truth.T, strict=True)},
        "search": {},
    }
    for style, (lang, template) in SEARCH_STYLES.items():
        queries = [template.format(en if lang == "en" else he) for en, he, _ in used]
        scores = image_emb @ clip.encode_texts(queries).T
        aps = [average_precision(scores[:, j], truth[:, j]) for j in range(len(used))]
        p10 = [truth[np.argsort(-scores[:, j])[:10], j].mean() for j in range(len(used))]
        report["keywords"]["search"][style] = {
            "mAP": pct(np.mean(aps)),
            "P@10": pct(np.mean(p10)),
            "AP": {q: pct(a) for q, a in zip(queries, aps, strict=True)},
        }
        print(f"keywords {style}: mAP {pct(np.mean(aps))} P@10 {pct(np.mean(p10))}", flush=True)

    report["tagging"] = {
        "logit_scale": spec.logit_scale,
        "logit_bias": spec.logit_bias,
        "service_templates": list(spec.tag_templates),
        "prompts": {},
    }
    labels = [en for en, _, _ in used]
    prompts = dict(TAG_PROMPTS)
    if spec.tag_templates not in prompts.values():
        prompts["service tag prompt"] = spec.tag_templates
    for name, templates in prompts.items():
        probs = sigmoid(
            spec.logit_scale * (image_emb @ embed_labels(clip, labels, templates).T)
            + spec.logit_bias
        )
        table = threshold_table(probs, truth)
        best = max(table, key=lambda row: row["f1"])
        report["tagging"]["prompts"][name] = {
            "templates": list(templates),
            "label_mAP": pct(
                np.mean([average_precision(probs[:, j], truth[:, j]) for j in range(len(used))])
            ),
            "pooled_AP": pct(average_precision(probs.ravel(), truth.ravel())),
            "median_prob_relevant": float(np.median(probs[truth])),
            "p99_prob_irrelevant": float(np.quantile(probs[~truth], 0.99)),
            "best_f1": best,
            "thresholds": table,
        }
        print(
            f"tags {name}: label mAP {report['tagging']['prompts'][name]['label_mAP']} "
            f"pooled AP {report['tagging']['prompts'][name]['pooled_AP']} best F1 {best}",
            flush=True,
        )

    out = args.out or ROOT / "calibration" / f"clip-{spec.name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
