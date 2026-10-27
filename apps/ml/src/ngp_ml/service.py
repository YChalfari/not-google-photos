from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from enum import StrEnum

import onnxruntime as ort

from .clip import ClipModel
from .config import ExecutionProvider, Settings
from .download import DownloadProgress, ModelUnavailableError, ensure_files
from .faces import ArcFaceEncoder, FaceAnalyzer, ScrfdDetector
from .registry import BUFFALO_L, CLIP_MODELS, ClipModelSpec, FaceModelSpec
from .runtime import create_session, resolve_provider

log = logging.getLogger(__name__)


class ModelState(StrEnum):
    disabled = "disabled"
    pending = "pending"
    downloading = "downloading"
    loading = "loading"
    ready = "ready"
    error = "error"


class ModelNotReadyError(RuntimeError):
    def __init__(self, kind: str, state: ModelState, detail: str | None = None) -> None:
        super().__init__(f"{kind} model is {state.value}" + (f": {detail}" if detail else ""))
        self.kind = kind
        self.state = state
        self.detail = detail


@dataclass
class ModelSlot[T]:
    kind: str
    name: str
    state: ModelState
    error: str | None = None
    providers: list[str] = field(default_factory=list)
    progress: DownloadProgress = field(default_factory=DownloadProgress)
    model: T | None = None
    load_seconds: float | None = None

    def status(self) -> dict:
        info: dict = {"name": self.name, "state": self.state.value}
        if self.providers:
            info["providers"] = self.providers
        if self.state == ModelState.downloading:
            info["download"] = self.progress.snapshot()
        if self.error:
            info["error"] = self.error
        if self.load_seconds is not None:
            info["load_seconds"] = round(self.load_seconds, 2)
        return info


class ModelManager:
    """Owns the ONNX sessions. Models download and load on a background thread."""

    retry_initial_seconds = 30.0
    retry_max_seconds = 600.0

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provider = resolve_provider(settings.execution_provider)
        self.face_spec: FaceModelSpec = BUFFALO_L
        clip_spec = CLIP_MODELS.get(settings.clip_model)
        self.clip_spec: ClipModelSpec | None = clip_spec
        self.faces: ModelSlot[FaceAnalyzer] = ModelSlot(
            "faces",
            BUFFALO_L.name,
            ModelState.pending if settings.faces_enabled else ModelState.disabled,
        )
        self.clip: ModelSlot[ClipModel] = ModelSlot(
            "clip",
            settings.clip_model,
            ModelState.pending if settings.clip_enabled else ModelState.disabled,
        )
        if settings.clip_enabled and clip_spec is None:
            self.clip.state = ModelState.error
            self.clip.error = f"unknown ML_CLIP_MODEL {settings.clip_model!r}; choose one of {sorted(CLIP_MODELS)}"
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._stop = threading.Event()

    @property
    def slots(self) -> list[ModelSlot]:
        return [self.faces, self.clip]

    @property
    def ready(self) -> bool:
        return all(s.state in (ModelState.ready, ModelState.disabled) for s in self.slots)

    def start(self) -> None:
        with self._start_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, name="model-loader", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def load_now(self) -> None:
        """Load every enabled model on the calling thread (CLI and tests)."""
        for slot in self.slots:
            self._load(slot)
            if slot.state == ModelState.error:
                raise ModelUnavailableError(f"{slot.kind}: {slot.error}")

    def _run(self) -> None:
        delay = self.retry_initial_seconds
        while not self._stop.is_set():
            for slot in self.slots:
                self._load(slot)
            retryable = [
                s for s in self.slots if s.state == ModelState.error and not self._permanent(s)
            ]
            if not retryable:
                return
            log.warning("Retrying model loading in %.0fs", delay)
            if self._stop.wait(delay):
                return
            delay = min(delay * 2, self.retry_max_seconds)

    def _permanent(self, slot: ModelSlot) -> bool:
        return slot.kind == "clip" and self.clip_spec is None

    def _load(self, slot: ModelSlot) -> None:
        if slot.state in (ModelState.ready, ModelState.disabled) or self._permanent(slot):
            return
        started = time.monotonic()
        try:
            slot.error = None
            slot.state = ModelState.downloading
            if slot.kind == "faces":
                model_dir = self.settings.models_dir / self.face_spec.name
                files = self.face_spec.files
            else:
                assert self.clip_spec is not None
                model_dir = self.settings.models_dir / self.clip_spec.name
                files = self.clip_spec.files
            slot.progress = DownloadProgress()
            ensure_files(model_dir, files, offline=self.settings.offline, progress=slot.progress)
            slot.state = ModelState.loading
            if slot.kind == "faces":
                slot.model, slot.providers = self._build_faces(model_dir)
            else:
                slot.model, slot.providers = self._build_clip(model_dir)
            slot.load_seconds = time.monotonic() - started
            slot.state = ModelState.ready
            log.info("%s model %s ready in %.1fs", slot.kind, slot.name, slot.load_seconds)
        except Exception as exc:
            slot.state = ModelState.error
            slot.error = str(exc)
            log.exception("Failed to load %s model %s", slot.kind, slot.name)

    def _session(self, path, accelerate: bool = True) -> ort.InferenceSession:
        provider = self.provider if accelerate else ExecutionProvider.cpu
        return create_session(path, provider, self.settings)

    def _build_faces(self, model_dir) -> tuple[FaceAnalyzer, list[str]]:
        det = self._session(model_dir / self.face_spec.detector.path)
        rec = self._session(model_dir / self.face_spec.recognizer.path)
        # w600k_r50 declares a fixed [1, 512] output; CoreML is stricter about that than CPU or CUDA.
        max_batch = 1 if "CoreMLExecutionProvider" in rec.get_providers() else 16
        analyzer = FaceAnalyzer(
            ScrfdDetector(det, self.settings.face_det_size), ArcFaceEncoder(rec, max_batch)
        )
        return analyzer, _merge_providers(det, rec)

    def _build_clip(self, model_dir) -> tuple[ClipModel, list[str]]:
        assert self.clip_spec is not None
        spec = self.clip_spec
        visual = self._session(model_dir / spec.visual.path)
        # Text encoding is cheap and its 256k-token embedding table is a poor fit for CoreML.
        textual = self._session(model_dir / spec.textual.path, accelerate=False)
        model = ClipModel(visual, textual, model_dir / spec.tokenizer.path, spec.preprocess)
        return model, _merge_providers(visual, textual)

    def get_faces(self) -> FaceAnalyzer:
        return self._get(self.faces)

    def get_clip(self) -> ClipModel:
        return self._get(self.clip)

    def _get[T](self, slot: ModelSlot[T]) -> T:
        if slot.state == ModelState.ready and slot.model is not None:
            return slot.model
        if slot.state == ModelState.pending:
            self.start()
        raise ModelNotReadyError(slot.kind, slot.state, slot.error)


def _merge_providers(*sessions: ort.InferenceSession) -> list[str]:
    seen: list[str] = []
    for session in sessions:
        for name in session.get_providers():
            if name not in seen:
                seen.append(name)
    return seen
