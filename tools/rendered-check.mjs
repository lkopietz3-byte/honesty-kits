// Loads the built playground in a real browser and checks what unit tests cannot:
// layout at several widths, light and dark, requests to other origins, console
// errors, keyboard focus, tap-target size, text collisions in the result graphics,
// layout shift, and (when axe-core is available) accessibility violations.
//
// It adds no dependency to package.json. Playwright and axe-core are found by
// path, the same way tools/demo-gif.mjs finds Playwright; without them it prints
// NOT_RUN and exits 3 (running nothing is not a pass).
//
//   node tools/build.mjs
//   node tools/rendered-check.mjs --playwright-root <dir containing playwright's index.mjs> \
//        [--axe <axe.min.js, or the axe-core folder>] [--url <already running page>] \
//        [--widths 390,768,1280] [--kits grounding-kit,trust-core] [--channel chrome] \
//        [--screenshots <directory for viewport screenshots>]
//
// Without --url it serves dist/ itself with tools/serve.mjs on a free local port.
// Exit codes: 0 every check passed, 1 a check failed, 3 NOT_RUN (a tool was missing).
//
// Two browser contexts are used. The first enforces the page's Content-Security-Policy
// and runs the layout, focus, tap-size and example checks. The second turns the policy
// off (bypassCSP) so it can inject axe, and logs every request the page's own code
// tries to make: that shows the page asks for nothing off-origin, instead of relying
// on the policy to hide it.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_KIT, KITS } from '../demos.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
const notRun = (why) => { console.log(`NOT_RUN: ${why}`); process.exit(3); };

// ---------------------------------------------------------------- tools
let pw;
try {
  pw = args['--playwright-root'] ? await import(pathToFileURL(path.join(args['--playwright-root'], 'index.mjs')).href) : await import('playwright');
} catch (error) {
  notRun(`Playwright not found (${error.code ?? error.message}). Pass --playwright-root <dir containing index.mjs>.`);
}
const { chromium } = pw.default ?? pw;

let axeSource = null;
{
  const candidates = [];
  if (args['--axe']) candidates.push(args['--axe'], path.join(args['--axe'], 'axe.min.js'), path.join(args['--axe'], 'node_modules/axe-core/axe.min.js'));
  try { candidates.push(createRequire(import.meta.url).resolve('axe-core/axe.min.js')); } catch { /* not installed here */ }
  const found = candidates.find((file) => existsSync(file) && statSync(file).isFile());
  if (found) axeSource = readFileSync(found, 'utf8');
}

// ---------------------------------------------------------------- server
let server = null;
let base = args['--url'];
if (!base) {
  if (!existsSync(path.join(root, 'dist/index.html'))) notRun('dist/index.html is missing. Run "node tools/build.mjs" first.');
  server = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => { const m = String(chunk).match(/(http:\/\/127\.0\.0\.1:\d+\/)/); if (m) resolve(m[1]); });
    server.on('exit', (code) => reject(new Error(`serve.mjs exited with ${code}`)));
  });
}
if (!base.endsWith('/')) base += '/';
const origin = new URL(base).origin;

const kitIds = (args['--kits'] ? args['--kits'].split(',') : KITS.map((k) => k.id));
const widths = (args['--widths'] ?? '390,768,1280').split(',').map(Number);
const heightFor = (w) => (w < 600 ? 844 : w < 1000 ? 1024 : 900);
const PROFILES = [
  { name: 'light', colorScheme: 'light', reducedMotion: 'no-preference' },
  { name: 'dark+reduced-motion', colorScheme: 'dark', reducedMotion: 'reduce' },
];

let browser;
for (const channel of args['--channel'] ? [args['--channel']] : ['chrome', undefined]) {
  try { browser = await chromium.launch({ channel, headless: true }); break; } catch { /* try the next browser */ }
}
if (!browser) { server?.kill(); notRun('no browser could be launched (tried the Chrome channel, then bundled Chromium).'); }
const screenshotDir = args['--screenshots'] ? path.resolve(args['--screenshots'])
  : mkdtempSync(path.join(tmpdir(), 'honesty-kits-rendered-'));
mkdirSync(screenshotDir, { recursive: true });

