# Cinematic AI Studio

**Bring Your Photos to Life.** Cinematic AI Studio turns a photo into a moving scene using a real AI image-to-video model. It runs **free** by default.

| | Free (default) | Paid (optional) |
|---|---|---|
| Video models | **Wan 2.2 14B Fast** (≤5 s) · **Wan 2.2 Director** (≤10 s, first + last frame, RIFE 32 fps) · **LTX-2.3 Distilled** (≤10 s, text **or** photo → video, 24 fps, native AI audio) — all on Hugging Face ZeroGPU Spaces | Runway Gen-4.5, Gen-4 Turbo, Veo 3.1 / 3.1 Fast |
| Longer videos | **Film Studio**: 10–30 s films assembled from real AI shots; each shot can start from the previous shot's real last frame | same workflow |
| Second free option | **Your own Wan 2.2 on Modal** — US$30 of free compute every month, no daily cap, 480p/720p, end frame (optional; needs a card on file, spend limit $0) | — |
| What you need | A free Hugging Face account and token | A Runway API key and credits |
| Limits | 5 min of ZeroGPU per day on a free account, 40 min on PRO (HF docs, checked Oct 2026). A 10 s Wan clip reserves ≈1–1.5 min, an LTX clip 75 s | Pay per second |
| Output | Wan: 480p, 16 fps (32 fps with RIFE). LTX: up to 1536×1024, 24 fps, with audio | 720p–1080p, up to 10 s |
| Prompt enhancer + photo analysis | Built into the browser, free. The hosted AI assistant is **opt-in** (`HF_ASSISTANT=on`) because free HF accounts no longer include Inference Provider credits | Claude (optional) |
| Assembly / export | ffmpeg.wasm in the browser: crossfades, music, fades, resize, fps, H.264/AAC MP4 | same |
| Hosting | Vercel Hobby (free) and/or GitHub Pages (free) | same |

Nothing is simulated. The studio only says "Video generated" once the model has actually returned a video and your browser has loaded it. Progress is the real step counter streamed from the Space (for example "Denoising step 3 of 4"), or Runway's own `progress` value. Errors show the provider's real message.

---

## 1. How it works

```
Browser ──► your backend (Vercel) ──► Hugging Face Space (Wan 2.2) ──► video
   ▲           holds HF_TOKEN            free ZeroGPU                   │
   └──────── live status stream ◄────────────────────────────────────────┘
             video is saved in the browser (IndexedDB) so it never expires
```

- A Gradio job on a Hugging Face Space only lives as long as the connection to it stays open. So the backend keeps one streaming request open per generation and forwards queue position, GPU start and step progress to the browser live, as NDJSON. If you cancel or close the tab, the job stops.
- Space output files are temporary, so the finished video is copied into your browser's storage straight away. Projects replay it even weeks later.
- On Vercel Hobby a function can run for up to **300 s**, which covers queue time plus generation. If the Space's queue is very long you'll get an honest "stream closed" message. Try again, or use a shorter clip.

## 2. Project layout

```
frontend/             static site (index.html, styles.css, app.js, js/*)  → Vercel or GitHub Pages
frontend/js/film-studio.js     Film Studio (shot plan, timeline, chained shots, export)
frontend/js/shot-planner.js    deterministic shot planner + continuity prompts (no paid LLM)
frontend/js/assembler*.js      ffmpeg.wasm assembly (graph builder is pure + unit-tested)
frontend/vendor/ffmpeg/        @ffmpeg/ffmpeg 0.12.15 + @ffmpeg/util 0.12.2 (MIT); the GPL core loads from jsDelivr
api/*.js              Vercel Functions (thin wrappers)
server/models.js      the only place model capabilities, limits and pricing are defined
server/core/          router (streams + JSON), validation, errors, AI assistant
server/providers/     VideoProvider (abstract) · HuggingFaceProvider (free) · ModalProvider (free credits) · RunwayProvider (paid)
modal/wan_app.py      your own Wan 2.2 GPU server on Modal (deployed by .github/workflows/deploy-modal.yml)
dev-server.js         local server: frontend + API
tests/                unit tests + full browser e2e (with a real Gradio test Space and a Runway test double)
```

