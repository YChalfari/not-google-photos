"""HTTP contract tests with stub models (no downloads)."""

import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ngp_ml.app import create_app
from ngp_ml.config import Settings
from ngp_ml.faces import Face
from ngp_ml.service import ModelManager, ModelState


class StubAnalyzer:
    def analyze(self, rgb, scale, thresholds):
        emb = np.zeros(512, np.float32)
        emb[0] = 1.0
        kept = Face(
            box=np.array([10, 20, 110, 140], np.float32) / scale,
            landmarks=np.tile(np.array([[50.0, 60.0]], np.float32), (5, 1)) / scale,
            score=0.91,
            size=100.0,
            sharpness=250.0,
            yaw=3.0,
            quality=0.97,
            embedding=emb,
            embedding_norm=21.5,
        )
        tiny = Face(
            box=np.array([300, 300, 310, 312], np.float32),
            landmarks=np.zeros((5, 2), np.float32),
            score=0.7,
            size=10.0,
            sharpness=80.0,
            yaw=0.0,
            quality=0.0,
            skip_reason="too_small",
        )
        return [kept, tiny]


class StubClip:
    def encode_image(self, image):
        v = np.zeros(768, np.float32)
        v[1] = 1.0
        return v

    def encode_texts(self, texts):
        out = np.zeros((len(texts), 768), np.float32)
        for i, text in enumerate(texts):
            out[i, len(text) % 768] = 1.0
        return out


def _manager(settings: Settings, ready: bool = True) -> ModelManager:
    manager = ModelManager(settings)
    if ready:
        manager.faces.model, manager.faces.state = StubAnalyzer(), ModelState.ready
        manager.clip.model, manager.clip.state = StubClip(), ModelState.ready
    return manager


@pytest.fixture
def settings(tmp_path):
    return Settings(cache_dir=tmp_path, preload=False, max_upload_mb=1, max_text_batch=4)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings, _manager(settings))) as c:
        yield c


def _jpeg(width=320, height=240) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (120, 80, 40)).save(buf, format="JPEG")
    return buf.getvalue()


