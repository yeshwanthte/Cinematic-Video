Vendored, unmodified ESM builds of:
- @ffmpeg/ffmpeg 0.12.15 (MIT) — classes.js, const.js, errors.js, index.js, types.js, utils.js, worker.js
- @ffmpeg/util 0.12.2 (MIT) — util/*

Vendored so the ffmpeg.wasm worker is same-origin (required by browsers).
The FFmpeg WebAssembly core (@ffmpeg/core 0.12.10, GPL-2.0-or-later because it includes x264)
is NOT stored here; the browser downloads it from jsDelivr at export time (see frontend/js/assembler.js).
https://github.com/ffmpegwasm/ffmpeg.wasm
