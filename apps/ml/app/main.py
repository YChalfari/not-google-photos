"""ML service skeleton.

InsightFace and the CLIP ONNX models are downloaded into MODEL_CACHE by a later piece.
This process only has to be reachable. CPU is the default, including in Docker.

On a Mac, the first backlog is much faster natively with ONNX Runtime's CoreML provider
(not inside Docker, which cannot use the Mac GPU):

    cd apps/ml
    python -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt onnxruntime
    export MODEL_CACHE=$HOME/.cache/ngp-models NGP_EXECUTION_PROVIDER=coreml
    uvicorn app.main:app --host 127.0.0.1 --port 8090

Then set ML_URL=http://127.0.0.1:8090 on the server.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="Not Google Photos ML", version="0.1.0")

CACHE = Path(os.environ.get("MODEL_CACHE", "/models"))
PROVIDER = os.environ.get("NGP_EXECUTION_PROVIDER", "cpu")


@app.get("/health")
def health() -> dict[str, object]:
    CACHE.mkdir(parents=True, exist_ok=True)
    ready = any(CACHE.iterdir()) if CACHE.exists() else False
    return {
        "status": "ok",
        "provider": PROVIDER,
        "cache": str(CACHE),
        "modelsReady": ready,
    }


@app.post("/faces")
def faces() -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "code": "not_implemented",
                "message": "Face detection arrives when the models are installed.",
            }
        },
    )


@app.post("/embed")
def embed() -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "code": "not_implemented",
                "message": "Embeddings arrive when the models are installed.",
            }
        },
    )
