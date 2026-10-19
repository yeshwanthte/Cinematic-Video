"""
Cinematic AI Studio — your own Wan 2.2 image-to-video server on Modal (modal.com).

Why: Modal's Starter plan includes US$30 of compute credits every month. Running the same
open-source Wan 2.2 14B model here gives far more generation time than Hugging Face's
free 5 GPU-minutes a day — and it is YOUR deployment, so no shared queue.

Cost control (set these once in Modal → Settings → Usage & Billing):
  • Spend limit = $0  → Modal stops workloads that would cost money once the free credits are used.
  • This app never runs more than ONE GPU container (max_containers=1) and shuts it down
    after SCALEDOWN seconds without work.

Deploy (no local Python needed — see .github/workflows/deploy-modal.yml), or locally:
  pip install modal && modal setup
  modal secret create cinematic-studio STUDIO_MODAL_SECRET=<a long random string>
  modal deploy modal/wan_app.py
  modal run modal/wan_app.py::download_weights      # one-time, ~70 GB into a Modal Volume (CPU only)

HTTP API (all routes need  Authorization: Bearer <STUDIO_MODAL_SECRET>):
  POST   /jobs                 {image, last_image?, prompt, negative_prompt?, duration, steps, seed?, max_dim}
                               → {id}
  GET    /jobs/{id}            → {status: queued|running|succeeded|failed|cancelled, progress?, step?, steps?, error?, seed?}
  GET    /jobs/{id}/video      → video/mp4 bytes (once succeeded)
  DELETE /jobs/{id}            → {cancelled: true}
  GET    /health               → {ok, gpu, model}
"""

import base64
import io
import os
import random
import time

import modal

APP_NAME = "cinematic-studio-wan"
GPU = os.environ.get("STUDIO_MODAL_GPU", "H200")  # 141 GB: both 14B experts + text encoder fit in bf16
SCALEDOWN = int(os.environ.get("STUDIO_MODAL_SCALEDOWN", "120"))  # seconds a warm GPU waits for the next job

MODEL_ID = "Wan-AI/Wan2.2-I2V-A14B-Diffusers"
BF16_ID = "cbensimon/Wan2.2-I2V-A14B-bf16-Diffusers"  # same weights stored in bf16 (half the download)
# Step-distillation (4-step "Lightning") LoRAs.
# Preferred: the official lightx2v LoRA pair trained FOR Wan 2.2 I2V A14B — one per expert, strength 1.0.
# The older Wan 2.1 LoRA (used by the public Space) has to be fused at 3× on the high-noise expert,
# which is a known cause of slow-motion movement and smeared / double outlines.
LORA22_REPO = "lightx2v/Wan2.2-Distill-Loras"
LORA22_HIGH = "wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors"
LORA22_LOW = "wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors"
LORA22_SCALE_HIGH = float(os.environ.get("STUDIO_LORA_HIGH", "1.0"))
LORA22_SCALE_LOW = float(os.environ.get("STUDIO_LORA_LOW", "1.0"))
# Fallback (only if the Wan 2.2 pair cannot be loaded): the Space's Wan 2.1 LoRA and its settings.
LORA_REPO = "Kijai/WanVideo_comfy"
LORA_FILE = "Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors"
VIDEO_QUALITY = 8  # imageio/ffmpeg quality 0–10 (was 5): fewer compression smears on hair and edges
FPS = 16
MIN_FRAMES, MAX_FRAMES = 8, 80
MODELS_DIR = "/models"
DEFAULT_NEGATIVE = "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 最差质量, 低质量, JPEG压缩残留, 畸形的, 多余的手指, 静止不动的画面, 慢动作, 重影, 残影, 双重曝光, 运动拖影, 画面闪烁"

app = modal.App(APP_NAME)
volume = modal.Volume.from_name("cinematic-studio-models", create_if_missing=True)
progress = modal.Dict.from_name("cinematic-studio-progress", create_if_missing=True)

gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.8.0",
        "diffusers==0.35.2",
        "transformers==4.57.1",
        "accelerate==1.10.1",
        "peft==0.17.1",
        "sentencepiece==0.2.1",
        "ftfy==6.3.1",
        "imageio==2.37.0",
        "imageio-ffmpeg==0.6.0",
        "huggingface_hub[hf_transfer]==0.35.3",
        "pillow==11.3.0",
        "numpy<2.3",
    )
    .env({"HF_HOME": MODELS_DIR, "HF_HUB_ENABLE_HF_TRANSFER": "1", "STUDIO_MODAL_GPU": GPU})
)
web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]==0.118.0").env({"STUDIO_MODAL_GPU": GPU})


# ---------------------------------------------------------------- helpers (pure, unit-testable)
def target_size(width: int, height: int, max_dim: int = 832, min_dim: int = 480, multiple: int = 16):
    """Same sizing rule as the official Wan 2.2 Space: long side = max_dim, both sides multiples of 16."""
    ar = width / height
    if abs(ar - 1) < 1e-6:
        side = int(round(max_dim * 640 / 832 / multiple)) * multiple
        return side, side
    if ar > 1:
        w, h = max_dim, max_dim / ar
    else:
        w, h = max_dim * ar, max_dim
    w = max(min_dim, min(max_dim, int(round(w / multiple)) * multiple))
    h = max(min_dim, min(max_dim, int(round(h / multiple)) * multiple))
    return w, h


def num_frames_for(duration: float) -> int:
    return 1 + max(MIN_FRAMES, min(MAX_FRAMES, int(round(float(duration) * FPS))))


def decode_image(data_uri: str):
    from PIL import Image

    b64 = data_uri.split(",", 1)[1] if data_uri.startswith("data:") else data_uri
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


# ---------------------------------------------------------------- one-time weight download (CPU only)
@app.function(image=gpu_image, volumes={MODELS_DIR: volume}, timeout=3 * 3600, cpu=4, memory=8192)
def download_weights():
    from huggingface_hub import hf_hub_download, snapshot_download

    snapshot_download(MODEL_ID, ignore_patterns=["transformer/*", "transformer_2/*"])  # pipeline parts
    snapshot_download(BF16_ID, allow_patterns=["transformer/*", "transformer_2/*"])  # bf16 experts
    hf_hub_download(LORA_REPO, LORA_FILE)
    for f in (LORA22_HIGH, LORA22_LOW):
        hf_hub_download(LORA22_REPO, f)
    volume.commit()
    print("Weights ready in the Modal Volume 'cinematic-studio-models'.")


