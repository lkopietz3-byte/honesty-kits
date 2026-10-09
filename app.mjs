// Playground UI. Loads each kit's published npm files (served by the site
// itself, or from jsDelivr outside the built site), runs the demo from
// demos.mjs against it, and renders the result, its
// graphic, a copyable report and the code to run the same check in CI.
import { GROUPS, KITS, decodeExample, encodeExample, formatJson, mcpLinks, reportMarkdown } from './demos.mjs';
import { renderViz } from './viz.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null) node.append(child);
  return node;
};

const GLYPH = { ok: '✓', bad: '✕', warn: '!', info: 'i', skip: '–' };
// Nodes that move between the header and the footer on phones; always use these references.
const VIEW_CODE = $('view-code');
const COPY_REPORT = $('copy-report');
const REG_SVG = $('reg');
const REG_PLATE = $('reg-plate');
const MARK_TEXT = { ok: 'Passed', bad: 'Problem', warn: 'Warning', info: 'Note', skip: 'Not checked' };
const TONE = {
  pass: { label: 'Passed', mark: 'ok' },
  fail: { label: 'Problems found', mark: 'bad' },
  warn: { label: 'Worth a look', mark: 'warn' },
  info: { label: 'Not enough to say', mark: 'info' },
  error: { label: 'Input rejected', mark: 'bad' },
  offline: { label: 'Could not load', mark: 'bad' },
  loading: { label: 'Loading', mark: 'info' },
};

// The built site serves each kit's published npm files itself (see
// tools/build.mjs) and says so with <meta name="kit-base">. Anywhere else (the
// raw page, an artifact preview) the same files come from jsDelivr.
const KIT_BASE = document.querySelector('meta[name="kit-base"]')?.content;
const kitUrl = (kit) => KIT_BASE
  ? new URL(`${kit.id}@${kit.version}/index.js`, new URL(KIT_BASE, document.baseURI)).href
  : `https://cdn.jsdelivr.net/npm/${kit.id}@${kit.version}/dist/index.js`;
const modules = new Map();
function loadKit(kit) {
  if (!modules.has(kit.id)) {
    const pending = import(kitUrl(kit));
    pending.catch(() => modules.delete(kit.id));
    modules.set(kit.id, pending);
  }
  return modules.get(kit.id);
}

const state = {
  kit: null, preset: 0, seq: 0, debounce: 0,
  result: null, vizKey: '', baseline: null, edited: false, view: 'result', input: null,
};
const problems = (result) => result.rows.filter((r) => r.mark === 'bad' || r.mark === 'warn').length;

// ------------------------------------------------------------------ helpers
function announce(text) {
  const node = $('announce');
  node.textContent = '';
  setTimeout(() => { node.textContent = text; }, 30);
}

async function copyText(text, button, selectTarget) {
  const done = (label) => {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = label;
    announce(label === 'Copied' ? 'Copied to the clipboard' : 'Selected. Press Command or Control plus C to copy.');
    setTimeout(() => { button.textContent = original; }, 1600);
  };
  try {
    await navigator.clipboard.writeText(text);
    done('Copied');
  } catch {
    const target = selectTarget ?? button.previousElementSibling;
    if (target) {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    done('Selected');
  }
}

const rawJson = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? Object.fromEntries(v) : v), 2);

// --------------------------------------------------------------------- rail
function renderNav() {
  const rail = $('rail');
  const select = $('kit-select');
  for (const group of GROUPS) {
    const kits = KITS.filter((k) => k.group === group);
    const list = el('ul');
    const optgroup = el('optgroup', { label: group });
    for (const kit of kits) {
      const button = el('button', { type: 'button', id: `nav-${kit.id}` },
        el('span', { className: 'kit-name', textContent: kit.name }),
        el('span', { className: 'kit-pkg', textContent: kit.id }));
      button.addEventListener('click', () => go(kit.id));
      list.append(el('li', {}, button));
      optgroup.append(el('option', { value: kit.id, textContent: `${kit.name} (${kit.id})` }));
    }
    rail.append(el('section', { className: 'rail-group' }, el('h2', { textContent: group }), list));
    select.append(optgroup);
  }
  const mcpButton = el('button', { type: 'button', textContent: 'Add them all to your AI agent' });
  mcpButton.addEventListener('click', openAgent);
  rail.append(el('p', { className: 'rail-mcp' }, 'Coding with Claude Code, Cursor or VS Code? ', mcpButton));
  select.addEventListener('change', () => go(select.value));
}

function go(id) {
  if (location.hash !== `#${id}`) location.hash = id;
  else selectKit(id);
}

