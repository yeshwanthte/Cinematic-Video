// Film Studio end-to-end: real browser + backend + Gradio test Spaces that copy the real Spaces'
// API signatures (Wan 2.2 Director / LTX-2.3), real ffmpeg.wasm assembly, ffprobe on the export.
import { spawn, execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/e2e/fixtures');
const OUT = path.join(ROOT, 'tests/e2e/artifacts');
mkdirSync(OUT, { recursive: true });
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'));
}
const procs = [];
const logs = {};
const start = (cmd, args, env, ready, tag) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    procs.push(p);
    logs[tag] = '';
    const t = setTimeout(() => reject(new Error(`${tag} did not start`)), 25000);
    const on = (d) => {
      logs[tag] += d.toString();
      if (logs[tag].includes(ready)) clearTimeout(t), resolve();
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
  });
process.on('exit', () => procs.forEach((p) => p.kill()));
const FAKE = 'tests/e2e/fake_wan_space.py';
await Promise.all([
  start('python3', ['-u', FAKE], { MODE: 'long', PORT: '7882' }, 'Running on local URL', 'long'),
  start('python3', ['-u', FAKE], { MODE: 'ltx', PORT: '7881' }, 'Running on local URL', 'ltx'),
  start('python3', ['-u', FAKE], { MODE: 'fast', PORT: '7883' }, 'Running on local URL', 'fast'),
  start('node', ['tests/e2e/fake_modal_app.js'], { PORT: '7890', STUDIO_MODAL_SECRET: 'test-modal-secret' }, 'fake modal app', 'modal'),
]);
await start('node', ['dev-server.js'], {
  PORT: '8787', HF_TOKEN: 'hf_test_local', RATE_LIMIT_PER_HOUR: '500',
  MODAL_ENDPOINT_URL: 'http://127.0.0.1:7890', MODAL_API_SECRET: 'test-modal-secret',
  HF_SPACE_OVERRIDES: JSON.stringify({ 'wan2.2-long': 'http://127.0.0.1:7882/', 'ltx-2.3': 'http://127.0.0.1:7881/', 'wan2.2-fast': 'http://127.0.0.1:7883/' }),
}, 'Cinematic AI Studio', 'dev');

