"""SigLIP-family image and text encoders (OpenCLIP models exported to ONNX)."""

from __future__ import annotations

import string
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

_PUNCTUATION = str.maketrans("", "", string.punctuation)


@dataclass(frozen=True)
class ClipPreprocess:
    image_size: int
    context_length: int
    pad_id: int
    mean: tuple[float, float, float] = (0.5, 0.5, 0.5)
    std: tuple[float, float, float] = (0.5, 0.5, 0.5)


def canonicalize_text(text: str) -> str:
    """open_clip's `canonicalize_text`, which SigLIP models were trained with."""
    text = text.replace("_", " ").translate(_PUNCTUATION).lower()
    return " ".join(text.split()).strip()


def preprocess_image(image: Image.Image, cfg: ClipPreprocess) -> np.ndarray:
    """RGB PIL image to a (1, 3, S, S) float32 tensor, matching open_clip's SigLIP eval transform
    (bicubic resize to a square without cropping)."""
    size = cfg.image_size
    image = image.resize((size, size), Image.Resampling.BICUBIC)
    arr = np.asarray(image, dtype=np.float32) / 255.0
    arr = (arr - np.asarray(cfg.mean, dtype=np.float32)) / np.asarray(cfg.std, dtype=np.float32)
    return arr.transpose(2, 0, 1)[None].astype(np.float32)


def _l2_normalize(x: np.ndarray) -> np.ndarray:
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-12)


class ClipModel:
    def __init__(
        self,
        visual: ort.InferenceSession,
        textual: ort.InferenceSession,
        tokenizer_path: Path,
        cfg: ClipPreprocess,
    ) -> None:
        self.visual = visual
        self.textual = textual
        self.cfg = cfg
        self.visual_input = visual.get_inputs()[0].name
        self.textual_input = textual.get_inputs()[0]
        self.text_dtype = np.int64 if self.textual_input.type == "tensor(int64)" else np.int32
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(cfg.context_length)
        self.tokenizer.enable_padding(length=cfg.context_length, pad_id=cfg.pad_id)

    def tokenize(self, texts: list[str]) -> np.ndarray:
        encodings = self.tokenizer.encode_batch([canonicalize_text(t) for t in texts])
        return np.asarray([e.ids for e in encodings], dtype=self.text_dtype)

    def encode_image(self, image: Image.Image) -> np.ndarray:
        tensor = preprocess_image(image, self.cfg)
        out = self.visual.run(None, {self.visual_input: tensor})[0]
        return _l2_normalize(out[0].astype(np.float32))

    def encode_texts(self, texts: list[str]) -> np.ndarray:
        """L2-normalized embeddings, one row per text. The exported text encoders take batch size 1."""
        ids = self.tokenize(texts)
        rows = [
            self.textual.run(None, {self.textual_input.name: ids[i : i + 1]})[0][0]
            for i in range(len(texts))
        ]
        return _l2_normalize(np.stack(rows).astype(np.float32))


def embed_labels(clip: ClipModel, labels: list[str], templates: tuple[str, ...]) -> np.ndarray:
    """One embedding per label for zero-shot tagging: the normalized mean over the prompt templates."""
    prompts = [template.format(label) for label in labels for template in templates]
    emb = clip.encode_texts(prompts).reshape(len(labels), len(templates), -1).mean(axis=1)
    return _l2_normalize(emb)
