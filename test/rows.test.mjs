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