// ---------------------------------------------------------------- helpers
const failures = [];
const lines = [];
const advisory = [];
const skipped = []; // checks that did not run; any entry means the run is NOT_RUN (exit 3), never a pass
function report(label, problems, detail) {
  const status = problems.length ? 'FAIL' : 'PASS';
  lines.push(`${status}  ${label}  ${detail}`);
  console.log(`${status}  ${label}  ${detail}`);
  for (const p of problems) { failures.push(`${label}: ${p}`); console.log(`        - ${p}`); }
}

function watch(page, sink) {
  page.on('request', (r) => {
    const u = new URL(r.url());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin) sink.offOrigin.add(r.url());
  });
  page.on('requestfailed', (r) => sink.failed.add(`${r.url().replace(origin, '')} (${r.failure()?.errorText ?? 'failed'})`));
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy/i.test(m.text())) sink.console.add(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => sink.console.add(`page error: ${e.message.slice(0, 200)}`));
}
const newSink = () => ({ offOrigin: new Set(), failed: new Set(), console: new Set() });
const resultReady = (page) => page.waitForFunction(() => { const t = document.querySelector('#verdict .tone'); return t && !t.classList.contains('tone-loading'); }, null, { timeout: 15000 });
async function openKit(page, id) {
  await page.goto(`${base}#${id}`, { waitUntil: 'networkidle' });
  await resultReady(page);
}

/** Text in result graphics that overlaps other text, or is clipped or cut with an ellipsis. */
const vizIssues = () => {
  const issues = [];
  for (const svg of document.querySelectorAll('#result-details svg')) {
    const box = svg.getBoundingClientRect();
    if (box.width < 60) continue;
    const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim() && getComputedStyle(t).display !== 'none' && getComputedStyle(t).visibility !== 'hidden' && Number(getComputedStyle(t).opacity) > 0.05);
    const rects = texts.map((t) => ({ t: t.textContent.trim().slice(0, 24), b: t.getBoundingClientRect() }));
    for (let a = 0; a < rects.length; a++) {
      const A = rects[a].b;
      if (A.left < box.left - 1 || A.right > box.right + 1) issues.push(`clipped "${rects[a].t}"`);
      if (rects[a].t.endsWith('…')) issues.push(`truncated "${rects[a].t}"`);
      for (let c = a + 1; c < rects.length; c++) {
        const B = rects[c].b;
        const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left);
        const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
        if (ox > 1.5 && oy > 1.5) issues.push(`overlap "${rects[a].t}" x "${rects[c].t}"`);
      }
    }
  }
  return [...new Set(issues)];
};

/** Visible controls smaller than 44 px in either direction (inline links are exempt). */
const smallTargets = () => {
  const out = [];
  const label = (e) => (e.id ? `#${e.id}` : (e.getAttribute('aria-label') || e.textContent || e.className || e.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 28));
  for (const e of document.querySelectorAll('button, [role=tab], select, input:not([type=hidden]), textarea, summary, a[href]')) {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (e.closest('[hidden], dialog:not([open]), .visually-hidden')) continue;
    if (e.tagName === 'A' && cs.display === 'inline') continue;
    const hit = e.matches('.cite') ? getComputedStyle(e, '::after') : null;
    const height = hit?.content === '""' && hit.position === 'absolute' ? r.height - parseFloat(hit.top) - parseFloat(hit.bottom) : r.height;
    if (r.width < 44 || height < 44) out.push(`${label(e)} ${Math.round(r.width)}x${Math.round(height)}`);
  }
  return out;
};

/** Tab through the page; every stop must show a focus indicator. */
async function focusWalk(page, stops = 30) {
  const missing = [];
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  let seen = 0;
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && cs.outlineColor !== 'rgba(0, 0, 0, 0)';
      const shadow = cs.boxShadow !== 'none';
      const name = e.id ? `#${e.id}` : (e.getAttribute('aria-label') || e.textContent || e.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 28);
      const rect = e.getBoundingClientRect();
      const ring = outline ? Math.max(0, parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset)) : 0;
      let clipped = false;
      for (let parent = e.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        const left = bounds.left + parent.clientLeft, top = bounds.top + parent.clientTop;
        if (style.overflowX !== 'visible' && parent.clientWidth > rect.width + 2 * ring
            && (rect.left - ring < left - 1 || rect.right + ring > left + parent.clientWidth + 1)) clipped = true;
        if (style.overflowY !== 'visible' && parent.clientHeight > rect.height + 2 * ring
            && (rect.top - ring < top - 1 || rect.bottom + ring > top + parent.clientHeight + 1)) clipped = true;
      }
      return { name, visible: (outline || shadow) && !clipped };
    });
    if (!info) continue;
    seen++;
    if (!info.visible) missing.push(info.name);
  }
  return { seen, missing: [...new Set(missing)] };
}

