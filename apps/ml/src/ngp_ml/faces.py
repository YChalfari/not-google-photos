"""InsightFace buffalo_l in plain ONNX Runtime: SCRFD-10G detection and ArcFace R50 embeddings.

Pre- and post-processing follow insightface 0.7 (`model_zoo/retinaface.py`, `model_zoo/arcface_onnx.py`,
`utils/face_align.py`) so the embeddings match the reference package.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

# ArcFace's canonical 112x112 positions for: image-left eye, image-right eye, nose tip,
# image-left mouth corner, image-right mouth corner.
ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)
ALIGNED_SIZE = 112
EMBEDDING_DIM = 512

# Nose offset from the eye midpoint, as a fraction of eye distance, is roughly
# 0.385 * tan(yaw) for an average adult face.
_YAW_RATIO = 0.385


@dataclass(frozen=True)
class QualityThresholds:
    min_score: float
    min_size: float
    min_sharpness: float
    max_faces: int


@dataclass
class Face:
    box: np.ndarray  # x1, y1, x2, y2 in the caller's image space
    landmarks: np.ndarray  # 5 x 2
    score: float
    size: float
    sharpness: float
    yaw: float
    quality: float
    embedding: np.ndarray | None = None
    embedding_norm: float | None = None
    skip_reason: str | None = None


def umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity transform (rotation, uniform scale, translation) mapping src onto dst.

    Same algorithm as skimage.transform.SimilarityTransform.estimate, which insightface uses.
    """
    src = src.astype(np.float64)
    dst = dst.astype(np.float64)
    num, dim = src.shape
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    src_demean = src - src_mean
    dst_demean = dst - dst_mean
    a = dst_demean.T @ src_demean / num
    d = np.ones((dim,), dtype=np.float64)
    if np.linalg.det(a) < 0:
        d[dim - 1] = -1
    t = np.eye(dim + 1, dtype=np.float64)
    u, s, v = np.linalg.svd(a)
    rank = np.linalg.matrix_rank(a)
    if rank == 0:
        return np.full((dim + 1, dim + 1), np.nan)
    if rank == dim - 1:
        if np.linalg.det(u) * np.linalg.det(v) > 0:
            t[:dim, :dim] = u @ v
        else:
            saved = d[dim - 1]
            d[dim - 1] = -1
            t[:dim, :dim] = u @ np.diag(d) @ v
            d[dim - 1] = saved
    else:
        t[:dim, :dim] = u @ np.diag(d) @ v
    scale = 1.0 / src_demean.var(axis=0).sum() * (s @ d)
    t[:dim, dim] = dst_mean - scale * (t[:dim, :dim] @ src_mean.T)
    t[:dim, :dim] *= scale
    return t


