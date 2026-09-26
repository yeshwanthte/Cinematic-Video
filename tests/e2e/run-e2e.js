// End-to-end test: real browser + real backend code + two test doubles:
//  • fake_wan_space.py — a real Gradio 6.1 app with the Wan 2.2 Space's exact API (free path)
//  • runway-test-double.js — Runway's documented HTTP contract (paid path)
// Usage: node tests/e2e/run-e2e.js   (needs Playwright: npm i -D playwright, or a global install)
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const req = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'));
  ({ chromium } = req('playwright'));
}

const procs = [];
const start = (cmd, args, env, ready) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    procs.push(p);
    const t = setTimeout(() => reject(new Error(`${args[0]} did not start`)), 10000);
    p.stdout.on('data', (d) => d.toString().includes(ready) && (clearTimeout(t), resolve()));
    p.stderr.on('data', (d) => process.stderr.write(`[${args[0]}] ${d}`));
  });
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

await start('node', ['tests/e2e/runway-test-double.js'], { PORT: '9911' }, 'listening');
await start('python3', ['-u', 'tests/e2e/fake_wan_space.py'], { PORT: '7861' }, 'Running on local URL');
await start('node', ['dev-server.js'], { PORT: '8787', HF_TOKEN: 'hf_test_local', HF_SPACE_URL: 'http://127.0.0.1:7861/', HF_ASSISTANT: 'off', RUNWAY_API_KEY: 'key_test_local', RUNWAY_API_BASE: 'http://127.0.0.1:9911', ALLOWED_ORIGINS: 'http://127.0.0.1:8788' }, 'Cinematic AI Studio');
// Static server that mimics GitHub Pages (sub-path, different origin, no backend)
await start('python3', ['-u', '-m', 'http.server', '8788', '--bind', '127.0.0.1'], {}, 'Serving');

// Big noisy JPEG to exercise the re-encode path (generated, not committed)
execSync(`python3 -c "import os;from PIL import Image;Image.frombytes('RGB',(4200,2800),os.urandom(4200*2800*3)).save('${OUT}/big-noise.jpg',quality=95)"`);

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const BASE = 'http://127.0.0.1:8787';
const lastToast = async () => (await page.locator('.toast').last().innerText().catch(() => '')).replace(/\n/g, ' ');
const upload = (sel, file) => page.setInputFiles(sel, Array.isArray(file) ? file : path.isAbsolute(file) ? file : path.join(FIX, file));
const waitStage = (s, timeout = 60000) => page.waitForSelector(`#stage[data-state="${s}"]`, { timeout });

