// Row wording: what the playground says about a kit's answer must match what the
// kit actually answered. These tests hold for the kit versions the site pins today
// and for the next releases. Where a rule only exists in a newer release (a tie
// in the bad rate, a placeholder reference, an unexplained merge of two pages),
// the test detects it from the installed kit and is skipped, not passed, when the
// installed kit predates it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KITS } from '../demos.mjs';

const kitOf = (id) => KITS.find((k) => k.id === id);
const run = async (id, input) => kitOf(id).run(await import(id), structuredClone(input));
const titles = (result) => result.rows.map((r) => r.title);

// ---------------------------------------------------------------- advice ledger
const day = (n) => new Date(Date.UTC(2026, 7, 1 + n)).toISOString().slice(0, 10);
const readings = (bad, total, start, exposed) =>
  Array.from({ length: total }, (_, i) => ({ subjectId: 'checkout', checkKey: 'error-rate-high', state: i < bad ? 'bad' : 'good', observedAt: day(start + i), ...(exposed ? { exposed: true } : {}) }));
const advice = (before, after) => ({
  recommendation: { id: 'rec-t', subjectId: 'checkout', checkKey: 'error-rate-high', proposedAt: '2026-08-01' },
  decision: { recommendationId: 'rec-t', status: 'adopted', decidedAt: '2026-08-20' },
  observations: [...readings(before[0], before[1], 2, false), ...readings(after[0], after[1], 21, true)],
});

test('advice ledger: a rising bad rate says it got worse, with both rates', async () => {
  const result = await run('advice-ledger-kit', advice([1, 4], [3, 4]));
  assert.equal(result.raw.verdict, 'not-holding');
  const row = result.rows.find((r) => r.title === 'The problem got worse after the advice');
  assert.ok(row, `rows: ${titles(result)}`);
  assert.match(row.detail, /25%.*75%/);
});

test('advice ledger: a falling rate that still reaches the refute count does not say it got worse', async () => {
  // 6 of 6 bad before, 2 of 20 since: the rate fell sharply, but the kit's refute bar is a fixed count.
  const result = await run('advice-ledger-kit', advice([6, 6], [2, 20]));
  assert.equal(result.raw.verdict, 'not-holding');
  assert.ok(!titles(result).some((t) => /got worse/.test(t)), `rows: ${titles(result)}`);
  const row = result.rows.find((r) => r.mark === 'bad');
  assert.match(row.detail, /refute threshold/);
  assert.match(row.detail, /fell/);
});

const tie = advice([1, 3], [1, 3]);
const tieRule = (await run('advice-ledger-kit', tie)).raw.verdict === 'not-holding';
test('advice ledger: an equal bad rate says the problem did not go down', { skip: tieRule ? false : 'installed advice-ledger-kit predates the tie rule (0.3.0); NOT_RUN' }, async () => {
  const result = await run('advice-ledger-kit', tie);
  assert.equal(result.tone, 'fail');
  const row = result.rows.find((r) => r.mark === 'bad');
  assert.equal(row.title, 'The problem did not go down after the advice');
  assert.match(row.detail, /1 of 3 before and 1 of 3 after/);
});

// -------------------------------------------------------------- claims registry
const claimsInput = (claims, now = '2026-10-01', maxAgeDays = '90') => ({ now, maxAgeDays, claims });

test('claims registry: day counts read "1 day", not "1 days"', async () => {
  const result = await run('claims-registry-kit', claimsInput([{ id: 'a', text: 'Checked yesterday', evidenceRef: 'tests/a.spec.ts', verifiedAt: '2026-09-30' }]));
  assert.equal(result.rows[0].detail, 'Checked 1 day ago.');
});

test('claims registry: an overdue claim says how far past the limit it is', async () => {
  const result = await run('claims-registry-kit', claimsInput([{ id: 'a', text: 'Old claim', evidenceRef: 'tests/a.spec.ts', verifiedAt: '2026-07-01' }]));
  assert.equal(result.tone, 'warn');
  assert.equal(result.rows[0].detail, 'Last checked 92 days ago, past the 90-day limit. Due for a re-check.');
});

