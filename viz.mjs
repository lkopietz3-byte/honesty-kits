// Result graphics. Each one is drawn from a kit's real output (the `viz`
// object a demo returns), at the panel's actual pixel width, on true scales.
//
// Motion grammar (shared with the specimen studio): arrivals ease out
// (out-cubic), 120 ms for small marks, 240 ms for state changes, 600 ms for a
// stage transition, one moving focus at a time. Every graphic's resting frame
// carries the full meaning, so reduced motion simply shows that frame.

const NS = 'http://www.w3.org/2000/svg';
const OUT = 'cubic-bezier(0.33, 1, 0.68, 1)';
const GLYPH = { ok: '✓', bad: '✕', warn: '!', info: 'i', skip: '–' };

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function node(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}
function add(parent, tag, attrs, text) {
  const n = node(tag, attrs, text);
  parent.append(n);
  return n;
}
function frame(width, height, label) {
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': label, class: 'viz-svg' });
  return svg;
}
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Text is measured with the page's own fonts (canvas measureText), so labels
// can wrap, flip sides or shorten before they collide or leave the frame.
const FONTS = {
  caption: ["10px 'IBM Plex Mono', ui-monospace, monospace", 0.8],
  tick: ["10.5px 'IBM Plex Mono', ui-monospace, monospace", 0],
  label: ["12px 'Schibsted Grotesk', system-ui, sans-serif", 0],
  tag: ["600 11.5px 'Schibsted Grotesk', system-ui, sans-serif", 0],
  strong: ["600 13px 'Schibsted Grotesk', system-ui, sans-serif", 0],
};
let ctx2d;
function measure(text, kind) {
  const [font, spacing] = FONTS[kind];
  ctx2d ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!ctx2d) return text.length * 7;
  ctx2d.font = font;
  return ctx2d.measureText(text).width + spacing * text.length;
}
function fit(text, maxWidth, kind) {
  if (measure(text, kind) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`, kind) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
/** Word-wrap into at most `maxLines` lines no wider than `maxWidth`. */
function wrap(text, maxWidth, kind, maxLines = 2) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (!line || measure(next, kind) <= maxWidth) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(' '));
  return lines.map((l) => fit(l, maxWidth, kind));
}

/** Animate only when asked and allowed; the element's own attributes are the resting frame. */
function play(motion, el, keyframes, { duration = 240, delay = 0 } = {}) {
  if (!motion.on || typeof el.animate !== 'function') return;
  el.animate(keyframes, { duration, delay: motion.base + delay, easing: OUT, fill: 'backwards' });
}
function drawIn(motion, path, duration, delay) {
  if (!motion.on || typeof path.getTotalLength !== 'function') return;
  const length = path.getTotalLength();
  if (!length) return;
  path.animate([{ strokeDasharray: `${length}`, strokeDashoffset: length }, { strokeDasharray: `${length}`, strokeDashoffset: 0 }],
    { duration, delay: motion.base + delay, easing: OUT, fill: 'backwards' });
}
function glyphBadge(parent, x, y, mark, size = 16) {
  const g = add(parent, 'g', { class: `v-mark v-${mark}`, transform: `translate(${x} ${y})` });
  add(g, 'rect', { x: -size / 2, y: -size / 2, width: size, height: size, rx: 2, class: 'v-badge' });
  add(g, 'text', { x: 0, y: 0.5, class: 'v-glyph', 'dominant-baseline': 'middle', 'text-anchor': 'middle' }, GLYPH[mark]);
  return g;
}
function niceStep(max, maxTicks = 6) {
  for (const step of [1, 2, 5, 7, 10, 14, 25, 30, 50, 60, 90, 100, 180, 250, 365, 500, 1000, 2500, 5000]) if (max / step <= maxTicks) return step;
  return Math.ceil(max / maxTicks);
}

// --------------------------------------------------------------- threads
function threads(v, W, motion) {
  const ids = [...v.evidenceIds];
  for (const s of v.sentences) for (const id of s.citedIds) if (!ids.includes(id)) ids.push(id);
  const rowH = 30;
  const H = Math.max(v.sentences.length, ids.length) * rowH + 34;
  const svg = frame(W, H, 'Each sentence connected to the evidence it cites');
  const lx = 40, rx = W - 70, top = 30;
  add(svg, 'text', { x: lx - 16, y: 14, class: 'v-caption' }, 'SENTENCES');
  add(svg, 'text', { x: rx - 16, y: 14, class: 'v-caption' }, 'EVIDENCE');
  const ey = (id) => top + ids.indexOf(id) * rowH;
  ids.forEach((id, i) => {
    const missing = !v.evidenceIds.includes(id);
    const g = add(svg, 'g', { class: missing ? 'v-node v-ghost' : 'v-node' });
    add(g, 'rect', { x: rx - 16, y: top + i * rowH - 11, width: 72, height: 22, rx: 2 });
    add(g, 'text', { x: rx - 8, y: top + i * rowH + 0.5, 'dominant-baseline': 'middle', class: 'v-label' }, trunc(missing ? `${id}?` : id, 9));
  });
  let step = 0;
  v.sentences.forEach((s, i) => {
    const y = top + i * rowH;
    const mark = { grounded: 'ok', invalid: 'bad', ungrounded: 'warn', placeholder: 'info' }[s.status] ?? 'info';
    add(svg, 'text', { x: lx - 30, y: y + 0.5, 'dominant-baseline': 'middle', class: 'v-label' }, `S${i + 1}`);
    if (s.citedIds.length === 0) {
      const stub = add(svg, 'path', { d: `M ${lx + 10} ${y} H ${lx + 70}`, class: `v-line v-${mark}`, 'stroke-dasharray': '3 4' });
      drawIn(motion, stub, 240, step * 180);
      const end = add(svg, 'text', { x: lx + 78, y: y + 0.5, 'dominant-baseline': 'middle', class: `v-tag v-${mark}` }, s.status === 'placeholder' ? 'marked: needs a source' : 'no citation');
      play(motion, end, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: step * 180 + 200 });
    } else {
      for (const id of s.citedIds) {
        const ty = ey(id);
        const good = s.status === 'grounded';
        const path = add(svg, 'path', { d: `M ${lx + 10} ${y} C ${(lx + rx) / 2} ${y}, ${(lx + rx) / 2} ${ty}, ${rx - 18} ${ty}`, class: `v-line v-${good ? 'ok' : 'bad'}`, 'stroke-dasharray': good ? null : '6 5' });
        drawIn(motion, path, 600, step * 180);
        if (!good) {
          const mx = (lx + rx) / 2, my = (y + ty) / 2;
          const cut = glyphBadge(svg, mx, my, 'bad', 15);
          play(motion, cut, [{ opacity: 0, transform: `translate(${mx}px, ${my}px) scale(0.4)` }, { opacity: 1, transform: `translate(${mx}px, ${my}px) scale(1)` }], { duration: 120, delay: step * 180 + 560 });
        }
      }
    }
    glyphBadge(svg, lx, y, mark);
    step += 1;
  });
  return svg;
}

// ----------------------------------------------------------------- needle
function needle(v, W, motion) {
  const r = Math.min(104, W / 2 - 60);
  const summary = `${v.supports} for · ${v.contradicts} against`;
  // On narrow panels the summary under the hub would run into the end labels.
  const low = r < (measure('CONTRADICTS', 'caption') + measure(summary, 'strong')) / 2 + 8;
  const H = low ? 166 : 150;
  const svg = frame(W, H, `Evidence direction: ${v.direction}`);
  const cx = W / 2, cy = 116;
  const arc = (a0, a1) => {
    const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy - r * Math.sin((a * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  add(svg, 'path', { d: arc(180, 122), class: 'v-band v-bad' });
  add(svg, 'path', { d: arc(118, 62), class: 'v-band v-skip' });
  add(svg, 'path', { d: arc(58, 0), class: 'v-band v-ok' });
  add(svg, 'text', { x: cx - r, y: cy + 22, 'text-anchor': 'middle', class: 'v-caption' }, 'CONTRADICTS');
  add(svg, 'text', { x: cx, y: cy - r - 12, 'text-anchor': 'middle', class: 'v-caption' }, 'SPLIT');
  add(svg, 'text', { x: cx + r, y: cy + 22, 'text-anchor': 'middle', class: 'v-caption' }, 'SUPPORTS');
  const total = v.supports + v.contradicts;
  const ratio = total ? (v.supports - v.contradicts) / total : 0;
  const angle = 90 - ratio * 76;
  const mark = { supports: 'ok', contradicts: 'bad', mixed: 'warn', none: 'skip' }[v.direction] ?? 'skip';
  const hand = add(svg, 'g', { class: `v-needle v-${mark}` });
  hand.style.transformBox = 'view-box';
  hand.style.transformOrigin = `${cx}px ${cy}px`;
  hand.style.transform = `rotate(${90 - angle}deg)`;
  add(hand, 'line', { x1: cx, y1: cy, x2: cx, y2: cy - r + 16, 'stroke-dasharray': total ? null : '4 4' });
  add(svg, 'circle', { cx, cy, r: 6, class: `v-hub v-${mark}` });
  play(motion, hand, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${90 - angle}deg)` }], { duration: 600 });
  add(svg, 'text', { x: cx, y: low ? cy + 42 : cy + 26, 'text-anchor': 'middle', class: 'v-strong' }, summary);
  return svg;
}

