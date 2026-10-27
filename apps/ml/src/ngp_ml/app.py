from __future__ import annotations

import hmac
import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any

import anyio
import numpy as np
import orjson
from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, schemas
from .clip import ClipModel, embed_labels
from .config import Settings, get_settings
from .faces import Face, FaceAnalyzer, QualityThresholds
from .imaging import DecodedImage, InvalidImageError, decode_image
from .registry import CLIP_MODELS
from .runtime import available_providers
from .service import ModelManager, ModelNotReadyError, ModelState

log = logging.getLogger(__name__)

RETRY_AFTER_SECONDS = 10


class OrjsonResponse(JSONResponse):
    """Writes numpy arrays straight to JSON; embeddings are most of every response body."""

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, option=orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS)


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def _error_response(
    status: int, code: str, message: str, details: Any = None, headers=None
) -> OrjsonResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    return OrjsonResponse({"error": body}, status_code=status, headers=headers)


_ERRORS = {
    400: {"model": schemas.ErrorResponse, "description": "Missing or undecodable image"},
    401: {
        "model": schemas.ErrorResponse,
        "description": "Missing or wrong bearer token (only when ML_API_TOKEN is set)",
    },
    413: {"model": schemas.ErrorResponse, "description": "Image larger than ML_MAX_UPLOAD_MB"},
    422: {"model": schemas.ErrorResponse, "description": "Invalid parameters"},
    503: {
        "model": schemas.ErrorResponse,
        "description": "Model still downloading or loading (see Retry-After), or failed",
    },
}

IMAGE_REQUEST_BODY = {
    "requestBody": {
        "required": True,
        "description": "The image, either as a multipart field named `image` or as the raw request body.",
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["image"],
                    "properties": {"image": {"type": "string", "format": "binary"}},
                }
            },
            "image/*": {"schema": {"type": "string", "format": "binary"}},
            "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
        },
    }
}


async def read_image_bytes(request: Request, max_bytes: int) -> bytes:
    too_large = ApiError(413, "payload_too_large", f"image exceeds {max_bytes} bytes")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes + 64 * 1024:
        raise too_large
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        try:
            form = await request.form(max_files=1, max_fields=16, max_part_size=max_bytes)
        except Exception as exc:
            raise ApiError(
                400, "invalid_multipart", f"could not parse multipart body: {exc}"
            ) from exc
        try:
            upload = form.get("image")
            if not isinstance(upload, UploadFile):
                raise ApiError(
                    400, "missing_image", "multipart body needs a file field named `image`"
                )
            data = await upload.read(max_bytes + 1)
        finally:
            await form.close()
    else:
        buffer = bytearray()
        async for chunk in request.stream():
            buffer.extend(chunk)
            if len(buffer) > max_bytes:
                raise too_large
        data = bytes(buffer)
    if len(data) > max_bytes:
        raise too_large
    if not data:
        raise ApiError(400, "missing_image", "request body is empty; send the image bytes")
    return data


def _face_dict(face: Face) -> dict[str, Any]:
    out: dict[str, Any] = {
        "bbox": {
            "x1": round(float(face.box[0]), 2),
            "y1": round(float(face.box[1]), 2),
            "x2": round(float(face.box[2]), 2),
            "y2": round(float(face.box[3]), 2),
        },
        "landmarks": [[round(float(x), 2), round(float(y), 2)] for x, y in face.landmarks],
        "score": round(face.score, 4),
        "quality": round(face.quality, 4),
        "size": round(face.size, 1),
        "sharpness": round(face.sharpness, 1),
        "yaw": round(face.yaw, 1),
    }
    if face.skip_reason is None:
        out["embedding"] = face.embedding
        out["embedding_norm"] = round(face.embedding_norm or 0.0, 3)
    else:
        out["reason"] = face.skip_reason
    return out