test('claims registry: a claim with no real evidence says placeholders do not count', async () => {
  const result = await run('claims-registry-kit', claimsInput([{ id: 'a', text: 'Backed by nothing', evidenceRef: '', verifiedAt: '2026-09-30' }]));
  assert.equal(result.tone, 'fail');
  assert.match(result.rows[0].detail, /placeholder/);
});

const boundary = claimsInput([{ id: 'a', text: 'Ninety days and twelve hours', evidenceRef: 'tests/a.spec.ts', verifiedAt: '2026-07-03T00:00:00Z' }], '2026-10-01T12:00:00Z');
const hourRule = (await run('claims-registry-kit', boundary)).raw.counts.stale === 1;
test('claims registry: a claim hours past the limit does not read as inside it', { skip: hourRule ? false : 'installed claims-registry-kit predates the exact-hours age rule (0.4.0); NOT_RUN' }, async () => {
  const result = await run('claims-registry-kit', boundary);
  assert.equal(result.tone, 'warn');
  assert.equal(result.rows[0].detail, 'Last checked 90 days and some hours ago, just past the 90-day limit. Due for a re-check.');
});

// -------------------------------------------------------------------- freshness
test('freshness: the fallback sentence says "1 day", not "1 days"', async () => {
  const input = { now: '2026-10-01', config: { warnAfterDays: 30, staleAfterDays: 90 }, pages: [{ page: 'Shipping rates', reviewedOn: '2026-09-30' }] };
  const result = await run('freshness-kit', input);
  assert.equal(result.rows[0].detail, 'Reviewed 1 day ago, inside your 30-day window.');
});

// ------------------------------------------------------------------- trust core
test('trust core: the source-type row reports the count the kit used, without calling it distinct', async () => {
  const result = await run('trust-core', kitOf('trust-core').presets[0].input);
  const row = result.rows[0];
  assert.match(row.detail, new RegExp(`^${result.raw.sourceCount} source types? counted\\. `));
  assert.ok(!/distinct/.test(row.detail), row.detail);
});

// -------------------------------------------------------------------- grounding
const thin = { text: 'Yes [[cite:e1]].', evidence: { e1: 'independent lab testing measured 14 hours of battery life' } };
const thinRule = (await run('grounding-kit', thin)).raw.sentences[0]?.reasons?.e1 === 'no-content-words';
test('grounding: a citation on a sentence with nothing to compare says so', { skip: thinRule ? false : 'installed grounding-kit predates the no-content-words reason (0.3.0); NOT_RUN' }, async () => {
  const result = await run('grounding-kit', thin);
  assert.equal(result.rows[0].mark, 'bad');
  assert.equal(result.rows[0].detail, 'Cites e1, but the sentence has no word longer than three characters, so there is nothing to compare.');
});

test('grounding: unknown and unsupported citations keep their messages', async () => {
  const unknown = await run('grounding-kit', { text: 'Battery life reached 14 hours [[cite:e9]].', evidence: { e1: 'x' } });
  assert.equal(unknown.rows[0].detail, 'Cites e9, which is not in the evidence.');
  const unsupported = await run('grounding-kit', { text: 'Battery life reached 14 hours [[cite:e1]].', evidence: { e1: 'the warranty covers five years of accidental damage' } });
  assert.equal(unsupported.rows[0].detail, 'Cites e1, but that evidence does not say this.');
});

// ---------------------------------------------------------------- corroboration
const sameSite = { coverage: 'strong', signals: [
  { source: 'https://example.com/docs/a', kind: 'structural', vote: 'supports', detail: 'API returns the new price' },
  { source: 'https://example.com/blog/b', kind: 'textual', vote: 'supports', detail: 'page shows the new price' },
] };
const mergeRule = ((await run('corroboration-kit', sameSite)).raw.groups ?? []).some((g) => g.merges.length > 0);
test('corroboration: two pages counted as one source say why', { skip: mergeRule ? false : 'installed corroboration-kit predates origin grouping (0.3.0); NOT_RUN' }, async () => {
  const result = await run('corroboration-kit', sameSite);
  const merge = result.raw.groups.flatMap((g) => g.merges)[0];
  const row = result.rows.find((r) => r.title === 'Counted as one source');
  assert.ok(row, `rows: ${titles(result)}`);
  assert.equal(row.detail, merge.explanation);
  assert.equal(row.mark, 'info');
});

