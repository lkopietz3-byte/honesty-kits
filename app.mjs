// Run the active check against its published npm build, served by this site.
import {
  CITATION_TRIALS, DEFAULT_KIT, GROUPS, KITS, decodeExample, encodeExample,
  formatJson, mcpLinks, progressLabel, reportMarkdown, verdictLabel,
} from './demos.mjs';
import { statusIcon, renderViz } from './viz.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null) node.append(child);
  return node;
};

const MARK_TEXT = { ok: 'Passed', bad: 'Problem', warn: 'Warning', info: 'Note', skip: 'Not checked' };
const COUNT_TEXT = { ok: ['passed', 'passed'], bad: ['problem', 'problems'], warn: ['warning', 'warnings'], info: ['note', 'notes'], skip: ['not checked', 'not checked'] };
const TONE_MARK = { pass: 'ok', fail: 'bad', warn: 'warn', info: 'info', error: 'bad', offline: 'bad', loading: 'info' };
const isCitations = () => state.kit.id === 'grounding-kit';
const isNumbers = () => state.kit.id === 'number-trace-kit';
const problems = (result) => result.rows.filter((r) => r.mark === 'bad' || r.mark === 'warn').length;
const kitDocs = (kit) => `https://github.com/lkopietz3-byte/${kit.id}`;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const recordFields = {
  'claims-registry-kit': ['claims', 'Claim', [
    ['id', 'Claim label'], ['text', 'Claim text', 'prose'], ['evidenceRef', 'Evidence link or reference'], ['verifiedAt', 'Review date'],
  ]],
  'freshness-kit': ['pages', 'Page', [['page', 'Page label'], ['reviewedOn', 'Review date']]],
  'corroboration-kit': ['signals', 'Source', [
    ['source', 'Source name'], ['kind', 'Evidence type', { textual: 'Text', structural: 'Data or records', behavioral: 'Observed behavior', declarative: 'A statement from the source' }],
    ['vote', 'What the source says', { supports: 'Supports the claim', contradicts: 'Contradicts the claim', inconclusive: 'Inconclusive' }], ['detail', 'Details', 'prose'],
  ]],
  'trust-core': ['reviews', 'Review', [
    ['id', 'Review label'], ['source', 'Source type'], ['sentiment', 'Review score (−1 negative, 1 positive)', 'number'],
    ['confidence', 'Confidence in the score (0 to 1)', 'number'], ['publishedAt', 'Publication date'],
  ]],
  'audit-chain-kit': ['entries', 'Entry', [['action', 'Action'], ['by', 'Who did it'], ['amountUsd', 'Amount ($)', 'number']]],
};

const modules = new Map();
let retryAttempt = 0;
function loadKit(kit, retry = false) {
  if (retry) modules.delete(kit.id);
  if (!modules.has(kit.id)) {
    const query = retry ? `?retry=${++retryAttempt}` : '';
    const pending = import(`./kits/${kit.id}@${kit.version}/index.js${query}`);
    pending.catch(() => { if (modules.get(kit.id) === pending) modules.delete(kit.id); });
    modules.set(kit.id, pending);
  }
  return modules.get(kit.id);
}

const state = {
  kit: null, seq: 0, debounce: 0,
  result: null, vizKey: '', baseline: null, edited: false, view: 'result', input: null,
  sources: new Map(), connections: [], trial: null, scrollTrial: false, editorErrors: [], situation: null,
};

const editDraft = $('edit-draft');
function scrollFocus(target) {
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function announce(text) {
  const node = $('announce');
  node.textContent = '';
  setTimeout(() => { node.textContent = text; }, 30);
}
function focusTarget(target) {
  target.focus({ preventScroll: true });
  scrollFocus(target);
}
function focusField(target) {
  const details = target.closest('details');
  if (details) details.open = true;
  focusTarget(target);
}
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.dataset.label ?? button.textContent;
    button.dataset.label = original;
    button.textContent = 'Copied';
    announce('Copied to the clipboard');
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => { button.textContent = original; }, 1600);
  } catch {
    const field = $('manual-text');
    field.value = text;
    $('manual-copy').showModal();
    field.focus();
    field.select();
  }
}

const rawJson = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Map ? Object.fromEntries(v) : v), 2);

// ---------------------------------------------------------------- check list
function renderNav() {
  for (const group of GROUPS) {
    const list = el('ul', { className: 'kit-list' });
    const kits = KITS.filter((k) => k.group === group);
    for (const kit of kits) {
      const button = el('button', { type: 'button', id: `nav-${kit.id}`, className: 'kit' },
        el('span', { className: 'kit-name', textContent: kit.name }),
        el('span', { className: 'kit-description', textContent: kit.catches }));
      button.addEventListener('click', () => {
        if (kit !== state.kit) selectKit(kit);
        const toggle = $('picker-toggle');
        if (toggle.getAttribute('aria-expanded') === 'true') {
          toggle.setAttribute('aria-expanded', 'false');
          focusTarget($('kit-title'));
        }
        if (location.hash !== `#${kit.id}`) location.hash = kit.id;
      });
      list.append(el('li', {}, button));
    }
    const details = el('details', {}, el('summary', {}, group, el('span', { className: 'chevron', ariaHidden: 'true' })), list);
    details.setAttribute('name', 'check-groups');
    $('rail').append(details);
  }
  $('picker-toggle').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.setAttribute('aria-expanded', String(button.getAttribute('aria-expanded') === 'false'));
  });
  document.querySelector('.picker').addEventListener('keydown', (event) => {
    const toggle = $('picker-toggle');
    if (event.key !== 'Escape' || toggle.getAttribute('aria-expanded') !== 'true') return;
    event.preventDefault();
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  });
}

