"""Calibrate face thresholds on LFW (Labeled Faces in the Wild) with the service's own face pipeline.

1. Baseline: cosine distances for the 3,000 same-person and 3,000 different-person pairs of the
   official 10-fold `pairs.txt`; true and false match rates at candidate distances; 10-fold accuracy.
2. Degraded faces: the same pairs with one or both photos shrunk to a small face or blurred, with the
   faces detected again, to see where embeddings stop being trustworthy (ML_FACE_MIN_SIZE and
   ML_FACE_MIN_SHARPNESS) and whether low-quality faces of different people collapse together.

Data: LFW images and pairs.txt from the figshare mirror that scikit-learn's `fetch_lfw_pairs` uses,
downloaded into ML_CACHE_DIR/datasets/lfw on first use (180 MB).

    uv run python scripts/calibrate_faces.py            # about 25 minutes on 4 CPU cores
"""

from __future__ import annotations

import argparse
import itertools
import json
import tarfile
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from ngp_ml.config import Settings
from ngp_ml.download import RemoteFile, ensure_files
from ngp_ml.faces import (
    ArcFaceEncoder,
    ScrfdDetector,
    align_face,
    estimate_yaw,
    quality_score,
    sharpness,
)
from ngp_ml.imaging import decode_image
from ngp_ml.service import ModelManager

ROOT = Path(__file__).resolve().parents[1]
DATA = [
    RemoteFile(
        "pairs.txt",
        ("https://ndownloader.figshare.com/files/5976006",),
        "ea42330c62c92989f9d7c03237ed5d591365e89b3e649747777b70e692dc1592",
        155335,
    ),
    RemoteFile(
        "lfw.tgz",
        ("https://ndownloader.figshare.com/files/5976018",),
        "055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0",
        180566744,
    ),
]
DETECT_THRESHOLD = 0.5
DISTANCES = (0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8)
KEY_DISTANCES = (0.5, 0.6, 0.7)
FACE_SIZES = (16, 20, 24, 32, 40, 48, 64)  # target face box side, pixels
BLUR_SIGMAS = (1.0, 2.0, 3.0, 4.0)  # Gaussian sigma on the 250 px LFW photo (faces about 100 px)
CANVAS = 320


@dataclass
class Sample:
    embedding: np.ndarray
    size: float
    sharpness: float
    score: float
    quality: float


def read_pairs(path: Path) -> list[tuple[int, str, str, bool]]:
    """(fold, image a, image b, same person) for every line of LFW's pairs.txt."""

    def image(name: str, number: str) -> str:
        return f"lfw/{name}/{name}_{int(number):04d}.jpg"

    lines = path.read_text().splitlines()
    folds, per_fold = map(int, lines[0].split())
    pairs, i = [], 1
    for fold in range(folds):
        for same in (True, False):
            for _ in range(per_fold):
                parts = lines[i].split("\t")
                i += 1
                if same:
                    pairs.append((fold, image(parts[0], parts[1]), image(parts[0], parts[2]), True))
                else:
                    pairs.append(
                        (fold, image(parts[0], parts[1]), image(parts[2], parts[3]), False)
                    )
    return pairs


def center_faces(
    detector: ScrfdDetector, encoder: ArcFaceEncoder, images: list[np.ndarray]
) -> list[Sample | None]:
    """The face nearest each image's center (LFW photos are centered on the labeled person)."""
    crops, metas = [], []
    for index, rgb in enumerate(images):
        boxes, scores, kps = detector.detect(rgb, DETECT_THRESHOLD)
        if not len(boxes):
            continue
        height, width = rgb.shape[:2]
        centers = (boxes[:, :2] + boxes[:, 2:]) / 2
        j = int(np.argmin(np.linalg.norm(centers - (width / 2, height / 2), axis=1)))
        box, score, landmarks = boxes[j], float(scores[j]), kps[j]
        aligned = align_face(rgb, landmarks)
        size = float(min(box[2] - box[0], box[3] - box[1]))
        sharp = sharpness(aligned)
        quality = quality_score(score, size, sharp, estimate_yaw(landmarks))
        crops.append(aligned)
        metas.append((index, size, sharp, score, quality))
    out: list[Sample | None] = [None] * len(images)
    embeddings, _ = encoder.embed(crops)
    for (index, size, sharp, score, quality), emb in zip(metas, embeddings, strict=True):
        out[index] = Sample(emb, size, sharp, score, quality)
    return out