// ---------------------------------------------------------------- 1. layout, examples, focus, tap size
for (const width of widths) {
  for (const profile of PROFILES) {
    const label = `${width}px ${profile.name}`;
    const ctx = await browser.newContext({ viewport: { width, height: heightFor(width) }, colorScheme: profile.colorScheme, reducedMotion: profile.reducedMotion });
    await ctx.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    const page = await ctx.newPage();
    const sink = newSink();
    watch(page, sink);
    const problems = [];
    let examples = 0, bad = 0, overflowKits = [], vizCount = 0, tapAll = new Set(), cls = 0;
    // Force the shell, fallback fonts and skeleton to paint on a cold visit.
    const assets = /\.(?:woff2|mjs|js)$/;
    const slow = async (route) => {
      const url = route.request().url();
      await new Promise((resolve) => setTimeout(resolve, url.endsWith('.woff2') ? 700 : 325));
      await route.continue();
    };
    await page.route(assets, slow);
    await page.goto(base, { waitUntil: 'networkidle' });
    await resultReady(page);
    await page.evaluate(() => document.fonts.ready);
    cls = await page.evaluate(() => window.__cls);
    await page.unroute(assets, slow);
    for (const id of kitIds) {
      try {
        await openKit(page, id);
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) overflowKits.push(id);
        if (width === 1280) {
          await page.locator('#sheet-body').evaluate((body) => { body.scrollTop = 0; window.scrollTo(0, 0); });
          const inView = await page.locator('#limit-slot .limit').evaluate((limit) => {
            const r = limit.getBoundingClientRect();
            const pane = document.getElementById('sheet-body').getBoundingClientRect();
            return r.top >= pane.top && r.bottom <= Math.min(pane.bottom, innerHeight) + 1;
          });
          if (!inView) problems.push(`${id}: the limit is outside the 1280×900 sheet viewport`);
        }
        for (const t of await page.evaluate(smallTargets)) tapAll.add(t);
        const chips = await page.$$('#examples .preset-chip');
        for (const [i, chip] of chips.entries()) {
          await chip.click();
          await page.waitForTimeout(350);
          examples++;
          const tone = await page.$eval('#verdict .tone', (t) => t.className);
          if (/tone-(loading|offline|error)/.test(tone)) { bad++; problems.push(`${id} example ${i + 1} shows "${tone.replace('tone ', '')}"`); }
          const graphic = page.locator('#result-details .graphic');
          if (await graphic.count()) {
            if (!(await graphic.evaluate((node) => node.open))) await graphic.locator('summary').click();
            await graphic.locator('.viz').waitFor();
          }
          const issues = await page.evaluate(vizIssues);
          vizCount += issues.length;
          if (issues.length) problems.push(`${id} example ${i + 1}: ${issues.slice(0, 3).join('; ')}`);
        }
      } catch (error) {
        problems.push(`${id}: ${error.message.split('\n')[0]}`);
      }
    }
    await openKit(page, kitIds[0]);
    const focus = await focusWalk(page);
    if (focus.seen === 0) problems.push('keyboard focus never reached a control');
    if (focus.missing.length) problems.push(`no visible focus on: ${focus.missing.join(', ')}`);
    if (overflowKits.length) problems.push(`horizontal scroll on: ${overflowKits.join(', ')}`);
    if (cls > 0.1) problems.push(`layout shift on load ${cls.toFixed(3)} (limit 0.1)`);
    if (sink.console.size) problems.push(`console errors: ${[...sink.console].slice(0, 3).join(' | ')}`);
    if (sink.offOrigin.size) problems.push(`requests to other origins: ${[...sink.offOrigin].slice(0, 3).join(', ')}`);
    if (sink.failed.size) problems.push(`failed requests: ${[...sink.failed].slice(0, 3).join(', ')}`);
    if (width <= 640 && tapAll.size) problems.push(`${label}: ${tapAll.size} controls under 44 px: ${[...tapAll].slice(0, 6).join('; ')}`);
    report(label, problems, `examples=${examples - bad}/${examples} viz-issues=${vizCount} focus-stops=${focus.seen} cls=${cls.toFixed(3)} off-origin=${sink.offOrigin.size} console-errors=${sink.console.size} tap<44=${tapAll.size}`);
    await ctx.close();
  }
}

