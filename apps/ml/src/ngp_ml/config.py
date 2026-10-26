from __future__ import annotations

import os
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ExecutionProvider(StrEnum):
    cpu = "cpu"
    coreml = "coreml"
    cuda = "cuda"
    auto = "auto"


def default_cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "ngp-ml"


class Settings(BaseSettings):
    """Every setting is read from an `ML_`-prefixed environment variable."""

    model_config = SettingsConfigDict(env_prefix="ML_", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8740
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    api_token: str | None = Field(
        default=None,
        description="If set, every endpoint except /health requires `Authorization: Bearer <token>`.",
    )

    cache_dir: Path = Field(default_factory=default_cache_dir)
    offline: bool = Field(
        default=False, description="Never download; fail if a model is missing from the cache."
    )
    preload: bool = Field(
        default=True, description="Download and load models at startup instead of on first use."
    )

    execution_provider: ExecutionProvider = ExecutionProvider.cpu
    cuda_device_id: int = 0
    coreml_compute_units: Literal["ALL", "CPUAndNeuralEngine", "CPUAndGPU", "CPUOnly"] = "ALL"
    intra_op_threads: int = Field(
        default=0, description="ONNX Runtime intra-op threads; 0 lets ONNX Runtime decide."
    )
    concurrency: int = Field(
        default=1, ge=1, description="Inference calls allowed to run at the same time."
    )

    faces_enabled: bool = True
    clip_enabled: bool = True
    clip_model: str = Field(
        default="ViT-B-16-SigLIP-i18n-256__webli",
        description="Changing it changes every CLIP vector: re-embed all photos and tag labels afterwards.",
    )

    face_det_size: int = Field(
        default=640, ge=160, le=1280, description="Square detector input size in pixels."
    )
    face_min_score: float = Field(default=0.6, ge=0.0, le=1.0)
    face_min_size: int = Field(
        default=40, ge=0, description="Skip faces whose shorter box side is below this (pixels)."
    )
    face_min_sharpness: float = Field(
        default=20.0, ge=0.0, description="Skip faces whose sharpness is below this."
    )
    face_max_faces: int = Field(
        default=50, ge=1, description="Keep at most this many faces per image (highest scores)."
    )

    max_image_side: int = Field(
        default=4096, ge=256, description="Larger images are downscaled after decoding."
    )
    max_upload_mb: float = Field(default=50.0, gt=0)
    max_text_batch: int = Field(default=512, ge=1)
    max_text_chars: int = Field(default=1000, ge=1)

    @property
    def models_dir(self) -> Path:
        return self.cache_dir / "models"

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)


@lru_cache
def get_settings() -> Settings:
    return Settings()
