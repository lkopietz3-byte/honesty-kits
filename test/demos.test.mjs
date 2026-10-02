// Runs every playground preset against the same kit versions the site loads
// from jsDelivr (pinned in package.json), and checks the verdict each preset
// is meant to show. If a kit's behavior or output shape changes, this fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { KITS, MCP, mcpLinks, reportMarkdown, formatJson } from '../demos.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const EXPECTED = {
  'grounding-kit': ['fail', 'pass'],
  'provenance-kit': ['fail', 'pass'],
  'corroboration-kit': ['pass', 'fail', 'warn'],
  'claims-registry-kit': ['fail', 'pass'],
  'freshness-kit': ['fail'],
  'payout-invariance-kit': ['pass', 'fail'],
  'mutation-invariance-kit': ['pass', 'fail'],
  'advice-ledger-kit': ['pass', 'fail'],
  'trust-core': ['pass', 'warn', 'info'],
  'agent-receipt-kit': ['fail', 'pass'],
  'audit-chain-kit': ['pass', 'fail'],
  'cost-governor-kit': ['pass', 'fail'],
};

test('every kit has a demo and pins the version the tests install', () => {
  assert.deepEqual(KITS.map((k) => k.id).sort(), Object.keys(EXPECTED).sort());
  for (const k of KITS) assert.equal(k.version, pkg.devDependencies[k.id], `${k.id} version`);
});

for (const kit of KITS) {
  test(`${kit.id}: presets show their intended verdicts`, async () => {
    const mod = await import(kit.id);
    const tones = [];
    for (const preset of kit.presets) {
      const result = await kit.run(mod, structuredClone(preset.input));
      assert.ok(result.headline && result.rows.length > 0, `${preset.label} has a headline and rows`);
      for (const row of result.rows) {
        assert.ok(['ok', 'bad', 'warn', 'info', 'skip'].includes(row.mark), `${preset.label} row mark`);
        assert.ok(row.title && !row.title.includes('undefined'), `${preset.label} row title: ${row.title}`);
        assert.ok(!String(row.detail ?? '').includes('undefined') && !String(row.detail ?? '').includes('?'), `${preset.label} row detail: ${row.detail}`);
      }
      tones.push(result.tone);
    }
    assert.deepEqual(tones, EXPECTED[kit.id]);
  });
}

test('bad input surfaces the kit’s own error instead of a fake result', async () => {
  const grounding = KITS.find((k) => k.id === 'grounding-kit');
  await assert.rejects(async () => grounding.run(await import('grounding-kit'), { text: 'x [[cite:e1]].', evidence: new Map() }));
  const claims = KITS.find((k) => k.id === 'claims-registry-kit');
  await assert.rejects(async () => claims.run(await import('claims-registry-kit'), { ...claims.presets[0].input, now: '2026-10-01T12:00:00' }), /zone/);
});

test('MCP install links use the documented formats', () => {
  const links = mcpLinks((s) => Buffer.from(s).toString('base64'));
  assert.equal(links.claudeCode, 'claude mcp add honesty-mcp -- npx -y honesty-mcp');
  const cursor = new URL(links.cursor);
  assert.equal(cursor.protocol, 'cursor:');
  assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get('config'), 'base64').toString()), MCP.config);
  const vscode = new URL(links.vscode);
  assert.equal(vscode.origin + vscode.pathname, 'https://insiders.vscode.dev/redirect/mcp/install');
  assert.deepEqual(JSON.parse(vscode.searchParams.get('config')), MCP.config);
  assert.deepEqual(JSON.parse(links.configJson).mcpServers['honesty-mcp'], MCP.config);
});

const VIZ = {
  'grounding-kit': 'threads', 'corroboration-kit': 'needle', 'claims-registry-kit': 'timeline', 'freshness-kit': 'timeline',
  'payout-invariance-kit': 'slope', 'mutation-invariance-kit': 'bars', 'advice-ledger-kit': 'bars', 'trust-core': 'dial',
  'agent-receipt-kit': 'lanes', 'audit-chain-kit': 'chain', 'cost-governor-kit': 'budget', 'provenance-kit': null,
};

test('each result carries its graphic data and a fix for every problem', async () => {
  for (const kit of KITS) {
    const mod = await import(kit.id);
    for (const preset of kit.presets) {
      const result = await kit.run(mod, structuredClone(preset.input));
      assert.equal(result.viz?.type ?? null, VIZ[kit.id], `${kit.id} ${preset.label} viz`);
      if (result.tone === 'fail' || result.tone === 'warn') assert.ok(result.rows.some((r) => r.fix), `${kit.id} ${preset.label} offers at least one fix`);
      for (const row of result.rows) if (row.fix) assert.ok(row.mark !== 'ok', `${kit.id} ${preset.label}: fix only on problem rows`);
      const md = reportMarkdown(kit, result);
      assert.ok(md.startsWith(`**${kit.id}@${kit.version}: `) && md.includes('What it does not check'), `${kit.id} report`);
    }
  }
});

test('every generated snippet runs against the real kit and exits like the playground verdict', async () => {
  const dir = new URL('./.snippets/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  try {
    for (const kit of KITS) {
      const mod = await import(kit.id);
      for (const [i, preset] of kit.presets.entries()) {
        const result = await kit.run(mod, structuredClone(preset.input));
        const file = new URL(`${kit.id}-${i}.mjs`, dir);
        writeFileSync(file, kit.snippet(structuredClone(preset.input)));
        const run = spawnSync(process.execPath, [file.pathname], { encoding: 'utf8' });
        assert.ok(run.status === 0 || run.status === 1, `${kit.id} ${preset.label} crashed: ${run.stderr}`);
        if (result.tone === 'pass') assert.equal(run.status, 0, `${kit.id} ${preset.label} should exit 0`);
        if (result.tone === 'fail') assert.equal(run.status, 1, `${kit.id} ${preset.label} should exit 1`);
        assert.ok(run.stdout.trim().length > 0, `${kit.id} ${preset.label} prints something`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatJson output is valid JSON for every preset', () => {
  for (const kit of KITS) for (const preset of kit.presets) for (const value of Object.values(preset.input)) {
    if (typeof value === 'object') assert.deepEqual(JSON.parse(formatJson(value)), value);
  }
});