# ---------------------------------------------------------------- the GPU worker
@app.cls(
    gpu=GPU,
    image=gpu_image,
    volumes={MODELS_DIR: volume},
    timeout=900,
    scaledown_window=SCALEDOWN,
    max_containers=1,  # never more than one GPU at a time → predictable spending
)
class Wan:
    @modal.enter()
    def load(self):
        import torch
        from diffusers.models.transformers.transformer_wan import WanTransformer3DModel
        from diffusers.pipelines.wan.pipeline_wan_i2v import WanImageToVideoPipeline

        t0 = time.time()
        kw = dict(torch_dtype=torch.bfloat16, local_files_only=True)
        self.pipe = WanImageToVideoPipeline.from_pretrained(
            MODEL_ID,
            transformer=WanTransformer3DModel.from_pretrained(BF16_ID, subfolder="transformer", **kw),
            transformer_2=WanTransformer3DModel.from_pretrained(BF16_ID, subfolder="transformer_2", **kw),
            **kw,
        ).to("cuda")
        self.lora = self._load_loras()
        print(f"Wan 2.2 loaded in {time.time() - t0:.0f}s with LoRA: {self.lora}")

    def _load_loras(self) -> str:
        from huggingface_hub import hf_hub_download

        try:
            for f in (LORA22_HIGH, LORA22_LOW):
                hf_hub_download(LORA22_REPO, f)  # cached in the Volume; downloads once (~1.4 GB) if missing
            volume.commit()
            # Load BOTH before fusing anything, so a failure leaves the base model untouched.
            self.pipe.load_lora_weights(LORA22_REPO, weight_name=LORA22_HIGH, adapter_name="w22_high", local_files_only=True)
            self.pipe.load_lora_weights(LORA22_REPO, weight_name=LORA22_LOW, adapter_name="w22_low", load_into_transformer_2=True, local_files_only=True)
            self.pipe.set_adapters(["w22_high", "w22_low"], adapter_weights=[1.0, 1.0])
            self.pipe.fuse_lora(adapter_names=["w22_high"], lora_scale=LORA22_SCALE_HIGH, components=["transformer"])
            self.pipe.fuse_lora(adapter_names=["w22_low"], lora_scale=LORA22_SCALE_LOW, components=["transformer_2"])
            self.pipe.unload_lora_weights()
            return f"wan2.2-lightx2v-1022 ({LORA22_SCALE_HIGH:g}/{LORA22_SCALE_LOW:g})"
        except Exception as e:  # incompatible key format, download failure, …
            print(f"Wan 2.2 LoRA pair could not be used ({e!r}); falling back to the Wan 2.1 LoRA.")
            try:
                self.pipe.unload_lora_weights()
            except Exception:
                pass
        self.pipe.load_lora_weights(LORA_REPO, weight_name=LORA_FILE, adapter_name="lightx2v", local_files_only=True)
        self.pipe.load_lora_weights(LORA_REPO, weight_name=LORA_FILE, adapter_name="lightx2v_2", load_into_transformer_2=True, local_files_only=True)
        self.pipe.set_adapters(["lightx2v", "lightx2v_2"], adapter_weights=[1.0, 1.0])
        self.pipe.fuse_lora(adapter_names=["lightx2v"], lora_scale=3.0, components=["transformer"])
        self.pipe.fuse_lora(adapter_names=["lightx2v_2"], lora_scale=1.0, components=["transformer_2"])
        self.pipe.unload_lora_weights()
        return "wan2.1-lightx2v (fallback, 3/1)"

    @modal.method()
    def generate(self, job_id: str, image: str, last_image: str | None, prompt: str, negative_prompt: str,
                 duration: float, steps: int, seed: int | None, max_dim: int) -> dict:
        import tempfile

        import torch
        from diffusers.utils.export_utils import export_to_video

        progress[job_id] = {"status": "running", "step": 0, "steps": int(steps), "startedAt": time.time()}
        first = decode_image(image)
        w, h = target_size(*first.size, max_dim=max_dim)
        first = first.resize((w, h))
        last = decode_image(last_image).resize((w, h)) if last_image else None
        used_seed = int(seed) if seed is not None else random.randint(0, 2**31 - 1)

        def on_step(pipe, i, t, kwargs):
            progress[job_id] = {"status": "running", "step": i + 1, "steps": int(steps)}
            return kwargs

        frames = self.pipe(
            image=first,
            last_image=last,
            prompt=prompt,
            negative_prompt=", ".join(x for x in [DEFAULT_NEGATIVE, negative_prompt] if x),
            height=h,
            width=w,
            num_frames=num_frames_for(duration),
            guidance_scale=1.0,
            guidance_scale_2=1.0,
            num_inference_steps=int(steps),
            generator=torch.Generator(device="cuda").manual_seed(used_seed),
            callback_on_step_end=on_step,
        ).frames[0]
        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            export_to_video(frames, f.name, fps=FPS, quality=VIDEO_QUALITY)
            video = open(f.name, "rb").read()
        progress[job_id] = {"status": "succeeded", "step": int(steps), "steps": int(steps)}
        return {"video": video, "seed": used_seed, "width": w, "height": h, "frames": len(frames), "fps": FPS, "lora": self.lora}