// These actions must remain visible and tabbable once the cold-load state ends.
for (const width of [390, 768]) {
  for (const profile of PROFILES) {
    const page = await browser.newPage({ viewport: { width, height: heightFor(width) }, colorScheme: profile.colorScheme });
    const checks = [];
    const file = path.join(screenshotDir, `footer-${width}-${profile.colorScheme}.png`);
    try {
      await page.goto(base, { waitUntil: 'networkidle' });
      await resultReady(page);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(screenshotDir, `numbers-${width}-${profile.colorScheme}.png`), fullPage: false });
      const ids = ['copy-link', 'copy-report', 'view-code', ...(width === 390 ? ['open-agent-phone'] : [])];
      const unreached = new Set(ids);
      for (let i = 0; i < 60 && unreached.size; i++) {
        await page.keyboard.press('Tab');
        unreached.delete(await page.evaluate(() => document.activeElement?.id));
      }
      if (unreached.size) checks.push(`Tab did not reach: ${[...unreached].join(', ')}`);
      await page.locator('.sheet-foot').evaluate((footer) => footer.scrollIntoView({ block: 'end' }));
      await page.screenshot({ path: file, fullPage: false });
      const covered = await page.evaluate((buttons) => buttons.filter((id) => {
        const button = document.getElementById(id);
        const rect = button.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return !button.contains(target);
      }), ids);
      if (covered.length) checks.push(`The viewport does not hit: ${covered.join(', ')}`);
    } catch (error) {
      checks.push(error.message.split('\n')[0]);
    }
    report(`loaded footer ${width}px ${profile.name}`, checks, file);
    await page.close();
  }
}