function selectKit(kit, sharedInput = null) {
  hideCode();
  state.kit = kit;
  state.input = state.result = null;
  state.vizKey = '';
  for (const option of $('rail').querySelectorAll('[aria-current]')) option.removeAttribute('aria-current');
  const active = $(`nav-${kit.id}`);
  active.setAttribute('aria-current', 'page');
  active.closest('details').open = true;
  $('picker-label').textContent = `Choose a check · ${kit.name}`;
  $('kit-title').textContent = kit.name;
  $('kit-question').textContent = kit.question;
  $('npm-link').href = `https://www.npmjs.com/package/${kit.id}`;
  const benchmark = $('benchmark');
  const docs = kitDocs(kit);
  benchmark.replaceChildren(el(kit.benchmark ? 'a' : 'span', kit.benchmark
    ? { textContent: 'How well does it work?', href: kit.benchmark === 'readme' ? `${docs}#readme` : `${docs}/blob/main/README.md#${kit.benchmark}`, target: '_blank', rel: 'noopener' }
    : { textContent: 'Not benchmarked yet' }));
  document.title = `${kit.name} · Honesty Kits`;
  renderExamples();
  renderFoot();
  useInput(sharedInput ?? kit.presets[0].input, sharedInput ? -1 : 0);
  $('sheet-body').scrollTop = 0;
}

function renderExamples() {
  const box = $('examples');
  box.replaceChildren(el('span', { className: 'examples-label', textContent: 'Examples' }));
  state.kit.presets.forEach((preset, index) => {
    const chip = el('button', { type: 'button', className: 'chip preset-chip', textContent: preset.label });
    chip.addEventListener('click', () => useInput(preset.input, index));
    box.append(chip);
  });
  const textCheck = !!state.kit.draftKey;
  editDraft.replaceChildren(statusIcon('pencil'), textCheck ? 'Try your own text' : 'Edit inputs');
  editDraft.setAttribute('aria-controls', textCheck ? 'draft-editor' : 'fields');
  editDraft.removeAttribute('aria-expanded');
  if (state.kit.collapseInputs) editDraft.setAttribute('aria-expanded', 'false');
  if (isCitations()) box.append(makeTrials());
  box.append(editDraft);
  box.scrollLeft = 0;
}

function useInput(input, preset = -1, trial = null) {
  state.baseline = null;
  state.edited = false;
  state.trial = trial;
  state.scrollTrial = trial !== null;
  state.situation = trial === null ? state.kit.presets[preset]?.situation : CITATION_TRIALS[trial].situation;
  const chips = $('examples').querySelectorAll('.preset-chip');
  chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(i === preset)));
  setTrialChips();
  setDraftMode(false);
  renderFields(input);
  run();
}

const linkFor = (input) => `${location.origin}${location.pathname}#${state.kit.id}~${encodeExample(state.kit, input)}`;
function exampleLink() {
  const { input, errors } = readInput();
  const use = errors.length ? state.input : input;
  return use ? linkFor(use) : null;
}

// ------------------------------------------------------------------- inputs
function setDraftMode(editing) {
  $('draft-editor').hidden = !editing;
  $('result').hidden = editing;
  $('edit-draft').hidden = editing;
  const trials = $('trials');
  if (trials) trials.hidden = editing;
}

function fieldCard(id, label, control, className = 'field source-card') {
  const error = el('span', { className: 'field-error', id: `${id}-err` });
  control.setAttribute('aria-describedby', error.id);
  return el('div', { className }, el('label', { htmlFor: id, textContent: label }), control, error);
}

function selectControl(id, options, value) {
  const control = el('select', { id });
  if (!Object.hasOwn(options, value)) {
    control.append(el('option', { value: value ?? '', textContent: value || 'Choose an option', selected: true }));
  }
  for (const [key, label] of Object.entries(options)) control.append(el('option', { value: key, textContent: label, selected: key === value }));
  return control;
}

function renderFields(input) {
  const form = $('fields');
  form.replaceChildren();
  form.hidden = !!state.kit.collapseInputs;
  if (state.kit.collapseInputs) editDraft.setAttribute('aria-expanded', 'false');
  const draft = $('draft-editor');
  draft.replaceChildren();
  state.sources.clear();
  state.editorErrors = [];
  const record = recordFields[state.kit.id];
  const textInputs = el('div', { className: 'field-grid' });
  const numericObjects = [];
  const options = el('details', { className: 'input-options' }, el('summary', {}, 'Total and matching options'));
  for (const field of state.kit.fields) {
    const id = `f-${state.kit.id}-${field.key}`;
    const value = input[field.key];
    const holder = isNumbers() && field.kind !== 'text' ? options : textInputs;
    if (isCitations() && field.key === 'evidence') {
      form.append(evidenceEditor(id, field, value));
      continue;
    }
    if (field.kind === 'choice') {
      const control = selectControl(id, Object.fromEntries(field.options.map((option) => [option, field.optionLabels?.[option] ?? option])), value);
      control.addEventListener('change', edited);
      holder.append(fieldCard(id, field.label, control));
      continue;
    }
    const control = field.kind === 'line'
      ? el('input', { type: 'text', id, value: String(value ?? ''), spellcheck: false, autocomplete: 'off' })
      : el('textarea', { id, rows: field.rows ?? 6, value: field.kind === 'json' ? formatJson(value) : String(value), spellcheck: field.kind === 'text' });
    if (field.kind === 'text') control.classList.add('prose');
    control.addEventListener('input', edited);
    const card = fieldCard(id, field.label, control);
    if (field.key === state.kit.draftKey) {
      const done = el('button', { type: 'button', className: 'btn primary', textContent: 'Check it', onclick: () => {
        if (readInput().errors.length) { run(); return; }
        setDraftMode(false);
        $('edit-draft').focus();
        run();
      } });
      draft.append(card);
      if (state.kit.inputGuide) draft.append(el('p', { className: 'input-guide', textContent: state.kit.inputGuide }));
      draft.append(done);
    } else if (isNumbers() && field.key === 'evidence') {
      textInputs.append(numberSource(card, control));
    } else if (field.key === record?.[0]) {
      form.append(recordEditor(card, control, value, field, record.slice(1)));
    } else if (field.numberFields) {
      numericObjects.push({ field, card, control });
    } else {
      holder.append(card);
    }
  }
  if (state.kit.id === 'accuracy-claim-kit') form.append(accuracyEditor(textInputs, input));
  else form.prepend(...[
    textInputs.childElementCount ? textInputs : null,
    numericObjects.length ? numberEditor(numericObjects, input) : null,
  ].filter(Boolean));
  if (isNumbers()) form.append(options);
}