// --------------------------------------------------------------- timeline
function timeline(v, W, motion) {
  const pad = 28;
  const known = v.items.filter((i) => typeof i.ageDays === 'number');
  const maxAge = Math.max(10, ...known.map((i) => i.ageDays), ...v.thresholds.map((t) => t.days * 1.25));
  const step = niceStep(maxAge, W < 360 ? 4 : 6);
  const max = Math.ceil((maxAge * 1.08) / step) * step;
  const x = (d) => pad + (d / max) * (W - pad * 2);
  // Item labels sit right of their mark, or left when they would leave the
  // frame. Each goes in the lowest lane where it overlaps no other label, no
  // stem passes through it, and its own stem crosses no label below it.
  const lanes = [];
  const placed = v.items.map((item) => {
    const px = typeof item.ageDays === 'number' ? x(item.ageDays) : W - pad;
    let text = trunc(item.label, 18);
    let w = measure(text, 'label');
    let side = 'right';
    if (px + 11 + w > W - 2) {
      if (px - 11 - w >= 2) side = 'left';
      else { text = fit(text, W - 2 - (px + 11), 'label'); w = measure(text, 'label'); }
    }
    const x0 = side === 'right' ? px - 8 : px - 11 - w, x1 = side === 'right' ? px + 11 + w : px + 8;
    const free = (L) => (lanes[L] ?? []).every((o) => x1 + 6 < o.x0 || x0 - 6 > o.x1);
    const clear = (L) => free(L)
      && lanes.slice(0, L).flat().every((o) => px < o.x0 - 3 || px > o.x1 + 3)
      && lanes.slice(L + 1).flat().every((o) => o.px < x0 - 3 || o.px > x1 + 3);
    // Stem avoidance is quadratic, so it applies to readable charts only; two
    // items at the same age can never avoid each other's stems either. Both
    // fall back to the first lane where the labels at least do not overlap.
    let lane = 0;
    if (v.items.length <= 60) while (lane <= lanes.length && !clear(lane)) lane += 1;
    if (v.items.length > 60 || lane > lanes.length) { lane = 0; while (!free(lane)) lane += 1; }
    const entry = { ...item, px, lane, side, text, x0, x1 };
    (lanes[lane] ??= []).push(entry);
    return entry;
  });
  const H = 92 + lanes.length * 22;
  const svg = frame(W, H, `Ages on a ${v.unit} scale`);
  const axisY = H - 30;
  add(svg, 'line', { x1: pad, y1: axisY, x2: W - pad, y2: axisY, class: 'v-axis' });
  for (let d = 0; d <= max; d += step) {
    add(svg, 'line', { x1: x(d), y1: axisY, x2: x(d), y2: axisY + 4, class: 'v-axis' });
    add(svg, 'text', { x: x(d), y: axisY + 16, 'text-anchor': 'middle', class: 'v-tick' }, `${d}`);
  }
  // Top labels: the unit caption at the left, then each threshold label right
  // of its line (or left of it) in the first row where it fits.
  const unit = fit(v.unit.toUpperCase(), W - pad, 'caption');
  add(svg, 'text', { x: pad - 4, y: 14, class: 'v-caption' }, unit);
  const taken = [{ row: 0, x0: pad - 4, x1: pad - 4 + measure(unit, 'caption') }];
  for (const t of v.thresholds) {
    const tx = x(t.days), w = measure(t.label, 'tick');
    const options = [];
    for (let row = 0; row < 3; row += 1) options.push({ row, x0: tx + 4, x1: tx + 4 + w, anchor: 'start', at: tx + 4 }, { row, x0: tx - 4 - w, x1: tx - 4, anchor: 'end', at: tx - 4 });
    const spot = options.find((o) => o.x0 >= 0 && o.x1 <= W && taken.every((u) => u.row !== o.row || o.x1 + 6 < u.x0 || o.x0 - 6 > u.x1)) ?? options[0];
    taken.push(spot);
    add(svg, 'line', { x1: tx, y1: 18, x2: tx, y2: axisY, class: 'v-threshold' });
    add(svg, 'text', { x: spot.at, y: 14 + spot.row * 14, 'text-anchor': spot.anchor, class: 'v-tick' }, t.label);
  }
  placed.forEach((item, i) => {
    const y = axisY - 22 - item.lane * 22;
    const g = add(svg, 'g', { class: 'v-dot' });
    add(g, 'line', { x1: item.px, y1: y + 8, x2: item.px, y2: axisY, class: `v-stem v-${item.mark}` });
    glyphBadge(g, item.px, y, item.mark, 15);
    add(g, 'text', { x: item.side === 'right' ? item.px + 11 : item.px - 11, y: y + 0.5, 'text-anchor': item.side === 'right' ? 'start' : 'end', 'dominant-baseline': 'middle', class: 'v-label' }, item.text);
    play(motion, g, [{ transform: `translateX(${pad - item.px}px)`, opacity: 0.2 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 600, delay: i * 140 });
  });
  return svg;
}

// ------------------------------------------------------------------ slope
function slope(v, W, motion) {
  const n = v.base.length;
  const rowH = 22;
  const ids = v.base.map((id) => trunc(id, 13));
  const labelW = Math.min(96, Math.max(50, ...ids.map((id) => measure(id, 'label'))) + 14);
  const panelW = (W - labelW) / Math.max(1, v.columns.length);
  const span = (c) => [labelW + c * panelW + 12, labelW + (c + 1) * panelW - 12];
  // Scenario names wrap to two lines rather than being cut off.
  const names = v.columns.map((col) => wrap(col.short ?? col.label, panelW - 8, 'label', 2));
  const nameLines = Math.max(1, ...names.map((l) => l.length));
  const H = n * rowH + 50 + nameLines * 14;
  const svg = frame(W, H, 'Ranking before and after each payout change');
  const y = (rank) => 30 + rank * rowH;
  ids.forEach((id, r) => add(svg, 'text', { x: labelW - 8, y: y(r) + 0.5, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'v-label' }, id));
  const [a0, a1] = span(0);
  const perPanel = measure('BASE', 'caption') + measure('AFTER', 'caption') + 8 <= a1 - a0 + 8;
  if (!perPanel) add(svg, 'text', { x: a0 - 4, y: 14, class: 'v-caption' }, 'EACH PANEL: BASE → AFTER');
  const longVerdict = Math.max(measure('order changed', 'tag'), measure('same order', 'tag')) <= panelW - 6;
  v.columns.forEach((col, c) => {
    const [x0, x1] = span(c);
    if (perPanel) {
      add(svg, 'text', { x: x0 - 4, y: 14, class: 'v-caption' }, 'BASE');
      add(svg, 'text', { x: x1 + 4, y: 14, 'text-anchor': 'end', class: 'v-caption' }, 'AFTER');
    }
    v.base.forEach((id, r) => {
      const r2 = col.order.indexOf(id);
      const moved = r2 !== r;
      const path = add(svg, 'path', { d: `M ${x0} ${y(r)} L ${x1} ${y(r2)}`, class: `v-line v-${moved ? 'bad' : 'ok'}${moved ? '' : ' v-quiet'}` });
      add(svg, 'circle', { cx: x0, cy: y(r), r: 3.5, class: 'v-pt' });
      add(svg, 'circle', { cx: x1, cy: y(r2), r: 3.5, class: `v-pt v-${moved ? 'bad' : 'ok'}` });
      drawIn(motion, path, 600, c * 420);
    });
    const mid = (x0 + x1) / 2;
    names[c].forEach((line, i) => add(svg, 'text', { x: mid, y: H - 22 - (names[c].length - 1 - i) * 14, 'text-anchor': 'middle', class: 'v-label' }, line));
    const word = longVerdict ? (col.changed ? 'order changed' : 'same order') : (col.changed ? 'changed' : 'same');
    const verdict = add(svg, 'text', { x: mid, y: H - 6, 'text-anchor': 'middle', class: `v-tag v-${col.changed ? 'bad' : 'ok'}` }, word);
    play(motion, verdict, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: c * 420 + 560 });
  });
  return svg;
}