// The default and a v1 fragment load only the selected kit's modules.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const requests = new Set();
  const page = await ctx.newPage();
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(/\/kits\/([^/@]+)@/);
    if (match) requests.add(match[1]);
  });
  const problems = [];
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await resultReady(page);
    if (await page.locator('#kit-title').textContent() !== 'Numbers') problems.push('Numbers did not open by default');
    const noteTitles = await page.locator('#result .row').first().locator('.note strong').evaluateAll((notes) =>
      notes.map((note) => [...note.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('')));
    if (JSON.stringify(noteTitles) !== JSON.stringify(['$1,299.00', '8.3%'])) problems.push(`wrong Numbers note titles: ${noteTitles.join(', ')}`);
    if (!(await page.locator('#stamp').evaluate((node) => node.classList.contains('tone-fail') && node.getBoundingClientRect().bottom < innerHeight))) {
      problems.push('the failing verdict was outside the first phone screen');
    }
    if (!(await page.locator('#result .row').first().evaluate((row) => row.getBoundingClientRect().bottom <= innerHeight))) {
      problems.push('the first marked Numbers sentence and its note were outside the first phone screen');
    }
    if ([...requests].join() !== DEFAULT_KIT) problems.push(`unexpected initial kit requests: ${[...requests].join(', ')}`);
    await page.locator('#skip-result').focus();
    await page.keyboard.press('Enter');
    if (!(await page.locator('#kit-title').evaluate((title) => title === document.activeElement))) problems.push('the skip link did not focus the result');
    const picker = page.locator('#picker-toggle');
    await picker.click();
    await page.locator('#nav-number-trace-kit').focus();
    await page.keyboard.press('Escape');
    if (await picker.getAttribute('aria-expanded') !== 'false' ||
      !(await picker.evaluate((toggle) => toggle === document.activeElement))) problems.push('Escape did not close the phone picker and restore focus');
    if (await page.locator('#sheet-body').getAttribute('tabindex') !== null) problems.push('the phone sheet is a redundant tab stop');

    // A v1 share token uses the old field names and document shape.
    const input = { text: 'A saved answer [[cite:e1]].', evidence: { e1: 'A saved answer from the old playground.' } };
    const token = Buffer.from(JSON.stringify({ v: 1, input })).toString('base64url');
    await openKit(page, `grounding-kit~${token}`);
    if (await page.inputValue('#f-grounding-kit-text') !== input.text) problems.push('the old Citations link lost its draft');
    if (await page.locator('.source-text').inputValue() !== input.evidence.e1) problems.push('the old Citations link lost its evidence');
    if ([...requests].sort().join() !== ['grounding-kit', DEFAULT_KIT].sort().join()) problems.push('switching checks imported an unrelated kit');
    if (await page.locator('#f-grounding-kit-text').isVisible()) problems.push('the draft textarea duplicates the result by default');
    await page.locator('#edit-draft').click();
    if (!(await page.locator('#f-grounding-kit-text').isVisible()) || await page.locator('#result .rows').isVisible()) {
      problems.push('the draft editor did not replace the rows');
    }
    await page.getByRole('button', { name: 'Check it' }).click();
    await page.locator('#result .row').first().waitFor({ state: 'visible' });

    for (const [index, id] of ['e1', 'e2'].entries()) {
      await page.locator(`#trial-${index}`).click();
      await page.getByText(`Cited; words overlap with ${id}`, { exact: false }).waitFor();
      if ((await page.locator('#stamp').textContent()) !== 'No structural problems'
          || !(await page.locator('#stamp').evaluate((stamp) => stamp.classList.contains('tone-info')))) problems.push(`trial ${id} had an incorrect stamp`);
      if ((await page.locator(`#trial-${index}`).getAttribute('aria-pressed')) !== 'true') problems.push(`trial ${id} did not stay pressed`);
      const callout = page.locator('.trial-callout');
      if (!(await callout.textContent()).includes(`This contradicts ${id} and still passes.`)) problems.push(`trial ${id} lacks a contradiction callout`);
      if ((await callout.locator('blockquote').textContent()) !== KITS.find((kit) => kit.id === 'grounding-kit').presets[0].input.evidence[id]) {
        problems.push(`trial ${id} did not quote its source`);
      }
      // The page scrolls smoothly, so give the scroll up to 2 s to settle before judging where the row is.
      const rowInView = await page.waitForFunction(() => {
        const row = document.querySelector('#result .row');
        if (!row) return false;
        const r = row.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }, null, { timeout: 2000 }).then(() => true, () => false);
      if (!rowInView) problems.push(`trial ${id} did not scroll to the affected row`);
      if (/backed|passed|all \d+ fixed/i.test(await page.locator('#result').innerText())) problems.push(`trial ${id} overstated its result`);
    }
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    await page.locator('#f-grounding-kit-evidence').fill('{');
    await page.getByText('Fix the marked input to check it again.').waitFor();
    await page.locator('#f-grounding-kit-evidence').fill(JSON.stringify(input.evidence));
    await page.getByRole('button', { name: 'Show source cards' }).click();
    if (await page.locator('.source-text').inputValue() !== input.evidence.e1) problems.push('valid JSON did not round-trip to the evidence card');
  } catch (error) {
    problems.push(error.message.split('\n')[0]);
  }
  report('default check, old share, citation limits and recovery', problems, `modules=${[...requests].join(',')}`);
  await ctx.close();
}