---

## 3. Setup, step by step (all free)

### A. Create your free Hugging Face token (3 min)
1. Sign up at **https://huggingface.co/join** and confirm your email.
2. Open **https://huggingface.co/settings/tokens**, click **Create new token**, and choose token type **Read**. Name it `cinematic-studio`, then click **Create**.
3. Copy the token. It starts with `hf_…`. Keep it private.

### B. Put the code on GitHub (5 min)
4. Unzip the project and create a new repository on **github.com** (Private is fine).
5. Click **"uploading an existing file"** and drag in **the contents** of the `cinematic-ai-studio` folder, not the folder itself. Then **Commit changes**. The top level of the repo must show `api`, `frontend`, `server`, `package.json` and `vercel.json`.
   *Don't upload `node_modules` if you ran `npm install` locally. Vercel installs dependencies itself.*

### C. Deploy on Vercel Hobby (5 min)
6. **https://vercel.com** → **Sign up with GitHub** → **Add New → Project** → import your repo.
7. For **Framework Preset** choose **Other**. Leave the build settings alone.
8. Add these **Environment Variables**:
   | Name | Value |
   |---|---|
   | `HF_TOKEN` | your `hf_…` token |
   | `STUDIO_ACCESS_CODE` | a private password you make up. It stops strangers using up your daily GPU |
9. Click **Deploy**. You get `https://<project>.vercel.app`.

### D. Check it (2 min)
10. Open `https://<project>.vercel.app/api/health`. You should see `"huggingface":{"configured":true…}`.
11. Open `https://<project>.vercel.app` → **Settings**. Leave the API endpoint **blank**, enter your access code, and click **Save & test connection**. The pill at the top should say **"Hugging Face connected · @your-name · Free"**.

### E. Your first free video
12. In **Studio**, upload a photo and accept the analysis (or correct the photo type), then pick a style and a camera move.
13. The model **Wan 2.2 14B Fast · Free** is already selected. Choose **3 sec** to save GPU. The cost line shows *Free · reserves ≈ 29 s of your ≈300 s daily GPU*.
14. Click **Generate Video**. The steps show the real queue position, then *Denoising step 1…4 of 4*. It usually takes about 30–90 s plus any queue time.
15. Play it, try the before/after slider, download it, make variations.

---

---

## Image Studio (free)

Edit a photo from a written instruction, or create a new image from text. It runs on the same free Hugging Face token and daily GPU allowance as the video models.

| Model | What it's for | Space |
|---|---|---|
| **Qwen Image Edit 2511 · Free** (default) | Edits that keep the same person (background, outfit, lighting, restoration). Accepts up to 3 reference photos | `linoyts/Qwen-Image-Edit-2511-Fast` (4-step) |
| **FLUX.1 Kontext [dev] · Free** | High-quality single-photo edits and text-to-image. Uses more GPU | `black-forest-labs/FLUX.1-Kontext-Dev` |
| **FLUX.1 [schnell] · Free** | Fast text-to-image, 6 aspect ratios up to 1344 px | `black-forest-labs/FLUX.1-schnell` |

**Features:**
- 12 quick-edit presets and 6 create presets
- **"Keep exactly the same" locks**: face and identity, skin tone, hair, expression, pose, framing (plus clothing, background and lighting). Each lock is written into the prompt as an explicit preservation instruction.
- Enhance Prompt, using the AI assistant or the built-in rewrite
- Before/after slider
- Download as PNG
- **Keep editing this**, to chain several edits
- **Animate in Video Studio →**, which sends the result straight to the video generator
- Seed control and a history saved in your browser

**What to expect:** these open models are among the best available for keeping identity, and the locks tell them exactly what must not change. Still, **no model can guarantee a perfect match every time.** Always check with the before/after slider. If a face drifts, click **New variation** (it uses a new seed) or make the instruction more specific.