// ------------------------------------------------------------------- bars
function bars(v, W, motion) {
  const rows = [...(v.baseline ? [{ ...v.baseline, base: true }] : []), ...v.bars];
  const rowH = 26;
  const H = rows.length * rowH + 30;
  const svg = frame(W, H, `Values on a ${v.percent ? '0 to 100 percent' : 'zero-based'} scale`);
  const labelW = 92, valueW = 72;
  const max = v.percent ? 1 : Math.max(0, ...rows.map((r) => r.value ?? 0)) * 1.1 || 1;
  const x = (val) => labelW + (val / max) * (W - labelW - valueW);
  add(svg, 'line', { x1: labelW, y1: 4, x2: labelW, y2: H - 22, class: 'v-axis' });
  add(svg, 'text', { x: labelW, y: H - 6, class: 'v-tick' }, v.percent ? '0%' : `0 ${v.unit}`);
  add(svg, 'text', { x: x(max), y: H - 6, 'text-anchor': 'end', class: 'v-tick' }, v.percent ? '100%' : `${Math.round(max)} ${v.unit}`);
  rows.forEach((row, i) => {
    const y = 6 + i * rowH;
    add(svg, 'text', { x: labelW - 8, y: y + 9.5, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'v-label' }, trunc(row.label, 12));
    if (row.value === null || row.value === undefined) {
      add(svg, 'text', { x: labelW + 8, y: y + 9.5, 'dominant-baseline': 'middle', class: 'v-tick' }, 'no readings');
      return;
    }
    const mark = row.base ? 'skip' : row.changed ? 'bad' : 'ok';
    const bar = add(svg, 'rect', { x: labelW, y, width: Math.max(1, x(row.value) - labelW), height: 18, rx: 1, class: `v-bar v-${mark}` });
    add(svg, 'text', { x: x(row.value) + 6, y: y + 9.5, 'dominant-baseline': 'middle', class: 'v-value' }, v.percent ? `${Math.round(row.value * 100)}%` : `${row.value} ${v.unit}`);
    bar.style.transformBox = 'view-box';
    bar.style.transformOrigin = `${labelW}px 0px`;
    play(motion, bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600, delay: i * 140 });
  });
  return svg;
}

