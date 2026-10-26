"""Pinned model files. Every file is fetched from a fixed revision and checked against its SHA-256."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .clip import ClipPreprocess
from .download import RemoteFile


def _hf(repo: str, revision: str, path: str) -> str:
    return f"https://huggingface.co/{repo}/resolve/{revision}/{path}"


@dataclass(frozen=True)
class FaceRecommendations:
    """Starting points for the server's clustering, measured with this model (see calibration/)."""

    match_max_distance: float
    suggest_max_distance: float
    seed_min_quality: float


@dataclass(frozen=True)
class FaceModelSpec:
    name: str
    detector: RemoteFile
    recognizer: RemoteFile
    embedding_dim: int
    license: str
    source: str
    recommended: FaceRecommendations

    @property
    def files(self) -> list[RemoteFile]:
        return [self.detector, self.recognizer]


@dataclass(frozen=True)
class ClipModelSpec:
    name: str
    visual: RemoteFile
    textual: RemoteFile
    tokenizer: RemoteFile
    preprocess: ClipPreprocess
    embedding_dim: int
    logit_scale: float
    logit_bias: float
    license: str
    source: str
    tag_templates: tuple[str, ...]
    """Prompts a tag label is wrapped in; their embeddings are averaged. ("{}",) uses the bare label."""
    tag_min_probability: float
    """Suggested cut-off for sigmoid(logit_scale * cosine + logit_bias) when tagging."""

    @property
    def files(self) -> list[RemoteFile]:
        return [self.visual, self.textual, self.tokenizer]


# InsightFace buffalo_l (v0.7 release). Both mirrors serve files byte-identical to
# det_10g.onnx and w600k_r50.onnx inside the official buffalo_l.zip.
_BUFFALO_IMMICH = ("immich-app/buffalo_l", "d09715916a0778919a770c343533641e250b8699")
_BUFFALO_PUBLIC = ("public-data/insightface", "33c1063c49c785b7652d3fd529f86fa4f149392b")

BUFFALO_L = FaceModelSpec(
    name="buffalo_l",
    detector=RemoteFile(
        path="det_10g.onnx",
        urls=(
            _hf(*_BUFFALO_IMMICH, "detection/model.onnx"),
            _hf(*_BUFFALO_PUBLIC, "models/buffalo_l/det_10g.onnx"),
        ),
        sha256="5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
        size=16923827,
    ),
    recognizer=RemoteFile(
        path="w600k_r50.onnx",
        urls=(
            _hf(*_BUFFALO_IMMICH, "recognition/model.onnx"),
            _hf(*_BUFFALO_PUBLIC, "models/buffalo_l/w600k_r50.onnx"),
        ),
        sha256="4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
        size=174383860,
    ),
    embedding_dim=512,
    recommended=FaceRecommendations(
        match_max_distance=0.5, suggest_max_distance=0.6, seed_min_quality=0.5
    ),
    license="InsightFace pretrained models: non-commercial research use only",
    source="https://github.com/deepinsight/insightface/releases/tag/v0.7 (buffalo_l: SCRFD-10GF + ArcFace R50 WebFace600K)",
)


def _siglip(
    name: str,
    revision: str,
    *,
    image_size: int,
    pad_id: int,
    visual: tuple[str, int],
    textual: tuple[str, int],
    tokenizer: tuple[str, int],
    log_logit_scale: float,
    logit_bias: float,
    tag_templates: tuple[str, ...],
    tag_min_probability: float,
    source: str,
) -> ClipModelSpec:
    """An OpenCLIP SigLIP checkpoint as exported to ONNX by Immich (one visual and one text graph).

    `log_logit_scale` and `logit_bias` are the checkpoint's learned `logit_scale` (stored in log space)
    and `logit_bias`, which turn a cosine similarity into a calibrated sigmoid probability.
    """
    repo = f"immich-app/{name}"

    def remote(path: str, pin: tuple[str, int]) -> RemoteFile:
        return RemoteFile(path, (_hf(repo, revision, path),), pin[0], pin[1])

    return ClipModelSpec(
        name=name,
        visual=remote("visual/model.onnx", visual),
        textual=remote("textual/model.onnx", textual),
        tokenizer=remote("textual/tokenizer.json", tokenizer),
        preprocess=ClipPreprocess(image_size=image_size, context_length=64, pad_id=pad_id),
        embedding_dim=768,
        logit_scale=math.exp(log_logit_scale),
        logit_bias=logit_bias,
        tag_templates=tag_templates,
        tag_min_probability=tag_min_probability,
        license="Apache-2.0",
        source=f"{source}; ONNX export from huggingface.co/{repo}",
    )


