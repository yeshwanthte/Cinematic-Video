// Image Studio end-to-end: real browser + backend + Gradio test Spaces with the real Spaces' API signatures.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
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
const start = (cmd, args, env, ready) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    procs.push(p);
    const t = setTimeout(() => reject(new Error(`${args.join(' ')} did not start`)), 20000);
    p.stdout.on('data', (d) => d.toString().includes(ready) && (clearTimeout(t), resolve()));
    p.stderr.on('data', (d) => /Error|Traceback/.test(d) && process.stderr.write(`[${args[1] || args[0]}] ${d}`));
  });
process.on('exit', () => procs.forEach((p) => p.kill()));
await Promise.all([
  start('python3', ['-u', 'tests/e2e/fake_image_space.py'], { MODE: 'qwen', PORT: '7871' }, 'Running on local URL'),
  start('python3', ['-u', 'tests/e2e/fake_image_space.py'], { MODE: 'kontext', PORT: '7872' }, 'Running on local URL'),
  start('python3', ['-u', 'tests/e2e/fake_image_space.py'], { MODE: 'schnell', PORT: '7873' }, 'Running on local URL'),
  start('python3', ['-u', 'tests/e2e/fake_image_space.py'], { MODE: 'qwen1', PORT: '7874' }, 'Running on local URL'),
]);
await start('node', ['dev-server.js'], {
  PORT: '8787', HF_TOKEN: 'hf_test_local', HF_ASSISTANT: 'off',
  HF_SPACE_OVERRIDES: JSON.stringify({ 'qwen-edit-fast': 'http://127.0.0.1:7871/', 'flux-kontext': 'http://127.0.0.1:7872/', 'flux-schnell': 'http://127.0.0.1:7873/', 'qwen-edit': 'http://127.0.0.1:7874/' }),
}, 'Cinematic AI Studio');

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const lastToast = async () => (await page.locator('.toast').last().innerText().catch(() => '')).replace(/\n/g, ' ');
try {
  await page.goto('http://127.0.0.1:8787/#image');
  await page.waitForSelector('#iModels .model');
  check('Image Studio opens with free edit models', (await page.locator('#iModels .model').count()) === 3, await page.locator('#iModels').innerText());
  check('Identity locks on by default', await page.locator('[data-ilock="face"]').evaluate((e) => e.classList.contains('on')));

  // Edit flow (Qwen, gallery input)
  await page.setInputFiles('#iFileInput', path.join(FIX, 'portrait.jpg'));
  await page.waitForSelector('#istage[data-state="preview"]');
  await page.click('[data-imodel="qwen-edit-fast"]');
  await page.click('[data-ipreset="bg"]');
  check('Preset fills instruction and unlocks background', /background/i.test(await page.inputValue('#iPrompt')) && !(await page.locator('[data-ilock="background"]').evaluate((e) => e.classList.contains('on'))));
  await page.fill('#iPrompt', 'Change the background to a sunny beach');
  await page.click('#iGenerate');
  await page.waitForSelector('#iGenSteps li[data-step="render"].active', { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/img-01-generating.png` });
  await page.waitForSelector('#istage[data-state="result"]', { timeout: 40000 });
  const used = await page.locator('#iPromptUsed').textContent();
  check('Edit result shown; prompt includes identity lock', /Keep the person's face, facial features and identity/.test(used), used.slice(0, 140));
  check('Before/after compare active', await page.locator('#icompare.has-result:not(.no-before)').count() === 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/img-02-result.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#iDownload')]);
  check('Download PNG', dl.suggestedFilename().endsWith('.png'), dl.suggestedFilename());

  // Keep editing (iterate)
  await page.click('#iUseAsInput');
  await page.waitForSelector('#istage[data-state="preview"]');
  await page.fill('#iPrompt', 'Make it night');
  await page.click('[data-imodel="flux-kontext"]');
  await page.click('#iGenerate');
  await page.waitForSelector('#istage[data-state="result"]', { timeout: 40000 });
  check('Iterative edit with FLUX Kontext', /Kontext/.test(await page.locator('#iMeta').innerText()));

  // Errors
  await page.fill('#iPrompt', 'QUOTA test');
  await page.click('#iGenerate');
  await page.waitForSelector('#iGenError:not([hidden])', { timeout: 30000 });
  check('Quota error surfaced honestly', /free daily GPU allowance/.test(await page.locator('#iErrTitle').innerText()));
  await page.click('#iBack');
  await page.click('[data-imodel="qwen-edit"]');
  await page.fill('#iPrompt', 'Change the shirt to red');
  await page.click('#iGenerate');
  await page.waitForSelector('#istage[data-state="result"]', { timeout: 40000 });
  check('Qwen Image Edit (single-image Space) works', /Qwen Image Edit · Free/.test(await page.locator('#iMeta').innerText()));
  await page.fill('#iPrompt', 'BROKEN test');
  await page.click('#iGenerate');
  await page.waitForSelector('#iGenError:not([hidden])', { timeout: 30000 });
  check('Crash offers “Try with another model”', await page.locator('#iSwitch').isVisible(), await page.locator('#iSwitch').innerText());
  await page.click('#iBack');

  // Create from text (schnell, aspect)
  await page.click('[data-imode="create"]');
  await page.click('[data-imodel="flux-schnell"]');
  await page.click('[data-iaspect="16:9"]');
  await page.fill('#iPrompt', 'A modern villa at dusk');
  await page.click('[data-istyle="cinema"]');
  await page.click('#iGenerate');
  await page.waitForSelector('#istage[data-state="result"]', { timeout: 40000 });
  const dims = await page.evaluate(() => [document.querySelector('#iAfter').naturalWidth, document.querySelector('#iAfter').naturalHeight]);
  check('Text-to-image at 16:9 (1344×768)', dims[0] === 1344 && dims[1] === 768, dims.join('×'));
  check('History keeps all images', (await page.locator('#iGrid button').count()) === 4);

  // Send to video
  await page.click('#iAnimate');
  await page.waitForSelector('#stage[data-state="preview"]', { timeout: 10000 });
  check('“Animate in Video Studio” loads image into the video studio', /image-/.test(await page.locator('#fileMeta').innerText()));

  // persistence
  await page.reload();
  await page.click('[data-nav="image"]');
  await page.waitForSelector('#iGrid button');
  await page.locator('#iGrid button').first().click();
  await page.waitForSelector('#istage[data-state="result"]');
  check('Images persist after reload', true);

  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  await m.goto('http://127.0.0.1:8787/#image');
  await m.waitForSelector('#iModels .model');
  await m.screenshot({ path: `${OUT}/img-03-mobile.png` });
  check('Mobile: no horizontal overflow', (await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  check('No page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Unexpected failure', false, e.message.split('\n')[0]);
  await page.screenshot({ path: `${OUT}/img-zz-failure.png` });
} finally {
  await browser.close();
  const f = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - f}/${results.length} image checks passed`);
  process.exit(f ? 1 : 0);
}
