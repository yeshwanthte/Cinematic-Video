# TEST ONLY — local Gradio apps with the SAME API signatures as the real image Spaces:
#   MODE=qwen     → linoyts/Qwen-Image-Edit-2511-Fast   infer(images[Gallery], prompt, seed, randomize_seed,
#                                                         true_guidance_scale, num_inference_steps, height, width, rewrite_prompt)
#   MODE=kontext  → black-forest-labs/FLUX.1-Kontext-Dev infer(input_image, prompt, seed, randomize_seed, guidance_scale, steps)
#   MODE=schnell  → black-forest-labs/FLUX.1-schnell     infer(prompt, seed, randomize_seed, width, height, num_inference_steps)
# Real Gradio protocol (upload, queue, tqdm progress); the "edit" is a visible colour grade.
import os, time, random
import gradio as gr
from PIL import Image, ImageDraw, ImageOps
from tqdm import tqdm

MODE = os.environ.get("MODE", "qwen")
MAX_SEED = 2**31 - 1
FLAKY = {"n": 0}


def fake_edit(img, prompt, steps):
    if "QUOTA" in (prompt or ""):
        raise gr.Error("You have exceeded your free GPU quota (20s requested vs. 3s left). Try again in 1:02:03")
    if "CRASH" in (prompt or ""):
        raise gr.Error("CUDA out of memory.")
    if "FLAKY" in (prompt or "") and FLAKY["n"] == 0:
        FLAKY["n"] += 1
        raise gr.Error("RuntimeError")  # ZeroGPU surfaces crashed workers as a bare "RuntimeError"
    if "BROKEN" in (prompt or ""):
        raise gr.Error("RuntimeError")
    for _ in tqdm(range(int(steps)), desc="Denoising"):
        time.sleep(0.4)
    out = ImageOps.autocontrast(img.convert("RGB"))
    tint = Image.new("RGB", out.size, (255, 180, 90))
    return Image.blend(out, tint, 0.18)


def fake_create(prompt, w, h, steps):
    for _ in tqdm(range(int(steps)), desc="Denoising"):
        time.sleep(0.3)
    im = Image.new("RGB", (int(w), int(h)), (30, 40, 70))
    d = ImageDraw.Draw(im)
    for i in range(0, int(h), 8):
        d.line([(0, i), (int(w), i)], fill=(30 + i % 120, 60, 120))
    d.text((20, 20), (prompt or "")[:60], fill=(255, 255, 255))
    return im


