// Renders the social card from tools/og-card.html (a fixed design that uses
// the page's palette and vendored fonts, so it needs no running server).
//   node tools/og.mjs [--playwright-root /path/to/playwright] [--github /abs/path.png]
// Writes static/og.png at 1200x630. With --github it also writes the
// 1280x640 image for the GitHub repository's social preview, which is
// uploaded by hand in the repository settings (GitHub has no API for it).
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, a) => (i % 2 ? pairs : [...pairs, [v, a[i + 1]]]), []));
const pw = args['--playwright-root']
  ? await import(pathToFileURL(path.join(args['--playwright-root'], 'index.mjs')).href)
  : await import('playwright');
const card = pathToFileURL(fileURLToPath(new URL('./og-card.html', import.meta.url))).href;
const browser = await pw.chromium.launch();
async function render(width, height, out) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(card);
  await page.evaluate(() => document.fonts.ready);
  const missing = await page.evaluate(() => [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family));
  if (missing.length) throw new Error(`fonts not loaded: ${missing.join(', ')}`);
  await page.screenshot({ path: out });
  await page.close();
  console.log(`wrote ${out}`);
}
await render(1200, 630, fileURLToPath(new URL('../static/og.png', import.meta.url)));
if (args['--github']) await render(1280, 640, args['--github']);
await browser.close();