def align_face(rgb: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
    matrix = umeyama(landmarks, ARCFACE_TEMPLATE)[:2, :]
    return cv2.warpAffine(rgb, matrix, (ALIGNED_SIZE, ALIGNED_SIZE), borderValue=0.0)


def sharpness(aligned_rgb: np.ndarray) -> float:
    """Variance of the Laplacian over the inner face region of an aligned 112x112 crop."""
    gray = cv2.cvtColor(aligned_rgb, cv2.COLOR_RGB2GRAY)
    inner = gray[16:104, 16:96]
    return float(cv2.Laplacian(inner, cv2.CV_64F).var())


def estimate_yaw(landmarks: np.ndarray) -> float:
    """Signed head yaw in degrees from the 5 landmarks (0 = frontal)."""
    left_eye, right_eye, nose = landmarks[0], landmarks[1], landmarks[2]
    axis = right_eye - left_eye
    eye_dist = float(np.linalg.norm(axis))
    if eye_dist < 1e-6:
        return 90.0
    offset = float(np.dot(nose - (left_eye + right_eye) / 2.0, axis / eye_dist)) / eye_dist
    return math.degrees(math.atan(offset / _YAW_RATIO))


def _ramp(value: float, low: float, high: float) -> float:
    return float(min(1.0, max(0.0, (value - low) / (high - low))))


def quality_score(score: float, size: float, sharp: float, yaw: float) -> float:
    """0..1 summary of how usable a face is for recognition: geometric mean of four 0..1 factors.

    Any factor at zero (tiny, very blurry, full profile, or a weak detection) makes the
    whole score zero.
    """
    factors = (
        _ramp(score, 0.5, 0.8),
        _ramp(size, 24.0, 112.0),
        _ramp(math.log10(max(sharp, 1e-3)), math.log10(8.0), math.log10(150.0)),
        _ramp(75.0 - abs(yaw), 0.0, 45.0),
    )
    return float(np.prod(factors) ** (1.0 / len(factors)))


def _distance2bbox(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    x1 = points[:, 0] - distance[:, 0]
    y1 = points[:, 1] - distance[:, 1]
    x2 = points[:, 0] + distance[:, 2]
    y2 = points[:, 1] + distance[:, 3]
    return np.stack([x1, y1, x2, y2], axis=-1)


def _distance2kps(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    preds = []
    for i in range(0, distance.shape[1], 2):
        preds.append(points[:, 0] + distance[:, i])
        preds.append(points[:, 1] + distance[:, i + 1])
    return np.stack(preds, axis=-1)


def nms(dets: np.ndarray, threshold: float) -> list[int]:
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        overlap = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(overlap <= threshold)[0] + 1]
    return keep


class ScrfdDetector:
    """SCRFD face detector (buffalo_l det_10g.onnx): boxes, 5 landmarks and scores."""

    nms_threshold = 0.4
    num_anchors = 2

    def __init__(self, session: ort.InferenceSession, input_size: int = 640) -> None:
        self.session = session
        self.input_size = input_size
        self.input_name = session.get_inputs()[0].name
        outputs = session.get_outputs()
        if len(outputs) != 9:
            raise ValueError(
                f"expected a 3-stride SCRFD model with landmarks, got {len(outputs)} outputs"
            )
        self.output_names = [o.name for o in outputs]
        self.strides = (8, 16, 32)
        self._centers: dict[tuple[int, int, int], np.ndarray] = {}

    def _anchor_centers(self, height: int, width: int, stride: int) -> np.ndarray:
        key = (height, width, stride)
        if key not in self._centers:
            grid = np.stack(np.mgrid[:height, :width][::-1], axis=-1).astype(np.float32)
            centers = (grid * stride).reshape((-1, 2))
            self._centers[key] = np.stack([centers] * self.num_anchors, axis=1).reshape((-1, 2))
        return self._centers[key]

    def detect(
        self, rgb: np.ndarray, threshold: float
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Returns boxes (N, 4), scores (N,), landmarks (N, 5, 2) in `rgb` pixel coordinates."""
        size = self.input_size
        height, width = rgb.shape[:2]
        if height / width > 1.0:
            new_h, new_w = size, max(1, int(size * width / height))
        else:
            new_w, new_h = size, max(1, int(size * height / width))
        det_scale = new_h / height
        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = cv2.resize(rgb, (new_w, new_h))
        blob = ((canvas.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]
        outs = self.session.run(self.output_names, {self.input_name: blob})

        boxes_all, scores_all, kps_all = [], [], []
        for idx, stride in enumerate(self.strides):
            scores = outs[idx].reshape(-1)
            bbox_preds = outs[idx + 3].reshape(-1, 4) * stride
            kps_preds = outs[idx + 6].reshape(-1, 10) * stride
            centers = self._anchor_centers(size // stride, size // stride, stride)
            pos = np.where(scores >= threshold)[0]
            if pos.size == 0:
                continue
            boxes_all.append(_distance2bbox(centers, bbox_preds)[pos])
            scores_all.append(scores[pos])
            kps_all.append(_distance2kps(centers, kps_preds).reshape((-1, 5, 2))[pos])
        if not scores_all:
            return (
                np.zeros((0, 4), np.float32),
                np.zeros((0,), np.float32),
                np.zeros((0, 5, 2), np.float32),
            )

        scores = np.concatenate(scores_all)
        boxes = np.concatenate(boxes_all) / det_scale
        kps = np.concatenate(kps_all) / det_scale
        order = scores.argsort()[::-1]
        dets = np.hstack([boxes, scores[:, None]])[order]
        keep = nms(dets, self.nms_threshold)
        return boxes[order][keep], scores[order][keep], kps[order][keep]


class ArcFaceEncoder:
    """ArcFace R50 trained on WebFace600K (buffalo_l w600k_r50.onnx): 512-d identity embeddings."""

    def __init__(self, session: ort.InferenceSession, max_batch: int = 16) -> None:
        self.session = session
        self.input_name = session.get_inputs()[0].name
        self.max_batch = max_batch

    def embed(self, aligned: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        """Returns L2-normalized embeddings (N, 512) and the raw embedding norms (N,)."""
        if not aligned:
            return np.zeros((0, EMBEDDING_DIM), np.float32), np.zeros((0,), np.float32)
        raw = []
        for start in range(0, len(aligned), self.max_batch):
            chunk = np.stack(aligned[start : start + self.max_batch]).astype(np.float32)
            blob = ((chunk - 127.5) / 127.5).transpose(0, 3, 1, 2)
            raw.append(self.session.run(None, {self.input_name: blob})[0])
        emb = np.concatenate(raw).astype(np.float32)
        norms = np.linalg.norm(emb, axis=1)
        return emb / np.maximum(norms[:, None], 1e-12), norms


class FaceAnalyzer:
    def __init__(self, detector: ScrfdDetector, encoder: ArcFaceEncoder) -> None:
        self.detector = detector
        self.encoder = encoder

    def analyze(self, rgb: np.ndarray, scale: float, thresholds: QualityThresholds) -> list[Face]:
        """Detect, score and embed faces. `scale` maps caller pixels to `rgb` pixels.

        Faces below the size or sharpness threshold are returned with `skip_reason`
        set and no embedding.
        """
        boxes, scores, kps = self.detector.detect(rgb, thresholds.min_score)
        faces: list[Face] = []
        to_embed: list[np.ndarray] = []
        for box, score, lmk in list(zip(boxes, scores, kps, strict=True))[: thresholds.max_faces]:
            aligned = align_face(rgb, lmk)
            box_out = box / scale
            lmk_out = lmk / scale
            size = float(min(box_out[2] - box_out[0], box_out[3] - box_out[1]))
            sharp = sharpness(aligned)
            yaw = estimate_yaw(lmk)
            face = Face(
                box=box_out,
                landmarks=lmk_out,
                score=float(score),
                size=size,
                sharpness=sharp,
                yaw=yaw,
                quality=quality_score(float(score), size, sharp, yaw),
            )
            if size < thresholds.min_size:
                face.skip_reason = "too_small"
            elif sharp < thresholds.min_sharpness:
                face.skip_reason = "too_blurry"
            else:
                to_embed.append(aligned)
            faces.append(face)

        embeddings, norms = self.encoder.embed(to_embed)
        kept = (f for f in faces if f.skip_reason is None)
        for face, emb, norm in zip(kept, embeddings, norms, strict=True):
            face.embedding = emb
            face.embedding_norm = float(norm)
        return faces