test('corroboration: separate sources get no merge row', async () => {
  const result = await run('corroboration-kit', kitOf('corroboration-kit').presets[0].input);
  assert.ok(!titles(result).includes('Counted as one source'));
});

// ------------------------------------------------------------ accuracy claims
const counted = (claim, evidence = {}) => ({
  claim,
  evidence: { sample: { n: 1000, correct: 990 }, provenance: { source: 'human', raters: 2 }, sampling: 'random', ...evidence },
});
const accuracy = (display, value) => counted({ metric: 'accuracy', value, display });

test('accuracy: a figure above the interval is contradicted and names the top of the interval', async () => {
  const result = await run('accuracy-claim-kit', accuracy('99.5%', 0.995));
  assert.equal(result.tone, 'fail');
  assert.equal(result.raw.verdict, 'contradicted');
  assert.equal(result.rows[0].mark, 'bad');
  assert.match(result.rows[0].detail, /99\.456%/);
  assert.ok(result.rows[0].fix, 'a problem row offers a fix');
});

test('accuracy: a figure between the safe end and the observed rate is not called supported', async () => {
  const result = await run('accuracy-claim-kit', accuracy('98.5%', 0.985));
  assert.equal(result.raw.verdict, 'overstated');
  assert.equal(result.tone, 'warn');
  assert.match(result.rows[0].detail, /98\.169%.*990 of 1000/);
  assert.equal(result.viz.mark, 'warn');
});

test('accuracy: a supported figure is a pass whose graphic carries the interval', async () => {
  const result = await run('accuracy-claim-kit', accuracy('98%', 0.98));
  assert.equal(result.tone, 'pass');
  assert.ok(result.rows.every((r) => !r.fix || r.mark !== 'ok'));
  assert.ok(result.viz.claimed <= result.viz.interval.low && result.viz.interval.low < result.viz.interval.point, 'the claim sits at or below the safe end');
});

test('accuracy: an error rate is drawn as lower-is-better', async () => {
  const result = await run('accuracy-claim-kit', counted({ metric: 'error-rate', value: 0.01, display: '1%' }, { sample: { n: 1000, errors: 10 } }));
  assert.equal(result.raw.verdict, 'supported');
  assert.equal(result.viz.better, 'lower');
});

test('accuracy: labels from a model are refused, with no interval, a reason and a way out', async () => {
  const result = await run('accuracy-claim-kit', counted({ metric: 'accuracy', value: 0.98, display: '98%' }, { provenance: { source: 'model' } }));
  assert.equal(result.raw.verdict, 'refused');
  assert.equal(result.viz.interval, null);
  assert.equal(result.rows[0].mark, 'warn');
  assert.match(result.rows[0].fix, /label/);
  assert.equal(result.rows.at(-1).title, 'What you can say instead');
});

test('accuracy: a score that is not a proportion is refused and left off the scale', async () => {
  const result = await run('accuracy-claim-kit', counted({ metric: 'wer', value: 1.2, display: '120%' }));
  assert.equal(result.raw.verdict, 'refused');
  assert.equal(result.viz.claimed, null);
});

test('accuracy: a display that disagrees with its value is rejected, not judged', async () => {
  await assert.rejects(run('accuracy-claim-kit', accuracy('91%', 0.98)), /does not match/);
});

// -------------------------------------------------------------- number tracing
const traceInput = (n) => structuredClone(kitOf('number-trace-kit').presets[n].input);

test('numbers: an untraced number is a bad row that points at it and offers a fix', async () => {
  const result = await run('number-trace-kit', traceInput(0));
  assert.equal(result.tone, 'fail');
  const row = result.rows.find((r) => r.mark === 'bad');
  assert.equal(row.highlight, '45 days');
  assert.ok(row.title.includes('45 days'));
  assert.match(row.fix, /source/);
  assert.equal(result.headline, '1 of 3 numbers not found in the evidence.');
});