function numberEditor(objects, initial) {
  const grid = el('div', { className: 'field-grid' });
  const raw = el('div', { className: 'field-grid' }, ...objects.map(({ card }) => card));
  const toggle = el('button', { type: 'button', className: 'text-button' });
  const notice = el('p', { className: 'field-error', role: 'status' });
  const supportsFields = (input) => objects.every(({ field }) => isRecord(input[field.key])
    && field.numberFields.every(([key]) => !Object.hasOwn(input[field.key], key) || Number.isFinite(input[field.key][key])));

  function show(asJson, input) {
    raw.hidden = !asJson;
    grid.hidden = asJson;
    toggle.textContent = asJson ? 'Show number fields' : 'Edit as JSON';
    notice.textContent = '';
    grid.replaceChildren();
    if (asJson) return;
    for (const { field, control } of objects) {
      const values = { ...input[field.key] };
      for (const [key, label] of field.numberFields) {
        const id = `${control.id}-${key}`;
        const number = el('input', { id, type: 'number', step: 'any', value: String(values[key] ?? '') });
        number.dataset.fieldLabel = field.label;
        number.addEventListener('input', () => {
          const invalid = number.validity.badInput || (number.value !== '' && !Number.isFinite(number.valueAsNumber));
          $(`${id}-err`).textContent = invalid ? 'Enter a number.' : '';
          if (invalid) number.setAttribute('aria-invalid', 'true');
          else {
            number.removeAttribute('aria-invalid');
            if (number.value === '') delete values[key];
            else values[key] = number.valueAsNumber;
            control.value = formatJson(values);
          }
          edited();
        });
        grid.append(fieldCard(id, label, number));
      }
    }
  }

  state.editorErrors.push(() => [...grid.querySelectorAll('[aria-invalid="true"]')].map((node) => node.dataset.fieldLabel));
  toggle.addEventListener('click', () => {
    const { input, errors } = readInput();
    if (errors.length) {
      const invalid = (raw.hidden ? grid : raw).querySelector('[aria-invalid="true"]');
      if (invalid) { focusTarget(invalid); return; }
    }
    if (!raw.hidden && !supportsFields(input)) {
      notice.textContent = 'Use an object with numbers for these fields before switching back.';
      return;
    }
    show(raw.hidden, input);
    focusTarget(raw.hidden ? grid.querySelector('input') : objects[0].control);
  });
  show(!supportsFields(initial), initial);
  return el('section', { className: 'number-editor', ariaLabel: 'Number inputs' }, grid, raw, toggle, notice);
}

function recordEditor(raw, control, initial, field, [itemLabel, schema]) {
  const grid = el('div', { className: 'field-grid' });
  const toggle = el('button', { type: 'button', className: 'text-button' });
  const notice = el('p', { className: 'field-error', role: 'status' });
  const supportsCards = (value) => Array.isArray(value) && value.every((item) => isRecord(item)
    && schema.every(([key, , kind]) => item[key] == null || typeof item[key] === (kind === 'number' ? 'number' : 'string')));
  state.editorErrors.push(() => !grid.hidden && grid.querySelector('[aria-invalid="true"]') ? [field.label] : []);
  function show(asJson, value) {
    raw.hidden = !asJson;
    grid.hidden = asJson;
    toggle.textContent = asJson ? 'Show cards' : 'Edit as JSON';
    notice.textContent = '';
    grid.replaceChildren();
    if (asJson) return;
    const items = structuredClone(value);
    if (!items.length) grid.append(el('p', { className: 'empty', textContent: 'Use Edit as JSON to add a record.' }));
    for (const [index, item] of items.entries()) {
      const card = el('fieldset', { className: 'source-card record-card' },
        el('legend', { textContent: `${itemLabel} ${index + 1}` }));
      for (const [key, label, kind] of schema) {
        const id = `${control.id}-${index}-${key}`;
        const value = item[key] ?? '';
        const input = typeof kind === 'object' ? selectControl(id, kind, value)
          : kind === 'prose' ? el('textarea', { id, rows: 2, className: 'prose', value })
          : el('input', { id, type: kind === 'number' ? 'number' : 'text', step: kind === 'number' ? 'any' : '', value: String(value) });
        input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
          const error = $(`${id}-err`);
          const invalid = kind === 'number' && (input.validity.badInput || (input.value !== '' && !Number.isFinite(input.valueAsNumber)));
          error.textContent = invalid ? 'Enter a number.' : '';
          if (invalid) input.setAttribute('aria-invalid', 'true');
          else {
            input.removeAttribute('aria-invalid');
            if (kind === 'number' && input.value === '') delete item[key];
            else item[key] = kind === 'number' ? input.valueAsNumber : input.value;
            control.value = formatJson(items);
          }
          edited();
        });
        card.append(fieldCard(id, label, input, 'field'));
      }
      grid.append(card);
    }
  }
  toggle.addEventListener('click', () => {
    const { input, errors } = readInput();
    if (errors.includes(field.label)) {
      const invalid = (raw.hidden ? grid : raw).querySelector('[aria-invalid="true"]');
      if (invalid) focusTarget(invalid);
    } else if (raw.hidden) {
      show(true);
      focusTarget(control);
    } else if (supportsCards(input[field.key])) {
      show(false, input[field.key]);
      const first = grid.querySelector('input, textarea, select');
      if (first) focusTarget(first);
    } else {
      notice.textContent = 'These records need the JSON editor.';
    }
  });
  show(!supportsCards(initial), initial);
  return el('section', { className: 'record-editor', ariaLabel: field.label },
    el('div', { className: 'source-bar' }, el('h3', { textContent: field.label }), toggle), notice, grid, raw);
}

function numberSource(editor, control) {
  const text = el('p', { className: 'source-quote', textContent: control.value });
  const backlinks = el('div', { className: 'backlinks' });
  const edit = el('button', { type: 'button', className: 'text-button', textContent: 'Edit' });
  const card = el('section', { className: 'source-card', ariaLabel: 'Source' },
    el('div', { className: 'source-meta' }, el('h3', { className: 'source-tag', textContent: 'Source' }), backlinks, edit),
    text, editor);
  editor.hidden = true;
  editor.classList.remove('source-card');
  control.addEventListener('input', () => { text.textContent = control.value; });
  edit.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    text.hidden = !editor.hidden;
    edit.textContent = editor.hidden ? 'Edit' : 'Done';
    if (!editor.hidden) focusTarget(control);
  });
  state.sources.set('evidence', { card, focus: edit, backlinks, text });
  return card;
}

