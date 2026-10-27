from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
OUTPUT = Path(__file__).parent / ".output"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("ML_SKIP_MODEL_TESTS") == "1":
        skip = pytest.mark.skip(reason="ML_SKIP_MODEL_TESTS=1")
        for item in items:
            if "models" in item.keywords:
                item.add_marker(skip)


@pytest.fixture(scope="session")
def face_labels() -> dict[str, list[str]]:
    labels = json.loads((FIXTURES / "faces" / "labels.json").read_text())
    labels.pop("_comment", None)
    return labels


@pytest.fixture(scope="session")
def manager():
    """Real models, downloaded into ML_CACHE_DIR on first use (about 1.7 GB)."""
    from ngp_ml.config import Settings
    from ngp_ml.service import ModelManager

    m = ModelManager(Settings())
    m.load_now()
    return m


@pytest.fixture(scope="session")
def output_dir() -> Path:
    OUTPUT.mkdir(exist_ok=True)
    return OUTPUT
