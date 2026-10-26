from __future__ import annotations

import logging
from pathlib import Path

import onnxruntime as ort

from .config import ExecutionProvider, Settings

log = logging.getLogger(__name__)

ORT_PROVIDER_NAMES = {
    ExecutionProvider.cpu: "CPUExecutionProvider",
    ExecutionProvider.coreml: "CoreMLExecutionProvider",
    ExecutionProvider.cuda: "CUDAExecutionProvider",
}


def available_providers() -> list[str]:
    return list(ort.get_available_providers())


def resolve_provider(requested: ExecutionProvider) -> ExecutionProvider:
    """Map the requested provider to one this ONNX Runtime build can actually use.

    `auto` prefers CUDA, then CoreML, then CPU. An explicit provider that is not
    available falls back to CPU with a warning rather than refusing to start.
    """
    available = set(available_providers())
    if requested == ExecutionProvider.auto:
        for candidate in (ExecutionProvider.cuda, ExecutionProvider.coreml):
            if ORT_PROVIDER_NAMES[candidate] in available:
                return candidate
        return ExecutionProvider.cpu
    if ORT_PROVIDER_NAMES[requested] not in available:
        log.warning(
            "ML_EXECUTION_PROVIDER=%s but this onnxruntime build only has %s; using CPU",
            requested.value,
            sorted(available),
        )
        return ExecutionProvider.cpu
    return requested


def _provider_chain(provider: ExecutionProvider, settings: Settings) -> list:
    if provider == ExecutionProvider.cuda:
        return [
            ("CUDAExecutionProvider", {"device_id": settings.cuda_device_id}),
            "CPUExecutionProvider",
        ]
    if provider == ExecutionProvider.coreml:
        cache = settings.cache_dir / "coreml"
        cache.mkdir(parents=True, exist_ok=True)
        options = {
            "ModelFormat": "MLProgram",
            "MLComputeUnits": settings.coreml_compute_units,
            "ModelCacheDirectory": str(cache),
        }
        return [("CoreMLExecutionProvider", options), "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


_cuda_dlls_preloaded = False


def _preload_cuda_dlls() -> None:
    # onnxruntime-gpu installed with the [cuda,cudnn] extras ships CUDA and cuDNN as
    # pip packages; they must be loaded before the first CUDA session is created.
    global _cuda_dlls_preloaded
    if _cuda_dlls_preloaded:
        return
    _cuda_dlls_preloaded = True
    preload = getattr(ort, "preload_dlls", None)
    if preload is not None:
        try:
            preload()
        except Exception as exc:  # pragma: no cover - depends on the host GPU setup
            log.warning("onnxruntime.preload_dlls() failed: %s", exc)


def create_session(
    path: Path, provider: ExecutionProvider, settings: Settings
) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    if settings.intra_op_threads > 0:
        options.intra_op_num_threads = settings.intra_op_threads
    options.inter_op_num_threads = 1

    if provider == ExecutionProvider.cuda:
        _preload_cuda_dlls()
    try:
        session = ort.InferenceSession(
            str(path), sess_options=options, providers=_provider_chain(provider, settings)
        )
    except Exception as exc:
        if provider == ExecutionProvider.cpu:
            raise
        log.warning(
            "Could not start %s on %s (%s); using CPU for this model",
            path.name,
            provider.value,
            exc,
        )
        session = ort.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
    log.info("Loaded %s with %s", path, session.get_providers())
    return session