def test_health_is_ok_when_models_are_ready(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["models"]["faces"]["state"] == "ready"
    assert body["execution_provider"]["active"] == "cpu"


def test_health_is_503_while_loading(settings):
    with TestClient(create_app(settings, _manager(settings, ready=False))) as c:
        res = c.get("/health")
        assert res.status_code == 503
        assert res.json()["status"] == "loading"


def test_faces_with_raw_body(client):
    res = client.post("/v1/faces", content=_jpeg(), headers={"content-type": "image/jpeg"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model"] == "buffalo_l"
    assert body["embedding_dim"] == 512
    assert body["image"] == {"width": 320, "height": 240}
    face = body["faces"][0]
    assert set(face["bbox"]) == {"x1", "y1", "x2", "y2"}
    assert len(face["landmarks"]) == 5
    assert len(face["embedding"]) == 512
    assert body["skipped"][0]["reason"] == "too_small"
    assert "embedding" not in body["skipped"][0]
    assert body["thresholds"]["min_size"] == 40
    assert {"decode", "faces", "total"} <= set(body["timings_ms"])


def test_faces_with_multipart_and_threshold_overrides(client):
    res = client.post(
        "/v1/faces?min_size=64&min_sharpness=5",
        files={"image": ("photo.jpg", _jpeg(), "image/jpeg")},
    )
    assert res.status_code == 200, res.text
    assert res.json()["thresholds"]["min_size"] == 64
    assert res.json()["thresholds"]["min_sharpness"] == 5


def test_clip_image(client):
    res = client.post(
        "/v1/clip/image", content=_jpeg(), headers={"content-type": "application/octet-stream"}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model"] == "ViT-B-16-SigLIP-i18n-256__webli"
    assert body["embedding_dim"] == 768
    assert body["embedding"][1] == 1.0 and len(body["embedding"]) == 768
    assert body["image"] == {"width": 320, "height": 240}
    assert {"decode", "clip", "total"} <= set(body["timings_ms"])


def test_analyze_returns_faces_and_clip_from_one_upload(client):
    body = client.post("/v1/analyze", content=_jpeg()).json()
    assert body["faces"]["faces"] and len(body["clip"]["embedding"]) == 768
    only_clip = client.post("/v1/analyze?faces=false", content=_jpeg()).json()
    assert only_clip["faces"] is None and only_clip["clip"] is not None
    res = client.post("/v1/analyze?faces=false&clip=false", content=_jpeg())
    assert res.status_code == 422 and res.json()["error"]["code"] == "nothing_to_do"


def test_text_and_batch(client):
    single = client.post("/v1/clip/text", json={"text": "כלב בחוף הים"})
    assert single.status_code == 200
    assert len(single.json()["embedding"]) == 768
    batch = client.post(
        "/v1/clip/text/batch", json={"texts": ["dog", "beach", "birthday cake"], "prompt": "tag"}
    )
    assert batch.status_code == 200
    assert len(batch.json()["embeddings"]) == 3


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ({"texts": ["a", "b", "c", "d", "e"]}, "too_many_texts"),
        ({"texts": ["dog", "  "]}, "empty_text"),
        ({"texts": []}, "validation_error"),
        ({"texts": ["x" * 2000]}, "text_too_long"),
    ],
)
def test_batch_validation(client, payload, code):
    res = client.post("/v1/clip/text/batch", json=payload)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == code


@pytest.mark.parametrize(
    ("kwargs", "status", "code"),
    [
        ({"content": b""}, 400, "missing_image"),
        ({"content": b"definitely not an image"}, 400, "invalid_image"),
        ({"content": b"\0" * (2 * 1024 * 1024)}, 413, "payload_too_large"),
        ({"files": {"file": ("x.jpg", b"123", "image/jpeg")}}, 400, "missing_image"),
    ],
)
def test_image_errors_use_the_error_envelope(client, kwargs, status, code):
    res = client.post("/v1/faces", **kwargs)
    assert res.status_code == status
    assert res.json()["error"]["code"] == code


def test_endpoints_return_503_with_retry_after_while_loading(settings):
    with TestClient(create_app(settings, _manager(settings, ready=False))) as c:
        res = c.post("/v1/clip/text", json={"text": "dog"})
        assert res.status_code == 503
        assert res.json()["error"]["code"] == "model_loading"
        assert res.headers["retry-after"] == "10"


def test_api_token(tmp_path):
    settings = Settings(cache_dir=tmp_path, preload=False, api_token="s3cret")
    with TestClient(create_app(settings, _manager(settings))) as c:
        assert c.get("/health").status_code == 200
        assert c.post("/v1/clip/text", json={"text": "dog"}).status_code == 401
        ok = c.post(
            "/v1/clip/text", json={"text": "dog"}, headers={"Authorization": "Bearer s3cret"}
        )
        assert ok.status_code == 200


def test_models_endpoint_describes_vectors_and_scoring(client):
    body = client.get("/v1/models").json()
    assert body["faces"]["embedding_dim"] == 512
    assert body["clip"]["name"] == "ViT-B-16-SigLIP-i18n-256__webli"
    assert body["clip"]["embedding_dim"] == 768
    assert body["clip"]["logit_scale"] == pytest.approx(110.996, abs=1e-3)
    assert body["clip"]["logit_bias"] == pytest.approx(-12.885, abs=1e-3)
    assert body["clip"]["context_length"] == 64
    assert body["faces"]["defaults"]["min_size"] == 40
    assert "ViT-B-16-SigLIP2__webli" in body["available_clip_models"]


def test_unknown_clip_model_is_reported(tmp_path):
    settings = Settings(cache_dir=tmp_path, preload=False, clip_model="nope")
    manager = ModelManager(settings)
    assert manager.clip.state == ModelState.error
    assert "unknown ML_CLIP_MODEL" in manager.clip.error


def test_openapi_documents_the_image_body(client):
    spec = client.get("/openapi.json").json()
    body = spec["paths"]["/v1/faces"]["post"]["requestBody"]["content"]
    assert {"multipart/form-data", "image/*", "application/octet-stream"} <= set(body)
