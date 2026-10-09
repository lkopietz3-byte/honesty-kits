// One demo per kit. Each demo receives the kit's real published module (loaded
// from the site or jsDelivr in the browser, from node_modules in tests) and the user's
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
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * Readable, valid JSON: flat objects and primitive arrays stay on one line,
 * lists of flat objects get one object per line.
 */
export function formatJson(value, indent = '') {
  const flat = (v) => v === null || typeof v !== 'object';
  const inline = (v) => JSON.stringify(v).replace(/^\{"/, '{ "').replace(/\}$/, ' }').replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\[\]$/, '[]');
  const next = `${indent}  `;
  if (flat(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.every(flat)) return JSON.stringify(value).replace(/,/g, ', ');
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

export const KITS = [
  // ---------------------------------------------------------------- grounding
  {
    id: 'grounding-kit',
    version: '0.2.1',
    group: GROUPS[0],
    name: 'Citations',
    question: 'Does each sentence cite evidence that actually says it?',
    limit: 'Checks citation structure and wording overlap. It does not decide whether the evidence itself is true.',
    fields: [
      { key: 'text', label: 'Text your AI wrote', kind: 'text', rows: 6 },
      { key: 'evidence', label: 'Evidence it was given (id → text)', kind: 'json', rows: 6 },
    ],
    presets: [
      {
        label: 'A draft with problems',
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
        label: 'A clean draft',
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
        grounded: ['ok', 'Backed by its citation', null],
        placeholder: ['info', 'Honestly marked as needing a source', 'Find a source before publishing, or keep the gap visible to readers.'],
        ungrounded: ['warn', 'Makes a claim with no citation', 'Cite the evidence that supports it, or mark it [citation needed].'],
        invalid: ['bad', 'Bad citation', 'Point the citation at evidence that says this, or rewrite the sentence to match the evidence.'],
      };
      const known = new Set(Object.keys(input.evidence));
      const rows = result.sentences.map((s) => {
        const [mark, why, fix] = look[s.status] ?? ['info', s.status, null];
        let detail = `${why}.${s.citedIds.length ? ` Cites ${s.citedIds.join(', ')}.` : ''}`;
        if (s.status === 'invalid') {
          const missing = s.citedIds.filter((id) => !known.has(id));
          detail = missing.length
            ? `Cites ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the evidence.`
            : `Cites ${s.citedIds.join(', ')}, but that evidence does not say this.`;
        }
        return { mark, title: clip(s.sentence), detail, fix };
      });
      const { grounded, placeholder, ungrounded, invalid } = result.counts;
      const tone = invalid > 0 ? 'fail' : ungrounded > 0 ? 'warn' : 'pass';
      const headline = result.isClean
        ? `Structurally clean: ${plural(result.sentences.length, 'sentence')} checked, ${plural(placeholder, 'honest gap')}.`
        : `Not ready to ship: ${plural(invalid, 'bad citation')}, ${plural(ungrounded, 'uncited claim')}.`;
      const viz = {
        type: 'threads',
        sentences: result.sentences.map((s) => ({ status: s.status, citedIds: s.citedIds, validIds: s.validIds })),
        evidenceIds: Object.keys(input.evidence),
      };
      return { tone, headline, summary: `${grounded} backed · ${placeholder} marked · ${ungrounded} uncited · ${invalid} bad`, rows, viz, raw: result };
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
    version: '0.2.1',
    group: GROUPS[0],
    name: 'Certainty wording',
    question: 'Does the copy sound more certain than its source allows?',
    limit: 'Matches a starter list of phrases you can extend. It is a wording check, not a fact check.',
    fields: [{ key: 'claims', label: 'Claims, each tagged with where it came from', kind: 'json', rows: 13 }],
    presets: [
      {
        label: 'Marketing copy',
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
        certainty_phrase_without_backing_tier: 'Soften the wording (for example “we estimate”) or move the claim to a tier that backs it.',
        missing_source_ref: 'Add a sourceRef that says what the claim was checked against.',
        unrecognized_tier: 'Tag the claim as verified, modeled or editorial.',
      };
      const flagged = new Set(offenses.map((o) => o.claimId));
      const rows = [
        ...offenses.map((o) => ({ mark: 'bad', title: clip(o.claimText), detail: o.message, fix: fixes[o.reason] ?? 'Reword the claim or back it with a source.', highlight: o.phrase ?? null })),
        ...input.claims
          .filter((c) => c && !flagged.has(c.id))
          .map((c) => ({ mark: 'ok', title: clip(String(c.text)), detail: `No wording problem for a “${c.tier}” claim.` })),
      ];
      const tone = offenses.length ? 'fail' : 'pass';
      const headline = offenses.length
        ? `${plural(offenses.length, 'wording problem')} across ${plural(input.claims.length, 'claim')}.`
        : `No wording problems found in ${plural(input.claims.length, 'claim')} under these rules.`;
      return { tone, headline, rows, raw: offenses };
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

  // ------------------------------------------------------------ corroboration
  {
    id: 'corroboration-kit',
    version: '0.2.1',
    group: GROUPS[0],
    name: 'Evidence strength',
    question: 'How strong is the evidence for a claim, and which way does it point?',
    limit: 'Counts distinct sources you name. It cannot tell whether those sources are really independent.',
    fields: [
      { key: 'coverage', label: 'How much of the evidence you looked at: strong, partial or thin', kind: 'line' },
      { key: 'signals', label: 'What each source said', kind: 'json', rows: 11 },
    ],
    presets: [
      {
        label: 'Two sources agree',
        input: {
          coverage: 'strong',
          signals: [
            { source: 'pricing-api', kind: 'structural', vote: 'supports', detail: 'API returns the new price' },
            { source: 'checkout-page', kind: 'textual', vote: 'supports', detail: 'page shows the new price' },
          ],
        },
      },
      {
        label: 'The evidence says no',
        input: {
          coverage: 'strong',
          signals: [
            { source: 'inventory-db', kind: 'structural', vote: 'contradicts', detail: 'stock count is 0' },
            { source: 'product-page', kind: 'textual', vote: 'contradicts', detail: 'page says sold out' },
          ],
        },
      },
      {
        label: 'Thin sample, mixed signals',
        input: {
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
      const voteMark = { supports: 'ok', contradicts: 'bad', inconclusive: 'skip' };
      const rows = result.signals.map((s) => ({
        mark: voteMark[s.vote] ?? 'info',
        title: `${s.source}: ${s.vote}`,
        detail: `${s.kind} evidence. ${s.detail}`,
      }));
      const direction = {
        supports: 'The evidence supports the claim',
        contradicts: 'The evidence contradicts the claim',
        mixed: 'The evidence is split',
        none: 'There is no evidence either way',
      }[result.direction];
      if (result.direction === 'contradicts') rows.push({ mark: 'bad', title: 'Correct or withdraw the claim', detail: 'The evidence points the other way.', fix: 'Update the claim to match the evidence, or remove it.' });
      else if (result.verdict !== 'confirmed') rows.push({ mark: 'skip', title: 'Not confirmed yet', detail: `Coverage is ${result.coverage}.`, fix: 'Look at more of the evidence, and add a non-textual check (an API, a schema or observed behavior) before calling it confirmed.' });
      const tone = result.direction === 'contradicts' ? 'fail' : result.direction === 'supports' && result.verdict === 'confirmed' ? 'pass' : 'warn';
      return {
        tone,
        headline: `${direction}. Strength: ${result.verdict} (${result.coverage} coverage).`,
        summary: `${plural(result.supports, 'supporting source')} · ${plural(result.contradicts, 'contradicting source')}`,
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
    version: '0.3.1',
    group: GROUPS[1],
    name: 'Claims on your site',
    question: 'Is every public claim still backed by evidence someone checked recently?',
    limit: 'Checks that a claim points at evidence and that it was reviewed recently, not that the evidence still holds.',
    fields: [
      { key: 'now', label: 'Today (fixed so results are repeatable)', kind: 'line' },
      { key: 'maxAgeDays', label: 'Re-check claims every N days', kind: 'line' },
      { key: 'claims', label: 'Claims and their evidence', kind: 'json', rows: 12 },
    ],
    presets: [
      {
        label: 'A typical product page',
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
      const now = strictDate(input.now, 'Today');
      const maxAgeDays = Number(input.maxAgeDays);
      const report = kit.generateClaimsReport(input.claims, maxAgeDays, now);
      const rows = [
        ...report.unverified.map((c) => ({ mark: 'bad', title: clip(c.text), detail: 'No evidence linked. Nothing backs this claim.', fix: 'Link evidence (a test, document or data source), or take the claim down.' })),
        ...report.stale.map((c) => ({ mark: 'warn', title: clip(c.text), detail: c.ageDays === null ? 'The review date could not be read.' : `Last checked ${c.ageDays} days ago. Due for a re-check.`, fix: 'Re-check the evidence and update verifiedAt.' })),
        ...report.current.map((c) => ({ mark: 'ok', title: clip(c.text), detail: `Checked ${c.ageDays} days ago.` })),
      ];
      const { current, stale, unverified, total } = report.counts;
      const tone = unverified ? 'fail' : stale ? 'warn' : 'pass';
      const headline = unverified || stale
        ? `${plural(unverified, 'claim')} with no evidence, ${stale} overdue for a check.`
        : `All ${plural(total, 'claim')} are backed and recently checked.`;
      const mark = (c) => (report.unverified.includes(c) ? 'bad' : report.stale.includes(c) ? 'warn' : 'ok');
      const items = [...report.current, ...report.stale, ...report.unverified].map((c) => ({ label: c.id, ageDays: c.ageDays, mark: mark(c) }));
      return {
        tone,
        headline,
        summary: `${current} current · ${stale} stale · ${unverified} unverified`,
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
    version: '0.2.1',
    group: GROUPS[1],
    name: 'Freshness labels',
    question: 'How old is this information, and what should its label say?',
    limit: 'Measures age from the review date you supply. It does not know whether the content changed.',
    fields: [
      { key: 'now', label: 'Today (fixed so results are repeatable)', kind: 'line' },
      { key: 'config', label: 'When to warn and when to call it stale (days)', kind: 'json', rows: 4 },
      { key: 'pages', label: 'Pages and when each was last reviewed', kind: 'json', rows: 9 },
    ],
    presets: [
      {
        label: 'A help center',
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
    ],
    run(kit, input) {
      const now = strictDate(input.now, 'Today');
      const mark = { fresh: 'ok', aging: 'warn', stale: 'bad' };
      const fix = { aging: 'Schedule a review before it goes stale.', stale: 'Review the page and update its reviewed date.' };
      const results = input.pages.map((p) => ({ page: p.page, result: kit.assessFreshness(p.reviewedOn, input.config, undefined, now) }));
      const rows = results.map(({ page, result }) => {
        const badge = kit.freshnessBadgeText(result);
        return {
          mark: mark[result.level] ?? 'info',
          title: badge ? `${page}: “${badge}”` : `${page}: no label needed`,
          detail: result.message || `Reviewed ${result.ageDays} days ago, inside your ${input.config.warnAfterDays}-day window.`,
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

  // ------------------------------------------------------- payout-invariance
  {
    id: 'payout-invariance-kit',
    version: '0.2.1',
    group: GROUPS[2],
    name: 'Paid placement',
    question: 'Would your rankings change if a partner paid you more?',
    limit: 'Tests the scenarios you write. Passing them is evidence, not a proof for every possible payout.',
    fields: [
      { key: 'ranker', label: 'Ranking code under test', kind: 'choice', options: Object.keys(RANKERS) },
      { key: 'candidates', label: 'Products, with quality score and payout (basis points)', kind: 'json', rows: 7 },
    ],
    presets: [
      {
        label: 'A fair ranking',
        input: {
          ranker: 'Ranks by quality score only',
          candidates: [
            { id: 'trail-runner', score: 90, payoutRateBps: 50 },
            { id: 'city-sneaker', score: 72, payoutRateBps: 0 },
            { id: 'budget-pick', score: 61, payoutRateBps: 800 },
          ],
        },
      },
      {
        label: 'A hidden payout boost',
        input: {
          ranker: 'Quietly boosts higher-paying partners',
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
      const rows = scenarios.map((s) => {
        const failure = result.failures.find((f) => f.scenario === s.name);
        return failure
          ? { mark: 'bad', title: `If ${s.name}`, detail: `Ranking changed to ${failure.actual?.orderedIds?.join(' → ') ?? 'a different order'}.`, fix: 'Take payout fields out of the ranking path, or label paid placements clearly.' }
          : { mark: 'ok', title: `If ${s.name}`, detail: 'Ranking stayed the same.' };
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
        summary: `Base order: ${result.baseline.orderedIds.join(' → ')}`,
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
    version: '0.2.1',
    group: GROUPS[2],
    name: 'Hidden factors',
    question: 'Does a decision change when a field it should ignore changes?',
    limit: 'Tests the variations you list. Passing them is evidence, not a proof for every input.',
    fields: [
      { key: 'scorer', label: 'Decision code under test', kind: 'choice', options: Object.keys(SCORERS) },
      { key: 'applicant', label: 'Base applicant', kind: 'json', rows: 5 },
      { key: 'zips', label: 'Zip codes to try (should not matter)', kind: 'json', rows: 5 },
    ],
    presets: [
      { label: 'Ignores zip code', input: { scorer: 'Looks at income only', applicant: { name: 'Applicant', zip: '68102', income: 85000 }, zips: ['02138', '90210', '38652'] } },
      { label: 'Peeks at zip code', input: { scorer: 'Also peeks at zip code', applicant: { name: 'Applicant', zip: '68102', income: 85000 }, zips: ['02138', '90210', '38652'] } },
    ],
    run(kit, input) {
      const score = SCORERS[input.scorer] ?? SCORERS['Looks at income only'];
      const scenarios = input.zips.map((zip) => ({ name: `zip code ${zip}`, mutate: (app) => ({ ...app, zip }) }));
      const result = kit.assertInvariance(score, input.applicant, scenarios);
      const variants = scenarios.map((s) => {
        const failure = result.failures.find((f) => f.scenario === s.name);
        return { label: s.name.replace('zip code ', ''), value: failure ? failure.actual?.rateBps : result.baseline.rateBps, changed: Boolean(failure) };
      });
      const rows = scenarios.map((s, i) =>
        variants[i].changed
          ? { mark: 'bad', title: `With ${s.name}`, detail: `Decision changed: rate ${variants[i].value} bps instead of ${result.baseline.rateBps}.`, fix: 'Remove the field from the decision, or document why it is allowed.' }
          : { mark: 'ok', title: `With ${s.name}`, detail: 'Same decision.' });
      return {
        tone: result.passed ? 'pass' : 'fail',
        headline: result.passed
          ? `Same decision for all ${plural(scenarios.length, 'zip code')}.`
          : `The decision changed with zip code in ${result.failures.length} of ${plural(scenarios.length, 'case')}.`,
        summary: `Base decision: approved=${result.baseline.approved}, rate ${result.baseline.rateBps} bps`,
        rows,
        viz: { type: 'bars', unit: 'bps', baseline: { label: `base ${input.applicant.zip}`, value: result.baseline.rateBps }, bars: variants },
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
    version: '0.2.0',
    group: GROUPS[2],
    name: 'Did the advice work?',
    question: 'After someone followed a recommendation, did the problem actually get better?',
    limit: 'Compares the windows before and after the decision. It shows an association, not that the advice caused the change.',
    fields: [
      { key: 'recommendation', label: 'The recommendation', kind: 'json', rows: 6 },
      { key: 'decision', label: 'What the person decided, and when', kind: 'json', rows: 5 },
      { key: 'observations', label: 'Readings before and after', kind: 'json', rows: 9 },
    ],
    presets: [
      {
        label: 'The fix held',
        input: {
          recommendation: { id: 'rec-1', subjectId: 'checkout', checkKey: 'error-rate-high', proposedAt: '2026-09-01' },
          decision: { recommendationId: 'rec-1', status: 'adopted', decidedAt: '2026-09-10' },
          observations: [
            ...['02', '04', '06', '08'].map((d, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < 3 ? 'bad' : 'good', observedAt: `2026-09-${d}` })),
            ...['12', '14', '16', '18'].map((d) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: 'good', observedAt: `2026-09-${d}`, exposed: true })),
          ],
        },
      },
      {
        label: 'It got worse',
        input: {
          recommendation: { id: 'rec-2', subjectId: 'checkout', checkKey: 'error-rate-high', proposedAt: '2026-09-01' },
          decision: { recommendationId: 'rec-2', status: 'adopted', decidedAt: '2026-09-10' },
          observations: [
            ...['02', '04', '06', '08'].map((d, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < 1 ? 'bad' : 'good', observedAt: `2026-09-${d}` })),
            ...['12', '14', '16', '18'].map((d, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < 3 ? 'bad' : 'good', observedAt: `2026-09-${d}`, exposed: true })),
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
      if (grade.verdict === 'not-holding') rows.push({ mark: 'bad', title: 'The problem got worse after the advice', detail: 'More bad readings after the decision than before.', fix: 'Revisit the recommendation before applying it anywhere else.' });
      if (grade.refusalCodes.length) rows.push({ mark: 'skip', title: 'Not enough evidence to grade', detail: grade.refusalCodes.join(', '), fix: 'Collect more readings before and after the decision.' });
      const tone = grade.verdict === 'holding' ? 'pass' : grade.verdict === 'not-holding' ? 'fail' : 'warn';
      const label = { holding: 'The advice is holding up', 'not-holding': 'The advice is not holding up', refused: 'Not enough evidence to say' }[grade.verdict] ?? grade.verdict;
      const pct = (w) => (w.observations ? w.badRate : null);
      return {
        tone,
        headline: `${label}.`,
        summary: kit.describeGrade(grade),
        rows,
        viz: { type: 'bars', unit: '%', percent: true, bars: [{ label: 'before', value: pct(grade.baseline), changed: false }, { label: 'after', value: pct(grade.result), changed: grade.verdict === 'not-holding' }] },
        raw: grade,
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
    version: '0.2.0',
    group: GROUPS[3],
    name: 'Review patterns',
    question: 'Do these anonymous reviews look organic, or like a pattern worth a closer look?',
    limit: 'Flags two cheap patterns (one source, near-identical sentiment). It cannot prove any review is fake.',
    fields: [
      { key: 'now', label: 'Today (fixed so results are repeatable)', kind: 'line' },
      { key: 'reviews', label: 'Reviews: source site, sentiment (-1 to 1), confidence (0 to 1)', kind: 'json', rows: 10 },
    ],
    presets: [
      {
        label: 'Varied reviews',
        input: {
          now: '2026-10-01T00:00:00Z',
          reviews: [
            { id: 'r1', source: 'forum', sentiment: 0.8, confidence: 0.9, publishedAt: '2026-08-14' },
            { id: 'r2', source: 'marketplace', sentiment: 0.4, confidence: 0.8, publishedAt: '2026-07-02' },
            { id: 'r3', source: 'blog', sentiment: 0.6, confidence: 0.7, publishedAt: '2026-06-19' },
            { id: 'r4', source: 'community', sentiment: -0.2, confidence: 0.9, publishedAt: '2026-09-03' },
          ],
        },
      },
      {
        label: 'Near-identical 5-star reviews',
        input: {
          now: '2026-10-01T00:00:00Z',
          reviews: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ id, source: 'marketplace', sentiment: 0.99, confidence: 1, publishedAt: '2026-09-28' })),
        },
      },
      {
        label: 'Nothing usable',
        input: {
          now: '2026-10-01T00:00:00Z',
          reviews: [{ id: 'r1', source: 'unknown-site', sentiment: 0.9, confidence: 1, publishedAt: '2026-09-28' }],
        },
      },
    ],
    run(kit, input) {
      const now = strictDate(input.now, 'Today').toISOString();
      const result = kit.anonymous.assessAuthenticity(input.reviews, kit.anonymous.resolveAnonymousConfig(), { now });
      const look = 'Read these reviews yourself before trusting the score.';
      const rows = [
        { mark: result.flags.lowSourceCount ? 'warn' : 'ok', title: result.flags.lowSourceCount ? 'Evidence comes from very few source types' : 'Evidence spans several source types', detail: `${plural(result.sourceCount, 'distinct source type')}. Independence is not verified.`, fix: result.flags.lowSourceCount ? look : null },
        { mark: result.flags.uniformSentiment ? 'warn' : 'ok', title: result.flags.uniformSentiment ? 'Sentiment is unusually uniform' : 'Sentiment varies the way real opinions do', detail: 'Near-maximal sentiment with almost no variance is one cheap pattern worth a human look.', fix: result.flags.uniformSentiment ? look : null },
        { mark: result.eligibleSignalCount === result.signalCount ? 'ok' : 'skip', title: `${result.eligibleSignalCount} of ${plural(result.signalCount, 'review')} carried weight`, detail: 'Zero confidence, an unlisted source or fully decayed age gives a review no weight.', fix: result.eligibleSignalCount === result.signalCount ? null : 'Use sources listed in your config, with confidence above 0.' },
      ];
      const viz = { type: 'dial', score: result.trustScore, confidence: result.confidence.level, flags: result.flags };
      if (result.trustScore === null) {
        return { tone: 'info', headline: 'No score: there is not enough weighted evidence to say anything.', summary: result.explanation, rows: rows.slice(2), viz, raw: result };
      }
      const tone = result.flags.lowSourceCount || result.flags.uniformSentiment ? 'warn' : 'pass';
      return { tone, headline: `Heuristic score ${result.trustScore}/100 (${result.confidence.level} confidence).`, summary: result.explanation, rows, viz, raw: result };
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
    version: '0.2.0',
    group: GROUPS[3],
    name: 'Agent receipts',
    question: 'Did your AI agent stay inside what it was allowed to do, and do its claims match reality?',
    limit: 'Compares the agent’s report with the permission slip and the state you supply. “Accepted” means no mismatch found, not proven true.',
    fields: [
      { key: 'allowed', label: 'What the agent may do and cite', kind: 'json', rows: 4 },
      { key: 'report', label: 'What the agent says it did', kind: 'json', rows: 5 },
      { key: 'currentState', label: 'What you see when you check yourself', kind: 'json', rows: 2 },
    ],
    presets: [
      {
        label: 'An agent that overstepped',
        input: {
          allowed: { actions: ['log-in', 'add-to-cart'], evidenceIds: ['screenshot-1', 'screenshot-2'] },
          report: { claimedActions: ['log-in', 'add-to-cart', 'submit-payment'], citedEvidenceIds: ['screenshot-1'], claimedFacts: { cartItemCount: 1, couponApplied: true } },
          currentState: { cartItemCount: 0 },
        },
      },
      {
        label: 'An honest report',
        input: {
          allowed: { actions: ['log-in', 'add-to-cart'], evidenceIds: ['screenshot-1', 'screenshot-2'] },
          report: { claimedActions: ['log-in', 'add-to-cart'], citedEvidenceIds: ['screenshot-2'], claimedFacts: { cartItemCount: 1 } },
          currentState: { cartItemCount: 1 },
        },
      },
    ],
    run(kit, input) {
      const packet = kit.issuePacket({ task: 'shopping demo' }, 'local', input.allowed.actions, input.allowed.evidenceIds, { id: 'pkt-demo', issuedAt: '2026-10-01T09:00:00.000Z' });
      const claim = { packetId: packet.id, ...input.report };
      const result = kit.verifyReceipt(packet, claim, input.currentState);
      const rows = [
        ...(result.packetMismatch ? [{ mark: 'bad', title: 'The report answers a different permission slip', detail: 'Its packet id does not match.', fix: 'Reject the report and re-run the agent with the right packet.' }] : []),
        ...result.claimProblems.map((p) => ({ mark: 'bad', title: 'The report itself is malformed', detail: p, fix: 'Reject the report; ask the agent to report in the expected shape.' })),
        ...result.unauthorizedActions.map((a) => ({ mark: 'bad', title: `Did something it was not allowed to: ${a}`, detail: 'Not in the permission slip.', fix: 'Undo or block the action, and tighten what the agent may do.' })),
        ...result.droppedEvidenceIds.map((e) => ({ mark: 'bad', title: `Cited evidence it was not given: ${e}`, detail: 'Not in the evidence list, so it was dropped.', fix: 'Only accept evidence you handed the agent.' })),
        ...result.contradictions.map((c) => ({ mark: 'bad', title: `Says ${c.key} is ${JSON.stringify(c.claimedFact)}`, detail: `You see ${JSON.stringify(c.currentFact)}.`, fix: 'Trust your own read of the state over the agent’s report.' })),
        ...result.coverage.uncheckedFactKeys.map((k) => ({ mark: 'skip', title: `Not checked: ${k}`, detail: 'Your state did not include this fact.', fix: 'Add this fact to your own check so it can be compared.' })),
      ];
      if (!rows.some((r) => r.mark === 'bad')) rows.unshift({ mark: 'ok', title: 'Every action was allowed and every checked fact matched', detail: `${result.coverage.comparedFactCount} of ${result.coverage.claimedFactCount} claimed facts compared.` });
      const unauthorized = new Set(result.unauthorizedActions);
      return {
        tone: result.accepted ? 'pass' : 'fail',
        headline: result.accepted ? 'Accepted: no mismatch found.' : 'Rejected: the report does not match what was allowed or what you see.',
        summary: result.reason,
        rows,
        viz: {
          type: 'lanes',
          allowed: input.allowed.actions,
          claimed: input.report.claimedActions.map((a) => ({ label: a, ok: !unauthorized.has(a) })),
          facts: Object.keys(input.report.claimedFacts ?? {}).map((key) => {
            const c = result.contradictions.find((x) => x.key === key);
            return { label: key, state: c ? 'bad' : result.coverage.uncheckedFactKeys.includes(key) ? 'skip' : 'ok' };
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
    version: '0.2.0',
    group: GROUPS[3],
    name: 'Tamper-evident log',
    question: 'Has anyone edited or deleted entries in this log after the fact?',
    limit: 'Detects changes to entries it can see. Keep the anchor somewhere the log’s writer cannot edit, or a full rewrite goes unnoticed.',
    fields: [
      { key: 'entries', label: 'Log entries, in order', kind: 'json', rows: 12 },
      { key: 'tamper', label: 'Simulate tampering after the fact', kind: 'choice', options: ['Leave the log alone', 'Change a field in entry 1', 'Delete the last entry'] },
    ],
    presets: [
      {
        label: 'Untouched log',
        input: {
          entries: [
            { action: 'refund.requested', by: 'customer_17', amountUsd: 40 },
            { action: 'refund.approved', by: 'agent_3', amountUsd: 40 },
            { action: 'refund.paid', by: 'system', amountUsd: 40 },
          ],
          tamper: 'Leave the log alone',
        },
      },
      {
        label: 'Someone changed an amount',
        input: {
          entries: [
            { action: 'refund.requested', by: 'customer_17', amountUsd: 40 },
            { action: 'refund.approved', by: 'agent_3', amountUsd: 40 },
            { action: 'refund.paid', by: 'system', amountUsd: 40 },
          ],
          tamper: 'Change a field in entry 1',
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
        return {
          mark: broken ? 'bad' : after ? 'skip' : 'ok',
          title: `#${e.index} ${e.payload?.action ?? ''}`,
          detail: `${formatJson(e.payload)} · hash ${String(e.entryHash).slice(0, 12)}…`,
          mono: true,
          fix: broken ? 'Restore this entry from a backup and find out who could write to the log.' : null,
        };
      });
      if (brokenAt === stored.length) rows.push({ mark: 'bad', title: `#${stored.length} is missing`, detail: 'The saved anchor points at an entry that is no longer in the log.', fix: 'Restore the deleted entries from a backup.' });
      return {
        tone: result.valid ? 'pass' : 'fail',
        headline: result.valid ? `All ${plural(stored.length, 'entry', 'entries')} check out against the anchor.` : `Tampering detected at entry ${brokenAt}.`,
        summary: result.reason ?? 'Every hash links to the one before it, and the last one matches the saved anchor.',
        rows,
        viz: {
          type: 'chain',
          entries: stored.map((e) => ({ index: e.index, action: e.payload?.action ?? '', hash: String(e.entryHash).slice(0, 8) })),
          brokenAt,
          kind: result.valid ? null : brokenAt === stored.length ? 'missing' : /content does not match/.test(result.reason ?? '') ? 'content' : 'link',
          anchorIndex: anchor?.index ?? null,
        },
        raw: result,
      };
    },
    snippet: (input) => `import { appendEntry, verifyChain } from 'audit-chain-kit';

let chain = [];
for (const payload of ${js(input.entries)}) chain = await appendEntry(chain, payload);

// Save this anchor somewhere the log's writer cannot edit.
const last = chain[chain.length - 1];
const anchor = { index: last.index, entryHash: last.entryHash };

${{
  'Change a field in entry 1': '\n// Simulated tampering, as in the playground: someone edits entry 1 in storage.\nchain = JSON.parse(JSON.stringify(chain));\nchain[1].payload.amountUsd = 400;\n',
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
    version: '0.2.0',
    group: GROUPS[4],
    name: 'AI spend cap',
    question: 'Will the next model call push you over your budget?',
    limit: 'Prices calls with the rates you supply and estimates the next call before it runs. It is not a billing system.',
    fields: [
      { key: 'rates', label: 'Your model’s prices, USD per million tokens', kind: 'json', rows: 4 },
      { key: 'budget', label: 'Spent so far and your ceiling, USD', kind: 'json', rows: 4 },
      { key: 'nextCall', label: 'Estimated size of the next call, in tokens', kind: 'json', rows: 5 },
    ],
    presets: [
      { label: 'Room left', input: { rates: { inputPerMillion: 3, outputPerMillion: 15 }, budget: { spentSoFarUsd: 18.4, ceilingUsd: 25 }, nextCall: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 8000 } } },
      { label: 'Would go over', input: { rates: { inputPerMillion: 3, outputPerMillion: 15 }, budget: { spentSoFarUsd: 24.99, ceilingUsd: 25 }, nextCall: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 8000 } } },
    ],
    run(kit, input) {
      const check = kit.checkPreCallCeiling({ ...input.budget, estimatedNextCallUsage: input.nextCall, rates: input.rates });
      const next = kit.estimateCostUsd(input.rates, input.nextCall);
      const usd = (n) => `$${n.toFixed(4)}`;
      const rows = [
        { mark: 'info', title: `Next call is about ${usd(next)}`, detail: `At $${input.rates.inputPerMillion}/M input and $${input.rates.outputPerMillion}/M output. Cache reads are priced at 0.1x input unless you set your own rate.` },
        { mark: check.allowed ? 'ok' : 'bad', title: `Projected total ${usd(check.projectedTotalUsd)} of a ${usd(input.budget.ceilingUsd)} ceiling`, detail: check.allowed ? 'Under the ceiling, so the call may go ahead.' : 'Over the ceiling, so the call should not be made.', fix: check.allowed ? null : 'Skip or shrink the call, or raise the ceiling on purpose.' },
      ];
      return {
        tone: check.allowed ? 'pass' : 'fail',
        headline: check.allowed ? 'Go ahead: the next call fits in the budget.' : 'Stop: the next call would go over budget.',
        summary: `Projected ${usd(check.projectedTotalUsd)} = spent ${usd(input.budget.spentSoFarUsd)} + next call ${usd(next)}, ${check.allowed ? 'under' : 'over'} the ${usd(input.budget.ceilingUsd)} ceiling.`,
        rows,
        viz: { type: 'budget', spent: input.budget.spentSoFarUsd, next, ceiling: input.budget.ceilingUsd, allowed: check.allowed },
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

/** The MCP server that wraps eleven of the kits for AI coding agents. */
export const MCP = {
  id: 'honesty-mcp',
  version: '0.2.0',
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
  const sign = { ok: '✓', bad: '✗', warn: '!', info: 'i', skip: '–' };
  const lines = [`**${kit.id}@${kit.version}: ${result.headline}**`, ''];
  if (result.summary) lines.push(result.summary, '');
  for (const row of result.rows) {
    lines.push(`- ${sign[row.mark]} ${row.title}${row.detail ? `: ${row.detail}` : ''}`);
    if (row.fix) lines.push(`  - Fix: ${row.fix}`);
  }
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
    if (!Object.hasOwn(parsed.input, field.key)) return null;
    const value = parsed.input[field.key];
    if (field.kind === 'choice' && !field.options.includes(value)) return null;
    if ((field.kind === 'text' || field.kind === 'line') && typeof value !== 'string') return null;
    if (field.kind === 'json' && value === undefined) return null;
    input[field.key] = value;
  }
  if (Object.keys(parsed.input).some((key) => !kit.fields.some((f) => f.key === key))) return null;
  return input;
}
