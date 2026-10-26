# ngp-ml

Face detection and multilingual image search for Not Google Photos. A small FastAPI service
that runs [InsightFace buffalo_l](https://github.com/deepinsight/insightface) and a multilingual
SigLIP model through ONNX Runtime. No PyTorch at runtime.

The server's job workers call it over HTTP. It does not talk to the database.

## What it does

- `POST /v1/faces` finds faces and returns a 512-d embedding for each one that is large and sharp enough. Tiny and blurry faces come back under `skipped`, with no embedding.
- `POST /v1/clip/image` returns a 768-d embedding of a photo for semantic search and zero-shot tags.
- `POST /v1/clip/text` and `POST /v1/clip/text/batch` embed search queries and tag labels. Hebrew works without a language code.
- `POST /v1/analyze` does faces and the image embedding in one call.
- `GET /health` is 200 only once every enabled model is loaded, and 503 before that.

The full request and response shapes, the recommended clustering distances, and every environment variable are in the API contract the server worker reads.

## Models

| | Faces | Search and tags |
|---|---|---|
| Model | InsightFace `buffalo_l`: SCRFD-10G + ArcFace R50 (WebFace600K) | `ViT-B-16-SigLIP-i18n-256` (mSigLIP, multilingual SigLIP) |
| Vector | 512, L2-normalized, cosine distance | 768, L2-normalized, cosine similarity |
| License | non-commercial research only | Apache-2.0 |

mSigLIP is the default because English and Hebrew retrieval are about equal, and queries need no language code. On 1,000 Crossmodal-3600 images with two native-speaker captions each, all five candidates measured the same way on CPU:

| Model | ms/image | English R@1 / R@5 | Hebrew R@1 / R@5 |
|---|---|---|---|
| **ViT-B-16-SigLIP-i18n-256** (default) | 107 | 66.4 / 89.0 | **68.0 / 87.9** |
| ViT-B-16-SigLIP2 | 87 | **72.5 / 91.8** | 53.9 / 76.6 |
| ViT-B-32-SigLIP2-256 | 49 | 70.3 / 91.0 | 53.0 / 75.3 |
| XLM-RoBERTa ViT-B/32 | 41 | 63.8 / 88.6 | 63.2 / 85.8 |
| NLLB-CLIP base SigLIP | 230 | 65.2 / 89.0 | 73.6 / 92.2 |

Re-running the three models this service actually ships, through its own preprocessing, reproduces those recall numbers and is faster: mSigLIP at 79 ms per image, SigLIP 2 B/16 at 64 ms, SigLIP 2 B/32 at 30 ms. The reports are in `calibration/`.

SigLIP 2 is stronger in English and much weaker in Hebrew. NLLB-CLIP is the best in Hebrew, but it needs a language token, its image encoder is 384 px (about 2.5× slower here), and the checkpoint is CC-BY-NC. Switch models with `ML_CLIP_MODEL`; the other two SigLIP exports are already pinned. Changing the model changes every stored vector, so re-embed photos and tag labels afterwards.

buffalo_l's weights are licensed for non-commercial research. That covers personal and family use. Swap the face model before this becomes a product.

Models download on first start into `ML_CACHE_DIR` (about 1.7 GB) and are checked against pinned SHA-256 hashes. `ngp-ml download` fetches them without serving.

## Run with Docker

The image builds for `linux/amd64` and `linux/arm64`. CPU is the default.

```bash
docker build -t ngp-ml .
docker run --rm -p 8740:8740 -v ngp-ml-cache:/cache ngp-ml
```

`/health` stays 503 while the models download and load. The first start pulls about 1.7 GB into the `/cache` volume.

For an NVIDIA GPU, build the CUDA variant and run it with the NVIDIA Container Toolkit:

```bash
docker build --build-arg VARIANT=cuda -t ngp-ml:cuda .
docker run --rm --gpus all -p 8740:8740 -v ngp-ml-cache:/cache ngp-ml:cuda
```

## Run natively on a Mac

Docker on a Mac cannot use the GPU. For the first backlog, run the service on the host so ONNX Runtime's CoreML provider can use the GPU and Neural Engine. This needs macOS 14 or newer.

```bash
./scripts/run-mac.sh
```

That listens on `127.0.0.1:8740`, which a container on Docker Desktop reaches at `http://host.docker.internal:8740`. Set `ML_HOST=0.0.0.0` only if a process outside Docker Desktop has to connect. Confirm the provider with `uv run ngp-ml check`.

## Configuration

Every setting is an environment variable prefixed with `ML_`. The defaults are what the Docker image and `run-mac.sh` rely on.

| Variable | Default | |
|---|---|---|
| `ML_HOST` | `0.0.0.0` | `run-mac.sh` sets `127.0.0.1` |
| `ML_PORT` | `8740` | |
| `ML_API_TOKEN` | unset | when set, every route except `/health` requires `Authorization: Bearer <token>` |
| `ML_CACHE_DIR` | `~/.cache/ngp-ml` | Docker uses `/cache` |
| `ML_EXECUTION_PROVIDER` | `cpu` | `cpu`, `coreml`, `cuda`, or `auto` (CUDA, then CoreML, then CPU). An unavailable choice falls back to CPU |
| `ML_COREML_COMPUTE_UNITS` | `ALL` | `ALL`, `CPUAndNeuralEngine`, `CPUAndGPU`, `CPUOnly` |
| `ML_CUDA_DEVICE_ID` | `0` | |
| `ML_CLIP_MODEL` | `ViT-B-16-SigLIP-i18n-256__webli` | also `ViT-B-16-SigLIP2__webli`, `ViT-B-32-SigLIP2-256__webli` |
| `ML_FACES_ENABLED`, `ML_CLIP_ENABLED` | `true` | |
| `ML_FACE_MIN_SCORE` | `0.6` | detector confidence |
| `ML_FACE_MIN_SIZE` | `40` | skip a face whose shorter side is below this, in pixels of the photo as sent |
| `ML_FACE_MIN_SHARPNESS` | `20` | skip a blurrier face; Laplacian variance of the aligned crop |
| `ML_FACE_MAX_FACES` | `50` | |
| `ML_OFFLINE` | `false` | fail instead of downloading |
| `ML_CONCURRENCY` | `1` | inference calls in flight at once |

Per-request query parameters on `/v1/faces` and `/v1/analyze` override the four face thresholds.

## Develop

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run ngp-ml serve          # http://127.0.0.1:8740
uv run pytest                # downloads the models on first run, about 1.7 GB
ML_SKIP_MODEL_TESTS=1 uv run pytest
```

`scripts/calibrate_faces.py` measures buffalo_l on the LFW pairs and on shrunk and blurred copies, and writes `calibration/faces-lfw.json`. `scripts/eval_clip.py` repeats the retrieval and tagging measurement for whichever `ML_CLIP_MODEL` is configured.

The numbers those scripts produced are what `GET /v1/models` returns under `recommended`:

- Clustering uses cosine distance (`1 - cosine similarity`). Auto-merge up to **0.5**. From 0.5 to **0.6**, suggest "same person?" instead of merging. On LFW's 6,000 official pairs, 0.5 is the 95th percentile of genuine pairs and the closest different people are at 0.76, so false merges stay rare. A thin tail of genuine pairs goes past 0.6 (a 34-year gap in the fixture photos reaches 0.65), which is what the suggestion band is for.
- A new person should only be seeded by a face with `quality` of at least **0.5**.
- A zero-shot tag is `sigmoid(logit_scale * cosine + logit_bias)`. Keep it when that probability is at least **0.005**. SigLIP assigns one-word labels small probabilities; 0.5 would keep almost nothing.

The server owns the final thresholds and can change them without a new ML build. `recommended` is a measured starting point.