## Film Studio (10–30 s, free)

1. **Film** in the top bar → add the photo the film starts from (or choose **Text only**).
2. Type the idea, pick a preset (travel, portrait, product, nature, architecture, lifestyle, storytelling), a length (single shot, 10, 15, 20, 30 s), motion and model.
3. **Plan shots** builds an editable plan. Every shot is a native clip the model really supports (e.g. 20 s on Wan Director = 2 × 10 s). The continuity bible (subject, wardrobe, setting, lighting, look) is added to every prompt.
4. **Approve plan & generate shots.** Shot 1 starts from your photo; each "continue" shot starts from the **real last frame** of the shot before it, so the film reads as one take. Regenerate any single shot; shots that continued from it are flagged so you can refresh them.
5. **Export MP4**: crossfade / dip to black / cut, optional music (volume, fades), keep LTX's AI audio, resize to 720p/1080p, change fps (optionally with motion interpolation). The export summary states exactly what is AI-generated and what is post-processing.

What it is not: a single 30 s AI generation. No free model generates 30 s natively. The timeline always shows native clip length vs assembled length.

## Free extra GPU with Modal (optional)

Hugging Face gives 5 GPU-minutes a day. Modal's Starter plan gives **US$30 of compute every month**, which runs the same open Wan 2.2 14B model on your own GPU: no shared queue, no daily cap, 480p or **720p**, and an optional end frame. A clip costs roughly US$0.08–0.45 of those credits (warm vs. cold start; estimate), so about 70–250 clips a month.

**Is it really free?** Modal asks for a payment method on file. Set the workspace **spend limit to $0** (Modal → Settings → Usage & Billing) and Modal stops work instead of billing you once the monthly credits are used. The app also never runs more than one GPU at a time.