function markNumberSource(result) {
  const source = state.sources.get('evidence');
  const evidence = state.input.evidence;
  source.text.replaceChildren();
  let cursor = 0;
  for (const [start, end] of result.sourceRanges.toSorted((a, b) => a[0] - b[0])) {
    if (start < cursor) continue;
    source.text.append(evidence.slice(cursor, start), el('mark', { textContent: evidence.slice(start, end) }));
    cursor = end;
  }
  source.text.append(evidence.slice(cursor));
}

function accuracyEditor(raw, initial) {
  const claimJson = raw.querySelector('#f-accuracy-claim-kit-claim');
  const evidenceJson = raw.querySelector('#f-accuracy-claim-kit-evidence');
  const fields = el('div', { className: 'field-grid accuracy-fields' });
  const toggle = el('button', { type: 'button', className: 'text-button' });
  const notice = el('p', { className: 'field-error', role: 'status' });
  const figure = el('input', { id: 'accuracy-figure', type: 'text', inputMode: 'decimal' });
  const correct = el('input', { id: 'accuracy-correct', type: 'text', inputMode: 'numeric' });
  const checked = el('input', { id: 'accuracy-checked', type: 'text', inputMode: 'numeric' });
  const labelers = {
    human: 'People', automated: 'An automated test', 'by-construction': 'Known from how the data was made',
    model: 'A model', mixed: 'People and a model', unknown: 'Unknown',
  };
  const methods = {
    random: 'Random sample', stratified: 'Sampled by group', ranked: 'Picked by ranking', convenience: 'Easy to collect',
    complete: 'Complete set', 'held-out-split': 'Held-out test set', 'cross-validation': 'Cross-validation', unknown: 'Unknown',
  };
  const labeler = selectControl('accuracy-labeler', labelers, '');
  const sampling = selectControl('accuracy-sampling', methods, '');
  const controls = [
    [figure, 'The figure you want to publish (%)'], [correct, 'How many were correct'], [checked, 'How many were checked'],
    [labeler, 'Who labeled the items'], [sampling, 'How the items were picked'],
  ];
  for (const [field, label] of controls) fields.append(fieldCard(field.id, label, field, 'field'));
  const numeric = /^\d+(?:\.\d+)?%?$/;
  const whole = /^\d+$/;
  let model;
  const canShowFields = ({ claim, evidence }) => isRecord(claim) && claim.metric === 'accuracy'
    && (claim.display === undefined || (typeof claim.display === 'string' && numeric.test(claim.display)
      && claim.display.endsWith('%') && Number(claim.display.slice(0, -1)) / 100 === claim.value))
    && Number.isFinite(claim.value)
    && isRecord(evidence) && !Object.hasOwn(evidence, 'claim')
    && (evidence.sample === undefined || (isRecord(evidence.sample) && !Object.hasOwn(evidence.sample, 'errors')))
    && (evidence.provenance === undefined || isRecord(evidence.provenance));
  const showMode = (asJson) => {
    raw.hidden = !asJson;
    fields.hidden = asJson;
    toggle.textContent = asJson ? 'Show fields' : 'Edit as JSON';
    notice.textContent = '';
  };
  function fill(input) {
    model = structuredClone(input);
    const { claim, evidence } = model;
    figure.value = claim.display ?? String(Number((claim.value * 100).toPrecision(15)));
    correct.value = evidence.sample?.correct ?? '';
    checked.value = evidence.sample?.n ?? '';
    for (const [control, options, value] of [[labeler, labelers, evidence.provenance?.source], [sampling, methods, evidence.sampling]]) {
      control.replaceChildren(...selectControl(control.id, options, value).options);
      control.value = value ?? '';
    }
  }
  function sync(event) {
    const control = event.target;
    const error = $(`${control.id}-err`);
    control.removeAttribute('aria-invalid');
    error.textContent = '';
    const { claim, evidence } = model;
    if (control === figure) {
      const text = figure.value.trim();
      if (!numeric.test(text)) error.textContent = 'Enter a percentage such as 98.5%.';
      else {
        claim.value = Number(text.replace(/%$/, '')) / 100;
        claim.display = text.endsWith('%') ? text : `${text}%`;
      }
    } else if (control === correct || control === checked) {
      const key = control === correct ? 'correct' : 'n';
      const text = control.value.trim();
      if (text && (!whole.test(text) || !Number.isSafeInteger(Number(text)))) error.textContent = 'Enter a whole number.';
      else if (text) (evidence.sample ??= {})[key] = Number(text);
      else if (evidence.sample) delete evidence.sample[key];
    } else if (control === labeler) {
      (evidence.provenance ??= {}).source = labeler.value;
    } else if (control === sampling) {
      evidence.sampling = sampling.value;
    }
    if (error.textContent) control.setAttribute('aria-invalid', 'true');
    claimJson.value = formatJson(claim);
    evidenceJson.value = formatJson(evidence);
    edited();
  }
  for (const [control] of controls) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', sync);
  state.editorErrors.push(() => controls.filter(([control]) => !fields.hidden && control.hasAttribute('aria-invalid')).map(([, label]) => label));
  toggle.addEventListener('click', () => {
    const { input, errors } = readInput();
    if (errors.length) {
      const invalid = (raw.hidden ? fields : raw).querySelector('[aria-invalid="true"]');
      if (invalid) focusTarget(invalid);
      return;
    }
    if (raw.hidden) {
      showMode(true);
      focusTarget(claimJson);
    } else if (canShowFields(input)) {
      fill(input);
      showMode(false);
      focusTarget(figure);
    } else {
      notice.textContent = 'These inputs use settings that need the JSON editor.';
    }
  });
  const simple = canShowFields(initial);
  if (simple) fill(initial);
  showMode(!simple);
  return el('section', { className: 'accuracy-editor', ariaLabel: 'Accuracy inputs' },
    el('div', { className: 'source-bar' }, el('h3', { textContent: 'Inputs' }), toggle), notice, fields, raw);
}

const isEvidenceMap = (value) => isRecord(value) && Object.values(value).every((text) => typeof text === 'string');

