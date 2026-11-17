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
  assert.match(html, /<meta name="kit-base" content="\.\/kits\/">/);
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
  assert.ok(hrefs.length >= 5, 'has preloads');
  for (const href of hrefs) assert.ok(existsSync(new URL(href, dist)), `preload ${href}`);
  const fontUrls = [...html.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(fontUrls.length >= 12, 'font faces inlined');
  for (const f of fontUrls) assert.ok(existsSync(new URL(f, dist)), `font ${f}`);
  const licenses = readdirSync(new URL('fonts/', dist)).filter((f) => f.startsWith('OFL-'));
  assert.equal(licenses.length, 2, 'both font licenses ship with the fonts');
});

// ---------------------------------------------- focus rings on selected controls
// A selected rail button or pane tab is filled with --ink. Its inset focus ring is
// drawn on that fill, so the ring color must reach 3:1 against it (WCAG 1.4.11)
// in both themes.
test('K10 the inset focus ring on a selected rail button or tab contrasts with its fill', () => {
  const css = readFileSync(new URL('src/page.html', root), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const tokensIn = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const light = tokensIn(css.match(/:root\s*\{([^}]*)\}/)[1]);
  const darkMedia = tokensIn(css.match(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/)[1]);
  const darkPicked = tokensIn(css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)[1]);
  assert.deepEqual(darkMedia, darkPicked, 'both dark-theme blocks define the same colors');
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
  for (const selected of ['.rail button[aria-current="page"]', '.pane-tabs button[aria-selected="true"]']) {
    const fill = varOf(decl(selected, 'background'));
    assert.ok(fill, `${selected} has a background token`);
    const ring = varOf(decl(`${selected}:focus-visible`, 'outline-color')) ?? varOf(decl(`${selected}:focus-visible`, 'outline')) ?? base;
    for (const [theme, t] of [['light', light], ['dark', darkPicked]]) {
      const ratio = contrast(t[ring], t[fill]);
      assert.ok(ratio >= 3, `${theme}: ${selected} focus ring --${ring} on --${fill} is ${ratio.toFixed(2)}:1`);
    }
  }
});
