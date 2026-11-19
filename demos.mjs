// One demo per kit. Each demo receives the kit's real published module (loaded
// from the site in the browser and from node_modules in tests) and the user's
// edited input, calls the kit's own exports, and returns a plain result:
//
//   { tone: 'pass' | 'fail' | 'warn' | 'info', headline, summary?, rows, viz?, raw }
//
//   rows: [{ mark: 'ok' | 'bad' | 'warn' | 'info' | 'skip', title, detail?, fix?, highlight? }]
//   viz:  data for the result graphic (see viz.mjs), drawn from the kit's output
//
// snippet(input) returns runnable code for the same check, for CI or an app.
// Nothing here re-implements a kit's logic; it only arranges the output.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ratePercent = (bps) => `${(bps / 100).toFixed(2)}%`;
const parityFieldLabels = new Map([['priceUsd', 'price'], ['lastReviewed', 'review date']]);
const receiptFactLabels = new Map([['cartItemCount', 'items in cart'], ['couponApplied', 'coupon applied']]);
const receiptActionLabels = new Map([['log-in', 'sign in'], ['add-to-cart', 'add items to the cart'], ['submit-payment', 'send a payment']]);
const parityFieldLabel = (key) => parityFieldLabels.get(key) ?? key;
const receiptFactLabel = (key) => receiptFactLabels.get(key) ?? key;
const receiptActionLabel = (key) => receiptActionLabels.get(key) ?? key;

/**
 * A proportion as a percent with at least `digits` decimals, and more when fewer would
 * print a rate short of 100% as 100%, or a rate above 0% as 0%. No % sign.
 */
const percentDigits = (x, digits) => {
  for (let d = digits; d <= 15; d += 1) {
    const s = (x * 100).toFixed(d);
    if ((x >= 1 || Number(s) < 100) && (x <= 0 || Number(s) > 0)) return s;
  }
  return String(x * 100);
};

const EVIDENCE_CLAIM_REFUSAL = 'Put the figure in the claim field, not inside the evidence. The evidence holds the counts, who labeled and how items were picked.';
function accuracyExplanation(line) {
  // The claim's wording has not been judged. Keep its numbers in the raw result.
  return line.replace(/^claim\.text says .*?, which is not the figure judged /,
    'The wording states a different figure from the figure judged ');
}
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * How long ago a stale claim was checked, set against its limit. Newer claims-registry
 * releases compare exact hours, so a claim can be stale while its whole-day count still
 * equals the limit.
 */
const staleAge = (ageDays, maxAgeDays) =>
  ageDays > maxAgeDays
    ? `${plural(ageDays, 'day')} ago, past the ${maxAgeDays}-day limit`
    : `${plural(ageDays, 'day')} and some hours ago, just past the ${maxAgeDays}-day limit`;
/**
 * Readable, valid JSON: flat objects and primitive arrays stay on one line,
 * lists of flat objects get one object per line.
 */
export function formatJson(value, indent = '') {
  const flat = (v) => v === null || typeof v !== 'object';
  // Spacing is added between serialized pieces only, never inside a string, so the
  // printed JSON parses back to exactly the value the playground checked.
  const list = (arr) => `[${arr.map((x) => JSON.stringify(x)).join(', ')}]`;
  const inline = (v) => {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${Array.isArray(x) ? list(x) : JSON.stringify(x)}`);
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  };
  const next = `${indent}  `;
  if (flat(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.every(flat)) return list(value);
    return `[\n${value.map((v) => next + (isFlatObject(v) ? inline(v) : formatJson(v, next))).join(',\n')}\n${indent}]`;
  }
  if (isFlatObject(value) && inline(value).length + indent.length <= 72) return inline(value);
  const entries = Object.entries(value).map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatJson(v, next)}`);
  return `{\n${entries.join(',\n')}\n${indent}}`;
}
function isFlatObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== 'object' || (Array.isArray(x) && x.every((y) => y === null || typeof y !== 'object')));
}
const js = (value) => formatJson(value);

/** Parse a date-only or zoned timestamp the strict way; reject anything else. */
function strictDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new RangeError(`${label} must be YYYY-MM-DD or a timestamp with a zone, like 2026-10-01T12:00:00Z`);
  }
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} is not a real date`);
  return date;
}
const isoMidnight = (value) => (value.length === 10 ? `${value}T00:00:00Z` : value);

// parity-kit's two checks share most options, but each refuses the ones only the other
// takes. Everything else, including a misspelled name, goes to both, so the kit still
// refuses a typo instead of the playground dropping it.
const PARITY_MIRROR_ONLY = ['fields', 'numberTolerance'];
const PARITY_AUDIT_ONLY = ['sourceFields', 'reviewerField', 'expiryField', 'valueFields', 'now', 'bulkThreshold'];
const parityOptions = (options, drop) => Object.fromEntries(Object.entries(options).filter(([name]) => !drop.includes(name)));

export const GROUPS = [
  'Check what your AI writes',
  'Keep public claims honest',
  'Test ranking and decision code',
  'Trust, agents and records',
  'Control AI spend',
];

// Ranking and decision code used by two demos. The snippet prints each
// function's own source, so the code you copy is exactly the code that ran.
const RANKERS = {
  'Ranks by quality score only': function rank(data) {
    const sorted = [...data.candidates].sort((a, b) => b.score - a.score);
    return { orderedIds: sorted.map((c) => c.id) };
  },
  'Quietly boosts higher-paying partners': function rank(data) {
    const value = (c) => c.score + c.payoutRateBps / 20; // the hidden boost
    const sorted = [...data.candidates].sort((a, b) => value(b) - value(a));
    return { orderedIds: sorted.map((c) => c.id) };
  },
};
const PAYOUT_SCENARIOS = [
  { name: 'every partner pays the same, high rate', short: 'All pay the same', mutate: (d) => ({ candidates: d.candidates.map((c) => ({ ...c, payoutRateBps: 500 })) }) },
  {
    name: 'the lowest-scoring product pays the most',
    short: 'Lowest pays most',
    mutate: (d) => {
      const worst = [...d.candidates].sort((a, b) => a.score - b.score)[0];
      return { candidates: d.candidates.map((c) => ({ ...c, payoutRateBps: c.id === worst?.id ? 10_000 : 0 })) };
    },
  },
  { name: 'nobody pays anything', short: 'Nobody pays', mutate: (d) => ({ candidates: d.candidates.map((c) => ({ ...c, payoutRateBps: 0 })) }) },
];
const SCORERS = {
  'Looks at income only': function score(app) {
    return { approved: app.income >= 40000, rateBps: 900 - Math.round(app.income / 1000) };
  },
  'Also peeks at zip code': function score(app) {
    const penalty = app.zip.startsWith('3') ? 150 : 0; // the hidden factor
    return { approved: app.income >= 40000, rateBps: 900 - Math.round(app.income / 1000) + penalty };
  },
};

/** A function's source, re-indented to start at column 0. */
function source(fn) {
  const lines = fn.toString().split('\n');
  if (lines.length < 2) return lines[0];
  const base = lines[lines.length - 1].match(/^ */)[0].length;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(base, l.match(/^ */)[0].length)))].join('\n');
}
const scenariosSource = () =>
  `[\n${PAYOUT_SCENARIOS.map((sc) => `  { name: ${JSON.stringify(sc.name)}, mutate: ${source(sc.mutate).replace(/\n/g, '\n  ')} },`).join('\n')}\n]`;

export const DEFAULT_KIT = 'number-trace-kit';

export const CITATION_TRIALS = [
  { label: 'Deny the claim', source: 'e1', situation: 'An AI assistant flips the conclusion of a battery test.', text: 'Battery life did not reach 14 hours in independent lab testing [[cite:e1]].' },
  { label: 'Change the numbers', source: 'e2', situation: 'An AI assistant changes the return window and warranty length.', text: 'The product ships with a 900 day return window and a 10 year limited warranty [[cite:e2]].' },
];

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const markPriority = ['bad', 'warn', 'info', 'ok', 'skip'];

function numberDraft(output, rows) {
  const ordered = [...rows].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  const sentences = [];
  for (const { segment, index } of sentenceSegmenter.segment(output)) {
    const notes = [];
    while (cursor < ordered.length && ordered[cursor].offset < index + segment.length) {
      const note = ordered[cursor++];
      notes.push({ ...note, title: note.highlight });
    }
    if (!segment.trim()) continue;
    const sourceMarks = notes.filter((note) => note.fromSource).map((note) => note.mark);
    const sourceMark = markPriority.find((mark) => sourceMarks.includes(mark));
    sentences.push({
      title: segment.trim(),
      quoted: true,
      mark: markPriority.find((mark) => notes.some((note) => note.mark === mark)) ?? 'skip',
      notes: notes.length ? notes : [{ mark: 'skip', detail: 'No number checked in this sentence.' }],
      sources: sourceMark ? [{ id: 'evidence', mark: sourceMark }] : [],
    });
  }
  return sentences;
}

export function verdictLabel(result) {
  return result.stamp ?? {
    pass: 'Passed', fail: 'Problems found', warn: 'Worth a look', info: 'Not enough to say',
    error: 'Input rejected', offline: 'Could not load', loading: 'Loading',
  }[result.tone];
}

export function progressLabel(result, before, after) {
  if (result.trackProgress === false || before === after) return null;
  if (after > before) return `Up from ${before} to ${after}`;
  return after === 0 ? `${plural(before, 'problem')} fixed` : `Down from ${before} to ${after}`;
}

export const KITS = [
  // ---------------------------------------------------------------- grounding
  {
    id: 'grounding-kit',
    version: '0.3.0',
    group: GROUPS[0],
    name: 'Citations',
    question: 'Does each sentence carry a citation that points at matching evidence?',
    catches: 'Catch missing and mismatched citations.',
    benchmark: 'readme',
    draftKey: 'text',
    limit: 'Checks citation structure and word overlap. It cannot tell whether the words mean the same thing or whether a claim is true.',
    fields: [
      { key: 'text', label: 'Text your AI wrote', kind: 'text', rows: 6 },
      { key: 'evidence', label: 'Evidence it was given (id → text)', kind: 'json', rows: 6 },
    ],
    presets: [
      {
        label: 'A draft with problems',
        situation: 'An AI assistant drafts a product review from a lab test and warranty terms.',
        input: {
          text:
            'Battery life reached 14 hours in independent lab testing [[cite:e1]].\n' +
            'Some reviewers say the app drains battery overnight.\n' +
            'The warranty covers accidental damage for five years [[cite:e2]].\n' +
            'We could not confirm the refund processing time [citation needed].',
          evidence: {
            e1: 'independent lab testing measured 14 hours of battery life on a full charge',
            e2: 'the product ships with a 90 day return window and a 1 year limited warranty',
          },
        },
      },
      {
        label: 'Every sentence cited',
        situation: 'An AI assistant summarizes a battery test and the return policy for shoppers.',
        input: {
          text:
            'Battery life reached 14 hours in independent lab testing [[cite:e1]].\n' +
            'The product ships with a 90 day return window [[cite:e2]].',
          evidence: {
            e1: 'independent lab testing measured 14 hours of battery life on a full charge',
            e2: 'the product ships with a 90 day return window and a 1 year limited warranty',
          },
        },
      },
    ],
    run(kit, input) {
      const result = kit.classifyDocument(input.text, input.evidence);
      const look = {
        grounded: ['info', 'Cited', null],
        placeholder: ['info', 'Honestly marked as needing a source', 'Find a source before publishing, or keep the gap visible to readers.'],
        ungrounded: ['warn', 'Makes a claim with no citation', 'Cite the evidence that supports it, or mark it [citation needed].'],
        invalid: ['bad', 'Bad citation', 'Check the source yourself, then cite the intended source or revise the sentence.'],
      };
      const known = new Set(Object.keys(input.evidence));
      const rows = result.sentences.map((s) => {
        const [mark, why, fix] = look[s.status] ?? ['info', s.status, null];
        let detail = `${why}.${s.citedIds.length ? ` Cites ${s.citedIds.join(', ')}.` : ''}`;
        if (s.status === 'grounded') detail = `Cited; words overlap with ${s.validIds.join(', ')}`;
        if (s.status === 'invalid') {
          // Newer releases say why each citation failed; older ones only say that it did.
          const reason = (id) => s.reasons?.[id] ?? (known.has(id) ? 'not-supported' : 'unknown-id');
          const ids = (r) => s.citedIds.filter((id) => reason(id) === r);
          const [missing, notText, thin, rest] = [ids('unknown-id'), ids('invalid-evidence'), ids('no-content-words'), ids('not-supported')];
          const parts = [];
          if (missing.length) parts.push(`Cites ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the evidence.`);
          if (notText.length) parts.push(`The evidence for ${notText.join(', ')} is not text.`);
          if (thin.length) parts.push(`Cites ${thin.join(', ')}, but the sentence has no word longer than three characters, so there is nothing to compare.`);
          if (rest.length || !parts.length) parts.push(`Cites ${(rest.length ? rest : s.citedIds).join(', ')}, but there is too little word overlap.`);
          detail = parts.join(' ');
        }
        return { mark, label: s.status === 'grounded' ? detail : why, title: s.sentence, quoted: true, detail, fix };
      });
      const { grounded, placeholder, ungrounded, invalid } = result.counts;
      const tone = invalid > 0 ? 'fail' : ungrounded > 0 ? 'warn' : 'info';
      const headline = result.isClean
        ? 'Word overlap only. Read the evidence to judge whether it is true.'
        : `Not ready to ship: ${plural(invalid, 'bad citation')}, ${plural(ungrounded, 'uncited claim')}.`;
      const viz = {
        type: 'threads',
        sentences: result.sentences.map((s) => ({ status: s.status, citedIds: s.citedIds, validIds: s.validIds })),
        evidenceIds: Object.keys(input.evidence),
      };
      return {
        tone,
        headline,
        stamp: result.isClean ? 'No structural problems' : undefined,
        trackProgress: false,
        counts: [['cited', grounded, 'info'], ['marked', placeholder, 'info'], ['uncited', ungrounded, 'warn'], [invalid === 1 ? 'bad citation' : 'bad citations', invalid, 'bad']],
        reportSummary: `${grounded} cited · ${placeholder} marked · ${ungrounded} uncited · ${plural(invalid, 'bad citation')}`,
        rows, viz, raw: result,
      };
    },
    snippet: (input) => `import { classifyDocument } from 'grounding-kit';