function evidenceEditor(id, field, value) {
  const raw = el('textarea', { id, rows: field.rows, value: formatJson(value), spellcheck: false });
  const cards = el('div', { className: 'source-grid', id: 'source-cards' });
  const rawBox = el('div', { className: 'source-raw', id: 'source-json' },
    el('label', { htmlFor: id, textContent: 'Evidence as JSON' }), raw);
  const toggle = el('button', { className: 'text-button', type: 'button' });
  const error = el('p', { className: 'field-error', id: `${id}-err` });
  raw.setAttribute('aria-describedby', error.id);
  raw.addEventListener('input', edited);

  function showMode(asJson, evidence) {
    rawBox.hidden = !asJson;
    cards.hidden = asJson;
    toggle.textContent = asJson ? 'Show source cards' : 'Edit as JSON';
    cards.replaceChildren();
    state.sources.clear();
    if (asJson) return;
    if (!Object.keys(evidence).length) {
      cards.append(el('p', { className: 'empty', textContent: 'Use Edit as JSON to add a source.' }));
    }
    Object.entries(evidence).forEach(([key, text], index) => {
      const sourceId = el('input', { className: 'source-id', type: 'text', spellcheck: false, value: key });
      const sourceText = el('textarea', { className: 'source-text', rows: 2, spellcheck: false, value: text });
      sourceId.setAttribute('aria-label', `Source label ${index + 1}`);
      sourceId.setAttribute('aria-describedby', error.id);
      sourceText.setAttribute('aria-label', `Evidence text ${index + 1}`);
      const backlinks = el('div', { className: 'backlinks' });
      const card = el('div', { className: 'source-card' }, el('div', { className: 'source-meta' }, sourceId, backlinks), sourceText);
      cards.append(card);
      state.sources.set(key, { card, focus: sourceText, key: sourceId, backlinks });
      sourceId.addEventListener('input', edited);
      sourceText.addEventListener('input', edited);
    });
  }

  toggle.addEventListener('click', () => {
    const { input, errors } = readInput();
    const evidence = input[field.key];
    if (errors.includes(field.label)) {
      focusTarget(rawBox.hidden ? cards.querySelector('[aria-invalid="true"]') : raw);
      return;
    }
    if (!rawBox.hidden && !isEvidenceMap(evidence)) {
      raw.setAttribute('aria-invalid', 'true');
      error.textContent = 'Source cards need a JSON object with source IDs and text values.';
      focusTarget(raw);
      return;
    }
    const asJson = rawBox.hidden;
    raw.value = formatJson(evidence);
    showMode(asJson, evidence);
    if (asJson) focusTarget(raw);
    run();
  });
  showMode(!isEvidenceMap(value), value);
  return el('section', { className: 'sources', ariaLabel: 'Evidence' },
    el('div', { className: 'source-bar' }, el('h3', { textContent: 'Evidence it was given' }), toggle),
    cards, rawBox, error);
}

function edited() {
  state.edited = true;
  state.situation = null;
  state.trial = null;
  state.scrollTrial = false;
  setTrialChips();
  $('result').querySelectorAll('.situation, .trial-callout').forEach((node) => node.remove());
  ++state.seq;
  clearTimeout(state.debounce);
  state.debounce = setTimeout(run, 280);
}

function readCards(error) {
  const entries = [];
  const seen = new Set();
  let valid = true;
  for (const { key, focus } of state.sources.values()) {
    const id = key.value;
    const invalid = seen.has(id);
    key.removeAttribute('aria-invalid');
    if (invalid) {
      key.setAttribute('aria-invalid', 'true');
      valid = false;
    }
    entries.push([id, focus.value]);
    seen.add(id);
  }
  if (valid) return Object.fromEntries(entries);
  error.textContent = 'Give each source a different label.';
  return undefined;
}

function readInput() {
  const input = {};
  const errors = state.editorErrors.flatMap((read) => read());
  for (const field of state.kit.fields) {
    const id = `f-${state.kit.id}-${field.key}`;
    const control = $(id);
    const error = $(`${id}-err`);
    if (field.kind !== 'json') {
      input[field.key] = control.value;
      continue;
    }
    control.removeAttribute('aria-invalid');
    error.textContent = '';
    if (isCitations() && field.key === 'evidence' && !$('source-cards').hidden) {
      input[field.key] = readCards(error);
      if (input[field.key] === undefined) errors.push(field.label);
      continue;
    }
    try {
      input[field.key] = JSON.parse(control.value);
    } catch (e) {
      control.setAttribute('aria-invalid', 'true');
      error.textContent = `Not valid JSON: ${String(e.message).replace(/^JSON\.parse: /, '')}`;
      errors.push(field.label);
    }
  }
  return { input, errors };
}

// ------------------------------------------------------------------- result
async function run({ retry = false } = {}) {
  clearTimeout(state.debounce);
  const seq = ++state.seq;
  const kit = state.kit;
  const { input, errors } = readInput();
  if (errors.length) {
    setVerdict({ tone: 'error', headline: 'Fix the marked input to check it again.' });
    if (state.result) {
      $('stale').hidden = false;
      $('result').classList.add('is-stale');
    }
    else setStatusBody();
    return;
  }
  let mod;
  try {
    if (!state.result) {
      setVerdict({ tone: 'loading', headline: `Loading ${kit.name}.` });
      setStatusBody(el('div', { className: 'loading-result', ariaHidden: 'true' }));
    }
    mod = await loadKit(kit, retry);
  } catch {
    if (seq !== state.seq) return;
    if (retry && navigator.onLine) {
      // A failed transitive import stays cached for the life of the document.
      history.replaceState({ ...history.state, retry: { kit: kit.id, input } }, '');
      location.reload();
    } else {
      showOffline(kit);
    }
    return;
  }
  if (seq !== state.seq) return;
  try {
    const started = performance.now();
    const result = await kit.run(mod, structuredClone(input));
    if (seq !== state.seq) return;
    state.input = input;
    showResult(result, performance.now() - started);
  } catch (error) {
    if (seq !== state.seq) return;
    setVerdict({ tone: 'error', headline: String(error?.message ?? error) });
    setStatusBody();
  }
}