// --------------------------------------------------------------- selection
function selectKit(id, sharedInput = null) {
  const kit = KITS.find((k) => k.id === id) ?? KITS[0];
  state.kit = kit;
  state.result = null;
  for (const k of KITS) $(`nav-${k.id}`)?.removeAttribute('aria-current');
  $(`nav-${kit.id}`)?.setAttribute('aria-current', 'page');
  $('kit-select').value = kit.id;
  $('kit-title').textContent = kit.name;
  $('kit-question').textContent = kit.question;
  document.title = `${kit.name} · Honesty Kits`;
  renderExamples();
  renderFoot();
  if (sharedInput) useInput(sharedInput);
  else usePreset(0);
}

// A shared link's own input: no example chip is pressed, and the live tally
// starts from this input.
function useInput(input) {
  state.preset = -1;
  state.baseline = null;
  state.edited = false;
  for (const chip of $('examples').querySelectorAll('.chip')) chip.setAttribute('aria-pressed', 'false');
  renderFields(input);
  run();
}

/** A link that reopens the current kit with the current (last valid) input. */
function exampleLink() {
  const { input, errors } = readInput();
  const use = errors.length ? state.input : input;
  if (!use) return null;
  return `${location.origin}${location.pathname}#${state.kit.id}~${encodeExample(state.kit, use)}`;
}

function renderExamples() {
  const box = $('examples');
  box.replaceChildren(el('span', { className: 'examples-label', textContent: 'Examples' }));
  state.kit.presets.forEach((preset, index) => {
    const chip = el('button', { type: 'button', className: 'chip', textContent: preset.label });
    chip.setAttribute('aria-pressed', String(index === state.preset));
    chip.addEventListener('click', () => usePreset(index));
    box.append(chip);
  });
}

function usePreset(index) {
  state.preset = index;
  state.baseline = null;
  state.edited = false;
  for (const [i, chip] of [...$('examples').querySelectorAll('.chip')].entries()) chip.setAttribute('aria-pressed', String(i === index));
  renderFields(state.kit.presets[index].input);
  run();
}

// ------------------------------------------------------------------ fields
function renderFields(input) {
  const form = $('fields');
  form.replaceChildren();
  for (const field of state.kit.fields) {
    const id = `f-${state.kit.id}-${field.key}`;
    const value = input[field.key];
    if (field.kind === 'choice') {
      const group = el('div', { className: 'segmented' });
      for (const option of field.options) {
        const radio = el('input', { type: 'radio', name: id, value: option, checked: option === value });
        radio.addEventListener('change', edited);
        group.append(el('label', {}, radio, option));
      }
      form.append(el('fieldset', { className: 'field', id }, el('legend', { textContent: field.label }), group));
      continue;
    }
    const control = field.kind === 'line'
      ? el('input', { type: 'text', id, value: String(value), spellcheck: false, autocomplete: 'off' })
      : el('textarea', { id, rows: field.rows ?? 6, value: field.kind === 'json' ? formatJson(value) : String(value), spellcheck: field.kind === 'text' });
    if (field.kind === 'text') control.classList.add('prose');
    control.setAttribute('aria-describedby', `${id}-err`);
    control.addEventListener('input', edited);
    form.append(el('div', { className: 'field' },
      el('label', { htmlFor: id, textContent: field.label }),
      control,
      el('span', { className: 'field-error', id: `${id}-err` })));
  }
  const textFields = form.querySelectorAll('.field:has(textarea)');
  textFields[textFields.length - 1]?.classList.add('grow');
}

function edited() {
  state.edited = true;
  clearTimeout(state.debounce);
  state.debounce = setTimeout(run, 280);
}

function readInput() {
  const input = {};
  const errors = [];
  for (const field of state.kit.fields) {
    const id = `f-${state.kit.id}-${field.key}`;
    if (field.kind === 'choice') {
      input[field.key] = document.querySelector(`input[name="${id}"]:checked`)?.value;
      continue;
    }
    const control = $(id);
    const error = $(`${id}-err`);
    control.removeAttribute('aria-invalid');
    error.textContent = '';
    if (field.kind === 'json') {
      try {
        input[field.key] = JSON.parse(control.value);
      } catch (e) {
        control.setAttribute('aria-invalid', 'true');
        error.textContent = `Not valid JSON: ${String(e.message).replace(/^JSON\.parse: /, '')}`;
        errors.push(field.label);
      }
    } else {
      input[field.key] = control.value;
    }
  }
  return { input, errors };
}