const evidence = ${js(input.evidence)};

const text = ${js(input.text)};

const result = classifyDocument(text, evidence);
for (const s of result.sentences) console.log(s.status.padEnd(11), s.sentence);

// Fail the build when any sentence has a bad or missing citation.
if (!result.isClean) process.exitCode = 1;
`,
  },

  // --------------------------------------------------------------- provenance
  {
    id: 'provenance-kit',
    version: '0.3.0',
    group: GROUPS[0],
    name: 'Certainty wording',
    question: 'Does the copy sound more certain than its source allows?',
    catches: 'Catch wording that overstates certainty.',
    benchmark: 'strict-mode-for-ci',
    draftKey: 'claims',
    inputGuide: 'Source labels: Verified means checked against a source. Modeled means an estimate. Editorial means an opinion.',
    limit: 'Matches a starter list of phrases you can extend. It is a wording check, not a fact check.',
    fields: [{ key: 'claims', label: 'Claims and their sources', kind: 'json', rows: 13 }],
    presets: [
      {
        label: 'Marketing copy',
        situation: 'A shopping site writes about how it rates products and checks prices.',
        input: {
          claims: [
            { id: 'ratings', text: 'Our ratings are independently verified.', tier: 'modeled' },
            { id: 'prices', text: 'Prices are checked every morning (verified).', tier: 'verified' },
            { id: 'reviews', text: 'Review scores are not independently verified.', tier: 'modeled' },
            { id: 'picks', text: 'These are our favorite picks this season.', tier: 'editorial' },
          ],
        },
      },
      {
        label: 'Carefully worded copy',
        situation: 'A shop reports a price check and estimates delivery time.',
        input: {
          claims: [
            { id: 'prices', text: 'Prices were checked this morning.', tier: 'verified', sourceRef: 'retailer feed, 2026-10-01 06:00 UTC' },
            { id: 'estimate', text: 'We estimate delivery in 3 to 5 days.', tier: 'modeled' },
          ],
        },
      },
    ],
    run(kit, input) {
      const offenses = kit.validateClaims(input.claims);
      const fixes = {
        certainty_phrase_without_backing_tier: 'Remove the flagged phrase. If someone checked the claim, set its source label (tier) to verified and put the source in the sourceRef field.',
        missing_source_ref: 'Put the name or link of what you checked against in the sourceRef field.',
        unknown_tier: 'Set the source label (tier) to verified, modeled or editorial. If you choose verified, also name the source in the sourceRef field.',
      };
      const labels = {
        certainty_phrase_without_backing_tier: 'Wording overstates certainty',
        missing_source_ref: 'Source missing',
        unknown_tier: 'Unknown source label',
      };
      const clean = 'No listed phrase found';
      const flagged = new Set(offenses.map((o) => o.claimId));
      const rows = [
        ...offenses.map((o) => ({
          mark: 'bad', title: clip(o.claimText), quoted: true, highlight: o.phrase ?? null,
          label: labels[o.reason],
          detail: {
            missing_source_ref: 'The claim is labeled verified but names no source.',
            certainty_phrase_without_backing_tier: `“${o.phrase}” signals more certainty than the source label allows.`,
            unknown_tier: 'The source label is missing or unrecognized.',
          }[o.reason] ?? o.message,
          fix: fixes[o.reason] ?? 'Reword the claim or name its source.',
        })),
        ...input.claims
          .filter((c) => c && !flagged.has(c.id))
          .map((c) => ({ mark: 'info', title: clip(String(c.text)), quoted: true, label: clean, detail: `${clean}.` })),
      ];
      const tone = offenses.length ? 'fail' : 'info';
      const headline = offenses.length
        ? `${plural(offenses.length, 'wording problem')} across ${plural(input.claims.length, 'claim')}.`
        : input.claims.length ? `${plural(input.claims.length, 'claim')} checked against the phrase list.` : 'Add a claim to check.';
      return { tone, headline, stamp: offenses.length ? undefined : input.claims.length ? clean : 'No claims to check', rows, raw: offenses };
    },
    snippet: (input) => `import { validateClaims } from 'provenance-kit';

const claims = ${js(input.claims)};