function setVerdict(result, animate = false) {
  const label = verdictLabel(result);
  const stamp = $('stamp');
  const mark = TONE_MARK[result.tone];
  const changed = stamp.dataset.mark !== mark || stamp.textContent !== label;
  const animated = animate && changed;
  stamp.className = `stamp tone tone-${result.tone}${animated ? ' land' : ''}`;
  if (changed) {
    stamp.dataset.mark = mark;
    stamp.replaceChildren(statusIcon(mark), label);
  }
  const summary = result.headline === label ? '' : result.headline;
  if ($('verdict-summary').textContent !== summary) $('verdict-summary').textContent = summary;
  const foot = $('verdict-fix');
  foot.hidden = !result.fix;
  foot.replaceChildren(...(result.fix ? [el('b', { textContent: 'Fix. ' }), result.fix] : []));
}

function limitNote() {
  return el('p', { className: 'limit' }, el('strong', { textContent: 'What it does not check. ' }), state.kit.limit);
}

function setStatusBody(...children) {
  const loading = children.some((child) => child.classList.contains('loading-result'));
  $('result-pane').toggleAttribute('data-loading', loading);
  state.result = null;
  state.vizKey = '';
  $('result').classList.remove('is-stale');
  $('stale').hidden = true;
  $('result').replaceChildren(...children);
  $('result-details').replaceChildren();
  $('statement-slot').replaceChildren();
  $('timing').textContent = '';
  $('copy-report').disabled = $('view-code').disabled = true;
  if (state.view === 'code') hideCode();
  $('limit-slot').replaceChildren(...(loading ? [] : [limitNote()]));
  linkSources([]);
}

function showOffline(kit) {
  setVerdict({ tone: 'offline', headline: `Could not load ${kit.name}. Check your connection, then try again.` });
  const retry = el('button', { type: 'button', className: 'btn retry', textContent: 'Try again' });
  retry.addEventListener('click', () => {
    if (!navigator.onLine) {
      setVerdict({ tone: 'offline', headline: 'You still appear to be offline.' });
      return;
    }
    run({ retry: true });
  });
  setStatusBody(retry);
}

function progressChip(result) {
  const now = problems(result);
  if (state.baseline === null) state.baseline = now;
  const label = state.edited ? progressLabel(result, state.baseline, now) : null;
  return label ? el('span', { className: `progress mark-${now < state.baseline ? 'ok' : 'bad'}`, textContent: label }) : null;
}

function sourceTargets() {
  if (!isCitations()) return state.sources;
  return new Map([...state.sources.values()].map((source) => [source.key.value, source]));
}

let hoveredSource = null;
const linkTarget = (node) => node instanceof Element ? node.closest('.cite, .row, .source-card') : null;
function highlightSources(focused = linkTarget(document.activeElement)) {
  for (const node of $('sheet-content').querySelectorAll('.is-linked')) node.classList.remove('is-linked');
  for (const { row, target, buttons } of state.connections) {
    if ([hoveredSource, focused].some((node) => node === row || node === target.card || buttons.includes(node))) {
      for (const node of [row, target.card, ...buttons]) node.classList.add('is-linked');
    }
  }
}

function linkSources(connections) {
  state.connections = connections;
  for (const source of state.sources.values()) source.backlinks?.replaceChildren();
  for (const { index, row, target, mark } of connections) {
    target.backlinks?.append(el('button', {
      type: 'button', className: `backlink mark-${mark}`, textContent: `Used by sentence ${index + 1}`,
      onclick: () => { setDraftMode(false); focusTarget(row); },
    }));
  }
  highlightSources();
}

function proofNote(row, finding = false) {
  const label = finding ? row.title : row.label ?? row.title ?? MARK_TEXT[row.mark];
  const note = el('div', { className: `note mark-${row.mark}` },
    el('strong', {}, statusIcon(row.mark), el('span', { className: 'visually-hidden', textContent: `${MARK_TEXT[row.mark]}: ` }), label));
  if (row.detail && row.detail !== label && row.detail !== `${label}.`) note.append(el('p', { textContent: row.detail }));
  if (row.fix) note.append(el('p', {}, el('b', { textContent: 'Fix. ' }), row.fix));
  if (row.field) note.append(el('button', { type: 'button', className: 'text-button finding-link', textContent: 'Edit table',
    onclick: () => focusField($(`f-${state.kit.id}-${row.field}`)) }));
  return note;
}

function renderProof(result) {
  const connections = [];
  const targets = sourceTargets();
  const rows = el('ol', { className: 'rows' });
  let line = 0;
  for (const [index, item] of [...(result.draft ?? result.rows), ...(result.findings ?? [])].entries()) {
    if (!item.quoted) {
      rows.append(el('li', { className: 'finding row' }, proofNote(item, true)));
      continue;
    }
    const number = el('span', { className: 'line-number', ariaHidden: 'true', textContent: String(++line).padStart(2, '0') });
    const row = el('li', { className: `row mark-${item.mark}`, tabIndex: -1 });
    const mark = el('mark');
    const title = el('p', { className: 'row-title' }, mark);
    const notes = el('div', { className: 'margin' }, ...(item.notes ?? [item]).map((note) => proofNote(note)));
    const cited = isCitations() ? result.viz.sentences[index] : null;
    const linked = new Map();
    const sourceBadge = (id, tone) => {
      const target = targets.get(id);
      if (!target) return el('span', { className: `citation-id mark-${tone}`, textContent: id });
      if (!linked.has(id)) {
        const connection = { index, row, target, mark: tone, buttons: [] };
        connections.push(connection);
        linked.set(id, connection);
      }
      const isNumberSource = !cited && id === 'evidence';
      const name = isNumberSource ? 'Source' : id;
      const button = el('button', {
        type: 'button', className: `cite mark-${tone}`,
        onclick: () => focusTarget(target.focus),
      });
      button.append(statusIcon('source'), name);
      linked.get(id).buttons.push(button);
      button.setAttribute('aria-label', `Go to evidence source${isNumberSource ? '' : ` ${name}`}`);
      return button;
    };
    if (cited) {
      let offset = 0;
      for (const match of item.title.matchAll(/\[\[cite:\s*([\w-]+)\s*\]\]/g)) {
        const id = match[1];
        // Only make links for markers the kit parsed as citations in this sentence.
        if (!cited.citedIds.includes(id)) continue;
        mark.append(item.title.slice(offset, match.index), sourceBadge(id, cited.validIds.includes(id) ? 'info' : 'bad'));
        offset = match.index + match[0].length;
      }
      mark.append(item.title.slice(offset));
    } else {
      mark.textContent = item.title;
      for (const { id, mark: tone } of item.sources ?? []) title.append(sourceBadge(id, tone));
    }
    if (linked.size) row.tabIndex = 0;
    row.append(number, title, notes);
    rows.append(row);
    if (state.trial !== null && index === 0 && cited?.status === 'grounded') {
      const id = CITATION_TRIALS[state.trial].source;
      rows.append(el('li', { className: 'trial-callout mark-warn' },
        el('p', {}, statusIcon('warn'), `This contradicts ${id} and still passes. The check compares words, not meaning.`),
        el('blockquote', { className: 'source-quote', textContent: state.input.evidence[id] })));
    }
  }
  return { rows, connections };
}

