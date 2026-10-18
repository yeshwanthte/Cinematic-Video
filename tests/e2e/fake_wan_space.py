# TEST ONLY — a local Gradio app with the SAME API signature as the real
# Hugging Face Space "zerogpu-aoti/wan2-2-fp8da-aoti-faster" (Gradio 6.1).
# It speaks the genuine Gradio queue protocol (upload, queue/join, SSE status,
# tqdm progress), so the studio's HuggingFaceProvider is exercised end to end
# without GPU. The "video" is a simple zoom rendered from the input with ffmpeg.
#
# Prompt switches:  QUOTA → ZeroGPU-style quota error,  CRASH → generic error,
#                   SLOW → long run (cancel tests)
import os, subprocess, tempfile, time, random
MODE = os.environ.get("MODE", "legacy")  # legacy | fast | long | ltx
import gradio as gr
from tqdm import tqdm

FIXED_FPS = 16
MAX_DIM, MIN_DIM, SQUARE_DIM, MULTIPLE_OF = 832, 480, 640, 16
default_negative_prompt = "色调艳丽, 过曝, 静态"


def resize_dims(w, h):
    if w == h:
        return SQUARE_DIM, SQUARE_DIM
    ar = w / h
    if ar > MAX_DIM / MIN_DIM:
        tw, th = MAX_DIM, MIN_DIM
    elif ar < MIN_DIM / MAX_DIM:
        tw, th = MIN_DIM, MAX_DIM
    elif w > h:
        tw, th = MAX_DIM, int(round(MAX_DIM / ar))
    else:
        th, tw = MAX_DIM, int(round(MAX_DIM * ar))
    fw = max(MIN_DIM, min(MAX_DIM, round(tw / MULTIPLE_OF) * MULTIPLE_OF))
    fh = max(MIN_DIM, min(MAX_DIM, round(th / MULTIPLE_OF) * MULTIPLE_OF))
    return fw, fh


def generate_video(input_image, last_image, prompt, steps=4, negative_prompt=default_negative_prompt, duration_seconds=5.0,
                   guidance_scale=1, guidance_scale_2=1, seed=42, randomize_seed=False,
                   progress=gr.Progress(track_tqdm=True)):
    if input_image is None:
        raise gr.Error("Please upload an input image.")
    if "QUOTA" in (prompt or ""):
        raise gr.Error("You have exceeded your free GPU quota (51s requested vs. 12s left). Try again in 3:12:40")
    if "CRASH" in (prompt or ""):
        raise gr.Error("CUDA out of memory.")
    w, h = resize_dims(*input_image.size)
    img = input_image.convert("RGB").resize((w, h))
    tmp = tempfile.mkdtemp()
    src = os.path.join(tmp, "in.png")
    img.save(src)
    per_step = 6 if "SLOW" in (prompt or "") else 0.6
    for _ in tqdm(range(int(steps)), desc="Denoising"):
        time.sleep(per_step)
    out = os.path.join(tmp, "out.webm")
    frames = 1 + int(max(8, min(80, round(float(duration_seconds) * FIXED_FPS))))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-i", src,
                    "-vf", f"zoompan=z='1+0.0015*on':d={frames}:s={w}x{h}:fps={FIXED_FPS}",
                    "-frames:v", str(frames), "-pix_fmt", "yuv420p", "-c:v", "libvpx-vp9", "-b:v", "800k", out], check=True)
    used = random.randint(0, 2**31 - 1) if randomize_seed else int(seed)
    return out, used




