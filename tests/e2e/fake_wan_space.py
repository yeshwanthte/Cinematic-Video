# TEST ONLY — a local Gradio app with the SAME API signature as the real
# Hugging Face Space "zerogpu-aoti/wan2-2-fp8da-aoti-faster" (Gradio 6.1).
# It speaks the genuine Gradio queue protocol (upload, queue/join, SSE status,
# tqdm progress), so the studio's HuggingFaceProvider is exercised end to end
# without GPU. The "video" is a simple zoom rendered from the input with ffmpeg.
#
# Prompt switches:  QUOTA → ZeroGPU-style quota error,  CRASH → generic error,
#                   SLOW → long run (cancel tests)
import os, subprocess, tempfile, time, random
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


def generate_video(input_image, prompt, steps=4, negative_prompt=default_negative_prompt, duration_seconds=5.0,
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


with gr.Blocks() as demo:
    input_image_component = gr.Image(type="pil", label="Input Image")
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
    ui_inputs = [input_image_component, prompt_input, steps_slider, negative_prompt_input, duration_seconds_input,
                 guidance_scale_input, guidance_scale_2_input, seed_input, randomize_seed_checkbox]
    generate_button.click(fn=generate_video, inputs=ui_inputs, outputs=[video_output, seed_input], concurrency_limit=1)

if __name__ == "__main__":
    demo.queue().launch(server_name="127.0.0.1", server_port=int(os.environ.get("PORT", "7861")))
