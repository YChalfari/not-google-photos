import hashlib
import http.server
import threading
from pathlib import Path
from typing import ClassVar

import pytest

from ngp_ml.download import (
    DownloadProgress,
    ModelUnavailableError,
    RemoteFile,
    ensure_files,
    is_cached,
)

PAYLOAD = bytes(range(256)) * 4096  # 1 MiB


class _Handler(http.server.BaseHTTPRequestHandler):
    hits: ClassVar[list[str]] = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        _Handler.hits.append(self.path)
        if self.path.startswith("/missing"):
            self.send_error(404)
            return
        start = 0
        if self.headers.get("Range"):
            start = int(self.headers["Range"].split("=")[1].split("-")[0])
            self.send_response(206)
        else:
            self.send_response(200)
        body = PAYLOAD[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def server():
    _Handler.hits = []
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def _remote(base: str, *paths: str, sha: str | None = None) -> RemoteFile:
    return RemoteFile(
        path="weights/model.onnx",
        urls=tuple(base + p for p in paths),
        sha256=sha or hashlib.sha256(PAYLOAD).hexdigest(),
        size=len(PAYLOAD),
    )


def test_downloads_verifies_and_records_the_checksum(server, tmp_path: Path):
    remote = _remote(server, "/model.onnx")
    progress = DownloadProgress()
    ensure_files(tmp_path, [remote], offline=False, progress=progress)
    dest = tmp_path / "weights/model.onnx"
    assert dest.read_bytes() == PAYLOAD
    assert is_cached(dest, remote)
    assert progress.snapshot()["done_bytes"] == len(PAYLOAD)
    ensure_files(tmp_path, [remote], offline=True)  # cached: no network needed
    assert _Handler.hits == ["/model.onnx"]


def test_falls_back_to_the_next_mirror(server, tmp_path: Path):
    ensure_files(tmp_path, [_remote(server, "/missing", "/model.onnx")], offline=False)
    assert _Handler.hits == ["/missing", "/model.onnx"]


def test_resumes_a_partial_download(server, tmp_path: Path):
    part = tmp_path / "weights/model.onnx.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(PAYLOAD[:1000])
    ensure_files(tmp_path, [_remote(server, "/model.onnx")], offline=False)
    assert (tmp_path / "weights/model.onnx").read_bytes() == PAYLOAD
    assert not part.exists()


def test_checksum_mismatch_is_an_error(server, tmp_path: Path, monkeypatch):
    monkeypatch.setattr("ngp_ml.download.time.sleep", lambda _: None)
    with pytest.raises(ModelUnavailableError, match="checksum mismatch"):
        ensure_files(tmp_path, [_remote(server, "/model.onnx", sha="0" * 64)], offline=False)
    assert not (tmp_path / "weights/model.onnx").exists()


def test_offline_mode_refuses_to_download(tmp_path: Path):
    with pytest.raises(ModelUnavailableError, match="ML_OFFLINE"):
        ensure_files(tmp_path, [_remote("http://127.0.0.1:9", "/model.onnx")], offline=True)


def test_a_complete_file_without_a_sidecar_is_adopted_after_hashing(tmp_path: Path):
    remote = _remote("http://127.0.0.1:9", "/model.onnx")
    dest = tmp_path / remote.path
    dest.parent.mkdir(parents=True)
    dest.write_bytes(PAYLOAD)
    ensure_files(tmp_path, [remote], offline=False)
    assert is_cached(dest, remote)
