// Records docs/demo.gif from the playground: a number the AI made up, the
// draft fixed, Citations showing a contradiction that still passes its
// word-overlap check, and the generated CI code. Frames are screenshots; holds become GIF
// frame delays, so only the animated moments need many frames.
//
//   node tools/demo-gif.mjs [--url https://lkopietz3-byte.github.io/honesty-kits/] [--playwright-root /path/to/playwright]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, a) => (i % 2 ? pairs : [...pairs, [v, a[i + 1]]]), []));
const pw = args['--playwright-root']
  ? await import(pathToFileURL(path.join(args['--playwright-root'], 'index.mjs')).href)
  : await import('playwright');
const url = args['--url'] ?? 'https://lkopietz3-byte.github.io/honesty-kits/';
const W = 1200, H = 800;
const SCALE = 0.75; // keep the resulting GIF small enough for the README
const OW = Math.round(W * SCALE), OH = Math.round(H * SCALE);

/** Bilinear downscale of an RGBA buffer. */
function downscale(src) {
  const out = new Uint8Array(OW * OH * 4);
  for (let y = 0; y < OH; y++) {
    const sy = (y + 0.5) / SCALE - 0.5, y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(H - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < OW; x++) {
      const sx = (x + 0.5) / SCALE - 0.5, x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(W - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * W + x0) * 4 + c], b = src[(y0 * W + x1) * 4 + c], d = src[(y1 * W + x0) * 4 + c], e = src[(y1 * W + x1) * 4 + c];
        out[(y * OW + x) * 4 + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy);
      }
    }
  }
  return out;
}

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, colorScheme: 'light', reducedMotion: 'no-preference' });
const frames = [];
async function shot() { return downscale(PNG.sync.read(await page.screenshot({ type: 'png' })).data); }
async function hold(ms) { frames.push({ data: await shot(), delay: ms }); }
async function motion(ms) {
  const end = Date.now() + ms;
  let last = Date.now(), data = await shot();
  while (Date.now() < end) {
    await page.waitForTimeout(Math.max(0, 90 - (Date.now() - last)));
    const next = await shot();
    const now = Date.now();
    frames.push({ data, delay: Math.max(20, now - last) });
    data = next; last = now;
  }
  frames.push({ data, delay: 60 });
}
async function edit(selector, from, to) {
  const value = await page.inputValue(selector);
  if (!value.includes(from)) throw new Error(`text to replace not found: ${from}`);
  await page.fill(selector, value.replace(from, to));
}

// 1. The default check catches a number that is not in the source.
await page.goto(`${url}#number-trace-kit`);
await page.waitForSelector('#result .rows');
await page.waitForTimeout(150);
await motion(1300);
await hold(3000);
// 2. Fix the draft: drop the invented number, and the check passes.
await page.click('#edit-draft');
await edit('#f-number-trace-kit-output', 'Payment is due in 45 days.', 'Payment terms are in your account.');
await page.getByRole('button', { name: 'Check it' }).click();
await page.waitForTimeout(320);
await motion(1100);
await hold(2400);
// 3. Citations is honest about its limit: a sentence that contradicts its source still passes, and the page says so.
await page.goto(`${url}#grounding-kit`);
await page.waitForSelector('#result .rows');
await page.waitForTimeout(150);
await hold(1800);
await page.click('#trial-0');
await page.waitForSelector('.trial-callout');
await page.waitForTimeout(150);
await motion(900);
await hold(3400);
// 4. The same check as code for CI.
await page.click('#view-code');
await page.waitForTimeout(150);
await hold(3000);
await browser.close();

// One shared palette across all frames keeps colors steady (no flicker).
const sample = new Uint8Array(frames.length * 4 * 4000);
let k = 0;
for (const f of frames) for (let i = 0; i < 4000; i++) { const p = Math.floor(Math.random() * (f.data.length / 4)) * 4; sample.set(f.data.subarray(p, p + 4), k); k += 4; }
const palette = quantize(sample, 256);
const gif = GIFEncoder();
frames.forEach((f, i) => gif.writeFrame(applyPalette(f.data, palette), OW, OH, { palette, delay: f.delay, repeat: i === 0 ? 0 : undefined }));
gif.finish();
mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
const out = new URL('../docs/demo.gif', import.meta.url);
writeFileSync(out, gif.bytes());
const total = frames.reduce((s, f) => s + f.delay, 0);
console.log(`wrote docs/demo.gif: ${frames.length} frames, ${(total / 1000).toFixed(1)} s, ${(gif.bytes().length / 1e6).toFixed(2)} MB`);