// ------------------------------------------------------------------- dial
function dial(v, W, motion) {
  const lines = [
    [v.flags.lowSourceCount ? 'warn' : 'ok', v.flags.lowSourceCount ? 'Few source types' : 'Several source types'],
    [v.flags.uniformSentiment ? 'warn' : 'ok', v.flags.uniformSentiment ? 'Uniform sentiment' : 'Varied sentiment'],
    ['info', `Confidence: ${v.confidence}`],
  ].map(([m, text], i) => (v.score === null && i < 2 ? ['skip', `${text} (not assessed)`] : [m, text]));
  // Beside the ring when the longest line fits; otherwise stacked below it.
  const beside = 154 + Math.max(...lines.map(([, t]) => measure(t, 'label'))) <= W - 4;
  const H = beside ? 128 : 124 + lines.length * 26;
  const svg = frame(W, H, v.score === null ? 'No score' : `Heuristic score ${v.score} of 100`);
  const cx = 64, cy = 64, r = 46;
  const mark = v.score === null ? 'skip' : v.flags.lowSourceCount || v.flags.uniformSentiment ? 'warn' : 'ok';
  add(svg, 'circle', { cx, cy, r, class: 'v-ring' });
  if (v.score !== null) {
    const len = 2 * Math.PI * r;
    const fill = add(svg, 'circle', { cx, cy, r, class: `v-ring-fill v-${mark}`, 'stroke-dasharray': `${(v.score / 100) * len} ${len}`, transform: `rotate(-90 ${cx} ${cy})` });
    play(motion, fill, [{ strokeDasharray: `0 ${len}` }, { strokeDasharray: `${(v.score / 100) * len} ${len}` }], { duration: 600 });
  } else {
    add(svg, 'circle', { cx, cy, r, class: 'v-ring v-dashed' });
  }
  add(svg, 'text', { x: cx, y: cy - 4, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'v-big' }, v.score === null ? '—' : String(v.score));
  add(svg, 'text', { x: cx, y: cy + 22, 'text-anchor': 'middle', class: 'v-tick' }, v.score === null ? 'no score' : 'of 100');
  lines.forEach(([m, text], i) => {
    const g = add(svg, 'g', {});
    const bx = beside ? 140 : 26, by = beside ? 34 + i * 28 : 134 + i * 26;
    glyphBadge(g, bx, by, m, 15);
    add(g, 'text', { x: bx + 14, y: by + 0.5, 'dominant-baseline': 'middle', class: 'v-label' }, fit(text, W - bx - 16, 'label'));
    play(motion, g, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: 600 + i * 120 });
  });
  return svg;
}