# ---------------------------------------------------------------- the HTTP API (CPU, costs ~nothing)
@app.function(image=web_image, secrets=[modal.Secret.from_name("cinematic-studio")], max_containers=2)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def api():
    import hmac

    from fastapi import FastAPI, Header, HTTPException
    from fastapi.responses import JSONResponse, Response

    web = FastAPI(title="Cinematic AI Studio — Wan on Modal", docs_url=None, redoc_url=None)
    secret = os.environ.get("STUDIO_MODAL_SECRET", "")

    def auth(authorization: str | None):
        token = (authorization or "").removeprefix("Bearer ").strip()
        if not secret or not hmac.compare_digest(token, secret):
            raise HTTPException(status_code=401, detail="Missing or wrong Authorization bearer token.")

    def call_for(job_id: str):
        try:
            return modal.FunctionCall.from_id(job_id)
        except Exception:
            raise HTTPException(status_code=404, detail="Unknown job id.")

    @web.get("/health")
    def health(authorization: str | None = Header(None)):
        auth(authorization)
        return {"ok": True, "gpu": GPU, "model": MODEL_ID, "maxContainers": 1}

    @web.post("/jobs")
    def submit(body: dict, authorization: str | None = Header(None)):
        auth(authorization)
        image = body.get("image") or ""
        if not image.startswith("data:image/"):
            raise HTTPException(400, "image must be a data URI")
        steps = int(body.get("steps") or 4)
        duration = float(body.get("duration") or 5)
        max_dim = int(body.get("max_dim") or 832)
        if not (1 <= steps <= 12 and 0.5 <= duration <= 5.0 and max_dim in (832, 1280)):
            raise HTTPException(400, "steps 1–12, duration 0.5–5 s, max_dim 832 or 1280")
        job_id = f"job-{os.urandom(8).hex()}"
        call = Wan().generate.spawn(job_id, image, body.get("last_image") or None, str(body.get("prompt") or "")[:1000],
                                    str(body.get("negative_prompt") or "")[:1000], duration, steps, body.get("seed"), max_dim)
        progress[job_id] = {"status": "queued"}
        progress[call.object_id] = {"job": job_id}
        return {"id": call.object_id}

    @web.get("/jobs/{call_id}")
    def status(call_id: str, authorization: str | None = Header(None)):
        auth(authorization)
        call = call_for(call_id)
        job_id = (progress.get(call_id) or {}).get("job")
        p = (progress.get(job_id) or {}) if job_id else {}
        try:
            out = call.get(timeout=0)
            return {"status": "succeeded", "progress": 1, "seed": out.get("seed"), "width": out.get("width"), "height": out.get("height"), "fps": out.get("fps"), "frames": out.get("frames"), "lora": out.get("lora")}
        except TimeoutError:
            if p.get("status") == "running":
                steps = p.get("steps") or 1
                return {"status": "running", "step": p.get("step", 0), "steps": steps, "progress": min(1, p.get("step", 0) / steps)}
            return {"status": "queued", "note": "Waiting for the GPU (a cold start loads the model, ~1–2 min)"}
        except modal.exception.FunctionTimeoutError:
            return {"status": "failed", "error": "The GPU job hit its 15-minute limit."}
        except Exception as e:  # cancelled, crashed, out of credits, …
            msg = str(e) or e.__class__.__name__
            if "cancel" in msg.lower():
                return {"status": "cancelled"}
            return {"status": "failed", "error": msg[:500]}

    @web.get("/jobs/{call_id}/video")
    def video(call_id: str, authorization: str | None = Header(None)):
        auth(authorization)
        try:
            out = call_for(call_id).get(timeout=0)
        except TimeoutError:
            raise HTTPException(409, "Not finished yet.")
        except Exception as e:
            raise HTTPException(410, f"No video for this job: {e}")
        return Response(content=out["video"], media_type="video/mp4", headers={"Cache-Control": "private, no-store"})

    @web.delete("/jobs/{call_id}")
    def cancel(call_id: str, authorization: str | None = Header(None)):
        auth(authorization)
        call_for(call_id).cancel()
        return {"cancelled": True}

    @web.exception_handler(HTTPException)
    def http_error(_, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    return web