// ------------------------------------------------------------------- run
async function run() {
  const seq = ++state.seq;
  const kit = state.kit;
  const { input, errors } = readInput();
  if (errors.length) {
    showStale(`Fix the input marked in red to see a new result (${errors.join(', ')}).`);
    return;
  }
  let mod;
  try {
    if (!state.result) showLoading(kit);
    mod = await loadKit(kit);
  } catch {
    if (seq === state.seq) showOffline(kit);
    return;
  }
  const started = performance.now();
  try {
    const result = await kit.run(mod, structuredClone(input));
    if (seq !== state.seq) return;
    state.input = input;
    showResult(kit, result, performance.now() - started);
  } catch (e) {
    if (seq !== state.seq) return;
    showRejected(kit, e);
  }
}

// ------------------------------------------------------ registration mark
// In register when the check passes; the colored plate slips out of register
// when it finds problems. The resting position carries the meaning by itself.
const REG = {
  pass: { dx: 0, dy: 0, c: 'var(--ok)', label: 'In register: the check passed' },
  warn: { dx: 1.6, dy: -1.2, c: 'var(--warn)', label: 'Slightly out of register: worth a look' },
  fail: { dx: 4, dy: 3, c: 'var(--bad)', label: 'Out of register: problems found' },
  error: { dx: 4, dy: 3, c: 'var(--bad)', label: 'Out of register: the input was rejected' },
  offline: { dx: 0, dy: 0, c: 'var(--skip)', label: 'No result: the kit could not load' },
  info: { dx: 0, dy: 0, c: 'var(--info)', label: 'In register, but there was not enough to say' },
  loading: { dx: 0, dy: 0, c: 'var(--skip)', label: 'Waiting for a result' },
};
let regTone = 'loading';
function setRegister(tone) {
  const r = REG[tone] ?? REG.loading;
  const plate = REG_PLATE;
  const from = REG[regTone] ?? REG.loading;
  plate.style.setProperty('--c', r.c);
  plate.setAttribute('transform', `translate(${r.dx} ${r.dy})`);
  REG_SVG.setAttribute('aria-label', r.label);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (tone !== regTone && !reducedMotion && typeof plate.animate === 'function') {
    plate.animate([{ transform: `translate(${from.dx}px, ${from.dy}px)` }, { transform: `translate(${r.dx}px, ${r.dy}px)` }],
      { duration: 600, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });
  }
  regTone = tone;
}

// --------------------------------------------------------------- render
function verdictBlock(tone, headline, summary, extra) {
  const t = TONE[tone];
  setRegister(tone);
  return el('div', { className: 'verdict' },
    el('div', { className: 'verdict-top' },
      el('span', { className: `tone tone-${tone}` }, el('span', { className: `glyph mark-${t.mark}`, ariaHidden: 'true', textContent: GLYPH[t.mark] }), t.label),
      extra ?? null),
    el('h3', { textContent: headline }),
    summary ? el('p', { className: 'summary', textContent: summary }) : null);
}

function limitNote(kit) {
  return el('p', { className: 'limit' }, el('strong', { textContent: 'What it does not check: ' }), kit.limit);
}

function setResult(...children) {
  const box = $('result');
  box.className = 'result';
  box.replaceChildren(...children);
}

function setActions(enabled) {
  COPY_REPORT.disabled = !enabled;
  VIEW_CODE.disabled = !enabled;
}

function showLoading(kit) {
  $('timing').textContent = 'Loading…';
  setActions(false);
  setResult(verdictBlock('loading', `Loading ${kit.id}@${kit.version}, the published npm build.`, 'It runs in your browser. Nothing you type is sent anywhere.'));
}

function showOffline(kit) {
  $('timing').textContent = '';
  setActions(false);
  const retry = el('button', { type: 'button', className: 'btn retry', textContent: 'Try again' });
  retry.addEventListener('click', () => run());
  setResult(
    verdictBlock('offline', `Could not load ${kit.id}.`, 'Check your connection or any content blocker, then try again. You can also install it and run it locally.'),
    el('div', { className: 'result-body' }, retry, limitNote(kit)));
}

function showRejected(kit, error) {
  state.result = null;
  state.vizKey = '';
  $('timing').textContent = '';
  setActions(false);
  const name = error?.constructor?.name ?? 'Error';
  setResult(
    verdictBlock('error', 'The kit refused this input.', `${name}: ${error?.message ?? String(error)}`),
    el('div', { className: 'result-body' },
      el('p', { className: 'limit' }, 'This is deliberate. The kits reject malformed input with a clear error instead of guessing and handing back a plausible wrong answer.'),
      limitNote(kit)));
}

