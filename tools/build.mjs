// Builds dist/ for a static host (GitHub Pages): wraps src/page.html in a full
// HTML document and copies the modules next to it. No bundler, no deps.
//
// The live site serves everything itself, so it makes no third-party requests:
// - Each kit's published files are copied from node_modules (installed by
//   `npm ci` from the lockfile, so byte-identical to the npm tarball) into
//   kits/<kit>@<version>/. The page loads those instead of a CDN.
// - The two fonts are vendored in static/fonts/ (see tools/vendor-fonts.mjs).
// - A Content-Security-Policy lets the page load only its own files and send
//   nothing anywhere (connect-src 'none', form-action 'none').
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { KITS } from '../demos.mjs';

const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let page = readFileSync(new URL('src/page.html', root), 'utf8');

// Kits: copy every published .js (and source map) of the exact tested version.
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(new URL(`${entry.name}/`, from), new URL(`${entry.name}/`, to));
    else if (/\.js(\.map)?$/.test(entry.name)) copyFileSync(new URL(entry.name, from), new URL(entry.name, to));
  }
}
const kitDir = (kit) => `kits/${kit.id}@${kit.version}/`;
for (const kit of KITS) {
  const installed = new URL(`node_modules/${kit.id}/`, root);
  const { version } = JSON.parse(readFileSync(new URL('package.json', installed), 'utf8'));
  if (version !== kit.version) throw new Error(`${kit.id}: demos.mjs pins ${kit.version} but ${version} is installed (run npm ci)`);
  copyTree(new URL('dist/', installed), new URL(kitDir(kit), out));
}
// Preload the default kit's modules so the first result does not wait on a
// request chain (page -> app.mjs -> kit -> kit imports).
const first = KITS[0];
const firstFiles = readdirSync(new URL(kitDir(first), out)).filter((f) => f.endsWith('.js'));
const preload = ['app.mjs', 'demos.mjs', 'viz.mjs', ...firstFiles.map((f) => kitDir(first) + f)]
  .map((href) => `<link rel="modulepreload" href="./${href}">`).join('\n');

// Fonts: swap the Google Fonts links for the vendored files.
const googleFonts = /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2[^"]*">\n/;
if (!googleFonts.test(page)) throw new Error('src/page.html font links changed: update tools/build.mjs');
const fontCss = readFileSync(new URL('static/fonts/fonts.css', root), 'utf8');
const bodyFont = fontCss.match(/\/\* latin \*\/\s*@font-face \{\s*font-family: 'Schibsted Grotesk';[^}]*?url\((fonts\/[^)]+\.woff2)\)/);
if (!bodyFont) throw new Error('no latin Schibsted Grotesk file in static/fonts/fonts.css');
page = page.replace(googleFonts, `<link rel="preload" href="./${bodyFont[1]}" as="font" type="font/woff2" crossorigin>\n<style>${fontCss.replace(/^\/\*.*?\*\/\n/, '')}</style>\n`);
mkdirSync(new URL('fonts/', out), { recursive: true });
for (const file of readdirSync(new URL('static/fonts/', root))) {
  if (/\.(woff2|txt)$/.test(file)) copyFileSync(new URL(`static/fonts/${file}`, root), new URL(`fonts/${file}`, out));
}

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
// The page fragment starts with its head material (title, meta, font links and
// the stylesheet). Move that into <head> so crawlers read the metadata.
const split = page.indexOf('</style>') + '</style>'.length;
if (split < '</style>'.length) throw new Error('src/page.html has no </style>');
const headPart = page.slice(0, split);
const bodyPart = page.slice(split);
const site = 'https://lkopietz3-byte.github.io/honesty-kits/';
const jsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'Honesty Kits',
  url: site,
  description: 'Small, dependency-free TypeScript checks for the claims an AI product makes. Try all 12 kits in your browser.',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Any',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  license: 'https://opensource.org/licenses/MIT',
  sameAs: ['https://github.com/lkopietz3-byte/honesty-kits', 'https://www.npmjs.com/package/honesty-mcp'],
});
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="kit-base" content="./kits/">
${preload}
<meta property="og:title" content="Honesty Kits">
<meta property="og:type" content="website">
<meta property="og:url" content="https://lkopietz3-byte.github.io/honesty-kits/">
<meta property="og:image" content="https://lkopietz3-byte.github.io/honesty-kits/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Honesty Kits playground showing a ranking that changed when a partner paid more.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="canonical" href="https://lkopietz3-byte.github.io/honesty-kits/">
<script type="application/ld+json">${jsonLd}</script>
${headPart}
<meta property="og:description" content="Small, dependency-free checks for the claims your AI product makes. Try each one in your browser.">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${bodyPart}
</body>
</html>
`;
writeFileSync(new URL('index.html', out), html);
for (const file of ['app.mjs', 'demos.mjs', 'viz.mjs']) copyFileSync(new URL(file, root), new URL(file, out));
for (const file of ['og.png', 'favicon.svg']) copyFileSync(new URL(`static/${file}`, root), new URL(file, out));
writeFileSync(new URL('.nojekyll', out), '');
// No robots.txt: crawlers only read it at the domain root, not under a project path.
writeFileSync(new URL('sitemap.xml', out), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site}</loc></url>\n</urlset>\n`);
console.log(`built dist/ (index.html, app.mjs, demos.mjs, viz.mjs, ${KITS.length} kits, fonts)`);