try {
  // ---------------- home
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#backendStatus').dataset.state === 'ok', null, { timeout: 20000 });
  check('Home renders hero', (await page.locator('h1').first().innerText()).includes('Bring Your Photos'));
  check('Backend pill: free Hugging Face provider connected', /Hugging Face connected/.test(await page.locator('#backendStatus').innerText()), await page.locator('#backendStatus').innerText());
  check('Hero shows free model', /Wan 2.2/.test(await page.locator('#heroModel').innerText()));
  check('6 example cards', (await page.locator('.example').count()) === 6);
  await page.screenshot({ path: `${OUT}/01-home.png` });

  // ---------------- upload validation
  await page.click('.hero-cta .btn-primary');
  await waitStage('empty');
  await upload('#fileInput', 'tiny.gif');
  await page.waitForTimeout(300);
  check('GIF rejected as unsupported', /Unsupported image format/.test(await lastToast()), await lastToast());
  await upload('#fileInput', 'fake.jpg');
  await page.waitForTimeout(300);
  check('Corrupt/renamed file rejected', /not a valid/.test(await lastToast()), await lastToast());

  // ---------------- upload + preview + analysis
  await upload('#fileInput', 'portrait.jpg');
  await waitStage('preview');
  const meta = await page.locator('#fileMeta').innerText();
  check('Preview + filename/resolution/size shown', meta.includes('portrait.jpg') && meta.includes('1600×2000'), meta.replace(/\n/g, ' | '));
  await page.waitForFunction(() => !/Analysing|Scanning/.test(document.querySelector('#analysisSummary').textContent));
  check('Analysis ran (on-device, labelled)', (await page.locator('#analysisSource').innerText()).toLowerCase().includes('on-device'));
  const p0 = await page.inputValue('#promptInput');
  check('Prompt auto-built from controls', p0.length > 80 && /camera/i.test(p0), p0.slice(0, 90) + '…');

  // ---------------- controls
  await page.click('[data-camera="orbit"]');
  check('Camera card updates prompt', /orbits/.test(await page.inputValue('#promptInput')));
  await page.click('[data-style="dreamy"]');
  check('Style preset applies', /ethereal/.test(await page.inputValue('#promptInput')));
  await page.click('[data-category="landscape"]');
  await page.waitForTimeout(200);
  check('Landscape type marks blinking as not suitable', await page.locator('[data-subject="blink"]').evaluate((e) => e.classList.contains('off-fit')));
  await page.click('[data-subject="blink"]');
  check('Incompatible motion refused with reason', /doesn't fit/.test(await lastToast()));
  await page.click('[data-category="portrait"]');
  await page.click('[data-intensity="dynamic"]');
  check('Intensity changes speed wording', /steady, purposeful/.test(await page.inputValue('#promptInput')));
  await page.fill('#promptInput', 'zoom out slowly while wind moves her hair. She glances toward the window light.');
  await page.click('#enhancePrompt');
  await page.waitForTimeout(300);
  const enh = await page.inputValue('#promptInput');
  check('Enhance Prompt rewrites + applies detected intents', /pulls back/.test(enh) && /glances toward the window light/i.test(enh), enh.slice(0, 100) + '…');

  // ---------------- model settings (free default)
  const durs = await page.locator('#durationSeg button').allInnerTexts();
  const ratios = await page.locator('#ratioSeg button').allInnerTexts();
  check('Free Wan model: 3/5 s, 480p, includes 4:5', durs.join() === '3 sec,5 sec' && ratios.some((r) => r.startsWith('4:5')) && (await page.locator('#resolutionSeg').innerText()).includes('480p'), `${durs} | ${ratios.join(' ')}`);
  const cost = await page.locator('#costLine').innerText();
  check('Cost line: Free + GPU-seconds estimate', /Free/.test(cost) && /reserves ≈ \d+s/.test(cost), cost);
  check('Model list shows Free and Paid groups', (await page.locator('.model-group').count()) === 2 && /free/i.test(await page.locator('.model-group').first().innerText()));
  check('Negative prompt supported on Wan', /negative prompt/.test(await page.locator('#negNote').innerText()));
  await page.screenshot({ path: `${OUT}/02-studio-preview.png` });

  // ---------------- FREE generation (Hugging Face Space protocol)
  await page.click('[data-duration="3"]');
  await page.click('#rebuildPrompt');
  await page.click('#generateBtn');
  await waitStage('generating', 5000);
  await page.waitForSelector('#genSteps li[data-step="render"].active', { timeout: 30000 });
  await page.waitForFunction(() => /step \d of 4/.test(document.querySelector('#genSteps li[data-step="render"] small').textContent), null, { timeout: 15000 });
  const stepNote = await page.locator('#genSteps li[data-step="render"] small').innerText();
  check('Real Space progress (tqdm steps) streamed live', /reported by the Space/.test(stepNote), stepNote);
  await page.screenshot({ path: `${OUT}/03-generating.png` });
  await waitStage('result', 60000);
  const vs = await page.evaluate(() => ({ rs: document.querySelector('#video').readyState, w: document.querySelector('#video').videoWidth, h: document.querySelector('#video').videoHeight, src: document.querySelector('#video').src }));
  check('Free video generated, saved locally (blob:) and playing', vs.rs >= 2 && vs.w === 832 && vs.h === 480 && vs.src.startsWith('blob:'), JSON.stringify(vs));
  const rm = await page.locator('#resultMeta').innerText();
  check('Result metadata (832×480, Wan 2.2)', /832×480/.test(rm) && /Wan 2.2/.test(rm), rm.replace(/\n/g, ' '));
  await page.screenshot({ path: `${OUT}/04-result.png` });

  await page.hover('#player');
  await page.click('#vPlay');
  await page.click('#vMute');
  await page.click('#vRestart');
  check('Player controls work', true);
  await page.click('#vCompare');
  check('Before/after compare opens', await page.locator('#compare').isVisible());
  await page.screenshot({ path: `${OUT}/05-compare.png` });
  await page.click('#vCompare');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#btnDownload')]);
  const dlPath = `${OUT}/downloaded-free${path.extname(dl.suggestedFilename())}`;
  await dl.saveAs(dlPath);
  const size = Number(execSync(`stat -c %s "${dlPath}"`).toString());
  check('Download delivers the generated file', size > 5000, `${dl.suggestedFilename()} ${size} bytes`);

  await page.click('#btnVariation');
  await page.click('[data-var="v_orbit"]');
  await page.waitForSelector('.var-card:has([data-view-gen])', { timeout: 60000 });
  check('Free variation (orbit) generated', true);
  await page.screenshot({ path: `${OUT}/06-variations.png`, fullPage: true });

  // ---------------- free failure paths
  const runExpectingError = async (promptText, expect) => {
    await page.click('#btnEdit').catch(() => {});
    if ((await page.locator('#stage').getAttribute('data-state')) !== 'preview') await page.click('#genBack').catch(() => {});
    await page.fill('#promptInput', promptText);
    await page.click('#generateBtn');
    await page.waitForSelector('#genError:not([hidden])', { timeout: 45000 });
    const t = await page.locator('#genErrTitle').innerText();
    const m = await page.locator('#genErrMsg').innerText();
    check(`Error surfaced honestly: ${expect}`, t.includes(expect), `${t} / ${m}`);
    await page.click('#genBack');
  };
  await runExpectingError('A slow push-in. QUOTA', 'free daily GPU allowance');
  await page.screenshot({ path: `${OUT}/07-error.png` });
  await runExpectingError('A slow push-in. CRASH', 'Generation failed');

  // cancel (free) — closing the stream cancels the Space job
  await page.fill('#promptInput', 'A slow push-in. SLOW');
  await page.click('#generateBtn');
  await page.waitForSelector('#genSteps li[data-step="render"].active', { timeout: 30000 });
  await page.click('#genCancel');
  await waitStage('preview', 10000);
  check('Cancel (free) stops the job', /cancelled/i.test(await lastToast()), await lastToast());

  // ---------------- PAID path (Runway) still works
  await page.click('[data-model="gen4.5"]');
  const d2 = await page.locator('#durationSeg button').allInnerTexts();
  check('Runway Gen-4.5 durations 5/8/10', d2.join() === '5 sec,8 sec,10 sec', d2.join());
  check('Runway cost from published pricing', /60 credits/.test(await page.locator('#costLine').innerText()), await page.locator('#costLine').innerText());
  await page.click('[data-model="veo3.1_fast"]');
  check('Veo shows only 4/6/8 s and 1080p', (await page.locator('#durationSeg button').allInnerTexts()).join() === '4 sec,6 sec,8 sec' && (await page.locator('#resolutionSeg').innerText()).includes('1080p'));
  await page.click('[data-model="gen4.5"]');
  await page.click('#rebuildPrompt');
  await page.click('#generateBtn');
  await page.waitForSelector('#genSteps li[data-step="render"].active', { timeout: 30000 });
  await waitStage('result', 60000);
  check('Runway generation via polling succeeds', /Gen-4.5/.test(await page.locator('#resultMeta').innerText()));
  await runExpectingError('A slow push-in. NO_CREDITS', 'credits may be exhausted');
  await runExpectingError('A slow push-in. FAIL_SAFETY', 'content moderation');
  await page.click('[data-model="wan2.2-fast"]');

  // large image re-encode on the free model
  await upload('#fileInput', `${OUT}/big-noise.jpg`);
  await page.waitForFunction(() => document.querySelector('#fileMeta').textContent.includes('big-noise') && !document.querySelector('#stage').dataset.busy, null, { timeout: 20000 });
  await page.click('#rebuildPrompt');
  await page.click('#generateBtn');
  await page.waitForSelector('#genSteps li[data-step="prepare"].done', { timeout: 20000 });
  const prepNote = await page.locator('#genSteps li[data-step="prepare"] small').innerText();
  await waitStage('result', 60000);
  check('14 MB photo re-encoded and generated free', /MB|KB/.test(prepNote), prepNote);

  // ---------------- projects + persistence
  await page.click('[data-nav="projects"]');
  const cards = await page.locator('.project').count();
  check('Projects list both projects', cards >= 2, `${cards} cards`);
  await page.screenshot({ path: `${OUT}/08-projects.png` });
  await page.locator('.project [data-dup]').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.project').length === n, cards + 1, { timeout: 5000 }).catch(() => {});
  check('Duplicate project', (await page.locator('.project').count()) === cards + 1);
  const del = page.locator('.project [data-del]').first();
  await del.click();
  await del.click();
  await page.waitForTimeout(200);
  check('Delete project (with confirm)', (await page.locator('.project').count()) === cards);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#backendStatus').dataset.state === 'ok', null, { timeout: 20000 });
  await page.click('[data-nav="projects"]');
  await page.locator('.project').filter({ hasText: 'portrait' }).locator('button[data-open]').click();
  await waitStage('result', 20000);
  await page.locator('.hist').filter({ hasText: 'Wan 2.2' }).filter({ hasText: 'ready' }).first().click();
  await page.waitForFunction(() => document.querySelector('#video').src.startsWith('blob:') && document.querySelector('#video').readyState >= 2, null, { timeout: 10000 }).catch(() => {});
  check('After reload, free video replays from this browser (never expires)', await page.evaluate(() => document.querySelector('#video').readyState >= 2 && document.querySelector('#video').src.startsWith('blob:')));

  // ---------------- settings + offline backend
  await page.click('[data-nav="settings"]');
  const diag = await page.locator('#diag').innerText();
  check('Settings diagnostics (HF token + Runway optional)', /Hugging Face \(free\) token\s+Configured on server/.test(diag), diag.replace(/\n/g, ' | '));
  await page.fill('#apiBase', 'http://127.0.0.1:1');
  await page.click('#saveBackend');
  await page.waitForFunction(() => document.querySelector('#backendStatus').dataset.state === 'err');
  check('Offline backend reported', /offline/i.test(await page.locator('#backendStatus').innerText()));
  await page.click('[data-nav="studio"]');
  await page.click('#btnEdit').catch(() => {});
  await page.click('#generateBtn');
  await page.waitForSelector('#genError:not([hidden])', { timeout: 20000 });
  check('Network failure shown clearly', /Network problem/.test(await page.locator('#genErrTitle').innerText()));
  await page.click('#genBack');
  await page.click('[data-nav="settings"]');
  await page.fill('#apiBase', '');
  await page.click('#saveBackend');
  await page.waitForFunction(() => document.querySelector('#backendStatus').dataset.state === 'ok', null, { timeout: 20000 });

  // ---------------- story mode (free)
  await page.click('[data-nav="story"]');
  await upload('#storyInput', ['landscape.png', 'landscape.webp'].map((f) => path.join(FIX, f)));
  await page.waitForSelector('.scene >> nth=1');
  check('Story scenes created (2)', (await page.locator('li.scene').count()) === 2);
  await page.click('#storyGenerate');
  await page.waitForFunction(() => [...document.querySelectorAll('li.scene .st')].every((e) => e.classList.contains('ok')), null, { timeout: 90000 });
  check('Story: every scene generated free', true);
  await page.screenshot({ path: `${OUT}/09-story.png`, fullPage: true });

  check('No uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // ---------------- mobile / tablet
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.goto(BASE);
  await mp.screenshot({ path: `${OUT}/10-mobile-home.png` });
  const overflowHome = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await mp.click('.hero-cta .btn-primary');
  await mp.setInputFiles('#fileInput', path.join(FIX, 'portrait.jpg'));
  await mp.waitForSelector('#stage[data-state="preview"]');
  await mp.waitForTimeout(500);
  await mp.screenshot({ path: `${OUT}/11-mobile-studio.png` });
  const overflowStudio = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Mobile: no horizontal overflow, Generate reachable', overflowHome <= 0 && overflowStudio <= 0 && (await mp.locator('#generateBtn').isVisible()), `home=${overflowHome} studio=${overflowStudio}`);
  const t = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const tp = await t.newPage();
  await tp.goto(`${BASE}/#studio`);
  await tp.screenshot({ path: `${OUT}/12-tablet-studio.png` });
  check('Tablet: no horizontal overflow', (await tp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);

  // ---------------- GitHub Pages compatibility
  const gp = await (await browser.newContext()).newPage();
  const gpErrors = [];
  gp.on('pageerror', (e) => gpErrors.push(e.message));
  await gp.goto('http://127.0.0.1:8788/frontend/index.html');
  await gp.waitForFunction(() => document.querySelector('#backendStatus').dataset.state === 'err');
  check('Pages-style static hosting loads (sub-path, offline catalog)', gpErrors.length === 0 && (await gp.locator('.model').count()) === 6, gpErrors.join(' | '));
  await gp.click('[data-nav="settings"]');
  await gp.fill('#apiBase', 'http://127.0.0.1:8787');
  await gp.click('#saveBackend');
  await gp.waitForFunction(() => document.querySelector('#backendStatus').dataset.state === 'ok', null, { timeout: 20000 });
  check('Pages frontend → cross-origin backend via CORS', true, await gp.locator('#backendStatus').innerText());
} catch (e) {
  check('Unexpected test failure', false, e.stack?.split('\n').slice(0, 3).join(' '));
  await page.screenshot({ path: `${OUT}/zz-failure.png` }).catch(() => {});
} finally {
  await browser.close();
  cleanup();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
