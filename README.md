# Cinematic AI Studio

**Bring Your Photos to Life.** Cinematic AI Studio turns a photo into a moving scene using a real AI image-to-video model. It runs **free** by default.

| | Free (default) | Paid (optional) |
|---|---|---|
| Video model | **Wan 2.2 14B Fast** (open-source) on a Hugging Face ZeroGPU Space | Runway Gen-4.5, Gen-4 Turbo, Veo 3.1 / 3.1 Fast |
| What you need | A free Hugging Face account and token | A Runway API key and credits |
| Limits | ≈5 min of GPU per day on a free account (≈5 clips of 5 s, or ≈10 of 3 s). Resets 24 h after first use | Pay per second |
| Output | 480p, 16 fps, 1–5 s (a community model goes up to 10 s) | 720p–1080p, up to 10 s |
| AI photo analysis + Enhance Prompt | Hugging Face's free monthly credits. The built-in engine takes over when they run out | Claude (optional) |
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
api/*.js              Vercel Functions (thin wrappers)
server/models.js      the only place model capabilities, limits and pricing are defined
server/core/          router (streams + JSON), validation, errors, AI assistant
server/providers/     VideoProvider (abstract) · HuggingFaceProvider (free) · RunwayProvider (paid)
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

## 4. Optional extras

- **GitHub Pages frontend:** in `frontend/config.js`, set `apiBase: 'https://<project>.vercel.app'`. In the repo go to Settings → Pages → Source: **GitHub Actions** (the workflow is included). In Vercel, add `ALLOWED_ORIGINS=https://<user>.github.io` and redeploy.
- **Run locally:** install Node 20+, run `cp .env.example .env`, add `HF_TOKEN`, then `npm install` and `npm run dev`, and open http://localhost:8787.
- **More free GPU:** a Hugging Face PRO plan (paid) gives ≈40 min/day. You can also run your own copy of the Space and point to it with `HF_SPACE_OVERRIDES={"wan2.2-fast":"you/your-space"}`.
- **Turn off the AI assistant** (to keep your free monthly credits): `HF_ASSISTANT=off`.
- **Premium paid models:** add `RUNWAY_API_KEY`. Runway Gen-4.5, Gen-4 Turbo and Veo 3.1 then appear under "Paid" in the model list.

## 5. Security

- `HF_TOKEN`, `RUNWAY_API_KEY` and `ANTHROPIC_API_KEY` exist only as server environment variables. They're never in the frontend, localStorage, git, or any browser request. `/api/health` only reports `configured: true/false`.
- `STUDIO_ACCESS_CODE` protects your free quota and any paid credits.
- The download proxy only fetches files hosted on `*.hf.space` (or on Runway's own task record), so it can't be used for SSRF.
- Uploads are checked by type, magic bytes and size.

## 6. Honest limits

| Feature | Status |
|---|---|
| Free generation, live Space progress, cancel, variations, Story Mode scenes, projects, download | ✅ |
| Free output: 480p, 16 fps, ≤5 s (≤10 s on the community model). 720p/1080p and 15 s are not possible for free | as stated |
| Free daily limit: when it runs out you see *"Your free daily GPU allowance is used up"* with the time until it resets | ✅ |
| Public Spaces can be busy, restarting or renamed. You get a clear "Space unavailable" error, and the Space can be switched with `HF_SPACE_OVERRIDES` | known risk |
| Reloading the page during a free generation stops it (the connection closes). The studio marks it *interrupted* | by design |
| Stitching Story Mode clips into one video | ❌ not implemented (`/api/render` returns 501) |
| Audio | ❌ free models are silent. Native audio only on paid Veo 3.1 |

## 7. Adding providers

Extend `VideoProvider` (`server/providers/`). A polled provider implements `generate` / `getStatus` / `cancel`, like Runway. A streamed provider implements `generateStream` and sets `mode = 'stream'`, like Hugging Face. Register it in `providers/index.js`, add its models to `server/models.js`, and run `npm run sync-config`. The UI builds itself from that configuration.

## 8. Testing performed

- `npm test`: 10 unit tests covering validation for both providers, the free provider being the default, the SSRF guard, CORS, the access code, that secrets never leak, the Runway request contract, and the error mapping.
- `npm run test:e2e`: 50 browser checks. The free path runs against a **real Gradio 6.1 app with the Wan Space's exact API signature** (upload, queue, streamed step progress, quota error, crash, cancel). The paid path runs against a Runway contract double. Also covered: projects persisting across reloads, mobile/tablet layouts, and GitHub Pages hosting.
- **Not done here:** a call to the live public Space, because the build environment can't reach huggingface.co. The integration uses the official `@gradio/client` and the Space's published code. Your first generation (step 14) is that final check.