1. Sign up at [modal.com](https://modal.com), add a payment method, and set the spend limit to **$0**.
2. Modal → Settings → **API Tokens** → New token. Copy the token id and secret.
3. GitHub repo → Settings → Secrets and variables → Actions → add `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and `STUDIO_MODAL_SECRET` (a long random password you make up).
4. GitHub → **Actions → "Deploy video server to Modal" → Run workflow** (keep "Download the model weights" ticked the first time; it takes 20–40 min).
5. Open the finished run: its summary shows `MODAL_ENDPOINT_URL`. In Vercel add `MODAL_ENDPOINT_URL` and `MODAL_API_SECRET` (= your `STUDIO_MODAL_SECRET`), then redeploy.
6. In the Studio pick **Wan 2.2 14B · Your Modal GPU**. Settings → Save & test connection shows "Reachable · … on H200".

The first video after a quiet period waits ~1–3 min while the GPU starts and loads the model; following clips (e.g. Film Studio shots) reuse the warm GPU.

## 4. Optional extras

- **GitHub Pages frontend:** in `frontend/config.js`, set `apiBase: 'https://<project>.vercel.app'`. In the repo go to Settings → Pages → Source: **GitHub Actions** (the workflow is included). In Vercel, add `ALLOWED_ORIGINS=https://<user>.github.io` and redeploy.
- **Run locally:** install Node 20+, run `cp .env.example .env`, add `HF_TOKEN`, then `npm install` and `npm run dev`, and open http://localhost:8787.
- **More free GPU:** a Hugging Face PRO plan (paid) gives 40 min/day. You can also run your own copy of a Space and point to it with `HF_SPACE_OVERRIDES={"wan2.2-fast":"you/your-space"}`.
- **Hosted AI assistant (opt-in, may cost money):** `HF_ASSISTANT=on` sends photo analysis / prompt enhancement to Hugging Face Inference Providers. Free accounts have no included credits; PRO includes US$2/month; usage beyond that is billed to your HF account.
- **Self-host the ffmpeg core:** set `ffmpegCoreBase` in `frontend/config.js` to a folder containing `ffmpeg-core.js` and `ffmpeg-core.wasm` from `@ffmpeg/core@0.12.10`.
- **Premium paid models:** add `RUNWAY_API_KEY`. Runway Gen-4.5, Gen-4 Turbo and Veo 3.1 then appear under "Paid" in the model list.

## 5. Security

- `HF_TOKEN`, `RUNWAY_API_KEY` and `ANTHROPIC_API_KEY` exist only as server environment variables. They're never in the frontend, localStorage, git, or any browser request. `/api/health` only reports `configured: true/false`.
- `STUDIO_ACCESS_CODE` protects your free quota and any paid credits.
- Every generation carries a unique `X-Request-Id`; the same id is refused (409), so a double click or network retry can never spend GPU twice. Per-IP limits: `MAX_CONCURRENT_JOBS` (default 3) and `RATE_LIMIT_PER_HOUR` (default 30). These live in memory, so on Vercel they are per warm instance — a guard against accidents and loops; the access code is the real gate.
- The download proxy only fetches files hosted on `*.hf.space` (or on Runway's own task record), so it can't be used for SSRF.
- Uploads are checked by type, magic bytes and size. Videos, music and exported films stay in the browser (IndexedDB); nothing large passes through a Vercel function except the streamed clip itself.

## 6. Honest limits

| Feature | Status |
|---|---|
| Free generation, live Space progress, cancel, variations, Story Mode, Film Studio, projects, download | ✅ |
| Native clip length: Wan Fast ≤5 s, Wan Director ≤10 s, LTX-2.3 ≤10 s. 10–30 s films are **assembled** from shots | as stated |
| Identity: Wan 2.2 keeps faces best; LTX-2.3 is sharper/faster but can drift on faces in photo→video. No model guarantees identity | known |
| Free daily limit (5 min GPU): a 30 s film can need most of it. The plan shows the GPU estimate before you start | ✅ |
| Public Spaces can be busy, restarting or renamed. You get a clear "Space unavailable" error, and the Space can be switched with `HF_SPACE_OVERRIDES` | known risk |
| Reloading the page during a free generation stops it (the connection closes). The studio marks it *interrupted* | by design |
| Resize to 720p/1080p and fps changes are post-processing; they add no AI detail. Motion interpolation synthesizes frames | labelled in the export |
| Modal provider | Code checked and the HTTP contract tested against a local double; **not yet run on a real Modal GPU** (no Modal account here). Speed and cost per clip are estimates | first run is yours |
| Audio | LTX-2.3 native AI audio (free) · your uploaded music · Wan is silent · no AI voiceover/SFX |
| LTX-2.3 license | LTX-2 Community License: free under US$10M annual revenue; outputs must be disclosed as AI-generated. Wan 2.2 is Apache-2.0 |

## 7. Adding providers

Extend `VideoProvider` (`server/providers/`). A polled provider implements `generate` / `getStatus` / `cancel`, like Runway. A streamed provider implements `generateStream` and sets `mode = 'stream'`, like Hugging Face. Register it in `providers/index.js`, add its models to `server/models.js`, and run `npm run sync-config`. The UI builds itself from that configuration.

## 8. Testing performed

- `npm test`: 18 unit tests — validation for every model (text-to-video, end frame, fps, quality), the exact parameter names sent to each Space, duplicate-request and rate limits, the assistant being opt-in, the shot planner, and the FFmpeg graph (crossfade offsets, dropped duplicate frame, audio mix), plus the original security tests.
- `npm run test:e2e`: three browser suites against **real Gradio apps with each Space's exact API signature** (Wan Fast, Wan Director, LTX-2.3, image Spaces) and a Runway contract double. The film suite plans, generates and chains shots, exports with real ffmpeg.wasm and checks the MP4 with ffprobe (H.264 + AAC, size, fps, duration).
- **Not done here:** calls to the live public Spaces, because the build environment can't reach huggingface.co. Your first generation after deploying is that final check.
