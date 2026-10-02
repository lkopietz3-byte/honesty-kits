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
  const H = 150;
  const svg = frame(W, H, `Evidence direction: ${v.direction}`);
  const cx = W / 2, cy = 116, r = Math.min(104, W / 2 - 60);
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
  add(svg, 'text', { x: cx, y: cy + 26, 'text-anchor': 'middle', class: 'v-strong' }, `${v.supports} for · ${v.contradicts} against`);
  return svg;
}

// --------------------------------------------------------------- timeline
function timeline(v, W, motion) {
  const pad = 28;
  const known = v.items.filter((i) => typeof i.ageDays === 'number');
  const maxAge = Math.max(10, ...known.map((i) => i.ageDays), ...v.thresholds.map((t) => t.days * 1.25));
  const step = niceStep(maxAge);
  const max = Math.ceil((maxAge * 1.08) / step) * step;
  const x = (d) => pad + (d / max) * (W - pad * 2);
  const lanes = [];
  const placed = v.items.map((item) => {
    const px = typeof item.ageDays === 'number' ? x(item.ageDays) : W - pad;
    let lane = 0;
    while (lanes[lane] !== undefined && px - lanes[lane] < 92) lane += 1;
    lanes[lane] = px;
    return { ...item, px, lane };
  });
  const H = 92 + lanes.length * 22;
  const svg = frame(W, H, `Ages on a ${v.unit} scale`);
  const axisY = H - 30;
  add(svg, 'line', { x1: pad, y1: axisY, x2: W - pad, y2: axisY, class: 'v-axis' });
  for (let d = 0; d <= max; d += step) {
    add(svg, 'line', { x1: x(d), y1: axisY, x2: x(d), y2: axisY + 4, class: 'v-axis' });
    add(svg, 'text', { x: x(d), y: axisY + 16, 'text-anchor': 'middle', class: 'v-tick' }, `${d}`);
  }
  add(svg, 'text', { x: W - pad, y: 14, 'text-anchor': 'end', class: 'v-caption' }, v.unit.toUpperCase());
  for (const t of v.thresholds) {
    add(svg, 'line', { x1: x(t.days), y1: 18, x2: x(t.days), y2: axisY, class: 'v-threshold' });
    add(svg, 'text', { x: x(t.days) + 4, y: x(t.days) > W * 0.55 ? 28 : 14, class: 'v-tick' }, t.label);
  }
  placed.forEach((item, i) => {
    const y = axisY - 22 - item.lane * 22;
    const g = add(svg, 'g', { class: 'v-dot' });
    add(g, 'line', { x1: item.px, y1: y + 8, x2: item.px, y2: axisY, class: `v-stem v-${item.mark}` });
    glyphBadge(g, item.px, y, item.mark, 15);
    add(g, 'text', { x: item.px + 11, y: y + 0.5, 'dominant-baseline': 'middle', class: 'v-label' }, trunc(item.label, 14));
    play(motion, g, [{ transform: `translateX(${pad - item.px}px)`, opacity: 0.2 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 600, delay: i * 140 });
  });
  return svg;
}

// ------------------------------------------------------------------ slope
function slope(v, W, motion) {
  const n = v.base.length;
  const rowH = 22;
  const H = n * rowH + 64;
  const svg = frame(W, H, 'Ranking before and after each payout change');
  const labelW = 96;
  const panelW = (W - labelW) / v.columns.length;
  const y = (rank) => 30 + rank * rowH;
  v.base.forEach((id, r) => add(svg, 'text', { x: labelW - 8, y: y(r) + 0.5, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'v-label' }, trunc(id, 13)));
  v.columns.forEach((col, c) => {
    const x0 = labelW + c * panelW + 6, x1 = x0 + panelW - 30;
    add(svg, 'text', { x: x0, y: 14, class: 'v-caption' }, 'BASE');
    add(svg, 'text', { x: x1, y: 14, 'text-anchor': 'end', class: 'v-caption' }, 'AFTER');
    v.base.forEach((id, r) => {
      const r2 = col.order.indexOf(id);
      const moved = r2 !== r;
      const path = add(svg, 'path', { d: `M ${x0} ${y(r)} L ${x1} ${y(r2)}`, class: `v-line v-${moved ? 'bad' : 'ok'}${moved ? '' : ' v-quiet'}` });
      add(svg, 'circle', { cx: x0, cy: y(r), r: 3.5, class: 'v-pt' });
      add(svg, 'circle', { cx: x1, cy: y(r2), r: 3.5, class: `v-pt v-${moved ? 'bad' : 'ok'}` });
      drawIn(motion, path, 600, c * 420);
    });
    const short = col.short ?? col.label;
    add(svg, 'text', { x: (x0 + x1) / 2, y: H - 22, 'text-anchor': 'middle', class: 'v-label' }, trunc(short, Math.max(10, Math.floor(panelW / 7))));
    const verdict = add(svg, 'text', { x: (x0 + x1) / 2, y: H - 6, 'text-anchor': 'middle', class: `v-tag v-${col.changed ? 'bad' : 'ok'}` }, col.changed ? 'order changed' : 'same order');
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
  const max = v.percent ? 1 : Math.max(...rows.map((r) => r.value ?? 0)) * 1.1 || 1;
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
  const H = 128;
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
  add(svg, 'text', { x: cx, y: cy - 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'v-big' }, v.score === null ? '—' : String(v.score));
  add(svg, 'text', { x: cx, y: cy + 20, 'text-anchor': 'middle', class: 'v-tick' }, v.score === null ? 'no score' : 'of 100');
  const lines = [
    [v.flags.lowSourceCount ? 'warn' : 'ok', v.flags.lowSourceCount ? 'Few source types' : 'Several source types'],
    [v.flags.uniformSentiment ? 'warn' : 'ok', v.flags.uniformSentiment ? 'Uniform sentiment' : 'Varied sentiment'],
    ['info', `Confidence: ${v.confidence}`],
  ];
  lines.forEach(([m, text], i) => {
    const g = add(svg, 'g', {});
    glyphBadge(g, 140, 34 + i * 28, v.score === null && i < 2 ? 'skip' : m, 15);
    add(g, 'text', { x: 154, y: 34.5 + i * 28, 'dominant-baseline': 'middle', class: 'v-label' }, v.score === null && i < 2 ? `${text} (not assessed)` : text);
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
      add(svg, 'text', { x: x(i) + bw / 2, y: 76, 'text-anchor': 'middle', class: 'v-tag v-bad' }, 'content changed');
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
  const H = near ? 132 : 76;
  const svg = frame(W, H, `Spend ${total.toFixed(4)} of a ${v.ceiling} ceiling`);
  const pad = 10;
  const drawBar = (y, lo, hi, caption, digits) => {
    const x = (val) => pad + ((val - lo) / (hi - lo)) * (W - pad * 2);
    add(svg, 'text', { x: pad, y: y - 8, class: 'v-caption' }, caption);
    add(svg, 'rect', { x: pad, y, width: W - pad * 2, height: 16, class: 'v-track' });
    const spent = add(svg, 'rect', { x: pad, y, width: Math.max(0, x(Math.min(v.spent, hi)) - pad), height: 16, class: 'v-bar v-skip' });
    const nx = x(Math.max(lo, v.spent));
    const nextBar = add(svg, 'rect', { x: nx, y, width: Math.max(2, x(Math.min(total, hi)) - nx), height: 16, class: `v-bar v-${v.allowed ? 'ok' : 'bad'}` });
    const cx = x(v.ceiling);
    add(svg, 'line', { x1: cx, y1: y - 4, x2: cx, y2: y + 20, class: 'v-ceiling' });
    add(svg, 'text', { x: Math.min(cx, W - pad), y: y + 32, 'text-anchor': cx > W - 90 ? 'end' : 'middle', class: 'v-tick' }, `ceiling $${v.ceiling.toFixed(digits)}`);
    spent.style.transformBox = 'view-box';
    spent.style.transformOrigin = `${pad}px 0px`;
    play(motion, spent, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600 });
    play(motion, nextBar, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 600 });
  };
  drawBar(22, 0, Math.max(v.ceiling, total) * 1.04, `FULL BUDGET · $0 TO $${(Math.max(v.ceiling, total) * 1.04).toFixed(2)}`, 2);
  if (near) {
    const span = Math.max(v.next * 6, v.ceiling * 0.002);
    const lo = Math.max(0, Math.min(v.spent, v.ceiling) - span);
    const hi = Math.max(v.ceiling, total) + span * 0.35;
    drawBar(88, lo, hi, `ZOOMED · $${lo.toFixed(4)} TO $${hi.toFixed(4)} (THE NEXT CALL IS TOO SMALL TO SEE ABOVE)`, 4);
  }
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
