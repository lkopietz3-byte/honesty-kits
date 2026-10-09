// One-time vendoring: download the two web fonts from Google Fonts into
// static/fonts/ and write static/fonts/fonts.css pointing at the local files,
// so the live site makes no third-party font requests. Both families are under
// the SIL Open Font License 1.1 (licenses saved next to the files).
//
//   node tools/vendor-fonts.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CSS_URL = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap';
const LICENSES = {
  'OFL-IBMPlexMono.txt': 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt',
  'OFL-SchibstedGrotesk.txt': 'https://raw.githubusercontent.com/google/fonts/main/ofl/schibstedgrotesk/OFL.txt',
};
// Google serves woff2 with unicode-range subsets to modern browsers.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const dir = new URL('../static/fonts/', import.meta.url);
mkdirSync(dir, { recursive: true });

async function get(url, kind) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return kind === 'text' ? res.text() : Buffer.from(await res.arrayBuffer());
}

let css = await get(CSS_URL, 'text');
const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g)].map((m) => m[1]))];
if (!urls.length) throw new Error('no woff2 URLs in the Google Fonts CSS');
const manifest = [];
for (const url of urls) {
  const family = url.split('/s/')[1].split('/')[0];
  const bytes = await get(url, 'bytes');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const name = `${family}-${hash}.woff2`;
  writeFileSync(new URL(name, dir), bytes);
  css = css.split(url).join(`fonts/${name}`);
  manifest.push(`${name} ${bytes.length}`);
}
for (const [name, url] of Object.entries(LICENSES)) writeFileSync(new URL(name, dir), await get(url, 'text'));
writeFileSync(new URL('fonts.css', dir), `/* Vendored from Google Fonts by tools/vendor-fonts.mjs. SIL Open Font License 1.1: see OFL-*.txt. */\n${css}`);
console.log(manifest.join('\n'));