const offenses = validateClaims(claims);
for (const o of offenses) console.log(\`[\${o.claimId}] \${o.message}\`);
console.log(\`\${offenses.length} wording problem(s) in \${claims.length} claim(s)\`);

// Fail the build when copy claims more certainty than its source allows.
if (offenses.length > 0) process.exitCode = 1;
`,
  },

  // ------------------------------------------------------------ number-trace
  {
    id: 'number-trace-kit',
    version: '0.1.1',
    group: GROUPS[0],
    name: 'Numbers',
    question: 'Does every number in an AI answer appear in the evidence it was given?',
    catches: 'Catch numbers that changed or lack a source.',
    benchmark: 'accuracy-on-real-data',
    draftKey: 'output',
    limit: 'Checks that a number is present in the evidence, not that it is true or sits in the right sentence. Numbers written as words are not read.',
    fields: [
      { key: 'output', label: 'Paste what your AI wrote', kind: 'text', rows: 3 },
      { key: 'evidence', label: 'Paste the source it was given', kind: 'text', rows: 3 },
      { key: 'table', label: 'Rows that should add up to a printed total (null skips this)', kind: 'json', rows: 9 },
      { key: 'mode', label: 'How to match numbers', kind: 'choice', options: ['strict', 'report'],
        optionLabels: { strict: 'Match numbers in the source', report: 'Also check calculations from the source' } },
    ],
    presets: [
      {
        label: 'An invented number',
        situation: 'An AI assistant answers a customer’s question about an invoice.',
        input: {
          evidence: 'Subtotal $1,200.00. Tax (8.25%) $99.00. Total due $1,299.00.',
          output: 'Total due is $1,299.00, including 8.3% tax. Payment is due in 45 days.',
          table: { rows: [{ label: 'Subtotal', amount: '1200.00' }, { label: 'Tax', amount: '99.00' }], total: '1299.00' },
          mode: 'strict',
        },
      },
      {
        label: 'Numbers that trace',
        situation: 'An AI assistant repeats an invoice total and rounds its tax rate.',
        input: {
          evidence: 'Subtotal $1,200.00. Tax (8.25%) $99.00. Total due $1,299.00.',
          output: 'Total due is $1,299.00, including 8.3% tax.',
          table: { rows: [{ label: 'Subtotal', amount: '1200.00' }, { label: 'Tax', amount: '99.00' }], total: '1299.00' },
          mode: 'strict',
        },
      },
      {
        label: 'A figure built from two others',
        situation: 'An AI assistant compares this quarter’s total with last quarter’s.',
        input: {
          evidence: 'Last quarter the total was $1,000.00. This quarter the total is $1,299.00.',
          output: 'The total is $1,299.00, up 30% from last quarter.',
          table: null,
          mode: 'report',
        },
      },
      {
        label: 'Rows that do not add up',
        situation: 'An AI assistant repeats the total printed on an invoice.',
        input: {
          evidence: 'Subtotal $1,200.00. Tax $99.00. Total due $1,299.01.',
          output: 'Total due is $1,299.01, the subtotal plus tax.',
          table: { rows: [{ label: 'Subtotal', amount: '1200.00' }, { label: 'Tax', amount: '99.00' }], total: '1299.01' },
          mode: 'strict',
        },
      },
    ],
    run(kit, input) {
      const evidence = String(input.evidence);
      const output = String(input.output);
      const mode = input.mode === 'report' ? 'report' : 'strict';
      const result = kit.traceNumbers(output, evidence, { preset: mode });
      const sum = input.table == null ? null : kit.reconcile(input.table);
      const quote = (raw) => `“${raw}”`;
      // A few words around the number, cut at word edges, so each row says which one it means.
      const around = (start, end) => {
        let from = Math.max(0, start - 26);
        let to = Math.min(output.length, end + 14);
        const forward = output.indexOf(' ', from);
        if (from > 0 && forward !== -1 && forward < start) from = forward + 1;
        const back = output.lastIndexOf(' ', to);
        if (to < output.length && back > end) to = back;
        return `${from > 0 ? '…' : ''}${output.slice(from, to).replace(/\s+/g, ' ').trim()}${to < output.length ? '…' : ''}`;
      };
      const KIND = { sum: 'sum', difference: 'difference', ratio: 'ratio', 'percent-change': 'percent change', 'percent-of': 'percent of', average: 'average', product: 'product' };
      const NEAR = { 'unit-differs': 'unit', 'kind-differs': 'kind of number', 'sign-differs': 'sign' };
      const rows = [];
      // The kit passes some matches with a flag: the answer dropped a sign the evidence
      // has, or only one side carries the unit. Those are qualified matches, never plain ones.
      const qualified = (n) => {
        const notes = [];
        const fixes = [];
        if (n.signDiffers) {
          notes.push('The evidence has it with the opposite sign, so the answer may have dropped a minus sign or parentheses.');
          fixes.push('Restore the sign the evidence shows');
        }
        if (n.unitUnverified) {
          notes.push('Only one side carries the unit, so the match may be a coincidence between different quantities.');
          fixes.push('confirm the number means the same thing in both places');
        }
        return notes.length ? { mark: 'warn', note: ` ${notes.join(' ')}`, fix: `${fixes.join(', and ')}.`.replace(/^./, (c) => c.toUpperCase()) } : null;
      };
      for (const n of result.numbers) {
        const title = around(n.token.start, n.token.end);
        const base = { title, highlight: n.token.raw, offset: n.token.start, fromSource: Boolean(n.evidence.length || n.derivation?.operands.length) };
        const found = n.evidence[0] ? quote(n.evidence[0].raw) : 'the evidence';
        const q = qualified(n);
        const flag = (mark, detail) => (q ? { ...base, mark: q.mark, detail: `${detail}${q.note}`, fix: q.fix } : { ...base, mark, detail });
        if (n.status === 'traced') rows.push(flag('ok', `In the evidence as ${found}.`));
        else if (n.status === 'rounded') rows.push(flag('ok', `Matches ${found} in the evidence, rounded to the digits shown.`));
        else if (n.status === 'derived') {
          const d = n.derivation;
          rows.push(flag('info', `Not stated in the evidence. It matches the ${KIND[d.kind] ?? d.kind} of ${d.operands.map((o) => quote(o.raw)).join(' and ')}${d.exact ? '' : ', to the digits shown'}.`));
        } else if (n.status === 'untraced') {
          const near = (n.nearMisses ?? []).map((m) => `The evidence has ${quote(m.evidence.raw)} with a different ${NEAR[m.reason] ?? 'form'}.`).join(' ');
          rows.push({ ...base, mark: 'bad', detail: `Not in the evidence. ${near}`.trim(), fix: 'Remove the number, or add the source that states it to the evidence, then check again.' });
        } else if (n.status === 'unknown') {
          rows.push({ ...base, mark: 'warn', detail: `The kit could not decide${n.reason ? `: ${n.reason.replace(/-/g, ' ')}` : ''}.`, fix: 'Have a person check this number against its source.' });
        }
      }
      const numberRows = [...rows];
      for (const s of result.skipped) {
        if (s.reason === 'ignored') continue;
        const holds = s.reason === 'unread-glued-form' || s.reason === 'not-in-evidence';
        const why = { identifier: 'It looks like a name or code, not a quantity.', 'in-evidence': 'The evidence writes it the same way.', 'unread-glued-form': 'It is glued to letters the kit does not read.', 'not-in-evidence': 'It looks like a code that the evidence does not contain.' }[s.reason];
        const row = { mark: holds ? 'warn' : 'skip', title: around(s.start, s.end), highlight: s.raw, offset: s.start, detail: `Not read as a number. ${why}`, fix: holds ? 'Have a person check this one.' : undefined };
        rows.push(row);
        numberRows.push(row);
      }
      // The kit reads an integer amount as minor units (200 is 2.00), so show each row as the
      // kit read it, from the kit itself, not as typed.
      const exact = sum && Number(sum.difference) === 0;
      if (sum) {
        const parts = input.table.rows.map((r) => kit.reconcile({ rows: [r], total: r.amount }).sum).join(' + ');
        const gap = sum.difference.replace(/^-/, '');
        const side = sum.difference.startsWith('-') ? 'more' : 'less';
        if (sum.ok && exact) rows.push({ mark: 'ok', title: `Totals: the rows add up, ${parts || '0'} = ${sum.sum}`, field: 'table' });
        else if (sum.ok) rows.push({ mark: 'ok', title: 'Totals: the rows match within the tolerance', field: 'table', detail: `${parts} comes to ${sum.sum}. The total says ${sum.total}, ${gap} ${side}, inside the ${sum.tolerance} tolerance you allowed.` });
        else {
          const allowed = Number(sum.tolerance) === 0 ? '' : ` That is outside the ${sum.tolerance} tolerance you allowed.`;
          rows.push({ mark: 'bad', title: 'Totals: the rows do not add up to the printed total', field: 'table', detail: `The rows (${parts}) sum to ${sum.sum}, but the total says ${sum.total}, which is ${gap} ${side}.${allowed}`, fix: 'Correct the total or the row that is wrong.' });
        }
      }
      const { counts } = result;
      const found = result.numbers.length;
      const flagged = result.numbers.filter((n) => n.signDiffers || n.unitUnverified).length;
      if (!found) rows.unshift({ mark: 'info', title: 'No numbers to check', detail: 'The answer has no digits the kit reads. Numbers written as words are not read.' });
      const bits = [];
      if (counts.untraced) bits.push(`${counts.untraced} of ${plural(found, 'number')} not found in the source`);
      if (sum && !sum.ok) bits.push('the rows do not add up to the printed total');
      const tone = bits.length ? 'fail' : result.verdict === 'unknown' || flagged ? 'warn' : found ? 'pass' : 'info';
      const headline = bits.length
        ? `${bits.join(', and ')}.`.replace(/^./, (c) => c.toUpperCase())
        : result.verdict === 'unknown' ? 'Some numbers could not be read or decided, so a person should look.'
        : flagged ? `${plural(flagged, 'number')} ${flagged === 1 ? 'matches' : 'match'} the evidence only with a different sign or a unit on one side, so a person should look.`
        : found ? `${found === 1 ? 'The number' : found === 2 ? 'Both numbers' : `All ${found} numbers`} ${counts.derived ? `${found === 1 ? 'is' : 'are'} stated in the evidence or built from it` : `trace${found === 1 ? 's' : ''} to the source`}${sum ? (exact ? ', and the rows add up' : ', and the rows match the printed total within the allowed difference') : ''}.`
        : 'No numbers found in the answer.';
      const extra = [counts.signDiffers ? `${counts.signDiffers} with a different sign` : '', counts.unitUnverified ? `${counts.unitUnverified} with a unit on one side only` : ''].filter(Boolean);
      return {
        tone,
        headline,
        counts: [
          ['found in the source', counts.traced, 'ok'], ['rounded', counts.rounded, 'ok'], ['worked out', counts.derived, 'info'],
          ['not in the source', counts.untraced, 'bad'],
          ...(counts.unknown ? [['unknown', counts.unknown, 'warn']] : []),
          ...(flagged ? [['qualified', flagged, 'warn']] : []),
          ...(sum && !sum.ok ? [['total mismatch', 1, 'bad']] : []),
        ],
        reportSummary: `${counts.traced} found in the source, ${counts.rounded} rounded, ${counts.derived} worked out, ${counts.untraced} not in the source${counts.unknown ? `, ${counts.unknown} unknown` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}${sum && !sum.ok ? ', 1 total mismatch' : ''}.`,
        rows,
        draft: numberDraft(output, numberRows),
        findings: rows.filter((row) => row.offset === undefined),
        sourceRanges: result.numbers.filter((n) => n.status === 'traced' || n.status === 'rounded')
          .filter((n) => !n.signDiffers && !n.unitUnverified)
          .flatMap((n) => n.evidence.map(({ start, end }) => [start, end])),
        raw: { trace: result, reconcile: sum },
      };
    },
    snippet: (input) => `import { traceNumbers${input.table == null ? '' : ', reconcile'} } from 'number-trace-kit';

const evidence = ${js(input.evidence)};
const output = ${js(input.output)};

const result = traceNumbers(output, evidence, { preset: ${js(input.mode === 'report' ? 'report' : 'strict')} });
for (const n of result.numbers) {
  const flags = [n.signDiffers && 'sign differs from the evidence', n.unitUnverified && 'unit on one side only'].filter(Boolean);
  console.log(n.token.raw.padEnd(14), n.status, flags.length ? \`(\${flags.join(', ')})\` : '');
}
console.log(\`verdict: \${result.verdict}\`);
// A match with a dropped sign or a unit on one side still counts as traced; treat it as a problem.
const qualified = result.counts.signDiffers + result.counts.unitUnverified;
${input.table == null ? '' : `
const sum = reconcile(${js(input.table)});
console.log(!sum.ok ? \`rows sum to \${sum.sum}, total says \${sum.total}\` : Number(sum.difference) === 0 ? 'rows add up' : \`rows sum to \${sum.sum}, within the \${sum.tolerance} tolerance of \${sum.total}\`);
`}
// Fail the build when a number is missing from the evidence or matches it only with a different sign or unit${input.table == null ? '' : ', or the rows do not add up'}.
if (result.verdict !== 'clean' || qualified > 0${input.table == null ? '' : ' || !sum.ok'}) process.exitCode = 1;
`,
  },

  // ------------------------------------------------------------ corroboration
  {
    id: 'corroboration-kit',
    version: '0.3.0',
    group: GROUPS[0],
    name: 'Evidence strength',
    question: 'Do the sources you looked at agree with the claim?',
    catches: 'See whether sources agree.',
    limit: 'Counts the sources you name. It cannot tell whether different sources are really independent.',
    fields: [
      { key: 'claim', label: 'The claim you are checking', kind: 'line', optional: true },
      { key: 'coverage', label: 'How much of the evidence you looked at', kind: 'choice', options: ['strong', 'partial', 'thin'],
        optionLabels: { strong: 'Broad coverage', partial: 'Partial coverage', thin: 'Little evidence reviewed' } },
      { key: 'signals', label: 'What each source said', kind: 'json', rows: 11 },
    ],
    presets: [
      {
        label: 'The evidence says no',
        situation: 'A shop checks a stock claim against its inventory records and product page.',
        input: {
          claim: 'The product is in stock.',
          coverage: 'strong',
          signals: [
            { source: 'Inventory records', kind: 'structural', vote: 'contradicts', detail: 'The inventory records show 0 in stock.' },
            { source: 'Product page', kind: 'textual', vote: 'contradicts', detail: 'The product page says sold out.' },
          ],
        },
      },
      {
        label: 'Two sources agree',
        situation: 'A shop checks a price change against its price records and checkout page.',
        input: {
          claim: 'The new price is live.',
          coverage: 'strong',
          signals: [
            { source: 'Price records', kind: 'structural', vote: 'supports', detail: 'The price records show the new price.' },
            { source: 'Checkout page', kind: 'textual', vote: 'supports', detail: 'The checkout page shows the new price.' },
          ],
        },
      },
      {
        label: 'Thin sample, mixed signals',
        situation: 'A team compares a user’s praise for a feature with an open bug report.',
        input: {
          claim: 'The feature works as intended.',
          coverage: 'thin',
          signals: [
            { source: 'forum-post', kind: 'textual', vote: 'supports', detail: 'one user says it works' },
            { source: 'issue-tracker', kind: 'behavioral', vote: 'contradicts', detail: 'open bug report' },
          ],
        },
      },
    ],
    run(kit, input) {
      const result = kit.corroborate(input.signals, input.coverage);
      const voteMark = { supports: 'info', contradicts: 'bad', inconclusive: 'skip' };
      const voteLabel = { supports: 'Supports the claim.', contradicts: 'Contradicts the claim.', inconclusive: 'Inconclusive.' };
      const rows = result.signals.map((s) => ({
        mark: voteMark[s.vote] ?? 'info',
        title: s.detail ? `${s.detail.charAt(0).toUpperCase()}${s.detail.slice(1)}` : s.source,
        detail: s.detail ? `${s.source}. ${voteLabel[s.vote]}` : voteLabel[s.vote],
      }));
      const direction = {
        supports: 'The evidence supports the claim.',
        contradicts: `${plural(result.contradicts, 'source')} ${result.contradicts === 1 ? 'contradicts' : 'contradict'} the claim.`,
        mixed: 'The evidence is split.',
        none: 'There is no evidence either way.',
      }[result.direction];
      // Newer releases count pages of one site or repository once, and say so.
      for (const group of result.groups ?? []) {
        for (const merge of group.merges) rows.push({ mark: 'info', title: 'Counted as one source', detail: merge.explanation });
      }
      const fix = result.direction === 'contradicts' ? 'Update the claim to match the evidence, or remove it.'
        : result.verdict !== 'confirmed' ? 'Look at more evidence, including records or something you observed directly.'
        : null;
      const tone = result.direction === 'contradicts' ? 'fail' : result.direction === 'supports' && result.verdict === 'confirmed' ? 'pass' : 'warn';
      return {
        tone,
        headline: direction,
        fix,
        quote: input.claim?.trim(),
        counts: [[result.supports === 1 ? 'supporting source' : 'supporting sources', result.supports, 'info'],
          [result.contradicts === 1 ? 'contradicting source' : 'contradicting sources', result.contradicts, 'bad']],
        reportSummary: `${plural(result.supports, 'supporting source')} · ${plural(result.contradicts, 'contradicting source')}`,
        rows,
        viz: { type: 'needle', supports: result.supports, contradicts: result.contradicts, direction: result.direction, verdict: result.verdict, coverage: result.coverage },
        raw: result,
      };
    },
    snippet: (input) => `import { corroborate } from 'corroboration-kit';

const signals = ${js(input.signals)};

const result = corroborate(signals, ${js(input.coverage)});
console.log(\`direction: \${result.direction}, verdict: \${result.verdict}\`);

// Fail the build unless the evidence confirms the claim.
if (result.direction !== 'supports' || result.verdict !== 'confirmed') process.exitCode = 1;
`,
  },

  // ---------------------------------------------------------- claims-registry
  {
    id: 'claims-registry-kit',
    version: '0.4.0',
    group: GROUPS[1],
    name: 'Claims on your site',
    question: 'Does each public claim point at evidence that someone reviewed recently?',
    catches: 'Find claims that need evidence or a review.',
    limit: 'Checks that a claim points at evidence and that it was reviewed recently, not that the evidence still holds.',
    fields: [
      { key: 'now', label: 'Date to check against', kind: 'line' },
      { key: 'maxAgeDays', label: 'Re-check claims every N days', kind: 'line' },
      { key: 'claims', label: 'Claims and their evidence', kind: 'json', rows: 12 },
    ],
    presets: [
      {
        label: 'A typical product page',
        situation: 'A software team checks the references and review dates for its product claims.',
        input: {
          now: '2026-10-01',
          maxAgeDays: '90',
          claims: [
            { id: 'sync', text: 'Changes sync across your team in real time', evidenceRef: 'tests/sync.spec.ts', verifiedAt: '2026-09-20' },
            { id: 'soc2', text: 'SOC 2 Type II audited', evidenceRef: 'docs/soc2-2025.pdf', verifiedAt: '2025-11-01' },
            { id: 'uptime', text: '99.9% uptime, guaranteed', evidenceRef: '', verifiedAt: '2026-09-30' },
          ],
        },
      },
      {
        label: 'Everything current',
        situation: 'A software team reviews the references behind its syncing and export claims.',
        input: {
          now: '2026-10-01',
          maxAgeDays: '90',
          claims: [
            { id: 'sync', text: 'Changes sync across your team in real time', evidenceRef: 'tests/sync.spec.ts', verifiedAt: '2026-09-20' },
            { id: 'export', text: 'Export any report to CSV', evidenceRef: 'tests/export.spec.ts', verifiedAt: '2026-09-28' },
          ],
        },
      },
    ],
    run(kit, input) {
      const now = strictDate(input.now, 'Date to check against');
      const maxAgeDays = Number(input.maxAgeDays);
      const report = kit.generateClaimsReport(input.claims, maxAgeDays, now);
      const rows = [
        ...report.unverified.map((c) => ({ mark: 'bad', title: clip(c.text), quoted: true, label: 'Evidence link missing', detail: 'No evidence linked, or only a placeholder such as TODO.', fix: 'Link evidence (a test, document or data source), or take the claim down.' })),
        ...report.stale.map((c) => ({ mark: 'warn', title: clip(c.text), quoted: true, label: 'Review needed', detail: c.ageDays === null ? 'The review date could not be read.' : `Last checked ${staleAge(c.ageDays, maxAgeDays)}. Due for a re-check.`, fix: 'Re-check the evidence and update the review date.' })),
        ...report.current.map((c) => ({ mark: 'info', title: clip(c.text), quoted: true, label: 'Evidence link present', detail: `Has an evidence link; reviewed ${plural(c.ageDays, 'day')} ago.` })),
      ];
      const { current, stale, unverified, total } = report.counts;
      const tone = unverified ? 'fail' : stale ? 'warn' : 'info';
      const problems = [
        unverified ? `${plural(unverified, 'claim')} with no evidence link` : '',
        stale ? `${plural(stale, 'claim')} overdue for a check` : '',
      ].filter(Boolean);
      const headline = unverified || stale
        ? `${problems.join(', ')}.`
        : total === 0 ? 'There are no claims to check.'
        : total === 1 ? `The claim points at evidence and was checked within ${plural(maxAgeDays, 'day')}.`
        : `${total === 2 ? 'Both claims' : `All ${total} claims`} point at evidence and were checked within ${plural(maxAgeDays, 'day')}.`;
      const mark = (c) => (report.unverified.includes(c) ? 'bad' : report.stale.includes(c) ? 'warn' : 'info');
      const items = [...report.current, ...report.stale, ...report.unverified].map((c) => ({ label: c.id, ageDays: c.ageDays, mark: mark(c) }));
      return {
        tone,
        stamp: tone === 'info' ? total ? 'Evidence links present, dates recent' : 'No claims to check' : undefined,
        headline,
        counts: [['current', current, 'info'], ['overdue', stale, 'warn'], ['no evidence link', unverified, 'bad']],
        rows,
        viz: { type: 'timeline', items, thresholds: [{ days: maxAgeDays, label: `re-check after ${maxAgeDays}d` }], unit: 'days since last checked' },
        raw: report,
      };
    },
    snippet: (input) => `import { generateClaimsReport, formatClaimsReportAsText } from 'claims-registry-kit';

const claims = ${js(input.claims)};

const report = generateClaimsReport(claims, ${Number(input.maxAgeDays)}, new Date(${js(isoMidnight(input.now))})); // drop the date to use today
console.log(formatClaimsReportAsText(report));

// Fail the build when a claim has no evidence or is overdue for a check.
if (report.counts.unverified + report.counts.stale > 0) process.exitCode = 1;
`,
  },

  // ---------------------------------------------------------------- freshness
  {
    id: 'freshness-kit',
    version: '0.3.0',
    group: GROUPS[1],
    name: 'Freshness labels',
    question: 'How old is this information, and what should its label say?',
    catches: 'See which review dates are overdue.',
    limit: 'Measures age from the review date you supply. It does not know whether the content changed.',
    fields: [
      { key: 'now', label: 'Date to check against', kind: 'line' },
      { key: 'config', label: 'Review date limits', kind: 'json', rows: 4, numberFields: [
        ['warnAfterDays', 'Warn after this many days'],
        ['staleAfterDays', 'Mark as stale after this many days'],
      ] },
      { key: 'pages', label: 'Pages and when each was last reviewed', kind: 'json', rows: 9 },
    ],
    presets: [
      {
        label: 'A help center',
        situation: 'A support team checks when it last reviewed shipping, returns and warranty pages.',
        input: {
          now: '2026-10-01',
          config: { warnAfterDays: 30, staleAfterDays: 90 },
          pages: [
            { page: 'Shipping rates', reviewedOn: '2026-09-24' },
            { page: 'Return policy', reviewedOn: '2026-08-10' },
            { page: 'Warranty terms', reviewedOn: '2026-03-02' },
          ],
        },
      },
      {
        label: 'Recently reviewed pages',
        situation: 'A support team looks at the dates from its latest help center review.',
        input: {
          now: '2026-10-01',
          config: { warnAfterDays: 30, staleAfterDays: 90 },
          pages: [
            { page: 'Shipping rates', reviewedOn: '2026-09-24' },
            { page: 'Return policy', reviewedOn: '2026-09-25' },
            { page: 'Warranty terms', reviewedOn: '2026-09-26' },
          ],
        },
      },
    ],
    run(kit, input) {
      const now = strictDate(input.now, 'Date to check against');
      const mark = { fresh: 'ok', aging: 'warn', stale: 'bad' };
      const fix = { aging: 'Schedule a review before it goes stale.', stale: 'Review the page and update its reviewed date.' };
      const results = input.pages.map((p) => ({ page: p.page, result: kit.assessFreshness(p.reviewedOn, input.config, undefined, now) }));
      const rows = results.map(({ page, result }) => {
        const badge = kit.freshnessBadgeText(result);
        return {
          mark: mark[result.level] ?? 'info',
          title: page,
          quoted: true,
          label: badge ? badge.replace(/\s*\u2014\s*/g, ': ').replace(/\b(\d+)d\b/g, (_, days) => plural(Number(days), 'day')) : 'No freshness label needed',
          detail: result.message || `Reviewed ${plural(result.ageDays, 'day')} ago, inside your ${input.config.warnAfterDays}-day window.`,
          fix: fix[result.level] ?? null,
        };
      });
      const stale = results.filter((r) => r.result.level === 'stale').length;
      const warn = results.filter((r) => r.result.level === 'aging').length;
      const tone = stale ? 'fail' : warn ? 'warn' : 'pass';
      const headline = stale || warn ? `${plural(stale, 'page')} stale, ${warn} getting old.` : `All ${plural(results.length, 'page')} are fresh.`;
      return {
        tone,
        headline,
        rows,
        viz: {
          type: 'timeline',
          items: results.map((r) => ({ label: r.page, ageDays: r.result.ageDays, mark: mark[r.result.level] ?? 'info' })),
          thresholds: [{ days: input.config.warnAfterDays, label: `warn ${input.config.warnAfterDays}d` }, { days: input.config.staleAfterDays, label: `stale ${input.config.staleAfterDays}d` }],
          unit: 'days since last reviewed',
        },
        raw: results,
      };
    },
    snippet: (input) => `import { assessFreshness, freshnessBadgeText } from 'freshness-kit';

const config = ${js(input.config)};
const pages = ${js(input.pages)};
const now = new Date(${js(isoMidnight(input.now))}); // drop this to use today

let stale = 0;
for (const p of pages) {
  const result = assessFreshness(p.reviewedOn, config, undefined, now);
  console.log(p.page.padEnd(20), result.level.padEnd(6), freshnessBadgeText(result));
  if (result.level === 'stale') stale += 1;
}

// Fail the build when any page is stale.
if (stale > 0) process.exitCode = 1;
`,
  },

  // ---------------------------------------------------------- accuracy-claim
  {
    id: 'accuracy-claim-kit',
    version: '0.1.1',
    group: GROUPS[1],
    name: 'Accuracy figures',
    question: 'Do the counts behind an accuracy figure carry it?',
    catches: 'See what accuracy figure your counts support.',
    benchmark: 'agreement-with-an-independent-oracle-and-a-hand-labeled-holdout',
    limit: 'Takes your word on who labeled the items and how they were picked. It judges the figure against the counts, not whether the system is accurate.',
    fields: [
      { key: 'claim', label: 'The figure you want to publish', kind: 'json', rows: 6 },
      { key: 'evidence', label: 'The counts, who labeled and how items were picked', kind: 'json', rows: 12 },
    ],
    presets: [
      {
        label: 'More than the counts allow',
        situation: 'A team wants to publish an AI accuracy figure from a sample people graded.',
        input: {
          claim: { metric: 'accuracy', value: 0.995, display: '99.5%' },
          evidence: { sample: { n: 1000, correct: 990 }, provenance: { source: 'human', raters: 2 }, sampling: 'random' },
        },
      },
      {
        label: 'A figure the counts carry',
        situation: 'A team checks a cautious accuracy figure against a sample people graded.',
        input: {
          claim: { metric: 'accuracy', value: 0.98, display: '98%' },
          evidence: { sample: { n: 1000, correct: 990 }, provenance: { source: 'human', raters: 2 }, sampling: 'random' },
        },
      },
      {
        label: 'Between safe and observed',
        situation: 'A team checks a figure below the sample result before publishing it.',
        input: {
          claim: { metric: 'accuracy', value: 0.985, display: '98.5%' },
          evidence: { sample: { n: 1000, correct: 990 }, provenance: { source: 'human', raters: 2 }, sampling: 'random' },
        },
      },
      {
        label: 'Labels from a model',
        situation: 'A team uses another AI model to grade answers for an accuracy claim.',
        input: {
          claim: { metric: 'accuracy', value: 0.98, display: '98%' },
          evidence: { sample: { n: 1000, correct: 990 }, provenance: { source: 'model' }, sampling: 'random' },
        },
      },
    ],
    run(kit, input) {
      // The claim field is the figure being judged. A claim inside the evidence would
      // quietly replace it, so it is refused rather than merged.
      if (input.evidence && typeof input.evidence === 'object' && Object.hasOwn(input.evidence, 'claim')) {
        throw new TypeError(EVIDENCE_CLAIM_REFUSAL);
      }
      const r = kit.assessAccuracyClaim({ ...input.evidence, claim: input.claim });
      const pct = (x) => `${percentDigits(x, 2)}%`;
      const asPercent = (x) => `${Number(percentDigits(x, 4))}%`;
      // display is optional; without it the figure is the value, written as a percent.
      const display = typeof input.claim.display === 'string' ? input.claim.display : asPercent(r.claimed);
      // The kit judges the more favorable of the value and the printed figure (the top of
      // "98-99.8%", for example). The graphic marks that figure and says where it came from.
      const judged = Number.isFinite(r.assessedValue) ? r.assessedValue : r.claimed;
      const judgedElsewhere = typeof input.claim.display === 'string' && judged !== r.claimed;
      const OK = new Set(['claim-within-bound', 'matches-observed-rate', 'census-matches-count']);
      const NOTE = new Set(['precision-too-fine', 'claim-worse-than-counts', 'strata-not-reweighted']);
      const TITLES = {
        'claim-within-bound': 'The figure is within what the counts support',
        'matches-observed-rate': 'The figure is the rate the counts show',
        'census-matches-count': 'The figure is consistent with the exact count',
        'claim-differs-from-count': 'The figure does not match the exact count',
        'claim-outside-interval': 'The figure goes past what the counts allow',
        'claim-beyond-conservative-bound': 'The figure is more than the counts carry',
        'precision-too-fine': 'The figure has more digits than the counts support',
        'claim-worse-than-counts': 'The figure is less favorable than the counts',
        'strata-not-reweighted': 'Groups are pooled without weights',
        'text-figure-differs': 'The text states a different figure',
        'metric-not-supported': 'This kind of score cannot be judged here',
        'n-undisclosed': 'The counts are missing',
        'no-human-labels': 'The labels came from a model',
        'unknown-label-source': 'Nobody can say where the labels came from',
        'mixed-label-source': 'Some labels came from a model',
        'ranked-sample': 'The sample was picked by rank',
        'convenience-sample': 'The sample is whatever was easy to collect',
        'unknown-sampling': 'Nobody can say how the sample was picked',
        'sample-too-small': 'The sample is too small',
        'merged-strata-differ': 'Pooling the groups hides a real difference',
        'stratified-without-strata': 'Stratified sample, but no groups were given',
        'evaluation-stale': 'The evaluation is out of date',
        'evaluation-date-missing': 'The evaluation has no date',
      };
      const FIXES = {
        'claim-outside-interval': 'Publish the suggested statement below instead, or check more items.',
        'claim-beyond-conservative-bound': 'Publish the suggested statement below instead, or check more items.',
        'claim-differs-from-count': 'Print the figure the count gives, or check whether the count is stale or mistyped.',
        'precision-too-fine': 'Print fewer digits.',
        'claim-worse-than-counts': 'Check whether the printed figure is stale or mistyped.',
        'strata-not-reweighted': 'Report each group separately if they were sampled at different rates.',
        'text-figure-differs': 'Make the text state the same figure.',
        'metric-not-supported': 'Report accuracy, error rate, precision or recall instead.',
        'n-undisclosed': 'Write down how many items were checked and how many were right.',
        'no-human-labels': 'Have people label the items, or publish no accuracy figure.',
        'unknown-label-source': 'Write down who labeled the items.',
        'mixed-label-source': 'Judge only the items that people labeled.',
        'ranked-sample': 'Draw a random sample instead of the top-ranked items.',
        'convenience-sample': 'Pick items at random, or do not claim the figure beyond this sample.',
        'unknown-sampling': 'Write down how the items were picked.',
        'sample-too-small': 'Check more items before you publish a figure.',
        'merged-strata-differ': 'Report each group separately.',
        'stratified-without-strata': 'Give the counts for each group.',
      };
      const rows = [];
      const count = Math.max(r.reasons.length, r.explanation.length);
      for (let i = 0; i < count; i += 1) {
        const code = r.reasons[i];
        const mark = OK.has(code) ? 'ok' : NOTE.has(code) ? 'info' : r.verdict === 'contradicted' && (code === 'claim-outside-interval' || code === 'claim-differs-from-count') ? 'bad' : 'warn';
        rows.push({
          mark,
          title: TITLES[code] ?? (code ? `${code.charAt(0).toUpperCase()}${code.slice(1).replace(/-/g, ' ')}` : 'Note'),
          detail: r.explanation[i] ? accuracyExplanation(r.explanation[i]) : code,
          fix: mark === 'ok' ? undefined : FIXES[code] ?? 'Follow the explanation, then run the check again.',
        });
      }
      const tone = { supported: 'pass', contradicted: 'fail', overstated: 'warn', refused: 'warn' }[r.verdict] ?? 'info';
      const headline = {
        supported: `The counts carry ${display}.`,
        contradicted: `${display} goes past what the counts allow.`,
        overstated: `The counts do not carry ${display} as printed.`,
        refused: `No verdict on ${display}: the counts cannot carry a figure yet.`,
      }[r.verdict] ?? `Verdict: ${r.verdict}.`;
      const interval = r.interval;
      // The kit already rounds the two bounds outward at the precision it recommends.
      const bounds = r.suggestedStatement.match(/Wilson interval ([\d.]+%) to ([\d.]+%)/)?.slice(1);
      const LOWER = new Set(['error-rate', 'false-positive-rate', 'false-negative-rate']);
      // A complete set (a benchmark or a fixed split) is judged against its exact count, with
      // no interval. The count is the one the kit compared: right answers for a higher-is-better
      // metric, errors for an error rate.
      let census = null;
      if (r.basis === 'census') {
        const s = input.evidence.sample;
        const correct = s.correct ?? r.n - s.errors;
        const successes = LOWER.has(r.metric) ? r.n - correct : correct;
        census = { point: successes / r.n, successes, n: r.n };
      }
      return {
        tone,
        headline,
        summary: interval
          ? `${Math.round(interval.confidence * 100)}% interval from the counts${bounds ? `: ${bounds.join(' to ')}` : ''}. Observed ${pct(interval.point)} (${interval.successes} of ${interval.n}).`
          : census ? `Exact count on the whole set: ${census.successes} of ${census.n} (${pct(census.point)}). The whole set was checked, so there is no interval.`
          : 'No range was calculated. The findings below explain why this evidence could not be used.',
        rows,
        statement: r.suggestedStatement,
        viz: {
          type: 'interval',
          better: LOWER.has(r.metric) ? 'lower' : 'higher',
          claimed: Number.isFinite(judged) && judged >= 0 && judged <= 1 ? judged : null,
          display: judgedElsewhere ? asPercent(judged) : display,
          ...(judgedElsewhere ? { from: display } : {}),
          ...(census ? { census } : {}),
          verdict: r.verdict,
          mark: { supported: 'ok', contradicted: 'bad', overstated: 'warn', refused: 'warn' }[r.verdict] ?? 'info',
          interval: interval ? { ...interval, bounds } : null,
        },
        raw: r,
      };
    },
    snippet: (input) => `import { assessAccuracyClaim } from 'accuracy-claim-kit';

const claim = ${js(input.claim)};
const evidence = ${js(input.evidence)};

// The claim above is the figure judged. A claim inside the evidence would quietly replace it,
// so it is refused, as in the playground.
if (evidence && typeof evidence === 'object' && Object.hasOwn(evidence, 'claim')) {
  throw new TypeError(${JSON.stringify(EVIDENCE_CLAIM_REFUSAL)});
}

const result = assessAccuracyClaim({ ...evidence, claim });
console.log(result.verdict, result.reasons.join(', '));
${source(accuracyExplanation)}
for (const line of result.explanation) console.log(' -', accuracyExplanation(line));
console.log('Say this instead:', result.suggestedStatement);

// Fail the build unless the counts carry the figure.
if (result.verdict !== 'supported') process.exitCode = 1;
`,
  },

  // ------------------------------------------------------------------ parity
  {
    id: 'parity-kit',
    version: '0.1.1',
    group: GROUPS[1],
    name: 'Copies and dates',
    question: 'Does every copy of a fact still match its source, and did the review date move for a reason?',
    catches: 'Catch copies that drift and review dates that move.',
    benchmark: 'accuracy-on-real-data',
    limit: 'Compares the data you give it. It does not know which copy is right, prove that a person rechecked anything or check that a value is true.',
    fields: [
      { key: 'source', label: 'The data you trust (source of truth)', kind: 'json', rows: 9 },
      { key: 'copy', label: 'A copy you publish somewhere else', kind: 'json', rows: 9 },
      { key: 'earlier', label: 'The source before its last update (an empty list skips the check for moved dates)', kind: 'json', rows: 9 },
      { key: 'options', label: 'Which fields hold the review date and where a value came from', kind: 'json', rows: 4 },
    ],
    presets: [
      {
        label: 'A copy that drifted',
        situation: 'A software company compares a published plan list with its official prices.',
        input: {
          source: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'team', name: 'Team', price: 29, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
          ],
          copy: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'team', name: 'Team', price: 25, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'enterprise', name: 'Enterprise', price: 199, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
          ],
          earlier: [],
          options: { reviewedField: 'lastReviewed', sourceFields: ['source'] },
        },
      },
      {
        label: 'A copy and dates that hold up',
        situation: 'A software company updates a plan price and compares both copies of the list.',
        input: {
          source: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
            { id: 'team', name: 'Team', price: 29, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
          ],
          copy: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
            { id: 'team', name: 'Team', price: 29, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
          ],
          earlier: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
            { id: 'team', name: 'Team', price: 25, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
          ],
          options: { reviewedField: 'lastReviewed', sourceFields: ['source'] },
        },
      },
      {
        label: 'Dates moved, nothing rechecked',
        situation: 'A software company changes review dates on a price list without changing the records behind them.',
        input: {
          source: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'team', name: 'Team', price: 29, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
          ],
          copy: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'team', name: 'Team', price: 29, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-10-01' },
          ],
          earlier: [
            { id: 'starter', name: 'Starter', price: 9, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
            { id: 'team', name: 'Team', price: 29, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
            { id: 'business', name: 'Business', price: 79, source: 'https://example.test/pricing', lastReviewed: '2026-04-01' },
          ],
          options: { reviewedField: 'lastReviewed', sourceFields: ['source'] },
        },
      },
    ],
    run(kit, input) {
      const mirror = kit.compareMirror(input.source, input.copy, parityOptions(input.options, PARITY_AUDIT_ONLY));
      const skipDates = Array.isArray(input.earlier) && input.earlier.length === 0;
      const audit = skipDates ? null : kit.auditReviewStamps(input.earlier, input.source, parityOptions(input.options, PARITY_MIRROR_ONLY));
      const val = (v) => (v === undefined ? 'no value' : JSON.stringify(v));
      const SIDE = { canonical: 'source', mirror: 'copy', before: 'earlier snapshot', after: 'source' };
      const rows = [];
      const named = new Set();
      const WHY = { missing: 'is missing', 'not-a-string': 'is not text', 'zoneless-timestamp': 'has a time but no zone', 'unparseable-date': 'is not a date the kit can read', 'expiry-removed': 'was removed' };
      // A repeated id makes the kit flag the check, so it is a problem row, listed once even
      // when both checks see it in the source.
      const dupes = new Set();
      // The headline counts each repeated id once, wherever it repeats.
      const dupeIds = new Set();
      const problemRows = (report) => {
        for (const d of report.duplicateKeys) {
          const where = SIDE[d.side] ?? d.side;
          dupeIds.add(d.id);
          if (dupes.has(`${where}|${d.id}`)) continue;
          dupes.add(`${where}|${d.id}`);
          rows.push({ mark: 'bad', title: `${d.id} appears more than once in the ${where}`, detail: `Positions ${d.positions.join(', ')}. The kit cannot tell which record is right.`, fix: 'Keep one record per id.' });
        }
        for (const g of report.suspectKeys) rows.push({ mark: 'warn', title: `Look-alike ids: ${g.keys.map((k) => k.key).join(' and ')}`, detail: 'They differ only in case, spacing or look-alike characters, so they may be one record.', fix: 'Pick one spelling and use it everywhere.' });
        for (const i of report.invalid) rows.push({ mark: 'warn', title: `A record in the ${SIDE[i.side] ?? i.side} could not be read`, detail: i.detail ?? i.reason, fix: 'Fix the record so the kit can read it.' });
        for (const name of report.unknownFields.filter((n) => !named.has(n))) {
          named.add(name);
          rows.push({ mark: 'warn', title: `The field ${name} appears in no record`, detail: 'The check could not use it, so it did not run the way you meant.', fix: 'Correct the field name in the options or in the data.' });
        }
      };
      for (const id of mirror.missing) rows.push({ mark: 'bad', title: `${id} is missing from the copy`, detail: 'The source has it. The copy does not.', fix: 'Add it to the copy, or take it out of the source on purpose.' });
      for (const id of mirror.extra) rows.push({ mark: 'bad', title: `${id} is in the copy but not in the source`, detail: 'Nothing in the source backs it.', fix: 'Remove it from the copy, or add it to the source.' });
      for (const c of mirror.changed) {
        const detail = c.change === 'different' ? `The source says ${val(c.canonical)}. The copy says ${val(c.mirror)}.`
          : c.change === 'missing-in-mirror' ? `The source has ${val(c.canonical)}. The copy has no such field.`
          : `The copy has ${val(c.mirror)}. The source has no such field.`;
        rows.push({ mark: 'bad', title: `${c.id}: ${parityFieldLabel(c.field)} differs`, detail, fix: 'Rebuild the copy from the source instead of editing it by hand.' });
      }
      for (const s of mirror.stampHidesDrift) rows.push({ mark: 'bad', title: `${s.id}: same review date, different data`, detail: `Both say reviewed ${s.reviewedValue}, yet ${s.fields.map(parityFieldLabel).join(', ')} ${s.fields.length === 1 ? 'differs' : 'differ'}.`, fix: 'Recheck the record, then update the copy and its review date together.' });
      if (mirror.noFieldsCompared) rows.push({ mark: 'warn', title: 'No fields were compared', detail: 'Every field was left out, so nothing was checked.', fix: 'Stop leaving every field out of the comparison.' });
      problemRows(mirror);
      if (mirror.ok) rows.push({ mark: 'ok', title: 'Every record in the copy matches the source', detail: `${plural(mirror.compared, 'record')} compared, field by field.` });
      if (audit) {
        for (const s of audit.stampOnly) rows.push({ mark: 'bad', title: `${s.id}: review date moved with no change behind it`, detail: `From ${s.from} to ${s.to}. No value, source or reviewer changed.`, fix: 'Move the date only after a recheck that leaves a mark in the data, such as a changed source.' });
        for (const b of audit.bulkBump) rows.push({ mark: 'bad', title: `${plural(b.count, 'record')} moved to ${b.date}`, detail: b.summary, fix: 'If the whole file was rechecked, record that in the data.' });
        for (const f of audit.future) rows.push({ mark: 'bad', title: `${f.id}: review date is in the future`, detail: `The date ${f.value} is later than now.`, fix: 'Correct the date.' });
        for (const b of audit.backward) rows.push({ mark: 'bad', title: `${b.id}: review date moved earlier`, detail: `From ${b.from} to ${b.to}.`, fix: 'Find out why the date went back.' });
        for (const e of audit.extendedDeadlines) rows.push({ mark: 'warn', title: `${e.id}: deadline pushed later`, detail: `From ${e.from} to ${e.to}, with no change to the source.`, fix: 'Extend a deadline only after rechecking the source.' });
        for (const u of audit.unknown) rows.push({ mark: 'warn', title: `${u.id}: ${u.field} could not be read`, detail: `In the ${SIDE[u.side] ?? u.side}, the date ${WHY[u.reason] ?? u.reason.replace(/-/g, ' ')}.`, fix: 'Write the date as YYYY-MM-DD, or as a timestamp with a zone.' });
        if (audit.noOverlap) rows.push({ mark: 'warn', title: 'No record appears in both snapshots', detail: 'Nothing could be compared.', fix: 'Check that you picked the right two snapshots.' });
        problemRows(audit);
        if (audit.added.length || audit.removed.length) rows.push({ mark: 'info', title: 'Records changed since the earlier snapshot', detail: `${audit.added.length ? `Added: ${audit.added.join(', ')}. ` : ''}${audit.removed.length ? `Removed: ${audit.removed.join(', ')}.` : ''}`.trim() });
        if (audit.ok) rows.push({ mark: 'ok', title: 'Review dates moved only where the data changed', detail: `${plural(audit.compared, 'record')} compared with the earlier snapshot.` });
      } else {
        rows.push({ mark: 'skip', title: 'Date moves not checked', detail: 'There is no earlier copy to compare review dates with.' });
      }
      const flagged = mirror.status === 'flagged' || audit?.status === 'flagged';
      const unknown = mirror.status === 'unknown' || audit?.status === 'unknown';
      // The headline names each finding the kit flagged, not just that it flagged something.
      const parts = [];
      const drift = mirror.missing.length + mirror.extra.length + mirror.changed.length;
      const movedTogether = audit?.bulkBump.reduce((total, group) => total + group.count, 0) ?? 0;
      if (drift) parts.push(`the copy has drifted from its source in ${plural(drift, 'place')}`);
      if (mirror.stampHidesDrift.length) parts.push(plural(mirror.stampHidesDrift.length, 'review date hides drift', 'review dates hide drift'));
      if (dupeIds.size) parts.push(`${plural(dupeIds.size, 'id')} ${dupeIds.size === 1 ? 'appears' : 'appear'} more than once`);
      if (audit) {
        const n = (list, one, rest) => `${plural(list.length, one)}${rest}`;
        if (audit.stampOnly.length) parts.push(n(audit.stampOnly, 'review date', ' moved with nothing in the data to show a recheck'));
        if (audit.bulkBump.length) {
          // Each bulk bump is one new review date; several bumps are several dates.
          const moved = plural(movedTogether, 'record');
          parts.push(audit.bulkBump.length === 1 ? `${moved} moved to one review date at once` : `${moved} moved in bulk to ${plural(audit.bulkBump.length, 'review date')}`);
        }
        if (audit.backward.length) parts.push(n(audit.backward, 'review date', ' moved earlier'));
        if (audit.future.length) parts.push(n(audit.future, 'review date', audit.future.length === 1 ? ' is in the future' : ' are in the future'));
        if (audit.extendedDeadlines.length) parts.push(n(audit.extendedDeadlines, 'deadline', ' pushed later with no change to the source'));
      }
      if (flagged && !parts.length) parts.push('the kit flagged a problem, listed below');
      const dateProblems = mirror.stampHidesDrift.length + (audit
        ? audit.stampOnly.length + audit.backward.length + audit.future.length : 0);
      const warnings = rows.filter((row) => row.mark === 'warn').length;
      const counts = [
        ['drifted', drift, 'bad'],
        [dateProblems === 1 ? 'date problem' : 'date problems', dateProblems, 'bad'],
        ['records with dates moved together', movedTogether, 'bad'],
        [dupeIds.size === 1 ? 'repeated ID' : 'repeated IDs', dupeIds.size, 'bad'],
        [warnings === 1 ? 'warning' : 'warnings', warnings, 'warn'],
      ].filter(([, count]) => count);
      return {
        tone: flagged ? 'fail' : unknown ? 'warn' : 'pass',
        headline: flagged ? `${parts.join(', and ')}.`.replace(/^./, (c) => c.toUpperCase())
          : unknown ? 'Something could not be checked, so this is not a pass.'
          : `The copy matches its source${audit ? ' and the review dates moved for a reason' : ''}.`,
        summary: `${plural(mirror.compared, 'record')} compared with the source${audit ? `, ${audit.compared} with the earlier snapshot` : ''}.`,
        ...(counts.length ? { counts } : {}),
        rows,
        raw: { copy: mirror, dates: audit },
      };
    },
    snippet: (input) => {
      const skip = Array.isArray(input.earlier) && input.earlier.length === 0;
      return `import { compareMirror${skip ? '' : ', auditReviewStamps'} } from 'parity-kit';

const source = ${js(input.source)};
const copy = ${js(input.copy)};
const options = ${js(input.options)};
// Each check refuses an option it does not take, so send each one only the options it accepts.
const auditOnly = ${js(PARITY_AUDIT_ONLY)};
const mirrorOnly = ${js(PARITY_MIRROR_ONLY)};
const without = (names) => Object.fromEntries(Object.entries(options).filter(([name]) => !names.includes(name)));

const mirror = compareMirror(source, copy, without(auditOnly));
console.log('copy against source:', mirror.status);
for (const c of mirror.changed) console.log(\`  \${c.id}.\${c.field}: source \${JSON.stringify(c.canonical)}, copy \${JSON.stringify(c.mirror)}\`);
${skip ? '' : `
const earlier = ${js(input.earlier)};
const audit = auditReviewStamps(earlier, source, without(mirrorOnly));
console.log('review dates:', audit.status);
for (const s of audit.stampOnly) console.log(\`  \${s.id}: \${s.from} to \${s.to}, nothing else changed\`);
`}
// Fail the build when a copy drifts${skip ? '' : ' or a review date moves with nothing behind it'}. Treat "unknown" as a failure too.
if (!mirror.ok${skip ? '' : ' || !audit.ok'}) process.exitCode = 1;
`;
    },
  },

  // ------------------------------------------------------- payout-invariance
  {
    id: 'payout-invariance-kit',
    version: '0.3.0',
    group: GROUPS[2],
    name: 'Paid placement',
    question: 'Would your rankings change if a partner paid you more?',
    catches: 'See if payouts change the ranking.',
    collapseInputs: true,
    limit: 'Tests the scenarios you write. Passing them is evidence, not a proof for every possible payout.',
    fields: [
      { key: 'ranker', label: 'How to rank the products', kind: 'choice', options: Object.keys(RANKERS) },
      { key: 'candidates', label: 'Products, quality scores and commissions (100 basis points = 1%)', kind: 'json', rows: 7 },
    ],
    presets: [
      {
        label: 'A hidden payout boost',
        situation: 'A shoe site tests a ranking rule that gives higher-paying partners a boost.',
        input: {
          ranker: 'Quietly boosts higher-paying partners',
          candidates: [
            { id: 'trail-runner', score: 90, payoutRateBps: 50 },
            { id: 'city-sneaker', score: 72, payoutRateBps: 0 },
            { id: 'budget-pick', score: 61, payoutRateBps: 800 },
          ],
        },
      },
      {
        label: 'A fair ranking',
        situation: 'A shoe site tests whether a quality-only ranking changes when commissions change.',
        input: {
          ranker: 'Ranks by quality score only',
          candidates: [
            { id: 'trail-runner', score: 90, payoutRateBps: 50 },
            { id: 'city-sneaker', score: 72, payoutRateBps: 0 },
            { id: 'budget-pick', score: 61, payoutRateBps: 800 },
          ],
        },
      },
    ],
    run(kit, input) {
      const rank = RANKERS[input.ranker] ?? RANKERS['Ranks by quality score only'];
      const scenarios = PAYOUT_SCENARIOS;
      const result = kit.assertPayoutInvariance(rank, { candidates: input.candidates }, scenarios);
      const base = result.baseline.orderedIds.map((id) => input.candidates.find((c) => c.id === id));
      const first = base[0];
      const lowest = base.length > 1 && base.slice(1).every((c) => c.score > first.score);
      const highestPayout = base.length > 1 && base.slice(1).every((c) => c.payoutRateBps < first.payoutRateBps);
      const rows = scenarios.map((s) => {
        const failure = result.failures.find((f) => f.scenario === s.name);
        return failure
          ? { mark: 'bad', title: `If ${s.name}`, detail: `Ranking changed to ${failure.actual?.orderedIds?.join(' → ') ?? 'a different order'}.`, fix: 'Take payout fields out of the ranking path, or label paid placements clearly.' }
          : { mark: 'ok', title: `If ${s.name}`, detail: s.short === 'Lowest pays most' && lowest && highestPayout
            ? `Ranking stayed the same. ${first.id} already ranks first and pays the most.`
            : `Ranking stayed the same when ${s.name}.` };
      });
      const columns = scenarios.map((s) => {
        const failure = result.failures.find((f) => f.scenario === s.name);
        return { label: s.name, short: s.short, order: failure?.actual?.orderedIds ?? result.baseline.orderedIds, changed: Boolean(failure) };
      });
      return {
        tone: result.passed ? 'pass' : 'fail',
        headline: result.passed
          ? `Rankings ignored payout in all ${plural(scenarios.length, 'scenario')}.`
          : `Rankings moved with payout in ${result.failures.length} of ${plural(scenarios.length, 'scenario')}.`,
        summary: `Base order: ${base.map((c) => `${c.id} (score ${c.score}, payout ${ratePercent(c.payoutRateBps)})`).join(' → ')}.${lowest && highestPayout ? ` ${first.id} ranks first with the lowest score and highest payout.` : ''}`,
        rows,
        viz: { type: 'slope', base: result.baseline.orderedIds, columns },
        raw: result,
      };
    },
    snippet: (input) => `import { assertPayoutInvariance } from 'payout-invariance-kit';

// Your real ranking code goes here.
${source(RANKERS[input.ranker] ?? RANKERS['Ranks by quality score only'])}

const baseInput = { candidates: ${js(input.candidates)} };

const result = assertPayoutInvariance(rank, baseInput, ${scenariosSource()});
for (const f of result.failures) console.log(\`changed when \${f.scenario}\`);
console.log(result.passed ? 'ranking ignored payout in every scenario' : \`\${result.failures.length} scenario(s) changed the ranking\`);

// Fail the build when payout changes the ranking.
if (!result.passed) process.exitCode = 1;
`,
  },

  // ----------------------------------------------------- mutation-invariance
  {
    id: 'mutation-invariance-kit',
    version: '0.3.0',
    group: GROUPS[2],
    name: 'Hidden factors',
    question: 'Does a decision change when a field it should ignore changes?',
    catches: 'See if a decision depends on an unrelated field.',
    collapseInputs: true,
    limit: 'Tests the variations you list. Passing them is evidence, not a proof for every input.',
    fields: [
      { key: 'scorer', label: 'How to decide on a loan', kind: 'choice', options: Object.keys(SCORERS) },
      { key: 'applicant', label: 'Applicant details before changing the ZIP code', kind: 'json', rows: 5 },
      { key: 'zips', label: 'Zip codes to try (should not matter)', kind: 'json', rows: 5 },
    ],
    presets: [
      {
        label: 'Peeks at zip code',
        situation: 'A lender tries different ZIP codes while keeping the applicant’s income the same.',
        input: { scorer: 'Also peeks at zip code', applicant: { name: 'Applicant', zip: '68102', income: 85000 }, zips: ['02138', '90210', '38652'] },
      },
      {
        label: 'Ignores zip code',
        situation: 'A lender tests an income-only decision by changing the applicant’s ZIP code.',
        input: { scorer: 'Looks at income only', applicant: { name: 'Applicant', zip: '68102', income: 85000 }, zips: ['02138', '90210', '38652'] },
      },
    ],
    run(kit, input) {
      const score = SCORERS[input.scorer] ?? SCORERS['Looks at income only'];
      const scenarios = input.zips.map((zip) => ({ name: `zip code ${zip}`, mutate: (app) => ({ ...app, zip }) }));
      const result = kit.assertInvariance(score, input.applicant, scenarios);
      const variants = scenarios.map((s) => {
        const failure = result.failures.find((f) => f.scenario === s.name);
        const bps = failure ? failure.actual?.rateBps : result.baseline.rateBps;
        return { label: s.name.replace('zip code ', ''), value: bps == null ? null : bps / 10_000, changed: Boolean(failure) };
      });
      const rows = scenarios.map((s, i) =>
        variants[i].changed
          ? { mark: 'bad', title: `With ${s.name}`, detail: variants[i].value === null ? 'The decision could not be scored for this zip code.' : `Decision changed: rate ${ratePercent(variants[i].value * 10_000)} instead of ${ratePercent(result.baseline.rateBps)}.`, fix: 'Remove the field from the decision, or document why it is allowed.' }
          : { mark: 'ok', title: `With ${s.name}`, detail: 'Same decision.' });
      return {
        tone: result.passed ? 'pass' : 'fail',
        headline: result.passed
          ? `Same decision for all ${plural(scenarios.length, 'zip code')}.`
          : `The decision changed with zip code in ${result.failures.length} of ${plural(scenarios.length, 'case')}.`,
        summary: `Base decision: ${result.baseline.approved ? 'approved' : 'declined'} at ${ratePercent(result.baseline.rateBps)}.`,
        rows,
        viz: { type: 'bars', unit: '%', percent: true, digits: 2, baseline: { label: `base ${input.applicant.zip}`, value: result.baseline.rateBps / 10_000 }, bars: variants },
        raw: result,
      };
    },
    snippet: (input) => `import { assertInvariance } from 'mutation-invariance-kit';

// Your real decision code goes here.
${source(SCORERS[input.scorer] ?? SCORERS['Looks at income only'])}

const applicant = ${js(input.applicant)};
const scenarios = ${js(input.zips)}.map((zip) => ({ name: \`zip code \${zip}\`, mutate: (app) => ({ ...app, zip }) }));

const result = assertInvariance(score, applicant, scenarios);
for (const f of result.failures) console.log(\`decision changed with \${f.scenario}\`);
console.log(result.passed ? 'same decision in every scenario' : \`\${result.failures.length} scenario(s) changed the decision\`);

// Fail the build when a field the decision should ignore changes it.
if (!result.passed) process.exitCode = 1;
`,
  },

  // ------------------------------------------------------------ advice-ledger
  {
    id: 'advice-ledger-kit',
    version: '0.3.0',
    group: GROUPS[2],
    name: 'Did the advice work?',
    question: 'After someone followed a recommendation, did the problem actually get better?',
    catches: 'Compare what happened before and after advice.',
    collapseInputs: true,
    limit: 'Compares readings before and after the decision. It cannot tell whether the advice caused the change.',
    fields: [
      { key: 'recommendation', label: 'The recommendation', kind: 'json', rows: 6 },
      { key: 'decision', label: 'What the person decided, and when', kind: 'json', rows: 5 },
      { key: 'observations', label: 'Readings before and after', kind: 'json', rows: 9 },
    ],
    presets: [
      {
        label: 'It got worse',
        situation: 'A team compares checkout errors before and after it follows a recommendation.',
        input: {
          recommendation: { id: 'rec-2', subjectId: 'checkout', checkKey: 'error-rate-high', proposedAt: '2026-09-01' },
          decision: { recommendationId: 'rec-2', status: 'adopted', decidedAt: '2026-09-10' },
          observations: [
            ...['02', '04', '06', '08'].map((d, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < 1 ? 'bad' : 'good', observedAt: `2026-09-${d}` })),
            ...['12', '14', '16', '18'].map((d, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < 3 ? 'bad' : 'good', observedAt: `2026-09-${d}`, exposed: true })),
          ],
        },
      },
      {
        label: 'The fix held',
        situation: 'A team checks whether checkout errors fell after it followed a recommendation.',
        input: {
          recommendation: { id: 'rec-1', subjectId: 'checkout', checkKey: 'error-rate-high', proposedAt: '2026-09-01' },
          decision: { recommendationId: 'rec-1', status: 'adopted', decidedAt: '2026-09-10' },
          observations: [
            ...['02', '04', '06', '08'].map((d, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < 3 ? 'bad' : 'good', observedAt: `2026-09-${d}` })),
            ...['12', '14', '16', '18'].map((d) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: 'good', observedAt: `2026-09-${d}`, exposed: true })),
          ],
        },
      },
    ],
    run(kit, input) {
      const grade = kit.gradeDecision(input.decision, input.recommendation, input.observations);
      const window = (label, w) => ({
        mark: 'info',
        title: `${label}: bad in ${w.bad} of ${w.observations}`,
        detail: w.observations ? `Bad rate ${Math.round(w.badRate * 100)}%.` : 'No readings in this window.',
      });
      const rows = [window('Before the decision', grade.baseline), window('After (where the advice applied)', grade.result)];
      if (grade.verdict === 'not-holding') {
        const { baseline: before, result: after } = grade;
        const rate = (w) => `${Math.round(w.badRate * 100)}%`;
        // Compare as exact counts, the way the kit does, so a tie or a count-based verdict is described as what it is.
        const change = after.bad * before.observations - before.bad * after.observations;
        const note =
          change > 0
            ? { title: 'The problem got worse after the advice', detail: `The bad rate rose from ${rate(before)} to ${rate(after)}.` }
            : change === 0
              ? { title: 'The problem did not go down after the advice', detail: `Bad in ${before.bad} of ${before.observations} before and ${after.bad} of ${after.observations} after, so the rate did not fall.` }
              : { title: 'Too many bad readings kept showing up after the advice', detail: `The bad rate fell from ${rate(before)} to ${rate(after)}, but ${plural(after.bad, 'bad reading')} reached the refute threshold of ${grade.thresholds.refuteThreshold}. That bar counts readings, not rates.` };
        rows.push({ mark: 'bad', ...note, fix: 'Revisit the recommendation before applying it anywhere else.' });
      }
      if (grade.refusalCodes.length) rows.push({ mark: 'skip', title: 'Not enough evidence to grade', detail: grade.refusalCodes.join(', '), fix: 'Collect more readings before and after the decision.' });
      const tone = grade.verdict === 'holding' ? 'pass' : grade.verdict === 'not-holding' ? 'fail' : 'warn';
      const label = { holding: 'The advice is holding up', 'not-holding': 'The advice is not holding up', refused: 'Not enough evidence to say' }[grade.verdict] ?? grade.verdict;
      const pct = (w) => (w.observations ? w.badRate : null);
      return {
        tone,
        headline: `${label}.`,
        rows,
        viz: { type: 'bars', unit: '%', percent: true, bars: [{ label: 'before', value: pct(grade.baseline), changed: false }, { label: 'after', value: pct(grade.result), changed: grade.verdict === 'not-holding' }] },
        raw: { ...grade, description: kit.describeGrade(grade) },
      };
    },
    snippet: (input) => `import { gradeDecision, describeGrade } from 'advice-ledger-kit';

const recommendation = ${js(input.recommendation)};
const decision = ${js(input.decision)};
const observations = ${js(input.observations)};

const grade = gradeDecision(decision, recommendation, observations);
console.log(describeGrade(grade));

// Fail the build when the advice is not holding up.
if (grade.verdict === 'not-holding') process.exitCode = 1;
`,
  },

  // --------------------------------------------------------------- trust-core
  {
    id: 'trust-core',
    version: '0.3.0',
    group: GROUPS[3],
    name: 'Review patterns',
    question: 'Do the review scores or sources show an unusual pattern?',
    catches: 'Spot unusually uniform or single-source reviews.',
    benchmark: 'readme',
    limit: 'Flags two cheap patterns (one source, near-identical sentiment). It cannot prove any review is fake.',
    fields: [
      { key: 'now', label: 'Date to check against', kind: 'line' },
      { key: 'reviews', label: 'Reviews: source site, sentiment (-1 to 1), confidence (0 to 1)', kind: 'json', rows: 10 },
    ],
    presets: [
      {
        label: 'Near-identical 5-star reviews',
        situation: 'A shopper sees nearly identical praise from a single marketplace.',
        input: {
          now: '2026-10-01',
          reviews: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ id, source: 'marketplace', sentiment: 0.99, confidence: 1, publishedAt: '2026-09-28' })),
        },
      },
      {
        label: 'Varied reviews',
        situation: 'A shopper compares product reviews from several kinds of sites.',
        input: {
          now: '2026-10-01',
          reviews: [
            { id: 'r1', source: 'forum', sentiment: 0.8, confidence: 0.9, publishedAt: '2026-08-14' },
            { id: 'r2', source: 'marketplace', sentiment: 0.4, confidence: 0.8, publishedAt: '2026-07-02' },
            { id: 'r3', source: 'blog', sentiment: 0.6, confidence: 0.7, publishedAt: '2026-06-19' },
            { id: 'r4', source: 'community', sentiment: -0.2, confidence: 0.9, publishedAt: '2026-09-03' },
          ],
        },
      },
      {
        label: 'Nothing usable',
        situation: 'A shopper has a review from a source type the check does not recognize.',
        input: {
          now: '2026-10-01',
          reviews: [{ id: 'r1', source: 'unknown-site', sentiment: 0.9, confidence: 1, publishedAt: '2026-09-28' }],
        },
      },
    ],
    run(kit, input) {
      const now = strictDate(input.now, 'Date to check against').toISOString();
      const config = kit.anonymous.resolveAnonymousConfig();
      const result = kit.anonymous.assessAuthenticity(input.reviews, config, { now });
      const minimum = config.astroturf.minSignalsForUniformCheck;
      // The kit counts low-weight reviews as fractions toward the minimum.
      const weights = new Map(Object.entries(config.sourceWeights));
      const weighted = input.reviews.map((review) => [review,
        Math.min(1, (weights.get(review.source.trim().toLowerCase()) ?? 0) * review.confidence / config.fullCountWeight),
      ]).filter(([, weight]) => weight > 0);
      const eligible = weighted.length === result.eligibleSignalCount ? weighted
        : weighted.filter(([review]) => kit.anonymous.assessAuthenticity([review], config, { now }).eligibleSignalCount > 0);
      const effective = eligible.reduce((sum, [, weight]) => sum + weight, 0);
      const uniformityChecked = result.flags.uniformSentiment || effective >= minimum - minimum * 1e-9;
      const look = 'Read the reviews and check where they came from.';
      const uniformity = uniformityChecked
        ? { mark: result.flags.uniformSentiment ? 'warn' : 'info', title: result.flags.uniformSentiment ? 'Review scores are unusually similar' : 'No flag for similar review scores', detail: result.flags.uniformSentiment ? 'The scores are nearly identical and close to the top of the scale.' : 'The check looks for nearly identical scores near the top of the scale.', fix: result.flags.uniformSentiment ? look : null }
        : { mark: 'skip', title: 'Score similarity was not checked', detail: `The reviews carried less weight than ${minimum} full-weight reviews, the minimum for this check.` };
      const rows = [
        { mark: result.flags.lowSourceCount ? 'warn' : 'info', title: `Reviews come from ${plural(result.sourceCount, 'source type')}`, detail: result.flags.lowSourceCount ? 'The review sources are too concentrated for this check.' : 'The source count is above the threshold for this flag. Sources can still share an origin.', fix: result.flags.lowSourceCount ? look : null },
        uniformity,
        { mark: result.eligibleSignalCount === result.signalCount ? 'info' : 'skip', title: `${result.eligibleSignalCount} of ${plural(result.signalCount, 'review')} carried weight`, detail: 'A review needs confidence, a recognized source type and a recent enough date to carry weight.', fix: result.eligibleSignalCount === result.signalCount ? null : 'Use sources listed in your config, with confidence above 0.' },
      ];
      const viz = { type: 'dial', score: result.trustScore, confidence: result.confidence.level, flags: result.flags, uniformityChecked };
      if (result.trustScore === null) {
        return { tone: 'info', headline: 'No reviews carried enough weight to give a score.', rows: rows.slice(1), viz, raw: result };
      }
      const flagged = result.flags.lowSourceCount || result.flags.uniformSentiment;
      return { tone: flagged ? 'warn' : 'info', stamp: flagged ? undefined : 'No pattern flagged',
        headline: flagged ? 'The review scores or sources show an unusual pattern.'
          : uniformityChecked ? 'The score and source checks flagged no pattern.' : 'No source pattern flagged. Score similarity was not checked.',
        rows, viz, raw: result };
    },
    snippet: (input) => `import { anonymous } from 'trust-core';

const reviews = ${js(input.reviews)};

const result = anonymous.assessAuthenticity(reviews, anonymous.resolveAnonymousConfig(), { now: ${js(isoMidnight(input.now))} });
console.log(result.trustScore === null ? 'no score' : \`score \${result.trustScore}/100\`, result.flags);

// Flag the batch for a human look when either pattern shows up.
if (result.flags.lowSourceCount || result.flags.uniformSentiment) process.exitCode = 1;
`,
  },

  // -------------------------------------------------------- agent-receipt
  {
    id: 'agent-receipt-kit',
    version: '0.3.0',
    group: GROUPS[3],
    name: 'Agent receipts',
    question: 'Did your AI agent stay inside what it was allowed to do, and do its claims match reality?',
    catches: 'Catch actions outside an agent’s permissions.',
    collapseInputs: true,
    limit: 'Compares what the assistant reports with what you allowed and what you checked yourself. “Accepted” means the check found no mismatch.',
    fields: [
      { key: 'allowed', label: 'What the agent may do and cite', kind: 'json', rows: 4 },
      { key: 'report', label: 'What the agent says it did', kind: 'json', rows: 5 },
      { key: 'currentState', label: 'What you see when you check yourself', kind: 'json', rows: 2 },
    ],
    presets: [
      {
        label: 'An agent that overstepped',
        situation: 'A shopping assistant says it sent a payment, but it only had permission to fill a cart.',
        input: {
          allowed: { actions: ['log-in', 'add-to-cart'], evidenceIds: ['screenshot-1', 'screenshot-2'] },
          report: { claimedActions: ['log-in', 'add-to-cart', 'submit-payment'], citedEvidenceIds: ['screenshot-1'], claimedFacts: { 'items in cart': 1, 'coupon applied': true } },
          currentState: { 'items in cart': 0 },
        },
      },
      {
        label: 'A report that matches',
        situation: 'A shopper compares an assistant’s report with what is in the cart.',
        input: {
          allowed: { actions: ['log-in', 'add-to-cart'], evidenceIds: ['screenshot-1', 'screenshot-2'] },
          report: { claimedActions: ['log-in', 'add-to-cart'], citedEvidenceIds: ['screenshot-2'], claimedFacts: { 'items in cart': 1 } },
          currentState: { 'items in cart': 1 },
        },
      },
    ],
    run(kit, input) {
      const packet = kit.issuePacket({ task: 'shopping demo' }, 'local', input.allowed.actions, input.allowed.evidenceIds, { id: 'pkt-demo', issuedAt: '2026-10-01T09:00:00.000Z' });
      const claim = { packetId: packet.id, ...input.report };
      const result = kit.verifyReceipt(packet, claim, input.currentState);
      const rows = [
        ...(result.packetMismatch ? [{ mark: 'bad', title: 'The report answers a different permission slip', detail: 'The report gives the wrong reference number for its permission slip.', fix: 'Reject the report and run the agent with the right permission slip.' }] : []),
        ...result.claimProblems.map((p) => ({ mark: 'bad', title: 'The report could not be read', detail: p, fix: 'Reject the report and ask for it in the required format.' })),
        ...result.unauthorizedActions.map((a) => ({ mark: 'bad', title: `Action outside the permission slip: ${receiptActionLabel(a)}`, detail: 'The agent reported an action it was never allowed to take.', fix: 'Check whether the action happened, undo or block it if needed, and tighten what the agent may do.' })),
        ...result.droppedEvidenceIds.map((e) => ({ mark: 'bad', title: `Cited evidence it was not given: ${e}`, detail: 'Not in the evidence list, so it was dropped.', fix: 'Only accept evidence you handed the agent.' })),
        ...result.contradictions.map((c) => ({ mark: 'bad', title: `${receiptFactLabel(c.key)}: the agent reports ${JSON.stringify(c.claimedFact)}`, detail: `You see ${JSON.stringify(c.currentFact)}.`, fix: 'Use what you checked yourself when it differs from the report.' })),
        ...result.coverage.uncheckedFactKeys.map((k) => ({ mark: 'skip', title: `${receiptFactLabel(k)} was missing from your own check`, fix: 'Add this fact to your own check so it can be compared.' })),
      ];
      if (!rows.some((r) => r.mark === 'bad')) rows.unshift({ mark: 'ok', title: 'Every reported action was allowed and every checked fact matched', detail: `${result.coverage.comparedFactCount} of ${plural(result.coverage.claimedFactCount, 'claimed fact')} compared.` });
      const unauthorized = new Set(result.unauthorizedActions);
      return {
        tone: result.accepted ? 'pass' : 'fail',
        headline: result.accepted ? 'Accepted: no mismatch found.' : 'Rejected: the report does not match what was allowed or what you see.',
        summary: [
          result.unauthorizedActions.length ? `${plural(result.unauthorizedActions.length, 'claimed action')} outside the permission slip.` : '',
          result.contradictions.length ? `${plural(result.contradictions.length, 'claimed fact')} contradicted by your own check.` : '',
        ].filter(Boolean).join(' '),
        rows,
        viz: {
          type: 'lanes',
          allowed: input.allowed.actions.map(receiptActionLabel),
          claimed: input.report.claimedActions.map((a) => ({ label: receiptActionLabel(a), ok: !unauthorized.has(a) })),
          facts: Object.keys(input.report.claimedFacts ?? {}).map((key) => {
            const c = result.contradictions.find((x) => x.key === key);
            return { label: receiptFactLabel(key), state: c ? 'bad' : result.coverage.uncheckedFactKeys.includes(key) ? 'skip' : 'ok' };
          }),
        },
        raw: result,
      };
    },
    snippet: (input) => `import { issuePacket, verifyReceipt } from 'agent-receipt-kit';

// 1. Before the agent runs: what it may do and cite.
const packet = issuePacket({ task: 'shopping' }, 'local', ${js(input.allowed.actions)}, ${js(input.allowed.evidenceIds)});

// 2. What the agent reports back (untrusted input).
const claim = { packetId: packet.id, ...${js(input.report)} };

// 3. Your own fresh read of the same facts.
const currentState = ${js(input.currentState)};

const result = verifyReceipt(packet, claim, currentState);
console.log(result.reason);

// Stop the workflow when the report does not match.
if (!result.accepted) process.exitCode = 1;
`,
  },

  // -------------------------------------------------------------- audit-chain
  {
    id: 'audit-chain-kit',
    version: '0.3.0',
    group: GROUPS[3],
    name: 'Tamper-evident log',
    question: 'Has anyone edited or deleted entries in this log after the fact?',
    catches: 'Catch edits and deletions in a log.',
    limit: 'Detects changes by comparing entries with saved fingerprints (hashes). Keep the record of the last entry somewhere the log’s writer cannot edit, or a full rewrite goes unnoticed.',
    fields: [
      { key: 'entries', label: 'Log entries, in order', kind: 'json', rows: 12 },
      { key: 'tamper', label: 'What to change in the example log', kind: 'choice',
        options: ['Leave the log alone', 'Change a field in entry 1', 'Delete the last entry'],
        optionLabels: { 'Change a field in entry 1': 'Change the amount in entry 2' } },
    ],
    presets: [
      {
        label: 'Someone changed an amount',
        situation: 'A shop tests its refund log by changing the amount on an approval.',
        input: {
          entries: [
            { action: 'refund.requested', by: 'customer_17', amountUsd: 40 },
            { action: 'refund.approved', by: 'agent_3', amountUsd: 40 },
            { action: 'refund.paid', by: 'system', amountUsd: 40 },
          ],
          tamper: 'Change a field in entry 1',
        },
      },
      {
        label: 'Untouched log',
        situation: 'A shop checks a refund log it has left alone.',
        input: {
          entries: [
            { action: 'refund.requested', by: 'customer_17', amountUsd: 40 },
            { action: 'refund.approved', by: 'agent_3', amountUsd: 40 },
            { action: 'refund.paid', by: 'system', amountUsd: 40 },
          ],
          tamper: 'Leave the log alone',
        },
      },
    ],
    async run(kit, input) {
      let chain = [];
      for (const payload of input.entries) chain = await kit.appendEntry(chain, payload);
      const last = chain[chain.length - 1];
      const anchor = last ? { index: last.index, entryHash: last.entryHash } : undefined;
      let stored = JSON.parse(JSON.stringify(chain));
      if (input.tamper === 'Change a field in entry 1' && stored[1]) stored[1].payload = { ...stored[1].payload, amountUsd: 400 };
      if (input.tamper === 'Delete the last entry') stored = stored.slice(0, -1);
      const result = await kit.verifyChain(stored, undefined, anchor ? { anchor } : undefined);
      const brokenAt = result.valid ? null : result.brokenAtIndex ?? stored.length;
      const rows = stored.map((e) => {
        const after = brokenAt !== null && e.index > brokenAt;
        const broken = brokenAt !== null && e.index === brokenAt;
        const original = chain[e.index]?.payload?.amountUsd;
        const amount = e.payload?.amountUsd;
        const changedAmount = amount === original ? ''
          : original === undefined ? ` This example added an amount of ${formatJson(amount)}.`
          : ` This example changed the amount from ${formatJson(original)} to ${formatJson(amount)}.`;
        return {
          mark: broken ? 'bad' : after ? 'skip' : 'ok',
          title: `Entry ${e.index + 1}: ${e.payload?.action ?? ''}`,
          detail: after ? `The check stopped at entry ${brokenAt + 1}.`
            : broken ? `This entry no longer matches its recorded hash.${changedAmount}`
            : 'This entry matches its recorded hash.',
          fix: broken ? 'Restore this entry from a backup and find out who could write to the log.' : null,
        };
      });
      if (brokenAt === stored.length) rows.push({ mark: 'bad', title: `Entry ${stored.length + 1} is missing`, detail: 'The separately saved record points to an entry that is no longer in the log.', fix: 'Restore the deleted entries from a backup.' });
      return {
        tone: result.valid ? 'pass' : 'fail',
        headline: result.valid ? `${plural(stored.length, 'entry', 'entries')} matched the saved records.` : `Simulated tampering detected at entry ${brokenAt + 1}.`,
        rows,
        viz: {
          type: 'chain',
          entries: stored.map((e) => ({ index: e.index, action: e.payload?.action ?? '', hash: String(e.entryHash).slice(0, 8) })),
          brokenAt,
          kind: result.valid ? null : brokenAt === stored.length ? 'missing' : /content does not match/.test(result.reason ?? '') ? 'content' : 'link',
          anchorIndex: anchor?.index ?? null,
        },
        raw: { ...result, entries: stored, anchor },
      };
    },
    snippet: (input) => `import { appendEntry, verifyChain } from 'audit-chain-kit';

let chain = [];
for (const payload of ${js(input.entries)}) chain = await appendEntry(chain, payload);

// Save this anchor somewhere the log's writer cannot edit.
const last = chain[chain.length - 1];
const anchor = { index: last.index, entryHash: last.entryHash };

${{
  'Change a field in entry 1': '\n// Simulated tampering: edit the second entry in storage.\nchain = JSON.parse(JSON.stringify(chain));\nchain[1].payload.amountUsd = 400;\n',
  'Delete the last entry': '\n// Simulated tampering, as in the playground: someone deletes the last entry.\nchain = chain.slice(0, -1);\n',
}[input.tamper] ?? ''}
// Later: load the stored log and verify it against the anchor.
const result = await verifyChain(chain, undefined, { anchor });
console.log(result.valid ? 'log intact' : result.reason);

// Fail the build when the log was changed after the fact.
if (!result.valid) process.exitCode = 1;
`,
  },

  // ------------------------------------------------------------ cost-governor
  {
    id: 'cost-governor-kit',
    version: '0.3.0',
    group: GROUPS[4],
    name: 'AI spend cap',
    question: 'Will the next AI request push you over your budget?',
    catches: 'Flag a request that could exceed your budget.',
    limit: 'Estimates cost from the amount of text and the prices you enter. Your actual bill can differ.',
    fields: [
      { key: 'rates', label: 'AI prices', kind: 'json', rows: 4, numberFields: [
        ['inputPerMillion', 'Input price ($ per million tokens)'],
        ['outputPerMillion', 'Output price ($ per million tokens)'],
      ] },
      { key: 'budget', label: 'Budget', kind: 'json', rows: 4, numberFields: [
        ['spentSoFarUsd', 'Spent so far ($)'], ['ceilingUsd', 'Spending cap ($)'],
      ] },
      { key: 'nextCall', label: 'Estimated size of the next request', kind: 'json', rows: 5, numberFields: [
        ['inputTokens', 'Input tokens (text you send)'], ['outputTokens', 'Output tokens (text you expect back)'],
      ] },
    ],
    presets: [
      {
        label: 'Would go over',
        situation: 'A team prices another AI request when it is close to its spending cap.',
        input: { rates: { inputPerMillion: 3, outputPerMillion: 15 }, budget: { spentSoFarUsd: 24.99, ceilingUsd: 25 }, nextCall: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 8000 } },
      },
      {
        label: 'Room left',
        situation: 'A team estimates whether its next AI request will fit in the remaining budget.',
        input: { rates: { inputPerMillion: 3, outputPerMillion: 15 }, budget: { spentSoFarUsd: 18.4, ceilingUsd: 25 }, nextCall: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 8000 } },
      },
    ],
    run(kit, input) {
      const check = kit.checkPreCallCeiling({ ...input.budget, estimatedNextCallUsage: input.nextCall, rates: input.rates });
      const next = kit.estimateCostUsd(input.rates, input.nextCall);
      // Keep cents unless they would hide which side of the ceiling the total is on.
      const total = check.projectedTotalUsd;
      const ceiling = input.budget.ceilingUsd;
      let digits = 2;
      while (digits < 20 && total !== ceiling && total.toFixed(digits) === ceiling.toFixed(digits)) digits++;
      const usd = (n) => `$${n.toFixed(digits)}`;
      const relation = total === ceiling ? 'at' : check.allowed ? 'under' : 'over';
      const rows = [
        { mark: 'info', title: `Next request is about ${usd(next)}`, detail: `Per million tokens (pieces of text), the price is $${input.rates.inputPerMillion} for text sent and $${input.rates.outputPerMillion} for text returned.${input.nextCall.cacheReadTokens ? ` Includes ${input.nextCall.cacheReadTokens.toLocaleString('en-US')} tokens reused from earlier requests.` : ''}` },
        { mark: check.allowed ? 'ok' : 'bad', title: `Projected total ${usd(total)} of a ${usd(ceiling)} ceiling`, detail: check.allowed ? `${relation === 'at' ? 'At' : 'Under'} the ceiling, so the call may go ahead.` : 'Over the ceiling, so the call should not be made.', fix: check.allowed ? null : 'Skip or shrink the call, or raise the ceiling on purpose.' },
      ];
      return {
        tone: check.allowed ? 'pass' : 'fail',
        headline: check.allowed ? 'Go ahead: the next call fits in the budget.' : 'Stop: the next call would go over budget.',
        rows,
        viz: { type: 'budget', spent: input.budget.spentSoFarUsd, next, ceiling, digits, allowed: check.allowed },
        raw: check,
      };
    },
    snippet: (input) => `import { checkPreCallCeiling } from 'cost-governor-kit';

const rates = ${js(input.rates)}; // check these against current prices

const check = checkPreCallCeiling({
  spentSoFarUsd: ${input.budget.spentSoFarUsd},
  ceilingUsd: ${input.budget.ceilingUsd},
  estimatedNextCallUsage: ${js(input.nextCall).replace(/\n/g, '\n  ')},
  rates,
});
console.log(check.allowed ? 'ok to call' : check.reason);

// Refuse the call (or fail the job) when it would go over budget.
if (!check.allowed) process.exitCode = 1;
`,
  },
];

