from __future__ import annotations

import argparse
import json
import logging
import sys
import time

from .config import get_settings


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def _serve(_: argparse.Namespace) -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "ngp_ml.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        access_log=settings.log_level == "debug",
        timeout_graceful_shutdown=10,
    )


def _health(_: argparse.Namespace) -> None:
    """Exit 0 when the local server reports every model ready (used by the Docker HEALTHCHECK)."""
    import urllib.request

    settings = get_settings()
    host = "127.0.0.1" if settings.host in ("0.0.0.0", "::", "") else settings.host
    try:
        with urllib.request.urlopen(f"http://{host}:{settings.port}/health", timeout=4):
            pass
    except Exception as exc:
        raise SystemExit(f"unhealthy: {exc}") from exc


def _download(_: argparse.Namespace) -> None:
    from .download import DownloadProgress, ensure_files
    from .service import ModelManager

    settings = get_settings()
    manager = ModelManager(settings)
    targets = []
    if settings.faces_enabled:
        targets.append((manager.face_spec.name, manager.face_spec.files))
    if settings.clip_enabled:
        if manager.clip_spec is None:
            raise SystemExit(manager.clip.error)
        targets.append((manager.clip_spec.name, manager.clip_spec.files))
    for name, files in targets:
        ensure_files(
            settings.models_dir / name, files, offline=settings.offline, progress=DownloadProgress()
        )
        print(f"{name}: ready in {settings.models_dir / name}")


def _check(_: argparse.Namespace) -> None:
    """Load the models and time one inference each, to confirm the execution provider works."""
    import numpy as np
    from PIL import Image

    from .faces import QualityThresholds
    from .service import ModelManager

    settings = get_settings()
    manager = ModelManager(settings)
    started = time.perf_counter()
    manager.load_now()
    report: dict = {
        "execution_provider": {
            "requested": settings.execution_provider.value,
            "active": manager.provider.value,
        },
        "load_seconds": round(time.perf_counter() - started, 2),
    }
    rng = np.random.default_rng(0)
    image = Image.fromarray(rng.integers(0, 255, (720, 960, 3), dtype=np.uint8))
    if settings.faces_enabled:
        analyzer = manager.get_faces()
        th = QualityThresholds(
            settings.face_min_score, settings.face_min_size, settings.face_min_sharpness, 50
        )
        analyzer.analyze(np.asarray(image), 1.0, th)
        t0 = time.perf_counter()
        for _ in range(3):
            analyzer.analyze(np.asarray(image), 1.0, th)
        crops = [np.asarray(image)[:112, :112]] * 4
        analyzer.encoder.embed(crops)
        t1 = time.perf_counter()
        analyzer.encoder.embed(crops)
        report["faces"] = {
            "providers": manager.faces.providers,
            "detect_ms": round((t1 - t0) / 3 * 1000, 1),
            "embed_4_faces_ms": round((time.perf_counter() - t1) * 1000, 1),
        }
    if settings.clip_enabled:
        clip = manager.get_clip()
        clip.encode_image(image)
        t0 = time.perf_counter()
        clip.encode_image(image)
        t1 = time.perf_counter()
        clip.encode_texts(["a dog on the beach", "כלב על החוף"])
        report["clip"] = {
            "model": manager.clip.name,
            "providers": manager.clip.providers,
            "image_ms": round((t1 - t0) * 1000, 1),
            "text_ms": round((time.perf_counter() - t1) / 2 * 1000, 1),
        }
    print(json.dumps(report, indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="ngp-ml", description="Not Google Photos ML service")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("serve", help="run the HTTP API (default)").set_defaults(func=_serve)
    sub.add_parser(
        "download", help="download the configured models into ML_CACHE_DIR and exit"
    ).set_defaults(func=_download)
    sub.add_parser(
        "check", help="load the models, time one inference each, and print the providers"
    ).set_defaults(func=_check)
    sub.add_parser(
        "health", help="exit 0 if the running server is ready, 1 otherwise"
    ).set_defaults(func=_health)
    args = parser.parse_args(argv)
    _configure_logging(get_settings().log_level)
    getattr(args, "func", _serve)(args)


if __name__ == "__main__":
    main()