_SIGLIP2_TOKENIZER = ("220c63d496e0c14e63eb656c91e0215e926202e4c74b1f089e09f1920d779b04", 34362885)
_SIGLIP2_TEXTUAL_SIZE = 1129435819

CLIP_MODELS: dict[str, ClipModelSpec] = {
    spec.name: spec
    for spec in (
        # Default: multilingual SigLIP (mSigLIP). Hebrew and English queries work equally well.
        _siglip(
            "ViT-B-16-SigLIP-i18n-256__webli",
            revision="7c04ea75dece70f7554adf6146ca94fc5f416504",
            image_size=256,
            pad_id=1,
            visual=("eef71c81cb4113c6212f77ff0c6bb056f4dec472a5dfdbf09c06ea653d556585", 371858612),
            textual=(
                "2643542d4e72f48b9ff5bb3d6cccbda20d67534c4d26a704f3a43ae23c172cef",
                1110991411,
            ),
            tokenizer=(
                "886028796f5bfa7832e520ab044c43813f615b75a0e411e7833f8762644813ab",
                16339362,
            ),
            log_logit_scale=4.709494113922119,
            logit_bias=-12.885268211364746,
            tag_templates=("{}",),
            tag_min_probability=0.005,
            source="Google SigLIP i18n (multilingual, WebLI) ViT-B/16 at 256 px via OpenCLIP (timm/ViT-B-16-SigLIP-i18n-256)",
        ),
        # Better in English, much weaker in Hebrew.
        _siglip(
            "ViT-B-16-SigLIP2__webli",
            revision="5f3fc29104ebcf51e9d893af57604badd51a3ea6",
            image_size=224,
            pad_id=0,
            visual=("fee10c729875dd203d94f396ac3d664e301d39c977ef6d92e7f467a2a716f0b0", 371674292),
            textual=(
                "fc9991b415d7d0fac7ed540e875fd08a647c8a1abba99f12542531b004c4b68f",
                _SIGLIP2_TEXTUAL_SIZE,
            ),
            tokenizer=_SIGLIP2_TOKENIZER,
            log_logit_scale=4.724453449249268,
            logit_bias=-16.771724700927734,
            tag_templates=("{}",),
            tag_min_probability=0.005,
            source="Google SigLIP 2 ViT-B/16 at 224 px via OpenCLIP (timm/ViT-B-16-SigLIP2)",
        ),
        # Fastest image encoder of the three; English-first like the B/16 above.
        _siglip(
            "ViT-B-32-SigLIP2-256__webli",
            revision="762c736d366fc253e9453021144f9fe71789b075",
            image_size=256,
            pad_id=0,
            visual=("e96b8a3d32ab1b683aa12c45312342b4a10d4befef5f195f5cf84eadf1938696", 378359772),
            textual=(
                "ba6e09d2dbb3d7ac0f9e2935676db92dceebddfd06c1462b67019caa90eeea20",
                _SIGLIP2_TEXTUAL_SIZE,
            ),
            tokenizer=_SIGLIP2_TOKENIZER,
            log_logit_scale=4.717002868652344,
            logit_bias=-16.766876220703125,
            tag_templates=("{}",),
            tag_min_probability=0.005,
            source="Google SigLIP 2 ViT-B/32 at 256 px via OpenCLIP (timm/ViT-B-32-SigLIP2-256)",
        ),
    )
}