function countBar(result) {
  const counts = result.counts ?? Object.entries(COUNT_TEXT).map(([mark, labels]) => {
    const count = result.rows.filter((row) => row.mark === mark).length;
    return [labels[count === 1 ? 0 : 1], count, mark];
  }).filter(([, count]) => count);
  const bar = el('ul', { className: 'counts' });
  bar.setAttribute('aria-label', 'Result counts');
  for (const [label, count, mark] of counts) {
    const tone = count ? mark : 'skip';
    bar.append(el('li', { className: `count mark-${tone}` }, statusIcon(tone), el('strong', { textContent: String(count) }), label));
  }
  return bar;
}

function makeTrials() {
  const bar = el('div', { id: 'trials', className: 'trials', role: 'group', ariaLabel: 'Try to fool it' },
    el('span', { className: 'trials-label', textContent: 'Try to fool it' }));
  for (const [index, trial] of CITATION_TRIALS.entries()) {
    bar.append(el('button', {
      id: `trial-${index}`, type: 'button', className: 'chip', textContent: trial.label,
      onclick: () => useInput({ ...state.kit.presets[0].input, text: trial.text }, -1, index),
    }));
  }
  return bar;
}

function setTrialChips() {
  $('trials')?.querySelectorAll('.chip').forEach((chip, index) => chip.setAttribute('aria-pressed', String(index === state.trial)));
}

function drawViz(result, animate) {
  const holder = $('result-details').querySelector('.viz-holder');
  if (!holder) return;
  const width = holder.clientWidth;
  if (!width) return;
  const graphic = renderViz(result.viz, { width: width - 22, animate });
  holder.replaceChildren(...(graphic ? [graphic] : []));
  holder.hidden = !graphic;
}

function showResult(result, ms) {
  const key = `${state.kit.id}|${result.tone}|${problems(result)}`;
  const animate = state.vizKey !== key;
  state.vizKey = key;
  state.result = result;
  $('result-pane').removeAttribute('data-loading');
  const box = $('result');
  const details = $('result-details');
  const openGraphic = details.querySelector('.graphic')?.open ?? false;
  const openRaw = details.querySelector('.raw')?.open ?? false;
  $('stale').hidden = true;
  box.classList.remove('is-stale');
  $('timing').textContent = `Ran in ${ms < 1 ? '<1' : Math.round(ms)} ms`;
  $('copy-report').disabled = $('view-code').disabled = false;
  setVerdict(result, animate);
  const { rows, connections } = renderProof(result);
  const raw = el('details', { className: 'raw', open: openRaw },
    el('summary', { textContent: 'Show the raw result' }), el('pre', { textContent: rawJson(result.raw), tabIndex: 0 }));
  const viz = result.viz
    ? el('details', { className: 'graphic', open: openGraphic },
      el('summary', { textContent: 'Show the result graphic' }), el('div', { className: 'viz-holder' }))
    : null;
  viz?.addEventListener('toggle', () => { if (viz.open) drawViz(result, animate); });
  const contents = [
    el('div', { className: 'tally' }, countBar(result), progressChip(result)),
    state.situation ? el('p', { className: 'situation' }, el('strong', { textContent: 'Example situation. ' }), state.situation) : null,
    result.summary ? el('p', { className: 'result-summary', textContent: result.summary }) : null,
    state.kit.inputGuide ? el('p', { className: 'input-guide', textContent: state.kit.inputGuide }) : null,
    result.quote ? el('blockquote', { className: 'claim-quote' }, el('mark', { textContent: result.quote })) : null,
    rows,
  ];
  box.replaceChildren(...contents.filter(Boolean));
  $('limit-slot').replaceChildren(limitNote());
  const statement = result.statement ? suggestedStatement(result.statement) : null;
  $('statement-slot').replaceChildren(...(statement ? [statement] : []));
  details.replaceChildren(...[viz, raw].filter(Boolean));
  linkSources(connections);
  if (isNumbers()) markNumberSource(result);
  if (state.scrollTrial && matchMedia('(max-width: 640px)').matches) rows.firstElementChild?.scrollIntoView({ block: 'start' });
  state.scrollTrial = false;
  if (viz?.open) drawViz(result, false);
  if (state.view === 'code') showCode();
  // The sheet's own size does not change when new rows arrive, so recheck whether it now scrolls (and needs a tab stop).
  syncSheetFocus();
}

function suggestedStatement(statement) {
  const copy = el('button', { type: 'button', className: 'copy', textContent: 'Copy', ariaLabel: 'Copy suggested statement',
    onclick: () => copyText(statement, copy) });
  return el('section', { className: 'suggestion', ariaLabel: 'Suggested statement' },
    el('div', { className: 'source-bar' }, el('h3', { textContent: 'Suggested statement' }), copy),
    el('blockquote', { textContent: statement }));
}

// --------------------------------------------------------- report and code
function showCode(focus = false) {
  if (!state.input) return;
  state.view = 'code';
  const button = $('view-code');
  button.setAttribute('aria-pressed', 'true');
  button.textContent = 'Back to the result';
  const code = state.kit.snippet(structuredClone(state.input));
  const pre = el('pre', { className: 'code', textContent: code, tabIndex: 0 });
  const copy = el('button', { type: 'button', className: 'btn', textContent: 'Copy code', onclick: () => copyText(code, copy) });
  $('code-view').replaceChildren(
    el('p', {}, 'Run the same check with Node 20+ after installing ', el('code', { textContent: `${state.kit.id}@${state.kit.version}` }), '.'),
    isCitations()
      ? el('p', {}, 'The snippet exits with code 1 for a bad or missing citation. It checks citation structure and word overlap.')
      : el('p', {}, 'The snippet exits with code 1 for the conditions listed in its code.'),
    pre, copy);
  $('work-view').hidden = true;
  $('code-view').hidden = false;
  if (focus) focusTarget(pre);
}