/** The MCP server with tools for all 15 kits, for AI coding agents. */
export const MCP = {
  id: 'honesty-mcp',
  version: '0.4.0',
  serverName: 'honesty-mcp',
  config: { command: 'npx', args: ['-y', 'honesty-mcp'] },
};

/** Install links for the MCP server, built from documented formats. */
export function mcpLinks(toBase64) {
  const json = JSON.stringify(MCP.config);
  return {
    claudeCode: `claude mcp add ${MCP.serverName} -- npx -y honesty-mcp`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP.serverName}&config=${encodeURIComponent(toBase64(json))}`,
    vscode: `https://insiders.vscode.dev/redirect/mcp/install?name=${MCP.serverName}&config=${encodeURIComponent(json)}`,
    configJson: JSON.stringify({ mcpServers: { [MCP.serverName]: MCP.config } }, null, 2),
  };
}

/** A Markdown report of one result, for a pull request, issue or chat. */
export function reportMarkdown(kit, result, link) {
  const sign = { ok: '✓', bad: '✗', warn: '!', info: 'ℹ', skip: '–' };
  const verdict = result.stamp && result.stamp !== result.headline ? `${result.stamp}. ${result.headline}` : result.headline;
  const lines = [`**${kit.id}@${kit.version}: ${verdict}**`, ''];
  const summary = result.reportSummary ?? result.summary;
  if (summary) lines.push(summary, '');
  if (result.quote) lines.push(`> ${result.quote.replaceAll('\n', '\n> ')}`, '');
  if (result.fix) lines.push(`Fix: ${result.fix}`, '');
  for (const row of result.rows) {
    lines.push(`- ${sign[row.mark]} ${row.title}${row.detail ? `: ${row.detail}` : ''}`);
    if (row.fix) lines.push(`  - Fix: ${row.fix}`);
  }
  if (result.statement) lines.push('', `> ${result.statement.replaceAll('\n', '\n> ')}`);
  lines.push('', `_What it does not check: ${kit.limit}_`);
  if (link) lines.push('', `[Open this example in the playground](${link})`);
  return lines.join('\n');
}

