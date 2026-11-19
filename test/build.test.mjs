// Builds dist/ and checks what the live site will serve: every kit's published
// files at the tested version, a complete local import graph, vendored fonts,
// and a Content-Security-Policy that allows no third-party requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { KITS } from '../demos.mjs';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
execFileSync(process.execPath, ['tools/build.mjs'], { cwd: root, stdio: 'pipe' });
const html = readFileSync(new URL('index.html', dist), 'utf8');

test('the page loads nothing from other origins', () => {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.ok(csp, 'CSP meta present');
  for (const rule of ["default-src 'none'", "script-src 'self'", "font-src 'self'", "connect-src 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(rule), `CSP has ${rule}`);
  }
  assert.ok(!/https?:\/\/(?!lkopietz3-byte\.github\.io|schema\.org|www\.npmjs\.com|github\.com|opensource\.org|registry)[^"'\s)]*\.(js|mjs|css|woff2?)/.test(html), 'no third-party script, style or font URLs');
  assert.ok(!html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com'), 'fonts are local');
  assert.ok(!html.includes('name="kit-base"'), 'the shell has no unused kit-base metadata');
});

test('every kit is served at the tested version with a complete import graph', () => {
  for (const kit of KITS) {
    const dir = new URL(`kits/${kit.id}@${kit.version}/`, dist);
    assert.ok(existsSync(new URL('index.js', dir)), `${kit.id}@${kit.version}/index.js`);
    // Follow static relative imports from index.js; every target must exist.
    const seen = new Set();
    const walk = (url) => {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      assert.ok(existsSync(url), `${kit.id}: missing ${url.pathname.split('/kits/')[1]}`);
      const src = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? m[2];
        assert.ok(spec.startsWith('.'), `${kit.id}: bare import "${spec}" cannot load in the browser`);
        walk(new URL(spec, url));
      }
    };
    walk(new URL('index.js', dir));
    // Byte-identical to the installed npm package.
    const installed = new URL(`node_modules/${kit.id}/dist/index.js`, root);
    assert.equal(readFileSync(new URL('index.js', dir), 'utf8'), readFileSync(installed, 'utf8'), `${kit.id} index.js matches npm`);
  }
});

test('preloads and fonts point at files that exist', () => {
  const hrefs = [...html.matchAll(/<link rel="(?:modulepreload|preload)" href="\.\/([^"]+)"/g)].map((m) => m[1]);
  for (const file of ['app.mjs', 'demos.mjs', 'viz.mjs']) assert.ok(hrefs.includes(file), `preloads ${file}`);
  assert.ok(!hrefs.some((href) => href.startsWith('kits/')), 'kit code loads only when the check opens');
  for (const href of hrefs) assert.ok(existsSync(new URL(href, dist)), `preload ${href}`);
  const fontUrls = [...html.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(fontUrls.length >= 4, 'Instrument Sans and the Source Serif 4 faces are inlined');
  assert.match(html, /font-family: 'Instrument Sans'/);
  assert.match(html, /font-family: 'Source Serif 4'/);
  assert.equal((html.match(/font-display: swap/g) ?? []).length, fontUrls.length);
  assert.match(html, /font-family: 'Instrument Sans Fallback'/);
  assert.match(html, /font-family: 'Source Serif 4 Fallback'/);
  assert.deepEqual(readdirSync(new URL('static/fonts/', root)).filter((f) => f.endsWith('.woff2')).sort(),
    fontUrls.map((url) => url.slice('fonts/'.length)).sort());
  assert.ok(fontUrls.every((file) => hrefs.includes(file)), 'the local font faces preload');
  for (const f of fontUrls) assert.ok(existsSync(new URL(f, dist)), `font ${f}`);
  const licenses = readdirSync(new URL('fonts/', dist)).filter((f) => f.startsWith('OFL-'));
  assert.deepEqual(licenses.sort(), ['OFL-InstrumentSans.txt', 'OFL-SourceSerif4.txt']);
});

// The desk uses an external focus indicator. Check it against the paper, desk,
// and selection colors that can touch it in both themes.
test('focus rings contrast with the desk and selected controls in both themes', () => {
  const css = readFileSync(new URL('src/page.html', root), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const tokensIn = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const light = tokensIn(css.match(/:root\s*\{([^}]*)\}/)[1]);
  const dark = tokensIn(css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1]);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }));
  const decl = (selector, prop) => {
    let value;
    for (const r of rules) if (r.selectors.includes(selector)) for (const m of r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))) value = m[1].trim();
    return value;
  };
  const varOf = (value) => value?.match(/var\(--([a-z-]+)\)/)?.[1];
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const base = varOf(decl(':focus-visible', 'outline'));
  const fills = [
    'desk', 'paper', 'inset',
    varOf(decl('.kit[aria-current="page"]', 'background')),
    varOf(decl('.chip[aria-pressed="true"]', 'background')),
  ];
  for (const fill of fills) {
    assert.ok(fill, 'has a background token');
    for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
      const ratio = contrast(tokens[base], tokens[fill]);
      assert.ok(ratio >= 3, `${theme}: focus ring --${base} on --${fill} is ${ratio.toFixed(2)}:1`);
    }
  }
});