function showStale(message) {
  const box = $('result');
  if (!state.result) {
    setActions(false);
    setResult(verdictBlock('error', 'The input is not valid yet.', message));
    return;
  }
  box.classList.add('is-stale');
  box.querySelector('.stale-note')?.remove();
  box.querySelector('.result-body')?.prepend(el('p', { className: 'stale-note', textContent: `Showing the last result. ${message}` }));
}

function progressChip(result) {
  const now = problems(result);
  if (state.baseline === null) { state.baseline = now; return null; }
  if (!state.edited || now === state.baseline) return null;
  const was = state.baseline;
  const text = now < was
    ? (now === 0 ? `All ${was} fixed` : `Down from ${was} to ${now}`)
    : `Up from ${was} to ${now}`;
  const chip = el('span', { className: `progress ${now < was ? 'progress-better' : 'progress-worse'}`, textContent: text, title: 'Problems and warnings compared with the example you started from' });
  return chip;
}

function vizWidth() {
  const body = $('result');
  return Math.max(280, body.clientWidth - 28);
}

function drawViz(result, animate) {
  const holder = $('result').querySelector('.viz-holder');
  if (!holder) return;
  const graphic = renderViz(result.viz, { width: vizWidth(), animate });
  holder.replaceChildren(...(graphic ? [graphic] : []));
  holder.hidden = !graphic;
}

function showResult(kit, result, ms) {
  const animate = state.vizKey !== `${kit.id}|${result.tone}|${problems(result)}`;
  state.vizKey = `${kit.id}|${result.tone}|${problems(result)}`;
  state.result = result;
  $('timing').textContent = `Ran in ${ms < 1 ? '<1' : Math.round(ms)} ms`;
  setActions(true);
  const rows = el('ul', { className: 'rows' });
  for (const row of result.rows) {
    const title = el('div', { className: 'row-title' });
    if (row.highlight && row.title.toLowerCase().includes(row.highlight.toLowerCase())) {
      const at = row.title.toLowerCase().indexOf(row.highlight.toLowerCase());
      title.append(row.title.slice(0, at), el('mark', { textContent: row.title.slice(at, at + row.highlight.length) }), row.title.slice(at + row.highlight.length));
    } else {
      title.textContent = row.title;
    }
    rows.append(el('li', { className: 'row' },
      el('span', { className: `glyph mark-${row.mark}`, title: MARK_TEXT[row.mark], textContent: GLYPH[row.mark] },
        el('span', { className: 'visually-hidden', textContent: MARK_TEXT[row.mark] })),
      el('div', {},
        title,
        row.detail ? el('div', { className: row.mono ? 'row-detail mono' : 'row-detail', textContent: row.detail }) : null,
        row.fix ? el('div', { className: 'row-fix' }, el('strong', { textContent: 'Fix: ' }), row.fix) : null)));
  }
  const raw = el('details', { className: 'raw' }, el('summary', { textContent: 'Show the raw result' }), el('pre', { textContent: rawJson(result.raw) }));
  setResult(
    verdictBlock(result.tone, result.headline, result.summary, progressChip(result)),
    el('div', { className: 'result-body' }, el('div', { className: 'viz-holder' }), rows, limitNote(kit), raw));
  drawViz(result, animate);
  if (state.view === 'code') showCode();
}

// ---------------------------------------------------------- report and code
function showCode() {
  if (!state.input) return;
  state.view = 'code';
  VIEW_CODE.setAttribute('aria-pressed', 'true');
  setCodeLabel(true);
  const code = state.kit.snippet(structuredClone(state.input));
  const pre = el('pre', { className: 'code', textContent: code });
  const copy = el('button', { type: 'button', className: 'btn', textContent: 'Copy code' });
  copy.addEventListener('click', () => copyText(code, copy, pre));
  $('code-view').replaceChildren(
    el('p', { className: 'code-note' }, `The same check as an ES module, built from your current input. Run it with Node 20+ after `, el('code', { textContent: `npm install ${state.kit.id}` }), '. It exits with code 1 when it finds a problem, so it can fail a CI job or block a deploy.'),
    pre,
    copy);
  $('result').hidden = true;
  $('code-view').hidden = false;
}

function hideCode() {
  state.view = 'result';
  VIEW_CODE.setAttribute('aria-pressed', 'false');
  setCodeLabel(false);
  $('code-view').hidden = true;
  $('result').hidden = false;
  if (state.result) drawViz(state.result, false);
}

