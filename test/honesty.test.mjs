import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { KITS, formatJson, encodeExample } from '../demos.mjs';
const kit = (id) => KITS.find((k) => k.id === `${id}-kit`);
const input = (id, n = 0) => structuredClone(kit(id).presets[n].input);
const run = async (id, value) => kit(id).run(await import(kit(id).id), value);
function snippetMatches(id, value, result) {
  const code = kit(id).snippet(value);
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(proc.status, result.tone === 'fail' ? 1 : 0, proc.stderr || proc.stdout);
  return proc.stdout;
}
test('HK02: contradictory wording overlap is labeled as a heuristic', async () => {
  const r = await run('grounding', { text: 'The warranty covers accidental damage for five years [[cite:e1]].', evidence: {e1:'The warranty does not cover accidental damage for five years.'} });
  assert.equal(r.tone, 'pass');
  assert.match(r.rows[0].detail, /wording.overlap/);
  assert.match(kit('grounding').limit, /contradictions.*numbers/);
  assert.doesNotMatch(JSON.stringify(r), /Backed by its citation/);
});
test('HK03: JSON formatting and generated inputs preserve strings and own keys', async () => {
  for (const v of [['a,b','a":b','</script>'], {x:'a":b', y:'a,b'}, JSON.parse('{"__proto__":"a,b","x":["a,b"]}')]) assert.deepEqual(JSON.parse(formatJson(v)), v);
  const value = {text:'Battery life reached 14 hours [[cite:__proto__]].', evidence:JSON.parse('{"__proto__":"Battery life reached 14 hours"}')};
  snippetMatches('grounding', value, await run('grounding', value));
});
test('HK04: unchanged invariance scenarios are unchecked in rows, headlines, graphics and CI', async () => {
  const values = [ ['payout-invariance', {...input('payout-invariance'), candidates:[{id:'x',score:90,payoutRateBps:0}]}], ['mutation-invariance', {...input('mutation-invariance'), zips:['68102']}] ];
  for (const [id,v] of values) {
    const r = await run(id,v);
    assert.equal(r.tone,'fail'); assert.match(r.headline,/did not change the input/);
    assert.ok(r.rows.some((row)=>row.mark==='skip' && /Scenario did not change the input/.test(row.detail)));
    assert.ok((r.viz.columns ?? r.viz.bars).some((v)=>v.vacuous));
    assert.match(snippetMatches(id,v,r),/not tested/);
  }
});
test('HK05: reference presence and supplied dates do not claim verification', async () => {
  const r=await run('claims-registry',{now:'2026-10-01',maxAgeDays:'90',claims:[{id:'x',text:'Guaranteed correct',evidenceRef:'TODO',verifiedAt:'2026-10-01'}]});
  assert.equal(r.tone,'pass'); assert.match(r.headline,/reference-presence and review-date rules/); assert.match(r.rows[0].detail,/Reported review date/); assert.match(kit('claims-registry').limit,/Does not inspect evidence/);
});
test('HK06: a failed count rule with an improving rate does not claim deterioration', async () => {
  const v=input('advice-ledger'); v.observations[4].state=v.observations[5].state='bad'; const r=await run('advice-ledger',v);
  assert.equal(r.tone,'fail'); assert.match(r.rows.at(-1).title,/failed the configured holding rules/); assert.match(r.rows.at(-1).detail,/refute threshold/); assert.doesNotMatch(JSON.stringify(r.rows),/got worse|More bad readings/);
  const equal=input('advice-ledger');equal.observations.forEach((o,i)=>o.state=(i===0||i===4)?'bad':'good');
  const held=await run('advice-ledger',equal);assert.equal(held.tone,'pass');assert.equal(held.raw.baseline.badRate,held.raw.result.badRate);assert.match(held.headline,/meets the configured holding rules/);
});
test('HK09: demo ranking and scoring reject malformed domains, including generated CI', async () => {
  for (const v of [ {...input('payout-invariance'), candidates:[{id:'x',score:'bad',payoutRateBps:0}]}, {...input('payout-invariance'), candidates:[{id:'',score:1,payoutRateBps:0}]}, {...input('payout-invariance'), candidates:[{id:'x',score:1,payoutRateBps:-1}]}, {...input('payout-invariance'), candidates:[{id:'x',score:1,payoutRateBps:0},{id:'x',score:2,payoutRateBps:0}]}, {...input('payout-invariance'), ranker:'unknown'} ]) {
    await assert.rejects(async()=>run('payout-invariance',v));
    if (v.ranker === 'unknown') assert.throws(() => kit('payout-invariance').snippet(v), /Choose a listed ranker/);
    else {
      const p=spawnSync(process.execPath,['--input-type=module','-e',kit('payout-invariance').snippet(v)],{encoding:'utf8'}); assert.notEqual(p.status,0);
    }
  }
  for (const v of [{...input('mutation-invariance'),applicant:{zip:'68102'}},{...input('mutation-invariance'),zips:[123]},{...input('mutation-invariance'),scorer:'unknown'}]) {
    await assert.rejects(async()=>run('mutation-invariance',v));
    if (v.scorer === 'unknown') assert.throws(() => kit('mutation-invariance').snippet(v), /Choose a listed scorer/);
    else {
      const p=spawnSync(process.execPath,['--input-type=module','-e',kit('mutation-invariance').snippet(v)],{encoding:'utf8'}); assert.notEqual(p.status,0);
    }
  }
  assert.match(readFileSync(new URL('../README.md',import.meta.url),'utf8'),/Input behavior is defined by each kit/);
});
test('HK10: all demo clocks reject calendar rollovers and invalid time ranges', async () => {
  for (const id of ['claims-registry','freshness']) for (const now of ['2026-02-30','2026-04-31','2025-02-29','2026-10-01T24:00:00Z','2026-10-01T12:00:00+24:00']) await assert.rejects(async()=>run(id,{...input(id),now}),/real calendar date/);
  const trust=KITS.find(k=>k.id==='trust-core'); await assert.rejects(async()=>trust.run(await import('trust-core'),{...trust.presets[0].input,now:'2026-02-30'}),/real calendar date/);
  await run('claims-registry',{...input('claims-registry'),now:'2024-02-29'});
});
test('HK11: audit-chain empty, missing target and null payloads match generated CI', async () => {
  for(const entries of [[],[null],[null,null]]) for(const tamper of ['Leave the log alone','Change a field in entry 1','Delete the last entry']) {
    const v={entries,tamper}; const r=await run('audit-chain',v); snippetMatches('audit-chain',v,r);
    if(!entries.length) assert.match(r.headline,/No entries or anchor to verify/);
    if(entries.length<2 && tamper==='Change a field in entry 1') assert.match(JSON.stringify(r.rows),/Tampering was not simulated: entry 1 does not exist/);
  }
});
test('HK12: explicit receipt IDs match in playground and CI', async () => {
  for(const packetId of ['pkt-demo','different']) {const v=input('agent-receipt',1);v.report.packetId=packetId;snippetMatches('agent-receipt',v,await run('agent-receipt',v));}
});
test('HK13: receipt verdicts describe reported actions', async () => {
  const bad=await run('agent-receipt',input('agent-receipt')); assert.match(bad.rows.find(r=>r.title.includes('submit-payment')).title,/Reported an unauthorized action/);
  const good=await run('agent-receipt',input('agent-receipt',1)); assert.match(good.rows[0].title,/Every reported action was authorized; every compared fact matched/);
});
test('HK14: spend copy describes an estimate, including equality', async () => {
  const v={rates:{inputPerMillion:0,outputPerMillion:0},budget:{spentSoFarUsd:25,ceilingUsd:25},nextCall:{inputTokens:0,outputTokens:0}};const r=await run('cost-governor',v);
  assert.equal(r.tone,'pass');assert.equal(r.headline,'The estimate fits the budget.');assert.match(r.summary,/at or below/);assert.match(kit('cost-governor').limit,/concurrent/);
});
test('HK15: identical moderate sentiment does not claim variation', async () => {
  const k=KITS.find(k=>k.id==='trust-core');const v=structuredClone(k.presets[0].input);v.reviews.forEach(r=>r.sentiment=0.4);const r=await k.run(await import('trust-core'),v);assert.match(r.rows[1].title,/extreme uniform-sentiment pattern was not flagged/);
});
test('HK16: oversized example encoding fails visibly', () => {
  assert.throws(()=>encodeExample(kit('grounding'),{text:'x'.repeat(12000),evidence:{}}),/This example is too large to share in a link/);
});
test('HK19: structural advice refusals omit unmeasured windows and explain repair', async () => {
  const v=input('advice-ledger');v.decision.recommendationId='other';const r=await run('advice-ledger',v);
  assert.match(r.headline,/supplied record could not be graded/);assert.ok(r.rows.some(r=>/decision.recommendationId/.test(r.fix)));assert.doesNotMatch(JSON.stringify(r.rows),/No readings|Collect more/);assert.equal(r.viz,null);
});
test('HK24: provenance repairs require real verification before metadata', async () => {
  const r=await run('provenance',input('provenance'));assert.match(r.rows[0].fix,/perform the verification.*record its source before setting/);assert.doesNotMatch(r.rows[0].fix,/move the claim to a tier/);
});

