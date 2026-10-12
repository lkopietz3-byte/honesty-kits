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
//        [--widths 375,768,1440] [--kits grounding-kit,trust-core] [--channel chrome]
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KITS } from '../demos.mjs';

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
const widths = (args['--widths'] ?? '375,768,1440').split(',').map(Number);
const heightFor = (w) => (w < 600 ? 812 : w < 1000 ? 1024 : 900);
const PROFILES = [
  { name: 'light', colorScheme: 'light', reducedMotion: 'no-preference' },
  { name: 'dark+reduced-motion', colorScheme: 'dark', reducedMotion: 'reduce' },
];

let browser;
for (const channel of args['--channel'] ? [args['--channel']] : ['chrome', undefined]) {
  try { browser = await chromium.launch({ channel, headless: true }); break; } catch { /* try the next browser */ }
}
if (!browser) { server?.kill(); notRun('no browser could be launched (tried the Chrome channel, then bundled Chromium).'); }

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
const resultReady = (page) => page.waitForFunction(() => { const t = document.querySelector('#result .tone'); return t && !t.classList.contains('tone-loading'); }, null, { timeout: 15000 });
async function openKit(page, id) {
  await page.goto(`${base}#${id}`, { waitUntil: 'networkidle' });
  await resultReady(page);
}

/** Text in result graphics that overlaps other text, or is clipped or cut with an ellipsis. */
const vizIssues = () => {
  const issues = [];
  for (const svg of document.querySelectorAll('#result svg')) {
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
    if (r.width < 44 || r.height < 44) out.push(`${label(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
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
      return { name, visible: outline || shadow };
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
    for (const id of kitIds) {
      try {
        await openKit(page, id);
        if (id === kitIds[0]) { await page.waitForTimeout(800); cls = await page.evaluate(() => window.__cls); }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) overflowKits.push(id);
        for (const t of await page.evaluate(smallTargets)) tapAll.add(t);
        const chips = (await page.$$('#examples .chip')).length;
        for (let i = 0; i < chips; i++) {
          await (await page.$$('#examples .chip'))[i].click();
          await page.waitForTimeout(350);
          examples++;
          const tone = await page.$eval('#result .tone', (t) => t.className);
          if (/tone-(loading|offline|error)/.test(tone)) { bad++; problems.push(`${id} example ${i + 1} shows "${tone.replace('tone ', '')}"`); }
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
    if (tapAll.size) advisory.push(`${label}: ${tapAll.size} controls under 44 px: ${[...tapAll].slice(0, 6).join('; ')}`);
    report(label, problems, `examples=${examples - bad}/${examples} viz-issues=${vizCount} focus-stops=${focus.seen} cls=${cls.toFixed(3)} off-origin=${sink.offOrigin.size} console-errors=${sink.console.size} tap<44=${tapAll.size}`);
    await ctx.close();
  }
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
            for (const chip of (await page.$$('#examples .chip')).slice(0, 2)) await chip.click({ timeout: 5000 });
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