// Simple fields and record cards can round-trip through their JSON editors.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  try {
    await openKit(page, 'accuracy-claim-kit');
    await page.locator('#accuracy-figure').fill('98%');
    await page.waitForFunction(() => document.querySelector('#stamp').classList.contains('tone-pass'));
    const suggested = page.locator('.suggestion blockquote');
    if (!(await suggested.textContent()).includes('98.16% to 99.46%')) problems.push('the copyable statement lost the kit’s bounds');
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    const raw = page.locator('#f-accuracy-claim-kit-evidence');
    const evidence = JSON.parse(await raw.inputValue());
    evidence.provenance.raters = 3;
    await raw.fill(JSON.stringify(evidence));
    await page.getByRole('button', { name: 'Show fields' }).click();
    await page.locator('#accuracy-correct').fill('989');
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    const changed = JSON.parse(await raw.inputValue());
    if (changed.sample.correct !== 989 || changed.provenance.raters !== 3) problems.push('the plain fields lost values from the JSON');

    await openKit(page, 'claims-registry-kit');
    await page.locator('#f-claims-registry-kit-claims-0-text').fill('An edited site claim');
    await page.getByText('An edited site claim', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    const claims = page.locator('#f-claims-registry-kit-claims');
    if (JSON.parse(await claims.inputValue())[0].text !== 'An edited site claim') problems.push('the claim card did not update the JSON');
    await page.getByRole('button', { name: 'Show cards' }).click();
    if (await page.locator('#f-claims-registry-kit-claims-0-text').inputValue() !== 'An edited site claim') problems.push('the claim card lost its edit on return');

    await openKit(page, 'provenance-kit');
    await page.getByRole('button', { name: 'Carefully worded copy' }).click();
    await page.locator('#stamp.tone-info').filter({ hasText: 'No listed phrase found' }).waitFor();
    const wordingResult = page.locator('#result');
    if (await wordingResult.locator('use[href="#i-ok"]').count() || /passed/i.test(await wordingResult.textContent())) {
      problems.push('Certainty wording displayed approval for a phrase-list check');
    }

    await openKit(page, 'cost-governor-kit');
    if (await page.locator('#fields input[type=number]:visible').count() !== 6) problems.push('AI spend cap does not show six number fields');
    const inputPrice = page.locator('#f-cost-governor-kit-rates-inputPerMillion');
    await inputPrice.fill('4');
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    const rates = page.locator('#f-cost-governor-kit-rates');
    const call = page.locator('#f-cost-governor-kit-nextCall');
    if (JSON.parse(await rates.inputValue()).inputPerMillion !== 4 || JSON.parse(await call.inputValue()).cacheReadTokens !== 8000) {
      problems.push('the budget editor lost the new input price or the existing reused tokens');
    }
    await rates.fill('{');
    await page.getByRole('button', { name: 'Show number fields' }).click();
    if (!(await rates.isVisible()) || await rates.getAttribute('aria-invalid') !== 'true') problems.push('invalid JSON closed the budget editor');
    await rates.fill(JSON.stringify({ inputPerMillion: 5, outputPerMillion: 15, cacheReadPerMillion: 0.4 }));
    await page.getByRole('button', { name: 'Show number fields' }).click();
    if (await inputPrice.inputValue() !== '5') problems.push('the budget editor lost the JSON input price');
    await inputPrice.fill('6');
    await page.getByRole('button', { name: 'Edit as JSON' }).click();
    if (JSON.parse(await rates.inputValue()).cacheReadPerMillion !== 0.4) problems.push('the budget form deleted a custom reuse price');

    await openKit(page, 'freshness-kit');
    if (await page.locator('#fields input[type=number]:visible').count() !== 2) problems.push('Freshness labels does not show two number fields');
    await page.getByLabel('Warn after this many days').fill('3');
    await page.getByText('This information was last checked 7 days ago.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit as JSON', exact: true }).first().click();
    const thresholds = page.locator('#f-freshness-kit-config');
    if (JSON.parse(await thresholds.inputValue()).warnAfterDays !== 3) problems.push('the freshness threshold was not updated');

    for (const id of ['advice-ledger-kit', 'agent-receipt-kit', 'mutation-invariance-kit', 'payout-invariance-kit']) {
      await openKit(page, id);
      const inputs = page.locator('#fields');
      if (await inputs.isVisible() || !(await page.locator('.situation').isVisible())) problems.push(`${id} did not open with an example situation and collapsed inputs`);
      await page.getByRole('button', { name: 'Edit inputs' }).click();
      if (!(await inputs.isVisible())) problems.push(`${id} inputs did not open`);
    }
  } catch (error) {
    problems.push(error.message.split('\n')[0]);
  }
  report('structured inputs and JSON round trip', problems, 'Accuracy, Claims, AI spend cap, Freshness and four collapsed editors');
  await page.close();
}

