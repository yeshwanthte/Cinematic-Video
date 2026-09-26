// Single source of truth for model capabilities. Sourced from the Runway API reference,
// @runwayml/sdk 4.20 types and docs.dev.runwayml.com/guides/pricing (checked 2026-09-26).
// Edit here, then run `npm run sync-config` to refresh frontend/models.json (offline copy).
const MODELS = {
  "defaultProvider": "huggingface",
  "defaultModel": "wan2.2-fast",
  "providers": {
    "huggingface": {
      "label": "Hugging Face (free)",
      "free": true,
      "mode": "stream",
      "docs": "https://huggingface.co/docs/hub/en/spaces-zerogpu",
      "pricingSource": "https://huggingface.co/docs/hub/en/spaces-zerogpu",
      "quota": { "freeSecondsPerDay": 300, "proSecondsPerDay": 2400, "note": "ZeroGPU daily allowance per Hugging Face account (free ≈5 min, PRO ≈40 min). Resets 24 h after first use." },
      "models": {
        "wan2.2-fast": {
          "label": "Wan 2.2 14B Fast · Free",
          "quality": "Open-source · 480p · runs on free ZeroGPU",
          "description": "Alibaba's open Wan 2.2 image-to-video model (14B, Lightning 4-step) on the Hugging Face Space zerogpu-aoti/wan2-2-fp8da-aoti-faster. Free with a Hugging Face account; limited by your daily GPU allowance.",
          "space": "zerogpu-aoti/wan2-2-fp8da-aoti-faster",
          "endpoint": "/generate_video",
          "params": { "steps": 4, "baseNegative": "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 最差质量, 低质量, JPEG压缩残留, 畸形的, 多余的手指, 静止不动的画面" },
          "durations": { "min": 1, "max": 5, "presets": [3, 5] },
          "ratios": [
            { "value": "832:480", "aspect": "16:9", "resolution": "480p" },
            { "value": "480:832", "aspect": "9:16", "resolution": "480p" },
            { "value": "640:640", "aspect": "1:1", "resolution": "480p" },
            { "value": "672:832", "aspect": "4:5", "resolution": "480p" },
            { "value": "832:624", "aspect": "4:3", "resolution": "480p" },
            { "value": "624:832", "aspect": "3:4", "resolution": "480p" }
          ],
          "fps": 16,
          "promptRequired": false,
          "promptMaxChars": 1000,
          "negativePrompt": true,
          "audio": false,
          "seed": true,
          "inputAspectRange": null,
          "creditsPerSecond": null,
          "free": true,
          "gpuEstimate": { "base": 10, "stepSeconds": 15, "steps": 4, "baseVolume": 42052608, "fps": 16, "minFrames": 8, "maxFrames": 80 },
          "creditsNote": "Free. Each video reserves GPU time from your daily ZeroGPU allowance (formula published in the Space's code)."
        },
        "wan2.2-long": {
          "label": "Wan 2.2 Extended · Free (community)",
          "quality": "Open-source · 480p · up to 10 s",
          "description": "Community Wan 2.2 Space r3gm/wan2-2-fp8da-aoti-preview with longer clips (up to 10 s). Uses much more of your daily GPU allowance; community Spaces can change without notice.",
          "space": "r3gm/wan2-2-fp8da-aoti-preview",
          "endpoint": "/generate_video",
          "params": { "steps": 4 },
          "durations": { "min": 1, "max": 10, "presets": [5, 8, 10] },
          "ratios": [
            { "value": "832:480", "aspect": "16:9", "resolution": "480p" },
            { "value": "480:832", "aspect": "9:16", "resolution": "480p" },
            { "value": "640:640", "aspect": "1:1", "resolution": "480p" },
            { "value": "672:832", "aspect": "4:5", "resolution": "480p" },
            { "value": "832:624", "aspect": "4:3", "resolution": "480p" },
            { "value": "624:832", "aspect": "3:4", "resolution": "480p" }
          ],
          "fps": 16,
          "promptRequired": false,
          "promptMaxChars": 1000,
          "negativePrompt": true,
          "audio": false,
          "seed": true,
          "inputAspectRange": null,
          "creditsPerSecond": null,
          "free": true,
          "gpuEstimate": null,
          "creditsNote": "Free, but long clips can use most or all of a free account's daily GPU allowance in one run."
        }
      }
    },
    "runway": {
      "label": "Runway",
      "docs": "https://docs.dev.runwayml.com/api/",
      "pricingSource": "https://docs.dev.runwayml.com/guides/pricing/",
      "creditUsd": 0.01,
      "pollIntervalMs": 5000,
      "models": {
        "gen4.5": {
          "label": "Runway Gen-4.5",
          "quality": "Flagship \u00b7 highest motion fidelity",
          "description": "Runway's most capable image-to-video model. Best realism, physics and prompt adherence.",
          "durations": {
            "min": 2,
            "max": 10,
            "presets": [
              5,
              8,
              10
            ]
          },
          "ratios": [
            {
              "value": "1280:720",
              "aspect": "16:9",
              "resolution": "720p"
            },
            {
              "value": "720:1280",
              "aspect": "9:16",
              "resolution": "720p"
            },
            {
              "value": "960:960",
              "aspect": "1:1",
              "resolution": "720p"
            },
            {
              "value": "832:1104",
              "aspect": "3:4",
              "resolution": "720p"
            },
            {
              "value": "1104:832",
              "aspect": "4:3",
              "resolution": "720p"
            },
            {
              "value": "1584:672",
              "aspect": "21:9",
              "resolution": "720p"
            }
          ],
          "promptRequired": true,
          "promptMaxChars": 1000,
          "negativePrompt": false,
          "audio": false,
          "seed": true,
          "inputAspectRange": [
            0.5,
            2.0
          ],
          "creditsPerSecond": 12
        },
        "gen4_turbo": {
          "label": "Runway Gen-4 Turbo",
          "quality": "Fast \u00b7 lower cost",
          "description": "Quicker, cheaper drafts. Good for exploring motion ideas before a Gen-4.5 final.",
          "durations": {
            "min": 2,
            "max": 10,
            "presets": [
              5,
              8,
              10
            ]
          },
          "ratios": [
            {
              "value": "1280:720",
              "aspect": "16:9",
              "resolution": "720p"
            },
            {
              "value": "720:1280",
              "aspect": "9:16",
              "resolution": "720p"
            },
            {
              "value": "960:960",
              "aspect": "1:1",
              "resolution": "720p"
            },
            {
              "value": "832:1104",
              "aspect": "3:4",
              "resolution": "720p"
            },
            {
              "value": "1104:832",
              "aspect": "4:3",
              "resolution": "720p"
            },
            {
              "value": "1584:672",
              "aspect": "21:9",
              "resolution": "720p"
            }
          ],
          "promptRequired": false,
          "promptMaxChars": 1000,
          "negativePrompt": false,
          "audio": false,
          "seed": true,
          "inputAspectRange": [
            0.5,
            2.0
          ],
          "creditsPerSecond": 5
        },
        "veo3.1_fast": {
          "label": "Google Veo 3.1 Fast (via Runway)",
          "quality": "1080p \u00b7 native negative prompt",
          "description": "Google Veo 3.1 Fast served through the Runway API. Supports 1080p, negative prompts and optional native audio.",
          "durations": {
            "exact": [
              4,
              6,
              8
            ],
            "presets": [
              4,
              6,
              8
            ]
          },
          "ratios": [
            {
              "value": "1280:720",
              "aspect": "16:9",
              "resolution": "720p"
            },
            {
              "value": "720:1280",
              "aspect": "9:16",
              "resolution": "720p"
            },
            {
              "value": "1920:1080",
              "aspect": "16:9",
              "resolution": "1080p"
            },
            {
              "value": "1080:1920",
              "aspect": "9:16",
              "resolution": "1080p"
            }
          ],
          "promptRequired": false,
          "promptMaxChars": 1000,
          "negativePrompt": true,
          "audio": true,
          "seed": true,
          "inputAspectRange": null,
          "creditsPerSecond": 10,
          "creditsNote": "10 credits/sec without audio + 1 credit for the first-frame image. Audio pricing: see Runway pricing page."
        },
        "veo3.1": {
          "label": "Google Veo 3.1 (via Runway)",
          "quality": "Premium \u00b7 1080p \u00b7 native audio",
          "description": "Google Veo 3.1 served through the Runway API. Supports 1080p, negative prompts and native audio.",
          "durations": {
            "exact": [
              4,
              6,
              8
            ],
            "presets": [
              4,
              6,
              8
            ]
          },
          "ratios": [
            {
              "value": "1280:720",
              "aspect": "16:9",
              "resolution": "720p"
            },
            {
              "value": "720:1280",
              "aspect": "9:16",
              "resolution": "720p"
            },
            {
              "value": "1920:1080",
              "aspect": "16:9",
              "resolution": "1080p"
            },
            {
              "value": "1080:1920",
              "aspect": "9:16",
              "resolution": "1080p"
            }
          ],
          "promptRequired": false,
          "promptMaxChars": 1000,
          "negativePrompt": true,
          "audio": true,
          "seed": true,
          "inputAspectRange": null,
          "creditsPerSecond": null,
          "creditsNote": "Runway lists 40 credits/sec with audio. The exact estimate is returned by Runway when the task is created."
        }
      }
    }
  },
  "limits": {
    "maxImageDataUriBytes": 4000000,
    "acceptedMime": [
      "image/jpeg",
      "image/png",
      "image/webp"
    ]
  }
};

export default MODELS;
