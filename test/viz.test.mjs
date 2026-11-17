// Draws every result graphic, for every preset and some edge cases, at
// widths from a small phone to a wide desktop, with a minimal stand-in for
// the DOM. Catches layout loops, NaN or undefined coordinates, and labels
// that leave the frame. Without a canvas, viz.mjs measures text as 7px per
// character, so the layout decisions and these checks use the same metric.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KITS } from '../demos.mjs';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.attrs = {}; this.children = []; this.style = {}; this.text = ''; this.className = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(t) { this.text = String(t); }
  get textContent() { return this.text; }
  set innerHTML(h) { this.text = h; }
}
globalThis.document = {
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createElement: (tag) => (tag === 'canvas' ? { getContext: () => null } : new FakeNode(tag)),
  createTextNode: (t) => ({ textContent: t }),
};
globalThis.matchMedia = () => ({ matches: true }); // reduced motion: still frames only
const { renderViz } = await import('../viz.mjs');

const WIDTHS = [280, 300, 330, 360, 420, 520, 700, 960];
// Every node with the x offset its ancestors' translate() transforms add.
const nodesOf = (n, dx = 0) => {
  const t = /translate\(([-\d.]+)/.exec(n.attrs.transform ?? '');
  const x = dx + (t ? Number(t[1]) : 0);
  return [[n, x], ...(n.children ?? []).flatMap((c) => (c instanceof FakeNode ? nodesOf(c, x) : []))];
};

function check(viz, width, where) {
  const fig = renderViz(viz, { width, animate: false });
  assert.ok(fig, `${where}: renders`);
  const svg = fig.children[0];
  if (svg.tagName !== 'svg') return; // the lanes graphic is HTML and wraps itself
  const W = Number(svg.attrs.width);
  const [, , vw, vh] = svg.attrs.viewBox.split(' ').map(Number);
  assert.ok(vw === W && vh > 0 && Number.isFinite(vh), `${where}: viewBox ${svg.attrs.viewBox}`);
  for (const [n, dx] of nodesOf(svg)) {
    for (const [k, v] of Object.entries(n.attrs)) assert.ok(!/NaN|undefined|Infinity/.test(v), `${where}: ${n.tagName} ${k}="${v}"`);
    if (n.tagName !== 'text' || !n.text) continue;
    const x = dx + Number(n.attrs.x), w = n.text.length * 7;
    const anchor = n.attrs['text-anchor'] ?? 'start';
    const [left, right] = anchor === 'end' ? [x - w, x] : anchor === 'middle' ? [x - w / 2, x + w / 2] : [x, x + w];
    assert.ok(left >= -2 && right <= W + 2, `${where}: "${n.text}" spans ${left.toFixed(0)}..${right.toFixed(0)} in width ${W}`);
  }
}

for (const kit of KITS) {
  test(`${kit.id}: graphics fit at every width`, { timeout: 10000 }, async () => {
    const mod = await import(kit.id);
    for (const [i, preset] of kit.presets.entries()) {
      const result = await kit.run(mod, structuredClone(preset.input));
      if (!result.viz) continue;
      for (const width of WIDTHS) check(result.viz, width, `${kit.id} preset ${i} at ${width}px`);
    }
  });
}

test('timeline: items at the same age, or with unknown ages, still get placed', { timeout: 5000 }, () => {
  const items = (labels, age) => labels.map((label, i) => ({ label, ageDays: age, mark: ['ok', 'warn', 'bad'][i % 3] }));
  const thresholds = [{ days: 30, label: 'warn 30d' }, { days: 90, label: 'stale 90d' }];
  const cases = [
    items(['Pricing page', 'Warranty terms', 'Return policy', 'Shipping times'], 45),
    items(['Unknown A', 'Unknown B', 'Unknown C'], null),
    [...items(['Fresh', 'Also fresh'], 1), ...items(['Old', 'Older'], 400)],
  ];
  for (const [i, list] of cases.entries()) {
    for (const width of WIDTHS) check({ type: 'timeline', unit: 'days since last reviewed', items: list, thresholds }, width, `timeline case ${i} at ${width}px`);
  }
});

test('graphics survive empty and minimal inputs', { timeout: 5000 }, () => {
  const cases = [
    { type: 'threads', evidenceIds: [], sentences: [] },
    { type: 'needle', supports: 0, contradicts: 0, direction: 'none' },
    { type: 'timeline', unit: 'days', items: [], thresholds: [] },
    { type: 'slope', base: [], columns: [{ label: 'nobody pays anything', short: 'Nobody pays', order: [], changed: false }] },
    { type: 'slope', base: ['only-one'], columns: [] },
    { type: 'bars', bars: [], baseline: null, percent: false, unit: 'ms' },
    { type: 'bars', bars: [{ label: 'none yet', value: null }], baseline: null, percent: true, unit: '%' },
    { type: 'dial', score: null, flags: { lowSourceCount: false, uniformSentiment: false }, confidence: 'insufficient' },
    { type: 'chain', entries: [], brokenAt: null, kind: null, anchorIndex: null },
    { type: 'budget', spent: 0, next: 0, ceiling: 1, allowed: true },
    { type: 'interval', better: 'higher', claimed: null, display: '0.9', verdict: 'refused', mark: 'warn', interval: null },
    { type: 'interval', better: 'higher', claimed: 0.5, display: '50%', verdict: 'refused', mark: 'warn', interval: null },
  ];
  for (const viz of cases) for (const width of WIDTHS) check(viz, width, `${viz.type} (minimal) at ${width}px`);
});

test('timeline: a very long list still lays out quickly', { timeout: 5000 }, () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ label: `page-${i}`, ageDays: (i * 37) % 400, mark: 'ok' }));
  const started = performance.now();
  check({ type: 'timeline', unit: 'days since last reviewed', items, thresholds: [{ days: 30, label: 'warn 30d' }, { days: 90, label: 'stale 90d' }] }, 700, 'timeline 2000 items');
  assert.ok(performance.now() - started < 1500, `2000 items took ${(performance.now() - started).toFixed(0)} ms`);
});