// ------------------------------------------------------------------ chain
function chain(v, W, motion) {
  const entries = [...v.entries];
  const missing = v.brokenAt !== null && v.brokenAt >= entries.length;
  const slots = entries.length + (missing ? 1 : 0);
  const gap = 18;
  const bw = Math.min(96, (W - 16 - gap * (slots - 1)) / slots);
  const H = 104;
  const svg = frame(W, H, v.brokenAt === null ? 'Every link verified' : `Chain broken at entry ${v.brokenAt}`);
  const left = Math.max(8, (W - (slots * bw + (slots - 1) * gap)) / 2);
  const x = (i) => left + i * (bw + gap);
  for (let i = 0; i < slots; i += 1) {
    const isMissing = i >= entries.length;
    const e = entries[i];
    const state = v.brokenAt === null ? 'ok' : i < v.brokenAt ? 'ok' : i === v.brokenAt ? 'bad' : 'skip';
    if (i > 0) {
      const broken = state === 'bad' && v.kind !== 'content';
      const link = add(svg, 'path', { d: broken ? `M ${x(i) - gap} 40 l 5 -6 l 4 10 l 4 -8 l 5 4` : `M ${x(i) - gap} 40 H ${x(i)}`, class: `v-link v-${broken ? 'bad' : state === 'skip' ? 'skip' : 'ok'}` });
      play(motion, link, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: i * 160 });
    }
    const g = add(svg, 'g', { class: `v-block v-${state}${isMissing ? ' v-ghost' : ''}` });
    add(g, 'rect', { x: x(i), y: 18, width: bw, height: 44, rx: 2 });
    add(g, 'text', { x: x(i) + 8, y: 34, class: 'v-label' }, isMissing ? `#${i} missing` : `#${e.index}`);
    if (!isMissing) add(g, 'text', { x: x(i) + 8, y: 52, class: 'v-hash' }, bw > 70 ? e.hash : e.hash.slice(0, 4));
    if (state === 'bad' && v.kind === 'content') {
      // The entry's content no longer matches its own hash: mark the block, not the link.
      add(g, 'path', { d: `M ${x(i) + bw - 22} 24 l 14 14 M ${x(i) + bw - 8} 24 l -14 14`, class: 'v-cross' });
      add(svg, 'text', { x: x(i) + bw / 2, y: 12, 'text-anchor': 'middle', class: 'v-tag v-bad' }, fit('content changed', bw + gap, 'tag'));
    }
    play(motion, g, [{ opacity: 0.25 }, { opacity: 1 }], { duration: 240, delay: i * 160 });
    if (v.anchorIndex === i) {
      const a = add(svg, 'g', { class: 'v-anchor' });
      const ax = x(i) + bw / 2;
      add(a, 'circle', { cx: ax, cy: 82, r: 7 });
      add(a, 'path', { d: `M ${ax - 11} 82 H ${ax + 11} M ${ax} 71 V 93` });
      const right = ax + 96 < W;
      add(a, 'text', { x: right ? ax + 14 : ax - 14, y: 86, 'text-anchor': right ? 'start' : 'end', class: 'v-tick' }, 'saved anchor');
      play(motion, a, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: slots * 160 });
    }
  }
  return svg;
}

