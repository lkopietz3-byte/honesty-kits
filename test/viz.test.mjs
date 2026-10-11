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
  ];
  for (const viz of cases) for (const width of WIDTHS) check(viz, width, `${viz.type} (minimal) at ${width}px`);
});

test('timeline: a very long list still lays out quickly', { timeout: 5000 }, () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ label: `page-${i}`, ageDays: (i * 37) % 400, mark: 'ok' }));
  const started = performance.now();
  check({ type: 'timeline', unit: 'days since last reviewed', items, thresholds: [{ days: 30, label: 'warn 30d' }, { days: 90, label: 'stale 90d' }] }, 700, 'timeline 2000 items');
  assert.ok(performance.now() - started < 1500, `2000 items took ${(performance.now() - started).toFixed(0)} ms`);
});

const graphicNodes = (viz, width = 330) => nodesOf(renderViz(viz, { width, animate: false }).children[0]).map(([node]) => node);
test('HK18: one valid citation stays good beside a failed citation', () => {
  const nodes=graphicNodes({type:'threads',evidenceIds:['e1','e2'],sentences:[{status:'invalid',citedIds:['e1','e2'],validIds:['e1']}]});
  const links=nodes.filter(n=>n.tagName==='path' && /v-line/.test(n.attrs.class));
  assert.ok(links.some(n=>/v-ok/.test(n.attrs.class)));assert.ok(links.some(n=>/v-bad/.test(n.attrs.class)));
});
test('HK20: a zero-dollar budget has finite coordinates and a visible explanation', () => {
  const v={type:'budget',spent:0,next:0,ceiling:0,allowed:true};
  for(const w of WIDTHS)check(v,w,`zero budget at ${w}`);
  assert.ok(graphicNodes(v).some(n=>/zero budget/i.test(n.text)));
});
test('HK21: long chains wrap into positive-width rows', () => {
  const v={type:'chain',entries:Array.from({length:20},(_,i)=>({index:i,hash:'12345678'})),brokenAt:null,kind:null,anchorIndex:19};
  for(const w of WIDTHS) {
    check(v,w,`20-entry chain at ${w}`);
    for(const n of graphicNodes(v,w)) if(n.tagName==='rect')assert.ok(Number(n.attrs.width)>0);
  }
});
test('HK04: vacuous invariance graphics use unchecked labels and marks', () => {
  const v={type:'slope',base:['x'],columns:[{label:'same input',order:['x'],changed:false,vacuous:true}]};
  assert.ok(graphicNodes(v).some(n=>/not tested/.test(n.text)));
  const b={type:'bars',baseline:{label:'base',value:815},unit:'bps',bars:[{label:'68102',value:815,changed:false,vacuous:true}]};
  assert.ok(graphicNodes(b).some(n=>/not tested/.test(n.text)));
});
test('HK15: the sentiment graphic names the absent flag', () => {
  assert.ok(graphicNodes({type:'dial',score:75,flags:{lowSourceCount:false,uniformSentiment:false},confidence:'medium'},700).some(n=>n.text==='Extreme uniformity not flagged'));
});
test('unsafe input stays text in receipt graphics', () => {
  const payload='<img src=x onerror=alert(1)>';
  const fig=renderViz({type:'lanes',allowed:[payload],claimed:[{label:payload,ok:true}],facts:[]},{width:330,animate:false});
  const walk=(n)=>[n,...(n.children??[]).flatMap(walk)];
  assert.ok(walk(fig).some(n=>n.textContent===payload));assert.ok(!walk(fig).some(n=>n.tagName==='img'));
});