// First-screen evidence and the short laptop layout.
{
  const checks = [];
  const page = await browser.newPage();
  for (const [width, height] of [[1280, 900], [1440, 789], [1366, 768], [1280, 720], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    for (const id of width === 1440 || height === 900 ? [DEFAULT_KIT, 'grounding-kit'] : [DEFAULT_KIT]) {
      await openKit(page, id);
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => {
        const sheet = document.getElementById('sheet-body');
        sheet.scrollTop = 0;
        const pane = sheet.getBoundingClientRect();
        const source = document.querySelector('#fields .source-card').getBoundingClientRect();
        return {
          oneScreen: document.documentElement.scrollHeight === innerHeight,
          sourceVisible: source.top >= pane.top && source.bottom <= Math.min(pane.bottom, innerHeight) + 1,
          installSize: parseFloat(getComputedStyle(document.querySelector('.install code')).fontSize),
          scrollFocus: sheet.scrollHeight <= sheet.clientHeight + 1 || sheet.tabIndex === 0,
        };
      });
      if (!layout.oneScreen) checks.push(`${width}×${height} ${id}: the page exceeds one viewport`);
      if ((width === 1440 || height === 900 || width === 1366) && !layout.sourceVisible) checks.push(`${width}×${height} ${id}: the first source card is not fully visible`);
      if (layout.installSize < 12) checks.push(`${width}×${height} ${id}: install text is ${layout.installSize}px`);
      if (width === 1440 || height === 900 || width === 1366) {
        await page.screenshot({ path: path.join(screenshotDir, `${id}-${width}x${height}.png`), fullPage: false });
        if (width === 1280) {
          await page.emulateMedia({ colorScheme: 'dark' });
          await page.screenshot({ path: path.join(screenshotDir, `${id}-${width}x${height}-dark.png`), fullPage: false });
          await page.emulateMedia({ colorScheme: 'light' });
        }
      }
      if (!layout.scrollFocus) checks.push(`${width}×${height} ${id}: the scrolling sheet is not reachable by Tab`);
    }
  }
  await openKit(page, DEFAULT_KIT);
  const badge = page.locator('#result .cite').first();
  const source = page.locator('#fields .source-card').first();
  await badge.focus();
  if (!(await source.evaluate((card) => card.classList.contains('is-linked')))) checks.push('focusing the source chip did not highlight the card');
  await source.getByRole('button', { name: 'Edit', exact: true }).focus();
  if (!(await badge.evaluate((chip) => chip.classList.contains('is-linked')))) checks.push('focusing the source card did not highlight the chip');
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  if (!(await page.locator('#f-number-trace-kit-evidence').isVisible())) checks.push('the Numbers source editor did not open');
  report('short laptops and linked sources', checks, '1280×900, 1440×789, 1366×768, 1280×720, 1024×768');
  await page.close();
}

// Abort an entry import, then retry it with and without connectivity.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const problems = [];
  try {
    await page.route(/\/kits\/grounding-kit@[^/]+\/index\.js$/, (route) => route.abort());
    await openKit(page, 'grounding-kit');
    await page.locator('.retry').waitFor();
    await page.evaluate(() => { window.__samePage = true; });
    await ctx.setOffline(true);
    await page.locator('.retry').click();
    await page.getByText('You still appear to be offline.').waitFor();
    await ctx.setOffline(false);
    await page.locator('.retry').click();
    await page.locator('#result .row').first().waitFor();
    if (!(await page.evaluate(() => window.__samePage))) problems.push('a recoverable import failure reloaded the document');
  } catch (error) {
    problems.push(error.message.split('\n')[0]);
  }
  report('offline and in-place retry', problems, 'Citations');
  await ctx.close();
}

// ---------------------------------------------------------------- 2. header and page overflow, 300 to 1300 px
{
  const ctx = await browser.newContext({ viewport: { width: 300, height: 800 } });
  const page = await ctx.newPage();
  await openKit(page, kitIds[0]);
  const bad = [];
  for (let w = 300; w <= 1300; w += 10) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(40);
    const r = await page.evaluate(() => {
      const bar = document.querySelector('.top')?.getBoundingClientRect();
      const acts = [...document.querySelectorAll('.top-actions > *')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.getBoundingClientRect().right);
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, actionsEnd: acts.length ? Math.max(...acts) : 0, barEnd: bar ? bar.right : innerWidth };
    });
    if (r.sw > r.iw || r.actionsEnd > r.barEnd + 0.5) bad.push(`${w}px (page ${r.sw}/${r.iw}, header actions end ${Math.round(r.actionsEnd)} vs bar ${Math.round(r.barEnd)})`);
  }
  report('overflow sweep 300-1300px (step 10)', bad.length ? [`overflow at ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}`] : [], `widths=${(1300 - 300) / 10 + 1}`);
  await ctx.close();
}