def create_app(settings: Settings | None = None, manager: ModelManager | None = None) -> FastAPI:
    settings = settings or get_settings()
    manager = manager or ModelManager(settings)
    started_at = time.monotonic()
    limiter = anyio.CapacityLimiter(settings.concurrency)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if settings.preload:
            manager.start()
        yield
        manager.stop()

    app = FastAPI(
        title="Not Google Photos ML",
        version=__version__,
        summary="Face detection and embeddings (InsightFace buffalo_l) plus multilingual CLIP embeddings (SigLIP).",
        lifespan=lifespan,
        default_response_class=OrjsonResponse,
    )
    app.state.settings = settings
    app.state.manager = manager

    async def run(fn: Callable[..., Any], *args: Any) -> Any:
        return await anyio.to_thread.run_sync(fn, *args, limiter=limiter)

    def require_token(request: Request) -> None:
        if not settings.api_token:
            return
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), settings.api_token):
            raise ApiError(401, "unauthorized", "send `Authorization: Bearer <ML_API_TOKEN>`")

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> OrjsonResponse:
        return _error_response(exc.status, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(ModelNotReadyError)
    async def _not_ready(_: Request, exc: ModelNotReadyError) -> OrjsonResponse:
        if exc.state == ModelState.disabled:
            return _error_response(
                503, "model_disabled", f"the {exc.kind} model is disabled on this server"
            )
        if exc.state == ModelState.error:
            return _error_response(
                503, "model_unavailable", str(exc), headers={"Retry-After": "60"}
            )
        return _error_response(
            503, "model_loading", str(exc), headers={"Retry-After": str(RETRY_AFTER_SECONDS)}
        )

    @app.exception_handler(InvalidImageError)
    async def _invalid_image(_: Request, exc: InvalidImageError) -> OrjsonResponse:
        return _error_response(400, "invalid_image", str(exc))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> OrjsonResponse:
        details = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")}
            for e in exc.errors()
        ]
        return _error_response(422, "validation_error", "invalid request", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> OrjsonResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _error_response(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> OrjsonResponse:
        log.exception("Unhandled error")
        return _error_response(500, "internal_error", f"{type(exc).__name__}: {exc}")

    def thresholds(
        min_score: float | None,
        min_size: float | None,
        min_sharpness: float | None,
        max_faces: int | None,
    ) -> QualityThresholds:
        return QualityThresholds(
            min_score=settings.face_min_score if min_score is None else min_score,
            min_size=settings.face_min_size if min_size is None else min_size,
            min_sharpness=settings.face_min_sharpness if min_sharpness is None else min_sharpness,
            max_faces=settings.face_max_faces if max_faces is None else max_faces,
        )

    def faces_result(
        analyzer: FaceAnalyzer, decoded: DecodedImage, th: QualityThresholds
    ) -> dict[str, Any]:
        found = analyzer.analyze(decoded.rgb(), decoded.scale, th)
        return {
            "model": manager.face_spec.name,
            "embedding_dim": manager.face_spec.embedding_dim,
            "thresholds": {
                "min_score": th.min_score,
                "min_size": th.min_size,
                "min_sharpness": th.min_sharpness,
                "max_faces": th.max_faces,
            },
            "faces": [_face_dict(f) for f in found if f.skip_reason is None],
            "skipped": [_face_dict(f) for f in found if f.skip_reason is not None],
        }

    def clip_info() -> tuple[str, int]:
        spec = manager.clip_spec
        assert spec is not None
        return spec.name, spec.embedding_dim

    def analyze_job(
        data: bytes, analyzer: FaceAnalyzer | None, clip: ClipModel | None, th: QualityThresholds
    ) -> dict[str, Any]:
        timings: dict[str, float] = {}
        t0 = time.perf_counter()
        decoded = decode_image(data, settings.max_image_side)
        t1 = time.perf_counter()
        timings["decode"] = (t1 - t0) * 1000
        result: dict[str, Any] = {"image": {"width": decoded.width, "height": decoded.height}}
        if analyzer is not None:
            result["faces"] = faces_result(analyzer, decoded, th)
            t2 = time.perf_counter()
            timings["faces"] = (t2 - t1) * 1000
            t1 = t2
        if clip is not None:
            name, dim = clip_info()
            result["clip"] = {
                "model": name,
                "embedding_dim": dim,
                "embedding": clip.encode_image(decoded.image),
            }
            timings["clip"] = (time.perf_counter() - t1) * 1000
        timings["total"] = (time.perf_counter() - t0) * 1000
        result["timings_ms"] = {k: round(v, 1) for k, v in timings.items()}
        return result

    def embed_texts(clip: ClipModel, texts: list[str], prompt: str) -> np.ndarray:
        if prompt != "tag":
            return clip.encode_texts(texts)
        assert manager.clip_spec is not None
        return embed_labels(clip, texts, manager.clip_spec.tag_templates)

    def check_texts(texts: list[str]) -> None:
        if len(texts) > settings.max_text_batch:
            raise ApiError(
                422, "too_many_texts", f"send at most {settings.max_text_batch} texts per request"
            )
        for i, text in enumerate(texts):
            if not text.strip():
                raise ApiError(422, "empty_text", f"texts[{i}] is empty")
            if len(text) > settings.max_text_chars:
                raise ApiError(
                    422,
                    "text_too_long",
                    f"texts[{i}] is longer than {settings.max_text_chars} characters",
                )

    @app.get(
        "/health",
        response_model=schemas.HealthResponse,
        responses={503: {"model": schemas.HealthResponse}},
    )
    async def health() -> OrjsonResponse:
        """200 once every enabled model is ready; 503 while downloading or loading, or after a failure."""
        statuses = {slot.kind: slot.status() for slot in manager.slots}
        states = {slot.state for slot in manager.slots}
        if manager.ready:
            status = "ok"
        elif ModelState.error in states and not states & {
            ModelState.downloading,
            ModelState.loading,
        }:
            status = "error"
        else:
            status = "loading"
        body = {
            "status": status,
            "version": __version__,
            "execution_provider": {
                "requested": settings.execution_provider.value,
                "active": manager.provider.value,
                "available": available_providers(),
            },
            "models": statuses,
            "uptime_seconds": round(time.monotonic() - started_at, 1),
        }
        return OrjsonResponse(body, status_code=200 if status == "ok" else 503)

    @app.get(
        "/v1/models", response_model=schemas.ModelsResponse, dependencies=[Depends(require_token)]
    )
    async def models() -> OrjsonResponse:
        """Model names, vector sizes and scoring constants. Available while models are still loading."""
        face = manager.face_spec
        faces_info = None
        if settings.faces_enabled:
            faces_info = {
                "name": face.name,
                "embedding_dim": face.embedding_dim,
                "distance": "cosine",
                "license": face.license,
                "source": face.source,
                "defaults": asdict(thresholds(None, None, None, None)),
                "recommended": asdict(face.recommended),
            }
        clip_info_body = None
        spec = manager.clip_spec
        if settings.clip_enabled and spec is not None:
            clip_info_body = {
                "name": spec.name,
                "embedding_dim": spec.embedding_dim,
                "distance": "cosine",
                "logit_scale": spec.logit_scale,
                "logit_bias": spec.logit_bias,
                "image_size": spec.preprocess.image_size,
                "context_length": spec.preprocess.context_length,
                "tag_templates": list(spec.tag_templates),
                "recommended": {"tag_min_probability": spec.tag_min_probability},
                "license": spec.license,
                "source": spec.source,
            }
        return OrjsonResponse(
            {
                "faces": faces_info,
                "clip": clip_info_body,
                "available_clip_models": sorted(CLIP_MODELS),
            }
        )

    @app.post(
        "/v1/faces",
        response_model=schemas.FacesResponse,
        responses=_ERRORS,
        openapi_extra=IMAGE_REQUEST_BODY,
        dependencies=[Depends(require_token)],
    )
    async def faces(
        request: Request,
        min_score: float | None = Query(
            None, ge=0.0, le=1.0, description="Override ML_FACE_MIN_SCORE."
        ),
        min_size: float | None = Query(
            None, ge=0.0, description="Override ML_FACE_MIN_SIZE (pixels)."
        ),
        min_sharpness: float | None = Query(
            None, ge=0.0, description="Override ML_FACE_MIN_SHARPNESS."
        ),
        max_faces: int | None = Query(
            None, ge=1, le=500, description="Override ML_FACE_MAX_FACES."
        ),
    ) -> OrjsonResponse:
        """Detect faces, embed the usable ones, and list the tiny or blurry ones separately."""
        data = await read_image_bytes(request, settings.max_upload_bytes)
        analyzer = manager.get_faces()
        result = await run(
            analyze_job,
            data,
            analyzer,
            None,
            thresholds(min_score, min_size, min_sharpness, max_faces),
        )
        body = {**result.pop("faces"), **result}
        return OrjsonResponse(body)

    @app.post(
        "/v1/clip/image",
        response_model=schemas.ClipImageResponse,
        responses=_ERRORS,
        openapi_extra=IMAGE_REQUEST_BODY,
        dependencies=[Depends(require_token)],
    )
    async def clip_image(request: Request) -> OrjsonResponse:
        """Image embedding for semantic search and zero-shot tags."""
        data = await read_image_bytes(request, settings.max_upload_bytes)
        clip = manager.get_clip()
        result = await run(analyze_job, data, None, clip, thresholds(None, None, None, None))
        body = {**result.pop("clip"), **result}
        return OrjsonResponse(body)

    @app.post(
        "/v1/analyze",
        response_model=schemas.AnalyzeResponse,
        responses=_ERRORS,
        openapi_extra=IMAGE_REQUEST_BODY,
        dependencies=[Depends(require_token)],
    )
    async def analyze(
        request: Request,
        faces: bool = Query(True, description="Run face detection and embeddings."),
        clip: bool = Query(True, description="Compute the CLIP image embedding."),
        min_score: float | None = Query(None, ge=0.0, le=1.0),
        min_size: float | None = Query(None, ge=0.0),
        min_sharpness: float | None = Query(None, ge=0.0),
        max_faces: int | None = Query(None, ge=1, le=500),
    ) -> OrjsonResponse:
        """Faces and CLIP in one call, decoding the image once. Use this from the processing job."""
        if not faces and not clip:
            raise ApiError(422, "nothing_to_do", "enable `faces`, `clip`, or both")
        data = await read_image_bytes(request, settings.max_upload_bytes)
        analyzer = manager.get_faces() if faces else None
        clip_model = manager.get_clip() if clip else None
        th = thresholds(min_score, min_size, min_sharpness, max_faces)
        result = await run(analyze_job, data, analyzer, clip_model, th)
        result.setdefault("faces", None)
        result.setdefault("clip", None)
        return OrjsonResponse(result)

    @app.post(
        "/v1/clip/text",
        response_model=schemas.TextResponse,
        responses=_ERRORS,
        dependencies=[Depends(require_token)],
    )
    async def clip_text(body: schemas.TextRequest) -> OrjsonResponse:
        """Text embedding for a search query, in any language the model knows (Hebrew included)."""
        check_texts([body.text])
        clip = manager.get_clip()
        emb = await run(embed_texts, clip, [body.text], body.prompt)
        name, dim = clip_info()
        return OrjsonResponse({"model": name, "embedding_dim": dim, "embedding": emb[0]})

    @app.post(
        "/v1/clip/text/batch",
        response_model=schemas.TextBatchResponse,
        responses=_ERRORS,
        dependencies=[Depends(require_token)],
    )
    async def clip_text_batch(body: schemas.TextBatchRequest) -> OrjsonResponse:
        """Embeddings for many texts at once, such as the zero-shot tag vocabulary."""
        check_texts(body.texts)
        clip = manager.get_clip()
        emb = await run(embed_texts, clip, body.texts, body.prompt)
        name, dim = clip_info()
        return OrjsonResponse({"model": name, "embedding_dim": dim, "embeddings": emb})

    return app
