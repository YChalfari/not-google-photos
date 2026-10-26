"""Real multilingual CLIP model on the scene fixtures, through the HTTP API (downloaded into
ML_CACHE_DIR on first use)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from ngp_ml.app import create_app
from ngp_ml.config import Settings

pytestmark = pytest.mark.models

FIXTURES = Path(__file__).parent / "fixtures"

# file: (English query, Hebrew query), typed the way people search
SCENES = {
    "dog.jpg": ("dog", "כלב"),
    "cat.jpg": ("cat", "חתול"),
    "birthday_cake.jpg": ("birthday cake", "עוגת יום הולדת"),
    "beach.jpg": ("beach", "חוף ים"),
    "snow.jpg": ("snow", "שלג"),
    "car.jpg": ("car", "מכונית"),
    "bicycle.jpg": ("bicycle", "אופניים"),
    "flowers.jpg": ("flowers", "פרחים"),
    "salad.jpg": ("salad", "סלט"),
}
SENTENCES = {
    "birthday_cake.jpg": ("a cake with candles on it", "עוגה עם נרות"),
    "snow.jpg": ("people walking between snowy trees", "אנשים הולכים בין עצים מושלגים"),
    "bicycle.jpg": ("a bike with a child seat", "אופניים עם מושב לילד"),
    "dog.jpg": ("a dog lying on the grass", "כלב שוכב על הדשא"),
}


@pytest.fixture(scope="module")
def client(manager):
    with TestClient(create_app(Settings(preload=False), manager)) as c:
        yield c


@pytest.fixture(scope="module")
def scene_vectors(client) -> tuple[list[str], np.ndarray]:
    names = list(SCENES)
    vectors = []
    for name in names:
        res = client.post("/v1/clip/image", content=(FIXTURES / "scenes" / name).read_bytes())
        assert res.status_code == 200, res.text
        vectors.append(res.json()["embedding"])
    return names, np.asarray(vectors, dtype=np.float32)


def _texts(client, texts: list[str], prompt: str = "none") -> np.ndarray:
    res = client.post("/v1/clip/text/batch", json={"texts": texts, "prompt": prompt})
    assert res.status_code == 200, res.text
    return np.asarray(res.json()["embeddings"], dtype=np.float32)


def test_vectors_are_unit_length_with_the_advertised_size(client, scene_vectors):
    info = client.get("/v1/models").json()["clip"]
    _, images = scene_vectors
    texts = _texts(client, ["dog", "כלב"])
    assert images.shape[1] == texts.shape[1] == info["embedding_dim"] == 768
    np.testing.assert_allclose(np.linalg.norm(images, axis=1), 1.0, atol=1e-5)
    np.testing.assert_allclose(np.linalg.norm(texts, axis=1), 1.0, atol=1e-5)


@pytest.mark.parametrize("language", ["en", "he"])
def test_keyword_search_finds_each_scene(client, scene_vectors, language):
    names, images = scene_vectors
    queries = [SCENES[n][0 if language == "en" else 1] for n in names]
    found = [names[i] for i in (_texts(client, queries) @ images.T).argmax(axis=1)]
    misses = [(q, f) for q, f, n in zip(queries, found, names, strict=True) if f != n]
    assert not misses, misses


@pytest.mark.parametrize("language", ["en", "he"])
def test_sentence_search_finds_the_scene(client, scene_vectors, language):
    names, images = scene_vectors
    targets = list(SENTENCES)
    queries = [SENTENCES[n][0 if language == "en" else 1] for n in targets]
    best = (_texts(client, queries) @ images.T).argmax(axis=1)
    assert [names[b] for b in best] == targets


def test_english_and_hebrew_queries_land_close_together(client):
    english, hebrew = _texts(client, ["dog", "beach"]), _texts(client, ["כלב", "חוף ים"])
    sims = english @ hebrew.T
    assert sims[0, 0] > sims[0, 1] and sims[1, 1] > sims[1, 0]


def test_batch_matches_single_calls(client):
    texts = ["birthday cake", "עוגת יום הולדת", "a dog on the beach"]
    batch = _texts(client, texts)
    for text, row in zip(texts, batch, strict=True):
        single = client.post("/v1/clip/text", json={"text": text}).json()["embedding"]
        np.testing.assert_allclose(row, single, atol=1e-6)


def test_zero_shot_tags_pick_the_right_label(client, scene_vectors):
    names, images = scene_vectors
    info = client.get("/v1/models").json()["clip"]
    labels = [SCENES[n][0] for n in names]
    logits = (
        info["logit_scale"] * (images @ _texts(client, labels, prompt="tag").T) + info["logit_bias"]
    )
    probs = 1.0 / (1.0 + np.exp(-logits))
    assert [labels[i] for i in probs.argmax(axis=1)] == labels
    # One-word labels get small, uneven sigmoid probabilities (the parked car in a landscape scores
    # about 3e-4), so the recommended cut-off trades some recall for precision. dog, cat, cake,
    # beach, snow, and salad clear 0.005. The car, the bicycle, and the flower field land below it.
    threshold = info["recommended"]["tag_min_probability"]
    kept = np.diag(probs) >= threshold
    scores = dict(zip(labels, np.diag(probs), strict=True))
    assert set(np.array(labels)[kept]) == {
        "dog",
        "cat",
        "birthday cake",
        "beach",
        "snow",
        "salad",
    }, {k: round(float(v), 4) for k, v in scores.items()}
    off_diagonal = probs[~np.eye(len(labels), dtype=bool)]
    assert (off_diagonal >= threshold).mean() < 0.03


def test_analyze_returns_faces_and_clip_in_one_call(client):
    res = client.post(
        "/v1/analyze", content=(FIXTURES / "faces" / "obama_family_2011.jpg").read_bytes()
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["faces"]["faces"]) == 4
    assert len(body["clip"]["embedding"]) == 768
    assert {"decode", "faces", "clip", "total"} <= set(body["timings_ms"])
