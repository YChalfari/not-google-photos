from __future__ import annotations

import contextlib
import fcntl
import hashlib
import logging
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

import httpx

log = logging.getLogger(__name__)

CHUNK = 1024 * 1024


@dataclass(frozen=True)
class RemoteFile:
    path: str
    """Path relative to the model's directory in the cache."""
    urls: tuple[str, ...]
    """Mirrors tried in order."""
    sha256: str
    size: int


class ModelUnavailableError(RuntimeError):
    pass


@dataclass
class DownloadProgress:
    total_bytes: int = 0
    completed_bytes: int = 0
    current_bytes: int = 0
    current_file: str | None = None
    _lock: Lock = field(default_factory=Lock, repr=False)

    def start_file(self, name: str, offset: int) -> None:
        with self._lock:
            self.current_file = name
            self.current_bytes = offset

    def add(self, n: int) -> None:
        with self._lock:
            self.current_bytes += n

    def finish_file(self, size: int) -> None:
        with self._lock:
            self.completed_bytes += size
            self.current_bytes = 0
            self.current_file = None

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "done_bytes": self.completed_bytes + self.current_bytes,
                "total_bytes": self.total_bytes,
                "file": self.current_file,
            }


def _sidecar(dest: Path) -> Path:
    return dest.with_name(dest.name + ".sha256")


def is_cached(dest: Path, expected: RemoteFile) -> bool:
    """A file counts as cached once its hash was verified and recorded next to it."""
    try:
        if dest.stat().st_size != expected.size:
            return False
        return _sidecar(dest).read_text().strip() == expected.sha256
    except OSError:
        return False


@contextlib.contextmanager
def _dir_lock(directory: Path) -> Iterator[None]:
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / ".lock", "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _hash_file(path: Path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    return digest


def _fetch(
    url: str, part: Path, expected: RemoteFile, progress: DownloadProgress, label: str
) -> None:
    offset = part.stat().st_size if part.exists() else 0
    if offset > expected.size:
        part.unlink()
        offset = 0
    digest = _hash_file(part) if offset else hashlib.sha256()
    progress.start_file(label, offset)
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    timeout = httpx.Timeout(30.0, read=120.0)
    with httpx.stream(
        "GET", url, headers=headers, follow_redirects=True, timeout=timeout
    ) as response:
        if offset and response.status_code == 200:
            # The server ignored the range request; start over.
            offset = 0
            digest = hashlib.sha256()
            part.unlink(missing_ok=True)
            progress.start_file(label, 0)
        elif response.status_code not in (200, 206):
            raise httpx.HTTPStatusError(
                f"HTTP {response.status_code} for {url}",
                request=response.request,
                response=response,
            )
        with open(part, "ab" if offset else "wb") as out:
            for chunk in response.iter_bytes(CHUNK):
                out.write(chunk)
                digest.update(chunk)
                progress.add(len(chunk))
    if digest.hexdigest() != expected.sha256:
        part.unlink(missing_ok=True)
        raise ModelUnavailableError(f"checksum mismatch for {expected.path} from {url}")


def ensure_files(
    model_dir: Path,
    files: list[RemoteFile],
    *,
    offline: bool,
    progress: DownloadProgress | None = None,
    attempts: int = 3,
) -> None:
    """Make sure every file is present and verified in `model_dir`, downloading what is missing."""
    progress = progress or DownloadProgress()
    with _dir_lock(model_dir):
        missing = [f for f in files if not is_cached(model_dir / f.path, f)]
        if not missing:
            return
        if offline:
            names = ", ".join(f.path for f in missing)
            raise ModelUnavailableError(
                f"ML_OFFLINE is set and {model_dir.name} is missing: {names}"
            )
        progress.total_bytes += sum(f.size for f in missing)
        for remote in missing:
            dest = model_dir / remote.path
            dest.parent.mkdir(parents=True, exist_ok=True)
            # A complete file without a sidecar (for example copied in by hand) only needs hashing.
            if (
                dest.exists()
                and dest.stat().st_size == remote.size
                and _hash_file(dest).hexdigest() == remote.sha256
            ):
                _sidecar(dest).write_text(remote.sha256)
                progress.finish_file(remote.size)
                continue
            part = dest.with_name(dest.name + ".part")
            label = f"{model_dir.name}/{remote.path}"
            last_error: Exception | None = None
            for attempt in range(attempts):
                for url in remote.urls:
                    try:
                        log.info("Downloading %s (%.1f MB) from %s", label, remote.size / 1e6, url)
                        started = time.monotonic()
                        _fetch(url, part, remote, progress, label)
                        os.replace(part, dest)
                        progress.finish_file(remote.size)
                        _sidecar(dest).write_text(remote.sha256)
                        log.info("Saved %s in %.1fs", dest, time.monotonic() - started)
                        last_error = None
                        break
                    except (httpx.HTTPError, OSError, ModelUnavailableError) as exc:
                        last_error = exc
                        log.warning("Download of %s from %s failed: %s", remote.path, url, exc)
                if last_error is None:
                    break
                time.sleep(2 ** (attempt + 1))
            if last_error is not None:
                raise ModelUnavailableError(
                    f"could not download {label}: {last_error}"
                ) from last_error