// ----------------------------------------------------------------- budget
function budget(v, W, motion) {
  const total = v.spent + v.next;
  const near = Math.abs(v.ceiling - total) < v.ceiling * 0.05;
  const svg = frame(W, 0, `Spend ${total.toFixed(4)} of a ${v.ceiling} ceiling`);
  const pad = 10;
  let top = 0;
  const drawBar = (lo, hi, caption, digits) => {
    const lines = wrap(caption, W - pad * 2, 'caption', 3);
    lines.forEach((line, i) => add(svg, 'text', { x: pad, y: top + 14 + i * 14, class: 'v-caption' }, line));
    const y = top + 22 + (lines.length - 1) * 14;
    const x = (val) => pad + ((val - lo) / (hi - lo)) * (W - pad * 2);
    add(svg, 'rect', { x: pad, y, width: W - pad * 2, height: 16, class: 'v-track' });
    const spent = add(svg, 'rect', { x: pad, y, width: Math.max(0, x(Math.min(v.spent, hi)) - pad), height: 16, class: 'v-bar v-skip' });
    const nx = x(Math.max(lo, v.spent));
    const nextBar = add(svg, 'rect', { x: nx, y, width: Math.max(2, x(Math.min(total, hi)) - nx), height: 16, class: `v-bar v-${v.allowed ? 'ok' : 'bad'}` });
    const cx = x(v.ceiling);
    add(svg, 'line', { x1: cx, y1: y - 4, x2: cx, y2: y + 20, class: 'v-ceiling' });
    const label = `ceiling $${v.ceiling.toFixed(digits)}`;
    const half = measure(label, 'tick') / 2;
    const anchor = cx + half > W - pad ? 'end' : cx - half < pad ? 'start' : 'middle';
    add(svg, 'text', { x: anchor === 'end' ? Math.min(cx, W - pad) : anchor === 'start' ? Math.max(cx, pad) : cx, y: y + 32, 'text-anchor': anchor, class: 'v-tick' }, label);
    spent.style.transformBox = 'view-box';
    spent.style.transformOrigin = `${pad}px 0px`;
    play(motion, spent, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600 });
    play(motion, nextBar, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 600 });
    top = y + 44;
  };
  drawBar(0, Math.max(v.ceiling, total) * 1.04, `FULL BUDGET · $0 TO $${(Math.max(v.ceiling, total) * 1.04).toFixed(2)}`, 2);
  if (near) {
    const span = Math.max(v.next * 6, v.ceiling * 0.002);
    const lo = Math.max(0, Math.min(v.spent, v.ceiling) - span);
    const hi = Math.max(v.ceiling, total) + span * 0.35;
    drawBar(lo, hi, `ZOOMED · $${lo.toFixed(4)} TO $${hi.toFixed(4)} (THE NEXT CALL IS TOO SMALL TO SEE ABOVE)`, 4);
  }
  const H = top + (near ? 0 : 10);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', String(H));
  return svg;
}