// ------------------------------------------------------------ shared links
// An example travels in the URL fragment (never sent to a server) as
// base64url JSON. Decoding checks the shape against the kit's own fields, so a
// hand-edited or truncated link falls back to the kit's first example.

const MAX_TOKEN = 16000;
const toBase64Url = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (token) => {
  const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

/** Encode a kit's input for a shareable link fragment. */
export function encodeExample(kit, input) {
  const picked = {};
  for (const field of kit.fields) picked[field.key] = input[field.key];
  return toBase64Url(JSON.stringify({ v: 1, input: picked }));
}

/** Decode a link fragment back into a kit input, or null when it does not fit the kit. */
export function decodeExample(kit, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  let parsed;
  try { parsed = JSON.parse(fromBase64Url(token)); } catch { return null; }
  if (!parsed || parsed.v !== 1 || typeof parsed.input !== 'object' || parsed.input === null || Array.isArray(parsed.input)) return null;
  const input = {};
  for (const field of kit.fields) {
    if (!Object.hasOwn(parsed.input, field.key)) {
      if (field.optional) continue;
      return null;
    }
    const value = parsed.input[field.key];
    if (field.kind === 'choice' && !field.options.includes(value)) return null;
    if ((field.kind === 'text' || field.kind === 'line') && typeof value !== 'string') return null;
    if (field.kind === 'json' && value === undefined) return null;
    input[field.key] = value;
  }
  if (Object.keys(parsed.input).some((key) => !kit.fields.some((f) => f.key === key))) return null;
  return input;
}
