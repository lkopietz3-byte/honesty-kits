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