test('numbers: a rounded number says it matches the evidence once rounded', async () => {
  const result = await run('number-trace-kit', traceInput(1));
  const row = result.rows.find((r) => r.highlight === '8.3%');
  assert.equal(row.mark, 'ok');
  assert.match(row.detail, /Matches “\(8\.25%\)” in the evidence, rounded/);
  assert.equal(result.tone, 'pass');
});

test('numbers: a built figure is information that names what it was built from, and strict mode refuses it', async () => {
  const result = await run('number-trace-kit', traceInput(2));
  const row = result.rows.find((r) => r.highlight === '30%');
  assert.equal(row.mark, 'info');
  assert.match(row.detail, /percent change of “\$1,000\.00” and “\$1,299\.00”/);
  assert.match(result.headline, /stated in the evidence or built from it/);
  const strict = await run('number-trace-kit', { ...traceInput(2), mode: 'strict' });
  assert.equal(strict.tone, 'fail');
  assert.equal(strict.rows.find((r) => r.highlight === '30%').mark, 'bad');
});

test('numbers: rows that miss the printed total say by how much, and a null table skips the check', async () => {
  const off = await run('number-trace-kit', traceInput(3));
  assert.equal(off.tone, 'fail');
  assert.equal(off.headline, 'The rows do not add up to the printed total.');
  assert.match(off.rows.find((r) => r.mark === 'bad').detail, /sum to 1299\.00.*says 1299\.01.*0\.01 more/);
  const skipped = await run('number-trace-kit', traceInput(2));
  assert.ok(!skipped.rows.some((r) => /rows/.test(r.title)));
});

test('numbers: an answer with no digits is not called a pass', async () => {
  const result = await run('number-trace-kit', { ...traceInput(0), output: 'Revenue was five million dollars.', table: null });
  assert.equal(result.tone, 'info');
  assert.equal(result.rows[0].title, 'No numbers to check');
  assert.match(result.rows[0].detail, /written as words are not read/);
});

// ---------------------------------------------------------------------- parity
const parityInput = (n) => structuredClone(kitOf('parity-kit').presets[n].input);

test('parity: a drifted copy lists what is missing, extra and different, and the date that hides it', async () => {
  const result = await run('parity-kit', parityInput(0));
  assert.equal(result.tone, 'fail');
  assert.deepEqual(titles(result).slice(0, 4), [
    'business is missing from the copy',
    'enterprise is in the copy but not in the source',
    'team: priceUsd differs',
    'team: same review date, different data',
  ]);
  assert.equal(result.rows[2].detail, 'The source says 29. The copy says 25.');
  assert.equal(result.headline, 'The copy has drifted from its source in 3 places.');
  assert.equal(result.rows.at(-1).mark, 'skip', 'no earlier snapshot, so the date check is said to be skipped');
});

test('parity: a review date that moved on its own is flagged per record, with the dates', async () => {
  const result = await run('parity-kit', parityInput(1));
  assert.equal(result.tone, 'fail');
  const bad = result.rows.filter((r) => r.mark === 'bad');
  assert.equal(bad.length, 3);
  assert.equal(bad[0].detail, 'From 2026-04-01 to 2026-10-01. No value, source or reviewer changed.');
  assert.equal(result.rows[0].mark, 'ok', 'the copy itself still matches');
});

test('parity: a date that moved alongside a changed value passes', async () => {
  const result = await run('parity-kit', parityInput(2));
  assert.equal(result.tone, 'pass');
  assert.equal(result.raw.dates.stampOnly.length, 0);
});

test('parity: a misspelled date field is a warning, named once, not a pass', async () => {
  const input = parityInput(2);
  input.options.reviewedField = 'lastReviwed';
  const result = await run('parity-kit', input);
  assert.equal(result.tone, 'warn');
  assert.equal(titles(result).filter((t) => /lastReviwed appears in no record/.test(t)).length, 1);
});
