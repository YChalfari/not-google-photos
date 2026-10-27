import math

import cv2
import numpy as np
import pytest

from ngp_ml.faces import (
    ARCFACE_TEMPLATE,
    align_face,
    estimate_yaw,
    nms,
    quality_score,
    sharpness,
    umeyama,
)


def _similarity(scale: float, angle_deg: float, tx: float, ty: float) -> np.ndarray:
    a = math.radians(angle_deg)
    return np.array(
        [
            [scale * math.cos(a), -scale * math.sin(a), tx],
            [scale * math.sin(a), scale * math.cos(a), ty],
        ]
    )


def test_umeyama_recovers_a_similarity_transform():
    truth = _similarity(2.5, 17.0, 40.0, -12.0)
    src = ARCFACE_TEMPLATE.astype(np.float64)
    dst = src @ truth[:, :2].T + truth[:, 2]
    estimated = umeyama(src, dst)[:2]
    np.testing.assert_allclose(estimated, truth, atol=1e-6)


def test_align_face_maps_landmarks_onto_the_arcface_template():
    rng = np.random.default_rng(0)
    image = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
    forward = _similarity(2.0, -10.0, 120.0, 90.0)
    landmarks = ARCFACE_TEMPLATE @ forward[:, :2].T + forward[:, 2]
    aligned = align_face(image, landmarks.astype(np.float32))
    expected = cv2.warpAffine(
        image, cv2.invertAffineTransform(forward), (112, 112), borderValue=0.0
    )
    assert aligned.shape == (112, 112, 3)
    assert np.abs(aligned.astype(int) - expected.astype(int)).mean() < 1.0


def test_nms_keeps_the_best_of_overlapping_boxes():
    dets = np.array(
        [
            [10, 10, 110, 110, 0.9],
            [12, 12, 112, 112, 0.8],
            [200, 200, 260, 260, 0.7],
        ],
        dtype=np.float32,
    )
    assert nms(dets, 0.4) == [0, 2]


def test_yaw_is_zero_for_a_frontal_face_and_signed_for_turned_faces():
    frontal = ARCFACE_TEMPLATE.copy()
    frontal[2, 0] = (frontal[0, 0] + frontal[1, 0]) / 2
    assert abs(estimate_yaw(frontal)) < 1.0
    turned = frontal.copy()
    turned[2, 0] += 0.3 * (frontal[1, 0] - frontal[0, 0])
    turned_other_way = frontal.copy()
    turned_other_way[2, 0] -= 0.3 * (frontal[1, 0] - frontal[0, 0])
    assert 30 < estimate_yaw(turned) < 45
    assert estimate_yaw(turned_other_way) == pytest.approx(-estimate_yaw(turned), abs=1.5)


def test_quality_rises_with_each_factor_and_is_zero_for_unusable_faces():
    good = quality_score(0.9, 200, 500, 0)
    assert good == pytest.approx(1.0)
    assert quality_score(0.9, 30, 500, 0) < quality_score(0.9, 60, 500, 0) < good
    assert quality_score(0.9, 200, 15, 0) < quality_score(0.9, 200, 60, 0) < good
    assert quality_score(0.9, 200, 500, 60) < quality_score(0.9, 200, 500, 35) <= good
    assert quality_score(0.9, 20, 500, 0) == 0.0
    assert quality_score(0.9, 200, 5, 0) == 0.0
    assert quality_score(0.9, 200, 500, 80) == 0.0


def test_blur_lowers_sharpness():
    rng = np.random.default_rng(1)
    crop = rng.integers(0, 255, (112, 112, 3), dtype=np.uint8)
    crop = cv2.GaussianBlur(crop, (0, 0), 1.0)
    blurred = cv2.GaussianBlur(crop, (0, 0), 3.0)
    assert sharpness(blurred) < sharpness(crop) / 10