test('CI code names its warning policy and matches that policy on warning inputs', async () => {
  const ground = {...input('grounding',1),text:'A claim without a citation.'};
  const claims = {...input('claims-registry',1)};claims.claims.forEach(c=>c.verifiedAt='2025-01-01');
  const freshness = {...input('freshness')};freshness.pages=[{page:'Aging page',reviewedOn:'2026-08-10'}];
  const advice=input('advice-ledger');advice.decision.recommendationId='other';
  for(const [id,v,exit] of [['grounding',ground,1],['claims-registry',claims,1],['freshness',freshness,0],['advice-ledger',advice,0],['corroboration',input('corroboration',2),1]]) {
    const r=await run(id,v);assert.equal(r.tone,'warn');assert.match(kit(id).ciRule,/CI exits 1/);
    const proc=spawnSync(process.execPath,['--input-type=module','-e',kit(id).snippet(v)],{encoding:'utf8'});assert.equal(proc.status,exit,proc.stderr);
    assert.ok(kit(id).snippet(v).includes(kit(id).ciRule));
  }
});
test('clock normalization is disclosed and preserves the supplied date',async()=>{
  const value=input('claims-registry',1);const before=structuredClone(value);const r=await run('claims-registry',value);
  assert.deepEqual(value,before);assert.match(r.summary,/Clock used: 2026-10-01T00:00:00.000Z/);assert.match(r.summary,/Review window used: 90 days/);
});

