// Public, non-secret frontend configuration.
// NEVER put API keys here — this file is served to every visitor.
window.STUDIO_CONFIG = {
  // Where your backend lives.
  //  ''                                  → same origin (Vercel hosting both, or `npm run dev`)
  //  'https://your-project.vercel.app'   → GitHub Pages frontend + Vercel backend
  apiBase: '',
  // Optional: self-host the ffmpeg.wasm core (folder with ffmpeg-core.js + ffmpeg-core.wasm).
  // ffmpegCoreBase: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
};