function hideCode() {
  state.view = 'result';
  $('view-code').setAttribute('aria-pressed', 'false');
  $('view-code').textContent = 'Use it in your code';
  $('code-view').hidden = true;
  $('work-view').hidden = false;
}

function renderFoot() {
  const kit = state.kit;
  const cmd = `npm install ${kit.id}@${kit.version}`;
  const copy = el('button', { type: 'button', className: 'copy', textContent: 'Copy', onclick: () => copyText(cmd, copy) });
  const npm = el('a', { href: `https://www.npmjs.com/package/${kit.id}`, target: '_blank', rel: 'noopener', textContent: 'npm' });
  npm.setAttribute('data-npm', '');
  $('foot').replaceChildren(
    el('span', { className: 'install' }, el('code', { textContent: cmd }), copy),
    el('span', { className: 'foot-links' },
      el('a', { href: `${kitDocs(kit)}#readme`, target: '_blank', rel: 'noopener', textContent: 'Docs' }), npm));
}

function openAgent() {
  const dialog = $('agent-dialog');
  if (!dialog.open) dialog.showModal();
}
function setupAgent() {
  const links = mcpLinks((s) => btoa(s));
  $('cc-cmd').textContent = links.claudeCode;
  $('json-cfg').textContent = links.configJson;
  $('add-cursor').href = links.cursor;
  $('add-vscode').href = links.vscode;
  $('open-agent').addEventListener('click', openAgent);
  $('open-agent-phone').addEventListener('click', openAgent);
  $('close-agent').addEventListener('click', () => $('agent-dialog').close());
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button));
  }
  $('agent-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
}

// Old links use #<kit> and #<kit>~<shared example>.
function readHash() {
  const hash = location.hash.slice(1);
  let raw = hash;
  try { raw = decodeURIComponent(hash); } catch { /* Malformed fragment. */ }
  const [id, token] = raw.split('~');
  const kit = KITS.find((k) => k.id === id);
  return { raw, kit, shared: kit && token ? decodeExample(kit, token) : null };
}

renderNav();
setupAgent();
const phone = matchMedia('(max-width: 640px)');
const hero = document.querySelector('.hero');
const trust = hero.querySelector('.trust');
function placeTrust() {
  (phone.matches ? hero.parentElement : hero).append(trust);
}
phone.addEventListener('change', placeTrust);
placeTrust();
$('skip-result').addEventListener('click', (event) => {
  event.preventDefault();
  focusTarget($('kit-title'));
});
editDraft.addEventListener('click', () => {
  const key = state.kit.draftKey;
  if (key) {
    setDraftMode(true);
    focusField($(`f-${state.kit.id}-${key}`));
    return;
  }
  const form = $('fields');
  if (state.kit.collapseInputs) {
    form.hidden = !form.hidden;
    editDraft.setAttribute('aria-expanded', String(!form.hidden));
    if (form.hidden) return;
  }
  const field = form.querySelector('textarea:not([hidden] *), input:not([hidden] *), select:not([hidden] *)');
  if (field) focusField(field);
});
for (const region of [$('sheet-body'), document.querySelector('.picker')]) {
  region.addEventListener('focusin', ({ target }) => {
    if (target !== region && target.matches(':focus-visible')) scrollFocus(target);
  });
}
for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
  $('sheet-content').addEventListener(event, (e) => {
    const target = linkTarget(event.endsWith('out') ? e.relatedTarget : e.target);
    if (event.startsWith('pointer')) {
      if (target === hoveredSource) return;
      hoveredSource = target;
      highlightSources();
    } else {
      highlightSources(target);
    }
  });
}
$('fields').addEventListener('submit', (event) => event.preventDefault());
$('copy-report').addEventListener('click', (event) => {
  if (state.result) copyText(reportMarkdown(state.kit, state.result, linkFor(state.input)), event.currentTarget);
});
$('view-code').addEventListener('click', () => (state.view === 'code' ? hideCode() : showCode(true)));
$('copy-link').addEventListener('click', (event) => {
  const link = exampleLink();
  if (link) copyText(link, event.currentTarget);
});
$('share-link').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const shown = state.result && state.input;
  const link = shown ? linkFor(state.input) : exampleLink();
  if (!link) return;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: `${state.kit.name} · Honesty Kits`, text: shown ? state.result.headline : state.kit.question, url: link });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  await copyText(link, button);
});
/** A scrolling sheet must be reachable by Tab; a sheet that fits must not be an empty tab stop. */
function syncSheetFocus() {
  const body = $('sheet-body');
  if (getComputedStyle(body).overflowY === 'auto' && body.scrollHeight > body.clientHeight + 1) body.tabIndex = 0;
  else body.removeAttribute('tabindex');
}
let drawing = 0;
const redraw = () => {
  cancelAnimationFrame(drawing);
  drawing = requestAnimationFrame(() => {
    syncSheetFocus();
    if (state.result && state.view === 'result') drawViz(state.result, false);
  });
};
const resize = new ResizeObserver(redraw);
resize.observe($('sheet-content'));
resize.observe($('sheet-body'));
document.fonts?.ready.then(redraw);

addEventListener('hashchange', () => {
  const { raw, kit, shared } = readHash();
  if (raw === 'add-to-agent') return openAgent();
  if (kit && (shared || kit !== state.kit)) selectKit(kit, shared);
});
const initial = readHash();
const retry = history.state?.retry;
if (retry) {
  const stateWithoutRetry = { ...history.state };
  delete stateWithoutRetry.retry;
  history.replaceState(stateWithoutRetry, '');
}
const defaultKit = KITS.find((kit) => kit.id === DEFAULT_KIT);
selectKit(KITS.find((kit) => kit.id === retry?.kit) ?? initial.kit ?? defaultKit, retry?.input ?? initial.shared);
if (initial.raw === 'add-to-agent') openAgent();
