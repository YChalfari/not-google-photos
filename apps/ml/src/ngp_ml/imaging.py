from __future__ import annotations

import io
import warnings
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

register_heif_opener()

# EXIF orientations that swap width and height.
_TRANSPOSED_ORIENTATIONS = {5, 6, 7, 8}


class InvalidImageError(ValueError):
    pass


@dataclass(frozen=True)
class DecodedImage:
    image: Image.Image
    """RGB image, EXIF orientation applied, possibly downscaled."""
    width: int
    """Width of the upright image as sent. Coordinates in responses use this space."""
    height: int
    scale: float
    """`image` pixels per pixel of the upright image as sent (1.0 unless downscaled)."""

    def rgb(self) -> np.ndarray:
        return np.asarray(self.image)


def _to_rgb(img: Image.Image) -> Image.Image:
    if img.mode == "RGB":
        return img
    if img.mode in ("I;16", "I;16B", "I;16L", "I"):
        arr = np.asarray(img, dtype=np.float32)
        peak = 65535.0 if arr.max() > 255 else 255.0
        img = Image.fromarray(np.clip(arr * (255.0 / peak), 0, 255).astype(np.uint8), mode="L")
    if img.mode == "P":
        img = img.convert("RGBA" if "transparency" in img.info else "RGB")
    if img.mode in ("RGBA", "LA", "PA", "RGBa", "La"):
        rgba = img.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return img.convert("RGB")


def decode_image(data: bytes, max_side: int) -> DecodedImage:
    """Decode JPEG, PNG, WebP, HEIC/HEIF, AVIF, GIF, BMP or TIFF bytes into an upright RGB image."""
    if not data:
        raise InvalidImageError("empty image")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data))
            orientation = img.getexif().get(0x0112, 1)
            stored_w, stored_h = img.size
            width, height = (
                (stored_h, stored_w)
                if orientation in _TRANSPOSED_ORIENTATIONS
                else (stored_w, stored_h)
            )
            longest = max(width, height)
            if img.format == "JPEG" and longest > max_side:
                # Let libjpeg decode at 1/2, 1/4 or 1/8 scale; much faster for big originals.
                factor = max_side / longest
                img.draft(
                    "RGB", (max(1, round(stored_w * factor)), max(1, round(stored_h * factor)))
                )
            img = ImageOps.exif_transpose(img)
            img = _to_rgb(img)
    except (
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise InvalidImageError(f"unsupported or unsafe image: {exc}") from exc
    except (OSError, ValueError, SyntaxError) as exc:
        raise InvalidImageError(f"could not decode image: {exc}") from exc

    if max(img.size) > max_side:
        factor = max_side / max(img.size)
        img = img.resize(
            (max(1, round(img.width * factor)), max(1, round(img.height * factor))),
            Image.Resampling.LANCZOS,
            reducing_gap=3.0,
        )
    return DecodedImage(image=img, width=width, height=height, scale=img.width / width)