test('supplied corroboration votes do not claim that evidence was inspected',async()=>{
  const r=await run('corroboration',input('corroboration'));assert.match(r.headline,/Supplied source votes support/);assert.match(kit('corroboration').limit,/does not inspect the evidence/);
});


test('review 1: failing preset headlines name the changed factor without vacuous noise', async () => {
  assert.equal((await run('payout-invariance', input('payout-invariance', 1))).headline, 'Rankings moved with payout in 2 of 3 scenarios.');
  assert.equal((await run('mutation-invariance', input('mutation-invariance', 1))).headline, 'The decision changed with zip code in 1 of 3 scenarios.');
  const vacuous = await run('mutation-invariance', {...input('mutation-invariance'), zips: ['68102']});
  assert.match(vacuous.headline, /1 scenario did not change the input and was not tested/);
});

test('review 2: ordinary snippet data is readable and validation follows imports', () => {
  for (const k of KITS) for (const preset of k.presets) {
    const code = k.snippet(preset.input);
    assert.ok(!code.includes('JSON.parse("'), k.id);
    const validation = /function (strictDate|validateCandidates|validateDecisionData|validateRanking|validateScoring)/.exec(code);
    if (validation) assert.ok(code.indexOf('import ') < validation.index, k.id);
    assert.doesNotMatch(code, /Choose a listed ranker|Choose a listed scorer|Ranks by quality score only|Looks at income only/);
  }
  assert.match(kit('grounding').snippet(input('grounding')), /const evidence = \{/);
});

test('review 2: nested own __proto__ keys retain JSON semantics in generated code', () => {
  const values = [
    JSON.parse('{"deep":{"__proto__":{"x":1}}}'),
    [JSON.parse('{"__proto__":"a,b"}')],
    {x: '__proto__ is only text'},
  ];
  for (const value of values) {
    const code = kit('grounding').snippet({text: 'x', evidence: value});
    const expression = code.match(/const evidence = ([\s\S]*?);\n/)[1];
    const proc = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(JSON.stringify(${expression}));`], {encoding: 'utf8'});
    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(JSON.parse(proc.stdout), value);
  }
});

test('review 5: not-holding rows name only the failing rule', async () => {
  const value = input('advice-ledger');
  value.observations[4].state = value.observations[5].state = 'bad';
  const count = await run('advice-ledger', value);
  assert.notEqual(count.rows.at(-1).detail, count.summary);
  assert.match(count.rows.at(-1).detail, /refute threshold/);
  const rate = input('advice-ledger');
  rate.observations.forEach((o, i) => o.state = i === 0 || i === 4 ? 'bad' : 'good');
  rate.observations.pop();
  const worse = await run('advice-ledger', rate);
  assert.equal(worse.tone, 'fail');
  assert.match(worse.rows.at(-1).detail, /bad rate.*higher/);
  assert.notEqual(worse.rows.at(-1).detail, worse.summary);
});