def shrink(rgb: np.ndarray, face_size: float, target: float) -> np.ndarray:
    """Downscale so the face is `target` pixels, centered on a plain canvas."""
    factor = target / face_size
    small = cv2.resize(
        rgb,
        (max(1, round(rgb.shape[1] * factor)), max(1, round(rgb.shape[0] * factor))),
        interpolation=cv2.INTER_AREA,
    )
    if max(small.shape[:2]) > CANVAS:
        y0, x0 = (small.shape[0] - CANVAS) // 2, (small.shape[1] - CANVAS) // 2
        small = small[max(0, y0) : max(0, y0) + CANVAS, max(0, x0) : max(0, x0) + CANVAS]
    canvas = np.full((CANVAS, CANVAS, 3), 128, np.uint8)
    y0, x0 = (CANVAS - small.shape[0]) // 2, (CANVAS - small.shape[1]) // 2
    canvas[y0 : y0 + small.shape[0], x0 : x0 + small.shape[1]] = small
    return canvas


def blur(rgb: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(rgb, (0, 0), sigma)


def distance(a: Sample | None, b: Sample | None) -> float:
    """A face that was not found can never match, so it counts as infinitely far."""
    if a is None or b is None:
        return float("inf")
    return 1.0 - float(a.embedding @ b.embedding)


def percentiles(values) -> dict:
    v = np.asarray([x for x in values if np.isfinite(x)])
    if not len(v):
        return {"count": 0}
    qs = (0, 1, 5, 25, 50, 75, 95, 99, 100)
    return {"count": len(v), **{f"p{q}": round(float(np.percentile(v, q)), 4) for q in qs}}


def rate(values: np.ndarray, threshold: float, below: bool = True) -> float:
    if not len(values):
        return float("nan")
    hits = values <= threshold if below else values > threshold
    return round(float(hits.mean()), 4)


def roc_auc(same: np.ndarray, different: np.ndarray) -> float:
    """Probability that a random same-person pair is closer than a random different-person pair."""
    scores = np.concatenate([-same, -different])
    labels = np.concatenate([np.ones(len(same)), np.zeros(len(different))])
    ranks = scores.argsort().argsort() + 1.0
    positives = labels.sum()
    return float(
        (ranks[labels == 1].sum() - positives * (positives + 1) / 2)
        / (positives * (len(labels) - positives))
    )


def ten_fold_accuracy(folds: np.ndarray, distances: np.ndarray, same: np.ndarray) -> dict | None:
    """The standard LFW protocol: pick the best threshold on nine folds, test it on the tenth."""
    if len(np.unique(folds)) < 2:
        return None
    candidates = np.arange(0.0, 1.5, 0.005)
    accuracies, thresholds = [], []
    for fold in np.unique(folds):
        train, test = folds != fold, folds == fold
        train_acc = [((distances[train] <= t) == same[train]).mean() for t in candidates]
        best = float(candidates[int(np.argmax(train_acc))])
        thresholds.append(best)
        accuracies.append(((distances[test] <= best) == same[test]).mean())
    return {
        "mean": round(float(np.mean(accuracies)), 4),
        "std": round(float(np.std(accuracies)), 4),
        "threshold_mean": round(float(np.mean(thresholds)), 3),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=ROOT / "calibration" / "faces-lfw.json")
    parser.add_argument(
        "--degrade-folds", type=int, default=2, help="folds used for the degraded runs"
    )
    parser.add_argument(
        "--quick", action="store_true", help="100 pairs and two variants, to check the script"
    )
    args = parser.parse_args()

    settings = Settings(clip_enabled=False, preload=False)
    data_dir = settings.cache_dir / "datasets" / "lfw"
    ensure_files(data_dir, DATA, offline=settings.offline)
    if not (data_dir / "lfw").is_dir():
        with tarfile.open(data_dir / "lfw.tgz") as tar:
            tar.extractall(data_dir, filter="data")
    pairs = read_pairs(data_dir / "pairs.txt")
    variants = [("size", s) for s in FACE_SIZES] + [("blur", s) for s in BLUR_SIGMAS]
    if args.quick:
        pairs = pairs[:50] + pairs[300:350]
        variants = [variants[2], variants[-2]]

    manager = ModelManager(settings)
    manager.load_now()
    analyzer = manager.get_faces()
    small_detector = ScrfdDetector(analyzer.detector.session, input_size=CANVAS)
    print(f"buffalo_l on {', '.join(manager.faces.providers)}; {len(pairs)} pairs", flush=True)

    def load(path: str) -> np.ndarray:
        return decode_image((data_dir / path).read_bytes(), settings.max_image_side).rgb()

    paths = sorted({p for _, a, b, _ in pairs for p in (a, b)})
    started = time.perf_counter()
    baseline: dict[str, Sample | None] = {}
    for start in range(0, len(paths), 256):
        chunk = paths[start : start + 256]
        found = center_faces(analyzer.detector, analyzer.encoder, [load(p) for p in chunk])
        baseline.update(zip(chunk, found, strict=True))
        print(f"  baseline {start + len(chunk)}/{len(paths)}", flush=True)
    ms_per_image = (time.perf_counter() - started) * 1000 / len(paths)

    folds = np.array([f for f, _, _, _ in pairs])
    is_same = np.array([s for _, _, _, s in pairs])
    dist = np.array([distance(baseline[a], baseline[b]) for _, a, b, _ in pairs])
    found = [s for s in baseline.values() if s is not None]
    same_d, diff_d = dist[is_same], dist[~is_same]
    report: dict = {
        "model": "buffalo_l",
        "providers": manager.faces.providers,
        "metric": "cosine distance = 1 - cosine similarity",
        "dataset": "LFW, official 10-fold pairs.txt (3,000 same-person and 3,000 different-person pairs)",
        "images": len(paths),
        "no_face_found": len(paths) - len(found),
        "ms_per_image": round(ms_per_image, 1),
        "baseline": {
            "same_person": percentiles(same_d),
            "different_people": percentiles(diff_d),
            "roc_auc": round(
                roc_auc(np.nan_to_num(same_d, posinf=2.0), np.nan_to_num(diff_d, posinf=2.0)), 5
            ),
            "ten_fold_accuracy": ten_fold_accuracy(folds, np.nan_to_num(dist, posinf=2.0), is_same),
            "by_distance": [
                {
                    "distance": t,
                    "true_match_rate": rate(same_d, t),
                    "false_match_rate": rate(diff_d, t),
                    "false_matches": int((diff_d <= t).sum()),
                }
                for t in DISTANCES
            ],
            "distance_at_false_match_rate": {
                "1e-2": round(float(np.quantile(diff_d[np.isfinite(diff_d)], 1e-2)), 4),
                "1e-3": round(float(np.quantile(diff_d[np.isfinite(diff_d)], 1e-3)), 4),
            },
            "histogram": {
                "bin_edges": [round(x, 2) for x in np.arange(0.0, 1.45, 0.05)],
                "same_person": np.histogram(same_d, bins=np.arange(0.0, 1.45, 0.05))[0].tolist(),
                "different_people": np.histogram(diff_d, bins=np.arange(0.0, 1.45, 0.05))[
                    0
                ].tolist(),
            },
            "face_size": percentiles([s.size for s in found]),
            "sharpness": percentiles([s.sharpness for s in found]),
            "quality": percentiles([s.quality for s in found]),
        },
    }
    print(
        json.dumps(
            {
                k: report["baseline"][k]
                for k in ("same_person", "different_people", "roc_auc", "ten_fold_accuracy")
            }
        ),
        flush=True,
    )

    subset = [p for p in pairs if p[0] < args.degrade_folds]
    sub_paths = sorted({x for _, a, b, _ in subset for x in (a, b) if baseline[x] is not None})
    rgb = {p: load(p) for p in sub_paths}
    pooled: list[tuple[str, float, float, float]] = []  # (kind, sharpness, quality, distance)
    report["degraded"] = []
    for kind, value in variants:
        if kind == "size":
            images = [shrink(rgb[p], baseline[p].size, value) for p in sub_paths]
        else:
            images = [blur(rgb[p], value) for p in sub_paths]
        degraded = dict(
            zip(sub_paths, center_faces(small_detector, analyzer.encoder, images), strict=True)
        )
        same_one = np.array([distance(baseline[a], degraded.get(b)) for _, a, b, s in subset if s])
        diff_one = np.array(
            [distance(baseline[a], degraded.get(b)) for _, a, b, s in subset if not s]
        )
        diff_both = np.array(
            [distance(degraded.get(a), degraded.get(b)) for _, a, b, s in subset if not s]
        )
        hits = [d for d in degraded.values() if d is not None]
        for _, a, b, s in subset:
            if degraded.get(b) is None:
                continue
            if s and baseline[a] is not None:
                pooled.append(
                    (
                        "same",
                        degraded[b].sharpness,
                        degraded[b].quality,
                        distance(baseline[a], degraded[b]),
                    )
                )
            elif not s and degraded.get(a) is not None:
                worst = min((degraded[a], degraded[b]), key=lambda x: x.quality)
                pooled.append(
                    (
                        "different",
                        worst.sharpness,
                        worst.quality,
                        distance(degraded[a], degraded[b]),
                    )
                )
        row = {
            "variant": f"face {value:g} px" if kind == "size" else f"blur sigma {value:g}",
            "kind": kind,
            "value": value,
            "detected": round(len(hits) / len(sub_paths), 4),
            "detected_at_min_score": round(
                sum(h.score >= settings.face_min_score for h in hits) / len(sub_paths), 4
            ),
            "face_size_median": round(float(np.median([h.size for h in hits])), 1)
            if hits
            else None,
            "sharpness_median": round(float(np.median([h.sharpness for h in hits])), 1)
            if hits
            else None,
            "quality_median": round(float(np.median([h.quality for h in hits])), 3)
            if hits
            else None,
            "same_person_median_distance": round(float(np.median(same_one)), 4),
            "true_match_rate": {f"{t:g}": rate(same_one, t) for t in KEY_DISTANCES},
            "false_match_rate_one_degraded": {f"{t:g}": rate(diff_one, t) for t in KEY_DISTANCES},
            "false_match_rate_both_degraded": {f"{t:g}": rate(diff_both, t) for t in KEY_DISTANCES},
        }
        report["degraded"].append(row)
        print(json.dumps(row), flush=True)

    def buckets(field: int, edges: tuple[float, ...]) -> list[dict]:
        rows = []
        for low, high in itertools.pairwise(edges):
            same = np.array([d for k, *v, d in pooled if k == "same" and low <= v[field] < high])
            diff = np.array(
                [d for k, *v, d in pooled if k == "different" and low <= v[field] < high]
            )
            rows.append(
                {
                    "range": [low, high if np.isfinite(high) else None],
                    "same_pairs": len(same),
                    "different_pairs": len(diff),
                    "true_match_rate": {f"{t:g}": rate(same, t) for t in KEY_DISTANCES},
                    "false_match_rate": {f"{t:g}": rate(diff, t) for t in KEY_DISTANCES},
                }
            )
        return rows

    report["degraded_by_sharpness"] = buckets(
        0, (0.0, 5.0, 10.0, 15.0, 20.0, 30.0, 50.0, 100.0, float("inf"))
    )
    report["degraded_by_quality"] = buckets(1, (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
