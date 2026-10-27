from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ErrorBody(BaseModel):
    code: str = Field(examples=["invalid_image"])
    message: str
    details: list | dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody


class ImageInfo(BaseModel):
    width: int = Field(description="Width of the upright (EXIF-rotated) image as sent, in pixels.")
    height: int


class BBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class FaceBase(BaseModel):
    bbox: BBox = Field(description="Pixels in the upright image as sent (see `image`).")
    landmarks: list[tuple[float, float]] = Field(
        min_length=5,
        max_length=5,
        description="Image-left eye, image-right eye, nose tip, image-left mouth corner, image-right mouth corner.",
    )
    score: float = Field(description="Detector confidence, 0..1.")
    quality: float = Field(
        description="0..1 summary of size, sharpness, pose and detector confidence."
    )
    size: float = Field(description="Shorter side of the box, in pixels of the image as sent.")
    sharpness: float = Field(
        description="Laplacian variance of the aligned 112x112 face; below ~20 is blurry."
    )
    yaw: float = Field(
        description="Estimated head turn in degrees; 0 is frontal, +-90 is full profile."
    )


class Face(FaceBase):
    embedding: list[float] = Field(description="L2-normalized ArcFace embedding (512 floats).")
    embedding_norm: float = Field(description="Norm of the raw embedding before normalization.")


class SkippedFace(FaceBase):
    reason: Literal["too_small", "too_blurry"]


class FaceThresholds(BaseModel):
    min_score: float
    min_size: float
    min_sharpness: float
    max_faces: int


class FacesResult(BaseModel):
    model: str = Field(examples=["buffalo_l"])
    embedding_dim: int = Field(examples=[512])
    thresholds: FaceThresholds
    faces: list[Face] = Field(description="Faces worth recognizing, highest detector score first.")
    skipped: list[SkippedFace] = Field(
        description="Detected faces that were too small or blurry; no embedding."
    )


class FacesResponse(FacesResult):
    image: ImageInfo
    timings_ms: dict[str, float]


class ClipEmbedding(BaseModel):
    model: str = Field(examples=["ViT-B-16-SigLIP-i18n-256__webli"])
    embedding_dim: int = Field(examples=[768])
    embedding: list[float] = Field(
        description="L2-normalized; compare with cosine similarity (dot product)."
    )


class ClipImageResponse(ClipEmbedding):
    image: ImageInfo
    timings_ms: dict[str, float]


class AnalyzeResponse(BaseModel):
    image: ImageInfo
    faces: FacesResult | None
    clip: ClipEmbedding | None
    timings_ms: dict[str, float]


PromptMode = Literal["none", "tag"]


class TextRequest(BaseModel):
    text: str = Field(min_length=1, examples=["כלב בחוף הים"])
    prompt: PromptMode = Field(
        default="none",
        description="`none` embeds the text as-is (search queries). `tag` wraps it in the model's tag "
        "prompt templates and averages them (zero-shot tag labels, English).",
    )


class TextBatchRequest(BaseModel):
    texts: list[str] = Field(min_length=1, examples=[["dog", "beach", "birthday cake"]])
    prompt: PromptMode = Field(default="none", description="Same as in `/v1/clip/text`.")


class TextResponse(BaseModel):
    model: str
    embedding_dim: int
    embedding: list[float]


class TextBatchResponse(BaseModel):
    model: str
    embedding_dim: int
    embeddings: list[list[float]] = Field(description="Same order as `texts`.")


class ModelStatus(BaseModel):
    name: str
    state: Literal["disabled", "pending", "downloading", "loading", "ready", "error"]
    providers: list[str] | None = None
    download: dict | None = None
    error: str | None = None
    load_seconds: float | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "loading", "error"]
    version: str
    execution_provider: dict
    models: dict[str, ModelStatus]
    uptime_seconds: float


class FaceRecommendations(BaseModel):
    """Measured starting points for clustering with this model; the server owns the final values."""

    match_max_distance: float = Field(
        description="A new face can join a person when its close neighbors of that person are at most this far."
    )
    suggest_max_distance: float = Field(
        description='Up to this distance, offer a "Same person?" suggestion instead of merging automatically.'
    )
    seed_min_quality: float = Field(
        description="Only faces with at least this `quality` may start a new person."
    )


class FaceModelInfo(BaseModel):
    name: str
    embedding_dim: int
    distance: Literal["cosine"]
    license: str
    source: str
    defaults: FaceThresholds = Field(
        description="The skip thresholds this server applies by default."
    )
    recommended: FaceRecommendations


class ClipRecommendations(BaseModel):
    tag_min_probability: float = Field(
        description="Keep a tag when sigmoid(logit_scale * cosine + logit_bias) is at least this. SigLIP gives "
        "one-word labels small probabilities, so useful cut-offs are far below 0.5."
    )


class ClipModelInfo(BaseModel):
    name: str
    embedding_dim: int
    distance: Literal["cosine"]
    logit_scale: float = Field(
        description="Tag probability: sigmoid(logit_scale * cosine + logit_bias)."
    )
    logit_bias: float
    image_size: int
    context_length: int
    tag_templates: list[str] = Field(
        description='What `prompt: "tag"` wraps each label in; ["{}"] means the bare label.'
    )
    recommended: ClipRecommendations
    license: str
    source: str


class ModelsResponse(BaseModel):
    faces: FaceModelInfo | None
    clip: ClipModelInfo | None
    available_clip_models: list[str]