function setCodeLabel(showingCode) {
  const button = VIEW_CODE;
  button.replaceChildren(
    el('span', { className: 'label-long', textContent: showingCode ? 'Back to the result' : 'Use it in your code' }),
    el('span', { className: 'label-short', textContent: showingCode ? 'Back' : 'Get code' }));
}

// On phones the result header row is dropped to lift the verdict; its
// registration mark and actions move into the footer.
const phone = matchMedia('(max-width: 860px)');
// Held by reference: the footer is rebuilt on every kit change, which would
// otherwise detach these nodes and make later lookups by id return null.
const ACTIONS = document.querySelector('.pane-actions');
const REG_MARK = REG_SVG;
function placeActions() {
  const actions = ACTIONS;
  const reg = REG_MARK;
  if (phone.matches) {
    $('foot').prepend(reg, actions);
  } else {
    document.querySelector('.result-title').prepend(reg);
    document.querySelector('#result-pane > .pane-head').append(actions);
  }
}

function renderFoot() {
  const kit = state.kit;
  const cmd = `npm install ${kit.id}`;
  const code = el('code', { textContent: cmd });
  const copy = el('button', { type: 'button', className: 'copy', textContent: 'Copy' });
  copy.addEventListener('click', () => copyText(cmd, copy, code));
  const npmLink = el('a', { href: `https://www.npmjs.com/package/${kit.id}`, target: '_blank', rel: 'noopener', textContent: 'npm' });
  npmLink.setAttribute('data-npm', '');
  $('foot').replaceChildren(
    el('span', { className: 'install' }, code, copy),
    el('span', { className: 'foot-note', textContent: `Running the published ${kit.id}@${kit.version} in your browser.` }),
    el('span', { className: 'foot-links' },
      el('a', { href: `https://github.com/lkopietz3-byte/${kit.id}#readme`, target: '_blank', rel: 'noopener', textContent: 'Docs' }),
      npmLink));
  placeActions();
}

// ------------------------------------------------------------ phone tabs
function setPane(which) {
  document.body.dataset.pane = which;
  for (const button of document.querySelectorAll('[data-pane-tab]')) button.setAttribute('aria-selected', String(button.dataset.paneTab === which));
  if (which === 'result' && state.result && state.view === 'result') drawViz(state.result, false);
}

// ------------------------------------------------------------ agent dialog
function openAgent() {
  const dialog = $('agent-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function setupAgent() {
  const links = mcpLinks((s) => btoa(s));
  $('cc-cmd').textContent = links.claudeCode;
  $('json-cfg').textContent = links.configJson;
  $('add-cursor').href = links.cursor;
  $('add-vscode').href = links.vscode;
  $('open-agent').addEventListener('click', openAgent);
  $('close-agent').addEventListener('click', () => $('agent-dialog').close());
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button, $(button.dataset.copy)));
  }
  $('agent-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
}

// -------------------------------------------------------------------- boot
renderNav();
setupAgent();
COPY_REPORT.addEventListener('click', (event) => {
  if (state.result) copyText(reportMarkdown(state.kit, state.result, exampleLink()), event.currentTarget, $('result'));
});
VIEW_CODE.addEventListener('click', () => (state.view === 'code' ? hideCode() : showCode()));
for (const button of document.querySelectorAll('[data-pane-tab]')) button.addEventListener('click', () => setPane(button.dataset.paneTab));
setPane('result');
setCodeLabel(false);
phone.addEventListener('change', placeActions);
let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.result && state.view === 'result') drawViz(state.result, false); }, 120);
}).observe($('result-pane'));

// Fragment forms: #<kit>, #<kit>~<shared example>, #add-to-agent.
function readHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  const [id, token] = raw.split('~');
  const kit = KITS.find((k) => k.id === id);
  return { raw, kit, shared: kit && token ? decodeExample(kit, token) : null };
}
$('copy-link').addEventListener('click', (event) => {
  const link = exampleLink();
  if (link) copyText(link, event.currentTarget, $('fields'));
});
addEventListener('hashchange', () => {
  const { raw, kit, shared } = readHash();
  if (raw === 'add-to-agent') return openAgent();
  if (!kit) return;
  if (shared) { hideCode(); selectKit(kit.id, shared); }
  else if (kit.id !== state.kit?.id) { hideCode(); selectKit(kit.id); }
});
const initial = readHash();
selectKit(initial.kit ? initial.kit.id : KITS[0].id, initial.shared);
if (initial.raw === 'add-to-agent') openAgent();
for (const kit of KITS) if (kit !== state.kit) setTimeout(() => loadKit(kit).catch(() => {}), 1200);