// ---------------------------------------------------------------- 3. network audit and axe, Content-Security-Policy off
{
  const networkSink = newSink();
  let axeStates = 0;
  const axeFound = new Map();
  for (const profile of PROFILES) {
    for (const width of widths) {
      const ctx = await browser.newContext({ viewport: { width, height: heightFor(width) }, colorScheme: profile.colorScheme, reducedMotion: profile.reducedMotion, bypassCSP: true });
      const page = await ctx.newPage();
      watch(page, networkSink);
      for (const id of [...kitIds, 'add-to-agent']) {
        try {
          await page.goto(`${base}#${id}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(id === 'add-to-agent' ? 600 : 1000);
          if (profile === PROFILES[0] && id !== 'add-to-agent') {
            // Exercise the page's own code paths so any request they make would be logged.
            // A click that cannot happen fails this state (the catch below); it is not swallowed.
            for (const chip of (await page.$$('#examples .preset-chip')).slice(0, 2)) await chip.click({ timeout: 5000 });
            await page.waitForTimeout(1500); // let the result graphic's fade-in finish before axe measures colors
          }
          if (axeSource) {
            await page.addScriptTag({ content: axeSource });
            const violations = await page.evaluate(async () => {
              const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
              return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 2).map((n) => `${n.target.join(' ')} (${(n.any[0]?.message ?? '').slice(0, 140)})`) }));
            });
            axeStates++;
            for (const v of violations) {
              if (!axeFound.has(v.id)) axeFound.set(v.id, { ...v, where: new Set() });
              axeFound.get(v.id).where.add(`${width}px ${profile.name} #${id}`);
            }
          }
          if (id === 'add-to-agent') {
            // The dialog makes the page behind it inert, so test its own controls here.
            if (!(await page.$eval('#agent-dialog', (d) => d.open))) throw new Error('the agent dialog did not open from #add-to-agent');
            await page.click('#close-agent', { timeout: 5000 });
            if (await page.$eval('#agent-dialog', (d) => d.open)) throw new Error('the agent dialog did not close');
          }
        } catch (error) {
          failures.push(`network/dialog/axe ${width}px ${profile.name} #${id}: ${error.message.split('\n')[0]}`);
        }
      }
      await ctx.close();
    }
  }
  report('network audit (CSP off)', [...(networkSink.offOrigin.size ? [`requests to other origins: ${[...networkSink.offOrigin].slice(0, 5).join(', ')}`] : []), ...(networkSink.console.size ? [`console errors: ${[...networkSink.console].slice(0, 3).join(' | ')}`] : [])], `off-origin=${networkSink.offOrigin.size} console-errors=${networkSink.console.size}`);
  if (!axeSource) {
    console.log('NOT_RUN  axe: axe-core not found (pass --axe <axe.min.js or the axe-core folder>)');
    lines.push('NOT_RUN  axe');
    skipped.push('axe-core (not found; pass --axe <axe.min.js or the axe-core folder>)');
  } else {
    report('axe-core (wcag2a, 2aa, 21aa, 22aa, best-practice)', [...axeFound.values()].map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.where.size} states, e.g. ${[...v.where][0]}; ${v.targets.join(', ')})`), `states=${axeStates} violations=${axeFound.size}`);
  }
}

await browser.close();
server?.kill();
console.log('');
if (advisory.length) { console.log('Advisory (not a failure):'); advisory.forEach((a) => console.log(`  ${a}`)); }
if (failures.length) {
  console.log(`\nFAIL: ${failures.length} problem(s)${skipped.length ? `; also NOT_RUN: ${skipped.join('; ')}` : ''}`);
  process.exit(1);
}
if (skipped.length) {
  console.log(`\nNOT_RUN: ${skipped.length} check(s) did not run (${skipped.join('; ')}). The checks that ran passed, but this is not a full pass.`);
  process.exit(3);
}
console.log('\nPASS: every rendered check passed');
process.exit(0);
