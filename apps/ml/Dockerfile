# syntax=docker/dockerfile:1.7
#
# Not Google Photos ML service.
#
#   CPU image (linux/amd64 and linux/arm64, the default):
#     docker build -t ngp-ml apps/ml
#     docker buildx build --platform linux/amd64,linux/arm64 -t ngp-ml apps/ml
#   NVIDIA GPU image (needs the NVIDIA Container Toolkit on the host, run with --gpus all):
#     docker build --build-arg VARIANT=cuda -t ngp-ml:cuda apps/ml
#
# Models are not baked in: they download on first start into /cache (about 1.7 GB), so mount a volume
# there to keep them across restarts.

ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM ghcr.io/astral-sh/uv:0.13.5 AS uv

FROM ${PYTHON_IMAGE} AS build
# `cpu` or `cuda`: which dependency group supplies ONNX Runtime.
ARG VARIANT=cpu
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-default-groups --group "${VARIANT}" --no-install-project
COPY README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-default-groups --group "${VARIANT}" --no-editable

FROM ${PYTHON_IMAGE}
ARG VARIANT=cpu
RUN groupadd --system --gid 10001 ngp \
    && useradd --system --uid 10001 --gid ngp --home-dir /home/ngp --create-home ngp \
    && mkdir -p /cache \
    && chown ngp:ngp /cache
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    ML_HOST=0.0.0.0 \
    ML_PORT=8740 \
    ML_CACHE_DIR=/cache \
    ML_EXECUTION_PROVIDER=${VARIANT}
USER ngp
VOLUME ["/cache"]
EXPOSE 8740
# /health turns 200 once the models are downloaded and loaded; the first start downloads ~1.7 GB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --start-interval=5s --retries=3 \
    CMD ["ngp-ml", "health"]
CMD ["ngp-ml", "serve"]
