// Builds dist/ for a static host (GitHub Pages): wraps src/page.html in a full
// HTML document and copies the two modules next to it. No bundler, no deps.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
mkdirSync(out, { recursive: true });
const page = readFileSync(new URL('src/page.html', root), 'utf8');
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
console.log('built dist/ (index.html, app.mjs, demos.mjs, viz.mjs)');
