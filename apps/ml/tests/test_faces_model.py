"""Real buffalo_l models on the fixture photos (downloaded into ML_CACHE_DIR on first use)."""

from __future__ import annotations

import io
import itertools
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageFilter

from ngp_ml.config import Settings
from ngp_ml.faces import QualityThresholds
from ngp_ml.imaging import decode_image

pytestmark = pytest.mark.models

FACES = Path(__file__).parent / "fixtures" / "faces"
GROUP_PHOTOS = ("obama_family_2011.jpg", "williams_wilmore_2024.jpg")


def _thresholds(**overrides) -> QualityThresholds:
    s = Settings()
    base = dict(
        min_score=s.face_min_score,
        min_size=s.face_min_size,
        min_sharpness=s.face_min_sharpness,
        max_faces=s.face_max_faces,
    )
    return QualityThresholds(**{**base, **overrides})


def _analyze(manager, data: bytes, **overrides):
    decoded = decode_image(data, Settings().max_image_side)
    faces = manager.get_faces().analyze(decoded.rgb(), decoded.scale, _thresholds(**overrides))
    return decoded, sorted(faces, key=lambda f: float(f.box[0]))


@pytest.fixture(scope="session")
def labeled_faces(manager, face_labels):
    """(identity, file, face) for every kept face, matched to labels.json left to right."""
    out = []
    for name, identities in face_labels.items():
        _, faces = _analyze(manager, (FACES / name).read_bytes())
        kept = [f for f in faces if f.skip_reason is None]
        assert len(kept) == len(identities), (
            f"{name}: expected {len(identities)} faces, kept {len(kept)}"
        )
        out.extend((identity, name, face) for identity, face in zip(identities, kept, strict=True))
    return out


def test_detects_every_labeled_face_with_a_unit_embedding(labeled_faces):
    for identity, name, face in labeled_faces:
        assert face.embedding is not None and face.embedding.shape == (512,), (identity, name)
        assert np.linalg.norm(face.embedding) == pytest.approx(1.0, abs=1e-5)
        x1, y1, x2, y2 = face.box
        assert np.all((face.landmarks[:, 0] > x1) & (face.landmarks[:, 0] < x2)), (identity, name)
        assert np.all((face.landmarks[:, 1] > y1) & (face.landmarks[:, 1] < y2)), (identity, name)
        assert face.score > 0.6 and face.quality > 0.3, (identity, name, face.score, face.quality)


def test_same_person_is_closer_than_different_people(labeled_faces, output_dir):
    same, different = [], []
    for (id_a, file_a, face_a), (id_b, file_b, face_b) in itertools.combinations(labeled_faces, 2):
        distance = 1.0 - float(face_a.embedding @ face_b.embedding)
        pair = {"distance": round(distance, 4), "a": f"{file_a}:{id_a}", "b": f"{file_b}:{id_b}"}
        (same if id_a == id_b else different).append(pair)
    same.sort(key=lambda p: p["distance"])
    different.sort(key=lambda p: p["distance"])

    def summary(pairs):
        d = np.array([p["distance"] for p in pairs])
        qs = (0, 5, 25, 50, 75, 95, 100)
        return {"count": len(d), **{f"p{q}": round(float(np.percentile(d, q)), 4) for q in qs}}

    report = {
        "metric": "cosine distance = 1 - cosine similarity of L2-normalized buffalo_l embeddings",
        "same_person": summary(same),
        "different_people": summary(different),
        "margin": round(different[0]["distance"] - same[-1]["distance"], 4),
        "same_person_pairs": same,
        "closest_different_pairs": different[:10],
    }
    (output_dir / "face-distances.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"\nsame person: {report['same_person']}\ndifferent people: {report['different_people']}"
        f"\nmargin {report['margin']}; full report in {output_dir / 'face-distances.json'}"
    )

    assert same[-1]["distance"] < different[0]["distance"], (same[-1], different[0])
    assert len(same) >= 10 and len(different) >= 100


def test_people_in_group_photos_match_their_portraits(labeled_faces):
    portraits = [(i, n, f) for i, n, f in labeled_faces if n not in GROUP_PHOTOS]
    portrait_ids = {i for i, _, _ in portraits}
    checked = 0
    for identity, name, face in labeled_faces:
        if name not in GROUP_PHOTOS or identity not in portrait_ids:
            continue
        checked += 1
        nearest = max(portraits, key=lambda p: float(p[2].embedding @ face.embedding))
        assert nearest[0] == identity, (identity, name, "nearest portrait:", nearest[1])
    assert checked == 3  # Barack and Michelle Obama, Sunita Williams


def test_exif_rotation_does_not_change_faces(manager):
    upright = Image.open(FACES / "harris_2017.jpg")
    exif = Image.Exif()
    exif[0x0112] = 6  # stored rotated; viewers rotate 90 degrees clockwise
    buf = io.BytesIO()
    upright.transpose(Image.Transpose.ROTATE_90).save(buf, format="JPEG", quality=95, exif=exif)
    _, [plain] = _analyze(manager, (FACES / "harris_2017.jpg").read_bytes())
    decoded, [rotated] = _analyze(manager, buf.getvalue())
    assert (decoded.width, decoded.height) == upright.size
    assert np.abs(plain.box - rotated.box).max() < 3.0
    assert float(plain.embedding @ rotated.embedding) > 0.98


def test_tiny_and_blurry_faces_are_skipped_without_embeddings(manager):
    s = Settings()
    original = Image.open(FACES / "biden_2013.jpg").convert("RGB")
    _, [face] = _analyze(manager, (FACES / "biden_2013.jpg").read_bytes())
    assert face.skip_reason is None

    # Shrink until the face is half the minimum size, then pad back out so it sits in a larger photo.
    factor = 0.5 * s.face_min_size / face.size
    small = original.resize(
        (round(original.width * factor), round(original.height * factor)), Image.LANCZOS
    )
    canvas = Image.new(
        "RGB", (max(320, small.width * 2), max(240, small.height * 2)), (90, 110, 130)
    )
    canvas.paste(small, (canvas.width // 4, canvas.height // 4))
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    _, faces = _analyze(manager, buf.getvalue(), min_score=0.5)
    assert faces and all(f.skip_reason == "too_small" and f.embedding is None for f in faces)

    buf = io.BytesIO()
    original.filter(ImageFilter.GaussianBlur(radius=face.size / 25)).save(buf, format="PNG")
    _, faces = _analyze(manager, buf.getvalue(), min_score=0.5)
    assert faces and faces[0].skip_reason == "too_blurry" and faces[0].embedding is None
    assert faces[0].sharpness < s.face_min_sharpness <= face.sharpness
