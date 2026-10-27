#!/usr/bin/env bash
# Run the ML service natively on a Mac, so ONNX Runtime can use the GPU and Neural Engine
# through the CoreML provider. Docker on a Mac cannot see the GPU.
#
# Needs macOS 14 or newer: that is the onnxruntime wheel that includes CoreML.
# The server container reaches this process at http://host.docker.internal:8740.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "run-mac.sh is for macOS. Elsewhere, run: docker build -t ngp-ml . && docker run -p 8740:8740 -v ngp-ml-cache:/cache ngp-ml" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is not installed. See https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

# 127.0.0.1 is reachable from Docker Desktop containers as host.docker.internal.
# Set ML_HOST=0.0.0.0 only if something outside Docker Desktop has to connect.
export ML_EXECUTION_PROVIDER="${ML_EXECUTION_PROVIDER:-coreml}"
export ML_HOST="${ML_HOST:-127.0.0.1}"
export ML_PORT="${ML_PORT:-8740}"

echo "ngp-ml on ${ML_HOST}:${ML_PORT} with ML_EXECUTION_PROVIDER=${ML_EXECUTION_PROVIDER}" >&2
echo "Models download into ${ML_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ngp-ml} on first start." >&2
exec uv run ngp-ml serve