def render(img_or_none, w, h, frames, fps, prompt, audio=False):
    """Renders a short zoom (or a gradient for text-to-video) with ffmpeg; optional sine-tone audio."""
    tmp = tempfile.mkdtemp()
    out = os.path.join(tmp, "out.webm")
    if img_or_none is not None:
        src = os.path.join(tmp, "in.png")
        img_or_none.convert("RGB").resize((w, h)).save(src)
        vin = ["-loop", "1", "-i", src]
        vf = f"zoompan=z='1+0.0015*on':d={frames}:s={w}x{h}:fps={fps}"
    else:
        vin = ["-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}"]
        vf = "format=yuv420p"
    ain = ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={frames / fps + 0.5}"] if audio else []
    cmd = ["ffmpeg", "-loglevel", "error", "-y", *vin, *ain, "-vf", vf, "-frames:v", str(frames), "-pix_fmt", "yuv420p",
           "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "600k"]
    if audio:
        cmd += ["-c:a", "libopus", "-shortest"]
    cmd.append(out)
    subprocess.run(cmd, check=True)
    return out


def switches(prompt):
    if "QUOTA" in (prompt or ""):
        raise gr.Error("You have exceeded your free GPU quota (75s requested vs. 12s left). Try again in 3:12:40")
    if "CRASH" in (prompt or ""):
        raise gr.Error("CUDA out of memory.")


def denoise(steps, prompt):
    per_step = 6 if "SLOW" in (prompt or "") else 0.25
    for _ in tqdm(range(int(steps)), desc="Denoising"):
        time.sleep(per_step)


if MODE == "fast":  # zerogpu-aoti/wan2-2-fp8da-aoti-faster (no last_image; ≤5 s)
    def generate_video(input_image, prompt, steps=4, negative_prompt=default_negative_prompt, duration_seconds=5.0,
                       guidance_scale=1, guidance_scale_2=1, seed=42, randomize_seed=False, progress=gr.Progress(track_tqdm=True)):
        if input_image is None:
            raise gr.Error("Please upload an input image.")
        switches(prompt)
        w, h = resize_dims(*input_image.size)
        denoise(steps, prompt)
        frames = 1 + int(max(8, min(80, round(float(duration_seconds) * FIXED_FPS))))
        used = random.randint(0, 2**31 - 1) if randomize_seed else int(seed)
        return render(input_image, w, h, frames, FIXED_FPS, prompt), used

elif MODE == "long":  # r3gm/wan2-2-fp8da-aoti-preview (last_image, ≤10 s, RIFE multiplier)
    LAST = {}
    def generate_video(input_image, last_image, prompt, steps=4, negative_prompt=default_negative_prompt, duration_seconds=10.0,
                       guidance_scale=1, guidance_scale_2=1, seed=42, randomize_seed=False, quality=5, scheduler="UniPCMultistep",
                       flow_shift=6.0, frame_multiplier=16, video_component=True, safe_mode=False, enable_safety_checker=True,
                       progress=gr.Progress(track_tqdm=True)):
        if input_image is None:
            raise gr.Error("Please upload an input image.")
        switches(prompt)
        LAST["call"] = {"last_image": last_image is not None, "steps": int(steps), "frame_multiplier": int(frame_multiplier), "flow_shift": float(flow_shift)}
        print("CALL", LAST["call"], flush=True)
        w, h = resize_dims(*input_image.size)
        denoise(steps, prompt)
        frames = 1 + int(max(8, min(160, round(float(duration_seconds) * FIXED_FPS))))
        factor = int(frame_multiplier) // 16
        fps = FIXED_FPS * factor
        out = render(input_image, w, h, (frames - 1) * factor + 1, fps, prompt)
        used = random.randint(0, 2**31 - 1) if randomize_seed else int(seed)
        return out, out, used

elif MODE == "ltx":  # Lightricks/LTX-2-3 (optional image, 24 fps, native audio)
    def generate_video(input_image, prompt: str, duration: float, enhance_prompt: bool = True, seed: int = 42,
                       randomize_seed: bool = True, height: int = 1024, width: int = 1536, progress=gr.Progress(track_tqdm=True)):
        switches(prompt)
        denoise(8, prompt)
        frames = int(float(duration) * 24) + 1
        frames = ((frames - 1 + 7) // 8) * 8 + 1
        used = random.randint(0, 2**31 - 1) if randomize_seed else int(seed)
        # keep the test fast: render at a quarter of the requested size
        return render(input_image, int(width) // 4 // 2 * 2, int(height) // 4 // 2 * 2, frames, 24, prompt, audio=True), used

with gr.Blocks() as demo:
    if MODE == "fast":
        ii = gr.Image(type="pil", label="Input Image"); pr = gr.Textbox(label="Prompt")
        st = gr.Slider(1, 30, value=6, step=1, label="Inference Steps"); ng = gr.Textbox(value=default_negative_prompt, label="Negative Prompt")
        du = gr.Slider(0.5, 5.0, value=3.5, step=0.1, label="Duration"); g1 = gr.Slider(0, 10, value=1, step=0.5, label="GS"); g2 = gr.Slider(0, 10, value=1, step=0.5, label="GS2")
        sd = gr.Slider(0, 2**31 - 1, value=42, step=1, label="Seed"); rs = gr.Checkbox(value=True, label="Randomize seed")
        vo = gr.Video(label="Generated Video", autoplay=True, interactive=False, format="webm")
        gr.Button("Generate").click(fn=generate_video, inputs=[ii, pr, st, ng, du, g1, g2, sd, rs], outputs=[vo, sd], concurrency_limit=1)
    elif MODE == "long":
        ii = gr.Image(type="pil", label="Input Image"); li = gr.Image(type="pil", label="Last Image (Optional)"); pr = gr.Textbox(label="Prompt")
        st = gr.Slider(1, 30, value=6, step=1, label="Inference Steps"); ng = gr.Textbox(value=default_negative_prompt, label="Negative Prompt")
        du = gr.Slider(0.5, 10.0, value=3.5, step=0.1, label="Duration"); g1 = gr.Slider(0, 10, value=1, step=0.5, label="GS"); g2 = gr.Slider(0, 10, value=1, step=0.5, label="GS2")
        sd = gr.Slider(0, 2**31 - 1, value=42, step=1, label="Seed"); rs = gr.Checkbox(value=True, label="Randomize seed")
        ql = gr.Slider(1, 10, value=6, step=1, label="Quality"); sc = gr.Dropdown(["UniPCMultistep", "DPM++"], value="UniPCMultistep", label="Scheduler")
        fs = gr.Slider(0.5, 15.0, value=3.0, step=0.1, label="Flow shift"); fm = gr.Dropdown([16, 32, 64, 128], value=16, label="Frame multiplier")
        pv = gr.Checkbox(value=True, label="Play result"); sm = gr.Checkbox(value=True, label="Safe mode"); sf = gr.Checkbox(value=True, label="Safety filter")
        vo = gr.Video(label="Generated Video", autoplay=True, interactive=False, format="webm"); fo = gr.File(label="Download")
        gr.Button("Generate").click(fn=generate_video, inputs=[ii, li, pr, st, ng, du, g1, g2, sd, rs, ql, sc, fs, fm, pv, sm, sf], outputs=[vo, fo, sd], concurrency_limit=1)
    elif MODE == "ltx":
        ii = gr.Image(label="Input Image (Optional)", type="pil"); pr = gr.Textbox(label="Prompt", value="Make this image come alive with cinematic motion, smooth animation")
        du = gr.Slider(1.0, 10.0, value=3.0, step=0.1, label="Duration (seconds)"); en = gr.Checkbox(label="Enhance Prompt", value=False)
        sd = gr.Slider(0, 2**31 - 1, value=10, step=1, label="Seed"); rs = gr.Checkbox(label="Randomize Seed", value=True)
        hh = gr.Number(label="Height", value=1024, precision=0); ww = gr.Number(label="Width", value=1536, precision=0)
        vo = gr.Video(label="Generated Video", autoplay=True, format="webm")
        gr.Button("Generate").click(fn=generate_video, inputs=[ii, pr, du, en, sd, rs, hh, ww], outputs=[vo, sd])
    else:
        input_image_component = gr.Image(type="pil", label="Input Image")
        last_image_component = gr.Image(type="pil", label="Last frame (optional)")
        prompt_input = gr.Textbox(label="Prompt")
        steps_slider = gr.Slider(minimum=1, maximum=30, step=1, value=6, label="Inference Steps")
        negative_prompt_input = gr.Textbox(value=default_negative_prompt, label="Negative Prompt")
        duration_seconds_input = gr.Slider(minimum=0.5, maximum=5.0, step=0.1, value=3.5, label="Duration")
        guidance_scale_input = gr.Slider(minimum=0, maximum=10, step=0.5, value=1, label="GS")
        guidance_scale_2_input = gr.Slider(minimum=0, maximum=10, step=0.5, value=1, label="GS2")
        seed_input = gr.Slider(label="Seed", minimum=0, maximum=2**31 - 1, step=1, value=42)
        randomize_seed_checkbox = gr.Checkbox(label="Randomize seed", value=True)
        generate_button = gr.Button("Generate")
        # The real Space returns H.264 MP4 (plays in Chrome/Edge/Safari). The open-source Chromium used
        # for automated tests has no H.264 decoder, so the test double asks Gradio for WebM instead.
        video_output = gr.Video(label="Generated Video", autoplay=True, interactive=False, format="webm")
        ui_inputs = [input_image_component, last_image_component, prompt_input, steps_slider, negative_prompt_input, duration_seconds_input,
                     guidance_scale_input, guidance_scale_2_input, seed_input, randomize_seed_checkbox]
        generate_button.click(fn=generate_video, inputs=ui_inputs, outputs=[video_output, seed_input], concurrency_limit=1)


if __name__ == "__main__":
    demo.queue().launch(server_name="127.0.0.1", server_port=int(os.environ.get("PORT", "7861")))