test('interval: claims at, inside and beyond the band, either direction, at every width', { timeout: 5000 }, () => {
  const iv = (low, high, point, successes, n) => ({ low, high, point, confidence: 0.95, successes, n });
  const cases = [
    { better: 'higher', claimed: 0.98, display: '98%', verdict: 'supported', mark: 'ok', interval: iv(0.98169, 0.99456, 0.99, 990, 1000) },
    { better: 'higher', claimed: 0.995, display: '99.5%', verdict: 'contradicted', mark: 'bad', interval: iv(0.98169, 0.99456, 0.99, 990, 1000) },
    { better: 'higher', claimed: 0.985, display: '98.5%', verdict: 'overstated', mark: 'warn', interval: iv(0.98169, 0.99456, 0.99, 990, 1000) },
    { better: 'lower', claimed: 0.005, display: '0.5%', verdict: 'contradicted', mark: 'bad', interval: iv(0.0054, 0.0183, 0.01, 10, 1000) },
    { better: 'higher', claimed: 1, display: '100%', verdict: 'overstated', mark: 'warn', interval: iv(0.9869, 1, 1, 290, 290) },
    { better: 'higher', claimed: 0.5, display: '50%', verdict: 'supported', mark: 'ok', interval: iv(0.4, 0.6, 0.5, 50, 100) },
    { better: 'higher', claimed: 0.999999, display: '99.9999%', verdict: 'contradicted', mark: 'bad', interval: iv(0.9, 0.9000001, 0.9, 9, 10) },
  ];
  for (const [i, c] of cases.entries()) {
    for (const width of WIDTHS) check({ type: 'interval', ...c }, width, `interval case ${i} at ${width}px`);
  }
});
