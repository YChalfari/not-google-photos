"""CLI behavior that does not need the models."""

import pytest

from ngp_ml.cli import main
from ngp_ml.config import get_settings


def test_health_command_fails_when_no_server_is_listening(monkeypatch):
    monkeypatch.setenv("ML_HOST", "127.0.0.1")
    monkeypatch.setenv("ML_PORT", "9")
    get_settings.cache_clear()
    try:
        with pytest.raises(SystemExit) as exc:
            main(["health"])
        assert exc.value.code not in (0, None)
    finally:
        get_settings.cache_clear()