// ------------------------------------------------------------------ lanes
function lanes(v, _W, motion) {
  const wrap = document.createElement('div');
  wrap.className = 'v-lanes';
  const row = (title, items) => {
    const r = document.createElement('div');
    r.className = 'v-lane';
    const h = document.createElement('span');
    h.className = 'v-lane-title';
    h.textContent = title;
    r.append(h);
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = `v-chip v-${item.mark}`;
      chip.innerHTML = `<b aria-hidden="true">${GLYPH[item.mark]}</b>`;
      chip.append(document.createTextNode(item.label));
      r.append(chip);
    }
    return r;
  };
  const rows = [
    row('Allowed', v.allowed.map((label) => ({ label, mark: 'info' }))),
    row('Claimed', v.claimed.map((c) => ({ label: c.label, mark: c.ok ? 'ok' : 'bad' }))),
  ];
  if (v.facts.length) rows.push(row('Facts', v.facts.map((f) => ({ label: f.label, mark: f.state }))));
  rows.forEach((r, i) => { wrap.append(r); play(motion, r, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: i * 160 }); });
  return wrap;
}

const RENDER = { threads, needle, timeline, slope, bars, dial, chain, budget, lanes };

/**
 * Draw a result graphic. `animate` asks for motion (the caller passes true
 * only when the verdict changed); reduced-motion users always get the still.
 */
export function renderViz(viz, { width, animate }) {
  const render = viz && RENDER[viz.type];
  if (!render) return null;
  const motion = { on: Boolean(animate) && !reduced(), base: 0 };
  const box = document.createElement('figure');
  box.className = `viz viz-${viz.type}`;
  box.append(render(viz, Math.max(280, Math.floor(width)), motion));
  return box;
}