with gr.Blocks() as demo:
    if MODE == "qwen":
        def infer(images, prompt, seed=42, randomize_seed=False, true_guidance_scale=1.0, num_inference_steps=4,
                  height=None, width=None, rewrite_prompt=True, num_images_per_prompt=1, progress=gr.Progress(track_tqdm=True)):
            if not images:
                raise gr.Error("Please upload at least one image.")
            first = images[0][0] if isinstance(images[0], (list, tuple)) else images[0]
            if isinstance(first, str):
                first = Image.open(first)
            used = random.randint(0, MAX_SEED) if randomize_seed else int(seed)
            return [fake_edit(first, prompt, num_inference_steps)], used, gr.Button(visible=True)

        input_images = gr.Gallery(label="Input Images", type="pil", interactive=True)
        prompt = gr.Textbox(label="Prompt")
        seed = gr.Slider(0, MAX_SEED, value=0, step=1, label="Seed")
        randomize_seed = gr.Checkbox(value=True, label="Randomize seed")
        true_guidance_scale = gr.Slider(1.0, 10.0, value=1.0, step=0.1, label="True guidance scale")
        num_inference_steps = gr.Slider(1, 40, value=4, step=1, label="Steps")
        height = gr.Slider(256, 2048, value=None, step=8, label="Height")
        width = gr.Slider(256, 2048, value=None, step=8, label="Width")
        rewrite_prompt = gr.Checkbox(value=True, label="Rewrite prompt")
        result = gr.Gallery(label="Result")
        use_output_btn = gr.Button("Use as input", visible=False)
        run = gr.Button("Edit!")
        run.click(infer, [input_images, prompt, seed, randomize_seed, true_guidance_scale, num_inference_steps, height, width, rewrite_prompt],
                  [result, seed, use_output_btn], concurrency_limit=1)
    elif MODE == "qwen1":  # multimodalart/Qwen-Image-Edit-Fast: single gr.Image input
        def infer(image, prompt, seed=42, randomize_seed=False, true_guidance_scale=1.0, num_inference_steps=8, rewrite_prompt=True, progress=gr.Progress(track_tqdm=True)):
            used = random.randint(0, MAX_SEED) if randomize_seed else int(seed)
            return fake_edit(image, prompt, num_inference_steps), used

        input_image = gr.Image(label="Input Image", type="pil")
        prompt = gr.Textbox(label="Prompt")
        seed = gr.Slider(0, MAX_SEED, value=0, step=1, label="Seed")
        randomize_seed = gr.Checkbox(value=True, label="Randomize seed")
        true_guidance_scale = gr.Slider(1.0, 10.0, value=1.0, step=0.1, label="True guidance scale")
        num_inference_steps = gr.Slider(1, 40, value=8, step=1, label="Steps")
        rewrite_prompt = gr.Checkbox(value=True, label="Rewrite prompt")
        result = gr.Image(label="Result")
        run = gr.Button("Edit!")
        run.click(infer, [input_image, prompt, seed, randomize_seed, true_guidance_scale, num_inference_steps, rewrite_prompt], [result, seed], concurrency_limit=1)
    elif MODE == "kontext":
        def infer(input_image, prompt, seed=42, randomize_seed=False, guidance_scale=2.5, steps=28, progress=gr.Progress(track_tqdm=True)):
            used = random.randint(0, MAX_SEED) if randomize_seed else int(seed)
            img = fake_edit(input_image, prompt, 6) if input_image is not None else fake_create(prompt, 1024, 1024, 6)
            return img, used, gr.Button(visible=True)

        input_image = gr.Image(label="Upload the image for editing", type="pil")
        prompt = gr.Textbox(label="Prompt")
        seed = gr.Slider(0, MAX_SEED, value=0, step=1, label="Seed")
        randomize_seed = gr.Checkbox(value=True, label="Randomize seed")
        guidance_scale = gr.Slider(1, 10, value=2.5, step=0.1, label="Guidance")
        steps = gr.Slider(1, 30, value=28, step=1, label="Steps")
        result = gr.Image(label="Result")
        reuse = gr.Button("Reuse", visible=False)
        run = gr.Button("Run")
        run.click(infer, [input_image, prompt, seed, randomize_seed, guidance_scale, steps], [result, seed, reuse], concurrency_limit=1)
    else:
        def infer(prompt, seed=42, randomize_seed=False, width=1024, height=1024, num_inference_steps=4, progress=gr.Progress(track_tqdm=True)):
            used = random.randint(0, MAX_SEED) if randomize_seed else int(seed)
            return fake_create(prompt, width, height, num_inference_steps), used

        prompt = gr.Textbox(label="Prompt")
        seed = gr.Slider(0, MAX_SEED, value=0, step=1, label="Seed")
        randomize_seed = gr.Checkbox(value=True, label="Randomize seed")
        width = gr.Slider(256, 2048, value=1024, step=32, label="Width")
        height = gr.Slider(256, 2048, value=1024, step=32, label="Height")
        num_inference_steps = gr.Slider(1, 50, value=4, step=1, label="Steps")
        result = gr.Image(label="Result")
        run = gr.Button("Run")
        run.click(infer, [prompt, seed, randomize_seed, width, height, num_inference_steps], [result, seed], concurrency_limit=1)

if __name__ == "__main__":
    demo.queue().launch(server_name="127.0.0.1", server_port=int(os.environ.get("PORT", "7871")))
