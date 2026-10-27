import io

import numpy as np
import pytest
from PIL import Image

from ngp_ml.imaging import InvalidImageError, decode_image


def _jpeg(image: Image.Image, orientation: int | None = None) -> bytes:
    buf = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[0x0112] = orientation
    image.save(buf, format="JPEG", quality=95, exif=exif.tobytes())
    return buf.getvalue()


def _two_tone(width: int, height: int) -> Image.Image:
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[:, : width // 2] = (255, 0, 0)
    arr[:, width // 2 :] = (0, 0, 255)
    return Image.fromarray(arr)


def test_exif_orientation_is_applied_and_reported_size_is_upright():
    stored = _two_tone(300, 200)  # red on the left, blue on the right
    decoded = decode_image(
        _jpeg(stored, orientation=6), max_side=4096
    )  # 6 = rotate 90 degrees clockwise
    assert (decoded.width, decoded.height) == (200, 300)
    rgb = decoded.rgb()
    assert rgb.shape == (300, 200, 3)
    assert rgb[10, 100, 0] > 200 and rgb[10, 100, 2] < 60  # red ends up on top
    assert rgb[290, 100, 2] > 200 and rgb[290, 100, 0] < 60


def test_large_images_are_downscaled_but_coordinates_stay_in_the_sent_space():
    decoded = decode_image(_jpeg(_two_tone(4000, 3000), orientation=8), max_side=1000)
    assert (decoded.width, decoded.height) == (3000, 4000)
    assert max(decoded.image.size) <= 1000
    assert decoded.scale == pytest.approx(decoded.image.width / 3000, rel=1e-6)


def test_transparent_pixels_become_white():
    rgba = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    buf = io.BytesIO()
    rgba.save(buf, format="PNG")
    rgb = decode_image(buf.getvalue(), 4096).rgb()
    assert rgb.min() == 255


def test_sixteen_bit_grayscale_is_scaled_not_clipped():
    arr = np.full((20, 20), 32768, dtype=np.uint16)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    rgb = decode_image(buf.getvalue(), 4096).rgb()
    assert 120 < rgb.mean() < 135


def test_heic_is_supported():
    pillow_heif = pytest.importorskip("pillow_heif")
    if not pillow_heif.libheif_info().get("HEIF"):
        pytest.skip("this pillow-heif build cannot encode HEIC")
    buf = io.BytesIO()
    _two_tone(64, 48).save(buf, format="HEIF")
    decoded = decode_image(buf.getvalue(), 4096)
    assert (decoded.width, decoded.height) == (64, 48)


@pytest.mark.parametrize("payload", [b"", b"not an image", b"\xff\xd8\xff\xe0truncated"])
def test_garbage_is_rejected(payload):
    with pytest.raises(InvalidImageError):
        decode_image(payload, 4096)
