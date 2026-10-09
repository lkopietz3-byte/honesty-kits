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
