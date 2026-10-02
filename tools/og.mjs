// Captures the social card (static/og.png, 1200x630) from a running copy of
// the playground. Usage:
//   node tools/build.mjs && (cd dist && python3 -m http.server 4340) &
//   node tools/og.mjs [--url http://127.0.0.1:4340/] [--playwright-root /path/to/playwright]
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, a) => (i % 2 ? pairs : [...pairs, [v, a[i + 1]]]), []));
const pw = args['--playwright-root']
  ? await import(pathToFileURL(path.join(args['--playwright-root'], 'index.mjs')).href)
  : await import('playwright');
const url = args['--url'] ?? 'http://127.0.0.1:4340/';
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'light', reducedMotion: 'reduce' });
await page.goto(`${url}#payout-invariance-kit`);
await page.waitForSelector('#examples .chip');
await page.locator('#examples .chip').nth(1).click();
await page.waitForSelector('#result .viz-slope');
await page.waitForTimeout(500);
await page.screenshot({ path: new URL('../static/og.png', import.meta.url).pathname });
await browser.close();
console.log('wrote static/og.png');