// music fixture
const MUSIC = path.join(OUT, 'music.mp3');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=262:sample_rate=44100:duration=6', MUSIC]);

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file]).toString());

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
// Serve the ffmpeg.wasm core the app requests from the CDN from node_modules (the sandbox has no CDN access).
await ctx.route('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/*', (route) => {
  const name = route.request().url().split('/').pop();
  route.fulfill({ body: readFileSync(path.join(ROOT, 'node_modules/@ffmpeg/core/dist/esm', name)), contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
});
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shotState = (i) => page.locator('.fs-shot').nth(i).getAttribute('class');
const waitShot = (i, cls, timeout = 90000) => page.waitForFunction(([i, cls]) => document.querySelectorAll('.fs-shot')[i]?.classList.contains(cls), [i, cls], { timeout });

try {
  await page.goto('http://127.0.0.1:8787/#film');
  await page.waitForSelector('#fsModels .model');
  check('Film Studio lists the free models (Hugging Face + Modal)', (await page.locator('#fsModels .model').count()) === 4, await page.locator('#fsModels .model b').allInnerTexts().then((t) => t.join(' | ')));

  // 01 — idea
  await page.setInputFiles('#fsPhotoInput', path.join(FIX, 'portrait.jpg'));
  await page.waitForSelector('#fsPhoto:not([hidden])');
  await page.fill('#fsTitle', 'Beach walk');
  await page.fill('#fsIdea', 'A couple walking on a beach at sunset, wind in their clothes');
  await page.click('[data-preset="travel"]');
  await page.click('[data-fmodel="wan2.2-long"]');
  await page.click('[data-len="20"]');
  await page.click('[data-fq="fast"]');
  const picked = await page.locator('#fsRatio .on').getAttribute('data-fratio');
  check('Portrait photo auto-selects a portrait ratio', Number(picked.split(':')[1]) > Number(picked.split(':')[0]), picked);
  check('Length options show how many native clips are needed', /2 clips/.test(await page.locator('[data-len="20"]').innerText()));
  await page.click('#fsPlan');
  await page.waitForSelector('.fs-shot');
  const n = await page.locator('.fs-shot').count();
  check('20 s with a 10 s model → 2 shots of native length', n === 2 && (await page.locator('.fs-seg').count()) === 2);
  const firstStart = await page.locator('.fs-shot').nth(0).locator('[data-f="continuity"]').inputValue();
  const secondStart = await page.locator('.fs-shot').nth(1).locator('[data-f="continuity"]').inputValue();
  check('Shot 1 starts from the photo, shot 2 continues from shot 1', firstStart === 'photo' && secondStart === 'continue');
  const prompt2 = await page.locator('.fs-shot').nth(1).locator('.fs-prompt p').textContent();
  check('Continuity bible is in every prompt', /unbroken take/.test(prompt2) && /couple/i.test(prompt2), prompt2.slice(0, 120));
  check('Plan shows native vs assembled duration and GPU estimate', /native AI video/.test(await page.locator('#fsTimelineNote').innerText()) && /reserve/.test(await page.locator('#fsTimelineNote').innerText()));
  await page.screenshot({ path: `${OUT}/film-01-plan.png`, fullPage: false });

  // 02 — generate all
  await page.click('#fsGenerateAll');
  await page.waitForSelector('#fsStop:not([hidden])');
  await waitShot(0, 'done');
  await waitShot(1, 'done');
  const calls = (logs.long.match(/CALL (.*)/g) || []).map((l) => l.slice(5));
  check('Both shots generated on the Director Space (Fast = 4 steps)', calls.length === 2 && calls.every((c) => /'steps': 4/.test(c)), calls.join(' / '));
  const frames = await page.evaluate(async () => {
    const f = JSON.parse(localStorage.getItem('cas.films.v1'))[0];
    const { imageStore } = await import('/js/storage.js');
    return Promise.all(f.shots.map(async (s) => Boolean(await imageStore.get(`film_frame_${s.id}`))));
  });
  check('Real last frames were extracted for continuation', frames.every(Boolean));
  check('Timeline shows both shots ready', (await page.locator('.fs-seg.done').count()) === 2);

  // add a text-to-video LTX shot with native audio
  await page.click('#fsAddShot');
  const third = page.locator('.fs-shot').nth(2);
  await third.locator('[data-f="model"]').selectOption('ltx-2.3');
  await third.locator('[data-f="continuity"]').selectOption('text');
  await third.locator('[data-f="duration"]').selectOption('5');
  await third.locator('[data-f="action"]').fill('Sunset over the sea, waves rolling in');
  await page.locator('.fs-shot').nth(2).locator('[data-act="gen"]').click();
  await waitShot(2, 'done');
  check('Text-to-video shot on LTX-2.3 with AI audio', /AI audio/.test(await page.locator('.fs-shot').nth(2).innerText()));

  // 03 — export with music
  await page.setInputFiles('#fsMusicInput', MUSIC);
  await page.waitForSelector('#fsMix:not([hidden])');
  await page.click('[data-fsize="720"]');
  await page.click('[data-ffps="24"]');
  await page.click('#fsExport');
  await page.waitForSelector('#fsExportProgress:not([hidden])');
  await page.waitForSelector('#fsFinal:not([hidden])', { timeout: 240000 });
  const summary = await page.locator('#fsFinalSummary').innerText();
  check('Export summary separates AI clips, resizing, music and AI audio', /3 AI-generated clips/.test(summary) && /no new detail/.test(summary) && /your uploaded track/.test(summary) && /generated by the AI model/.test(summary), summary.replace(/\n/g, ' | ').slice(0, 220));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fsDownload')]);
  const file = path.join(OUT, 'film-export.mp4');
  await dl.saveAs(file);
  const pr = probe(file);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const a = pr.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(pr.format.duration);
  check('MP4 is H.264 + AAC at 720p / 24 fps', v?.codec_name === 'h264' && a?.codec_name === 'aac' && v.width === 720 && v.r_frame_rate === '24/1', `${v?.codec_name} ${v?.width}x${v?.height} ${v?.r_frame_rate} + ${a?.codec_name}`);
  check('Film length = 10 + 10 + 5 s minus two 0.5 s crossfades and one dropped frame', Math.abs(dur - 24.1) < 0.4, `${dur.toFixed(2)} s`);
  await page.screenshot({ path: `${OUT}/film-02-export.png`, fullPage: false });

  // regenerate shot 1 → shot 2 flagged as no longer seamless
  await page.locator('.fs-shot').nth(0).locator('[data-act="gen"]').click();
  await waitShot(0, 'running');
  await waitShot(0, 'done');
  await page.waitForFunction(() => document.querySelectorAll('.fs-shot')[0]?.querySelector('[data-act="gen"]') && !document.querySelectorAll('.fs-shot')[0].querySelector('[data-act="gen"]').disabled);
  check('Regenerating a shot flags the shot that continued from it', /stale/.test(await shotState(1)));

  // quota error is explained, prompt and plan are kept
  await page.locator('.fs-shot').nth(1).locator('[data-f="action"]').fill('QUOTA test walk');
  await page.locator('.fs-shot').nth(1).locator('[data-f="action"]').dispatchEvent('change');
  await page.locator('.fs-shot').nth(1).locator('[data-act="gen"]').click();
  await waitShot(1, 'failed');
  const err = await page.locator('.fs-shot').nth(1).locator('.fs-err').innerText();
  check('Quota exhaustion is explained, plan kept', /free daily GPU allowance/.test(err) && /reserve 75s/.test(err), err.replace(/\n/g, ' ').slice(0, 160));
  check('Usage meter shows today’s reservations and HF’s last report', /reserved ≈\d+ s/.test(await page.locator('#fsUsage').innerText()) && /12 s left/.test(await page.locator('#fsUsage').innerText()));

  // persistence
  await page.reload();
  await page.waitForSelector('.fs-shot');
  check('Film, shots and export persist after reload', (await page.locator('.fs-shot').count()) === 3 && (await page.locator('#fsFinal:not([hidden])').count()) === 1 && (await page.inputValue('#fsTitle')) === 'Beach walk');

  // text-only film on a photo-only model is prevented
  await page.click('#fsNew');
  await page.click('[data-src="text"]');
  check('Text-only film switches to a text-to-video model', (await page.locator('#fsModels .model.on').getAttribute('data-fmodel')) === 'ltx-2.3' && (await page.locator('[data-fmodel="wan2.2-fast"]').isDisabled()));

  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  await m.goto('http://127.0.0.1:8787/#film');
  await m.waitForSelector('#fsModels .model');
  await m.screenshot({ path: `${OUT}/film-03-mobile.png` });
  check('Mobile: no horizontal overflow', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);

  // ---- Studio: Director model with end frame, RIFE 32 fps and Max detail
  await page.goto('http://127.0.0.1:8787/#studio');
  await page.setInputFiles('#fileInput', path.join(FIX, 'portrait.jpg'));
  await page.waitForSelector('#stage[data-state="preview"]');
  await page.click('[data-model="wan2.2-long"]');
  await page.click('[data-quality="max"]');
  await page.click('[data-fps="32"]');
  await page.setInputFiles('#endFrameInput', path.join(FIX, 'landscape.png'));
  await page.waitForSelector('#endFrameImg:not([hidden])');
  check('Studio shows quality, RIFE fps and end-frame controls for the Director model', /RIFE/.test(await page.locator('#modelExtraNote').innerText()) && /reserves ≈ <b>|reserves ≈/.test(await page.locator('#costLine').innerText()));
  await page.waitForSelector('#generateBtn:not([disabled])');
  await page.click('#generateBtn');
  await page.waitForSelector('#stage[data-state="result"]', { timeout: 90000 });
  const last = (logs.long.match(/CALL (.*)/g) || []).pop() || '';
  check('First + last frame, 8 steps and RIFE ×2 reach the Space', /'last_image': True/.test(last) && /'steps': 8/.test(last) && /'frame_multiplier': 32/.test(last), last);
  await page.click('[data-model="ltx-2.3"]');
  check('LTX shows its own prompt enhancer and hides the end frame', (await page.locator('#spaceEnhanceWrap').isVisible()) && !(await page.locator('#endFrameBox').isVisible()) && /native|audio/i.test(await page.locator('#modelExtraNote').innerText()));
  await page.click('[data-model="wan2.2-fast"]');

  // ---- Story Mode: real assembly instead of the old "not implemented" card
  await page.goto('http://127.0.0.1:8787/#story');
  await page.setInputFiles('#storyInput', [path.join(FIX, 'portrait.jpg'), path.join(FIX, 'landscape.png')]);
  await page.waitForSelector('.scene');
  await page.click('#storyGenerate');
  await page.waitForFunction(() => document.querySelectorAll('.scene .st.ok').length === 2, null, { timeout: 120000 });
  await page.click('#renderTry');
  await page.waitForSelector('#renderResult:not([hidden])', { timeout: 180000 });
  check('Story Mode assembles its scenes into one MP4', /2 AI-generated clips/.test(await page.locator('#renderSummary').innerText()));

  // ---- Modal (your free monthly credits): Studio, 720p + end frame + Max detail
  const modalCalls = async () => (await (await fetch('http://127.0.0.1:7890/__calls', { headers: { Authorization: 'Bearer test-modal-secret' } })).json());
  await page.goto('http://127.0.0.1:8787/#studio');
  await page.setInputFiles('#fileInput', path.join(FIX, 'landscape.png'));
  await page.waitForSelector('#stage[data-state="preview"]');
  await page.click('[data-model="wan2.2-modal"]');
  check('Modal model shows its credit-based cost line', /Modal/.test(await page.locator('#costLine').innerText()) && /month/.test(await page.locator('#costLine').innerText()), await page.locator('#costLine').innerText());
  await page.click('[data-resolution="720p"]');
  await page.click('[data-quality="max"]');
  await page.setInputFiles('#endFrameInput', path.join(FIX, 'portrait.jpg'));
  await page.waitForSelector('#endFrameImg:not([hidden])');
  await page.waitForSelector('#generateBtn:not([disabled])');
  await page.click('#generateBtn');
  await page.waitForSelector('#stage[data-state="result"]', { timeout: 120000 });
  const mc = (await modalCalls()).pop();
  check('Modal job got 720p, 8 steps, end frame and negative prompt', mc?.max_dim === 1280 && mc.steps === 8 && mc.last_image && mc.negative, JSON.stringify(mc));
  const vsize = await page.evaluate(() => [document.querySelector('#video').videoWidth, document.querySelector('#video').videoHeight]);
  check('Modal result plays from this browser at 720p', vsize[0] === 1280 && vsize[1] === 720, vsize.join('×'));
  await page.click('#btnEdit').catch(() => {});

  // Modal out-of-credits is explained
  await page.goto('http://127.0.0.1:8787/#studio');
  await page.setInputFiles('#fileInput', path.join(FIX, 'landscape.png'));
  await page.waitForSelector('#stage[data-state="preview"]');
  await page.click('[data-model="wan2.2-modal"]');
  await page.fill('#promptInput', 'CREDITS test');
  await page.click('#generateBtn');
  await page.waitForSelector('#genError:not([hidden])', { timeout: 60000 });
  check('Modal credits running out is explained', /credits for this month/.test(await page.locator('#genErrMsg').innerText()), await page.locator('#genErrMsg').innerText());

  // Film Studio on Modal: 10 s = 2 chained 5 s shots through the polled path
  await page.goto('http://127.0.0.1:8787/#film');
  await page.waitForSelector('#fsModels .model');
  await page.click('#fsNew');
  await page.setInputFiles('#fsPhotoInput', path.join(FIX, 'landscape.png'));
  await page.waitForSelector('#fsPhoto:not([hidden])');
  await page.click('[data-fmodel="wan2.2-modal"]');
  await page.click('[data-len="10"]');
  await page.click('#fsPlan');
  await page.waitForSelector('.fs-shot');
  check('Modal film: 10 s → 2 shots of 5 s', (await page.locator('.fs-shot').count()) === 2 && /Modal GPU/.test(await page.locator('#fsTimelineNote').innerText()));
  await page.click('#fsGenerateAll');
  await waitShot(0, 'done', 120000);
  await waitShot(1, 'done', 120000);
  check('Both Modal shots generated and chained', (await page.locator('.fs-seg.done').count()) === 2);
  await page.click('#fsExport');
  await page.waitForSelector('#fsFinal:not([hidden])', { timeout: 180000 });
  check('Modal film exports to MP4', /2 AI-generated clips/.test(await page.locator('#fsFinalSummary').innerText()));

  // Settings shows the Modal app as reachable
  await page.goto('http://127.0.0.1:8787/#settings');
  await page.click('#saveBackend');
  await page.waitForFunction(() => /Modal/.test(document.querySelector('#diag')?.innerText || '') && /H200/.test(document.querySelector('#diag')?.innerText || ''), null, { timeout: 20000 }).catch(() => {});
  check('Settings diagnostics show the Modal app on its GPU', /H200/.test(await page.locator('#diag').innerText()), (await page.locator('#diag').innerText()).replace(/\n/g, ' | ').slice(0, 200));

  check('No page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Unexpected failure', false, e.message.split('\n')[0]);
  await page.screenshot({ path: `${OUT}/film-zz-failure.png` });
  writeFileSync(path.join(OUT, 'film-logs.txt'), Object.entries(logs).map(([k, v]) => `--- ${k}\n${v.slice(-4000)}`).join('\n'));
} finally {
  await browser.close();
  const f = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - f}/${results.length} film checks passed`);
  process.exit(f ? 1 : 0);
}
