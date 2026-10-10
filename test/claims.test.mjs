// Public claims: every count, license, privacy and provenance sentence in the
// README, the page and the generated metadata must match the source. Counts are
// derived (KITS, presets, the installed kit packages, and the honesty-mcp source
// when it is on disk); nothing here hard-codes a number. If someone edits a
// sentence so it drifts from the code, or adds a count this file cannot place,
// the test fails.
//
// honesty-mcp lives in a separate repository. Its checks need that source: set
// HONESTY_MCP_DIR, or keep it next to this repo (../honesty-mcp) or at
// ~/honesty-mcp. When it is not found those checks are skipped, not passed
// (see the skip messages), so CI without the sibling repo does not enforce them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KITS, GROUPS } from '../demos.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');

// ------------------------------------------------------------------ derived facts
const KIT_IDS = KITS.map((k) => k.id);
const EXAMPLES = KITS.reduce((n, k) => n + k.presets.length, 0);

function findMcpDir() {
  const candidates = [process.env.HONESTY_MCP_DIR, path.join(root, '../honesty-mcp'), path.join(homedir(), 'honesty-mcp')].filter(Boolean);
  return candidates.find((dir) => existsSync(path.join(dir, 'src/server.ts')) && existsSync(path.join(dir, 'package.json')));
}
const MCP_DIR = findMcpDir();
const mcpSkip = MCP_DIR ? false : 'honesty-mcp source not found (set HONESTY_MCP_DIR); NOT_RUN';

/** What the honesty-mcp source says it registers and which of our kits it wraps. */
function mcpFacts() {
  const server = readFileSync(path.join(MCP_DIR, 'src/server.ts'), 'utf8');
  const toolFiles = [...server.matchAll(/from "\.\/tools\/([A-Za-z]+)\.js"/g)].map((m) => m[1]);
  const tools = new Set();
  const kitsInSource = new Set();
  for (const file of toolFiles) {
    const src = readFileSync(path.join(MCP_DIR, `src/tools/${file}.ts`), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) tools.add(m[1]);
    for (const id of KIT_IDS) if (new RegExp(`["']${id}["']`).test(src)) kitsInSource.add(id);
  }
  const deps = Object.keys(JSON.parse(readFileSync(path.join(MCP_DIR, 'package.json'), 'utf8')).dependencies ?? {});
  const kitsInDeps = KIT_IDS.filter((id) => deps.includes(id));
  return { tools: [...tools], kitsInSource: [...kitsInSource].sort(), kitsInDeps: kitsInDeps.sort() };
}

// ------------------------------------------------------------------ text surfaces
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const toNumber = (w) => (/^\d+$/.test(w) ? Number(w) : WORDS[w.toLowerCase()]);

/** Plain text of an HTML document: no styles, scripts or tags; entities for the few we use. */
function htmlText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
const metaContent = (html, attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1] ?? '';

/**
 * Build into a scratch directory so this file never races build.test.mjs, which
 * owns dist/. Returns the built index.html.
 */
function buildScratch() {
  const out = mkdtempSync(path.join(tmpdir(), 'honesty-kits-claims-'));
  try {
    execFileSync(process.execPath, ['tools/build.mjs'], { cwd: root, stdio: 'pipe', env: { ...process.env, HONESTY_KITS_OUT: out } });
    return readFileSync(path.join(out, 'index.html'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
const built = buildScratch();
const jsonLd = JSON.parse(built.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);

/** Every file whose sentences the public can read, as [name, text]. */
const SURFACES = [
  ['README.md', read('README.md')],
  ['src/page.html', htmlText(read('src/page.html')) + metaContent(read('src/page.html'), 'name', 'description')],
  ['built index.html (visible text)', htmlText(built)],
  ['built JSON-LD description', jsonLd.description],
  ['built og:description', metaContent(built, 'property', 'og:description')],
  ['app.mjs', read('app.mjs')],
  ['demos.mjs (comments and kit copy)', read('demos.mjs')],
];

// ------------------------------------------------------------------ count phrases
// A count phrase is "<number> [of the|these [<number>]] <kits|examples|presets|packages|tools>",
// a pronoun count ("eleven of them", "the other two (", "three ES modules"), or any other
// spelled-out number in the prose. Each is checked against a derived value; one this file
// cannot place fails, so a new number cannot slip into the copy untested.
const COUNT = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b(\s+of\s+(?:the|these|those))?\s+(?:(\d+)\s+)?(kits|examples|presets|packages|tools)\b/gi;

const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
const PRONOUN = new RegExp(`\\b${NUM}\\s+of\\s+(?:them|those|these)\\b`, 'gi');
const OTHER_TWO = new RegExp(`\\bthe other ${NUM}\\s*\\(`, 'gi');
const MODULES = new RegExp(`\\b${NUM}\\s+ES modules\\b`, 'gi');
const SPELLED = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi;

function countClaims(text) {
  const claims = [];
  for (const m of text.matchAll(PRONOUN)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const before = text.slice(Math.max(0, m.index - 120), m.index);
    const kind = /^\s+run the check/.test(after) ? 'mcp-checking'
      : /^\s+hand you starter code/.test(after) ? 'mcp-scaffold'
      : /honesty-mcp|tools for/i.test(before) ? 'mcp-wrapped' : 'unplaced';
    claims.push({ phrase: m[0], kind, n: toNumber(m[1]), at: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(OTHER_TWO)) claims.push({ phrase: m[0], kind: 'mcp-scaffold', n: toNumber(m[1]), at: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(MODULES)) claims.push({ phrase: m[0], kind: 'modules', n: toNumber(m[1]), at: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(COUNT)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    const noun = m[4].toLowerCase();
    const n = toNumber(m[1]);
    if (m[2]) {
      // "has tools for eleven of the 12 kits": the first number is how many kits honesty-mcp covers.
      claims.push({ phrase: m[0], kind: noun === 'kits' && /(?:wraps|tools for)\s*$/.test(before) ? 'mcp-wrapped' : 'unplaced', n, at: m.index, end: m.index + m[0].length });
      if (m[3]) claims.push({ phrase: m[0], kind: noun === 'kits' ? 'kits' : 'unplaced', n: Number(m[3]), at: m.index, end: m.index + m[0].length });
    } else {
      claims.push({ phrase: m[0], kind: { kits: 'kits', examples: 'examples', presets: 'examples', packages: 'packages', tools: 'mcp-tools' }[noun], n, at: m.index, end: m.index + m[0].length });
    }
  }
  return claims;
}

function expectedCount(kind) {
  if (kind === 'kits') return KITS.length;
  if (kind === 'packages') return KITS.length + 1; // the kits plus honesty-mcp
  if (kind === 'examples') return EXAMPLES;
  if (kind === 'modules') {
    // The page's own ES modules are the .mjs files tools/build.mjs copies next to index.html.
    const list = read('tools/build.mjs').match(/for \(const file of \[([^\]]*\.mjs[^\]]*)\]\) copyFileSync/)?.[1] ?? '';
    return (list.match(/\.mjs/g) ?? []).length;
  }
  if (!MCP_DIR) return undefined; // cannot be checked without the honesty-mcp source
  const facts = mcpFacts();
  if (kind === 'mcp-wrapped') return facts.kitsInDeps.length;
  if (kind === 'mcp-tools') return facts.tools.length;
  const scaffolds = facts.tools.filter((t) => t.startsWith('scaffold_')).length;
  if (kind === 'mcp-scaffold') return scaffolds;
  if (kind === 'mcp-checking') return facts.kitsInDeps.length - scaffolds;
  return undefined;
}

/** Problems found in one surface; the mutation checks reuse this. */
export function countProblems(name, text, { prose = true } = {}) {
  const problems = [];
  const claims = countClaims(text);
  // Prose must not carry a spelled-out number that no pattern above placed.
  if (prose) {
    for (const m of text.matchAll(SPELLED)) {
      if (!claims.some((c) => m.index >= c.at && m.index < c.end)) problems.push(`${name}: cannot place the number in "${text.slice(Math.max(0, m.index - 25), m.index + 30).replace(/\s+/g, ' ')}"`);
    }
  }
  for (const c of claims) {
    if (c.kind === 'unplaced') { problems.push(`${name}: cannot place the count in "${c.phrase}"`); continue; }
    const expected = expectedCount(c.kind);
    if (expected === undefined) continue; // honesty-mcp source absent: skipped, see the dedicated test
    if (c.n !== expected) problems.push(`${name}: "${c.phrase}" says ${c.n} but the source says ${expected} (${c.kind})`);
  }
  return problems;
}

test('the number of kits, examples and packages matches the source', () => {
  assert.equal(new Set(KIT_IDS).size, KIT_IDS.length, 'kit ids are unique');
  assert.ok(KITS.length > 0 && EXAMPLES >= KITS.length, 'every kit has at least one example');
  const problems = SURFACES.flatMap(([name, text]) => countProblems(name, text, { prose: !/\.mjs/.test(name) }));
  assert.deepEqual(problems, []);
});

test('the README states the kit count and the honesty-mcp relationship in the exact words the source supports', () => {
  const readme = SURFACES[0][1];
  assert.ok(readme.includes(`There are ${KITS.length} kits`), `README says "There are ${KITS.length} kits"`);
  assert.ok(readme.includes('Plus honesty-mcp, a separate package'), 'README names honesty-mcp as a separate package');
  assert.ok(jsonLd.description.includes(`all ${KITS.length} kits`), 'JSON-LD description counts the kits');
  assert.ok(!/\b(13|thirteen)\s+kits\b/i.test(readme) && !/\b(12|twelve)\s+packages\b/i.test(readme), 'no bare 13 kits or 12 packages');
});

test('honesty-mcp: the "tools for N of the kits" numbers match its source', { skip: mcpSkip }, () => {
  const facts = mcpFacts();
  assert.deepEqual(facts.kitsInSource, facts.kitsInDeps, 'the kits its tools import match its dependencies');
  const wrapped = facts.kitsInDeps.length;
  assert.ok(wrapped > 0 && wrapped < KITS.length, 'wraps some but not all kits');
  assert.ok(facts.tools.length >= wrapped, 'at least one tool per wrapped kit');
  for (const [name, text] of SURFACES) {
    for (const c of countClaims(text).filter((x) => x.kind === 'mcp-wrapped')) assert.equal(c.n, wrapped, `${name}: "${c.phrase}"`);
  }
  // At least the README and the page dialog actually state it, so this cannot pass by saying nothing.
  for (const [name, text] of SURFACES.filter(([n]) => ['README.md', 'src/page.html'].includes(n))) {
    assert.ok(countClaims(text).some((x) => x.kind === 'mcp-wrapped'), `${name} states how many kits honesty-mcp wraps`);
  }
  const notWrapped = KIT_IDS.filter((id) => !facts.kitsInDeps.includes(id));
  assert.equal(notWrapped.length, KITS.length - wrapped);
  // The split between kits that run a check and kits that only get a scaffold tool (starter code).
  const scaffolds = new Set(facts.tools.filter((t) => t.startsWith('scaffold_')));
  const checking = wrapped - scaffolds.size;
  const wordFor = (n) => Object.keys(WORDS).find((w) => WORDS[w] === n);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  assert.ok(SURFACES[0][1].includes(`${cap(wordFor(checking))} of them run the check`), `README says ${wordFor(checking)} of the tools run a check`);
  assert.ok(SURFACES[0][1].includes(`the other ${wordFor(scaffolds.size)} (`), `README says ${wordFor(scaffolds.size)} tools are scaffolds`);
  assert.ok(SURFACES[1][1].includes(`${wordFor(scaffolds.size)} of them hand you starter code`), `the page says ${wordFor(scaffolds.size)} are scaffolds`);
});

// ------------------------------------------------------------------ README and page agree with KITS
test('the README lists every kit once, under its group, linked to the playground', () => {
  const readme = SURFACES[0][1];
  const headings = [...readme.matchAll(/^### (.+)$/gm)].map((m) => ({ title: m[1], at: m.index }));
  assert.deepEqual(headings.slice(0, GROUPS.length).map((h) => h.title), GROUPS, 'README group headings match GROUPS in order');
  const seen = [];
  for (const [i, h] of headings.slice(0, GROUPS.length).entries()) {
    const section = readme.slice(h.at, headings[i + 1]?.at ?? readme.length);
    const rows = [...section.matchAll(/^\| \[([a-z-]+)\]\(https:\/\/github\.com\/[^/)]+\/([a-z-]+)\) \|.*\[playground\]\(https:\/\/lkopietz3-byte\.github\.io\/honesty-kits\/#([a-z-]+)\) \|$/gm)];
    for (const [, label, repo, anchor] of rows) {
      assert.ok(label === repo && repo === anchor, `README row ${label} links to its own repo and playground anchor`);
      seen.push(label);
      assert.equal(KITS.find((k) => k.id === label)?.group, h.title, `${label} is under "${h.title}"`);
    }
  }
  assert.deepEqual([...seen].sort(), [...KIT_IDS].sort(), 'every kit appears in the README table exactly once');
});

test('every kit shows what it does not check', () => {
  for (const kit of KITS) {
    assert.ok(typeof kit.limit === 'string' && kit.limit.length > 20, `${kit.id} has a limit note`);
    assert.ok(typeof kit.question === 'string' && kit.question.endsWith('?'), `${kit.id} has a question`);
  }
});

// ------------------------------------------------------------------ license, dependencies, network
test('license claims: MIT in LICENSE, the README, the JSON-LD and every installed kit', () => {
  assert.match(read('LICENSE'), /^MIT License/m, 'LICENSE is MIT');
  assert.match(SURFACES[0][1], /^MIT licensed\.$/m, 'README closes with "MIT licensed."');
  assert.match(SURFACES[0][1], /MIT licensed, with zero runtime dependencies/, 'README says the kits are MIT licensed');
  assert.equal(jsonLd.license, 'https://opensource.org/licenses/MIT');
  for (const kit of KITS) {
    const pkg = JSON.parse(read(`node_modules/${kit.id}/package.json`));
    assert.equal(pkg.license, 'MIT', `${kit.id} declares MIT`);
  }
});

test('"zero runtime dependencies, plain ESM with types": true of every installed kit', () => {
  for (const kit of KITS) {
    const pkg = JSON.parse(read(`node_modules/${kit.id}/package.json`));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], `${kit.id} has no runtime dependencies`);
    assert.equal(pkg.type, 'module', `${kit.id} is ESM`);
    assert.ok(pkg.types || pkg.exports, `${kit.id} ships types`);
    const readme = read(`node_modules/${kit.id}/README.md`);
    assert.match(readme, /^#{1,4} .*limit/im, `${kit.id} README has a limits section`);
  }
});

// A static scan, not a proof: it reads each kit's published JavaScript for the browser
// and Node network APIs. It backs "no network calls" only as far as these names go.
test('"no network calls": no installed kit contains a network API', () => {
  const NETWORK = /(?<![\w.$])(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\s*\.\s*sendBeacon)|node:(?:http|https|http2|net|tls|dgram|dns|child_process)\b|from\s*['"](?:http|https|net|tls|dgram|dns|child_process)['"]/;
  const scan = (dir, kit) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file, kit);
      else if (/\.js$/.test(entry.name)) {
        const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$/gm, '$1');
        assert.ok(!NETWORK.test(code), `${kit}: ${path.relative(root, file)} references a network API`);
      }
    }
  };
  for (const kit of KITS) scan(path.join(root, 'node_modules', kit.id, 'dist'), kit.id);
});

test('the playground code itself makes no network request of its own to other sites', () => {
  for (const file of ['app.mjs', 'demos.mjs', 'viz.mjs']) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$/gm, '$1');
    assert.ok(!/(?<![\w.$])(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/.test(code), `${file} has no fetch, XHR, WebSocket, EventSource or beacon`);
  }
  // The one dynamic import loads the kit from the same site when the build says so
  // (the kit-base meta), and from jsDelivr only on the unbuilt page.
  assert.match(built, /<meta name="kit-base" content="\.\/kits\/">/);
  assert.ok(!/cdn\.jsdelivr\.net|fonts\.googleapis\.com/.test(built), 'the built page names no CDN');
});

// ------------------------------------------------------------------ wording
// Quoted examples of overclaiming copy ("independently verified") are mentions, not claims.
const stripQuoted = (text) => text.replace(/"[^"\n]{1,60}"|“[^”\n]{1,60}”/g, ' ');

const BANNED = [
  [/\bcertif(?:ied|ication|ifications|ies|y)\b/i, 'certification claim'],
  [/\bfraud\b/i, 'fraud-detection claim'],
  [/\bfake\s+reviews?\b/i, 'fake-review claim'],
  [/\bguarantee[sd]?\b/i, 'guarantee'],
  [/\bverified\b/i, '"verified" claim'],
  [/\btamper[- ]proof\b|\bunhackable\b|\b100%\s+(?:accurate|secure|safe)\b/i, 'absolute security or accuracy claim'],
  [/\b(?:with|signed|attested|have|has)\s+(?:build\s+)?provenance\b|\bpublished from github\b/i, 'provenance claim about packages (six of 13 have none)'],
];
const BRITISH = /\b(colour|behaviour|licence|favour|honour|centre|organis(?:e|ed|ing|ation)|catalogue|grey|analyse|cancelled|labelled|travelling|optimis(?:e|ed|ing))\w*\b/i;

/** Wording problems in one surface; the mutation checks reuse this. */
export function wordingProblems(name, text) {
  const problems = [];
  if (/—/.test(text)) problems.push(`${name}: contains an em dash`);
  const brit = text.match(BRITISH);
  if (brit) problems.push(`${name}: British spelling "${brit[0]}"`);
  const prose = stripQuoted(text);
  for (const [re, label] of BANNED) {
    const hit = prose.match(re);
    if (hit) problems.push(`${name}: ${label} ("${hit[0]}")`);
  }
  return problems;
}

test('public copy has no em dashes, British spellings or claims the code does not back', () => {
  // The kit-facing copy in demos.mjs is the kit names, questions and limits; the preset
  // inputs are deliberately written as the overclaiming text the kits are meant to flag.
  const kitCopy = KITS.map((k) => `${k.name}. ${k.question} ${k.limit}`).join('\n');
  const surfaces = [...SURFACES.filter(([n]) => !n.startsWith('demos.mjs')), ['kit names, questions and limits', kitCopy]];
  const problems = surfaces.flatMap(([name, text]) => wordingProblems(name, text));
  assert.deepEqual(problems, []);
});

test('the wording checks catch what they are meant to catch', () => {
  assert.ok(wordingProblems('x', 'It is certified and guaranteed.').length >= 2);
  assert.ok(wordingProblems('x', 'Our colour choice — bold.').length === 2);
  assert.ok(wordingProblems('x', 'All packages are published with provenance.').length === 1);
  assert.deepEqual(wordingProblems('x', 'Does it say "independently verified" without a source?'), []);
  assert.ok(countProblems('x', 'Try all 99 kits.').length === 1);
  assert.ok(countProblems('x', 'It has 13 kits.').length === 1);
  assert.ok(countProblems('x', 'It has 12 packages.').length === 1);
  assert.ok(countProblems('x', 'Pick from 7777 examples.').length === 1);
  if (MCP_DIR) assert.ok(countProblems('x', 'honesty-mcp has tools for ten of them.').length === 1, 'a pronoun count is checked');
  assert.ok(countProblems('x', 'It is a thing, and there are ten of them.').length === 1, 'a pronoun count with no context is unplaced');
  assert.ok(countProblems('x', 'The page has seven ES modules.').length === 1, 'an ES module count is checked');
  assert.ok(countProblems('x', 'There are twelve of something.').length === 1, 'an unplaced spelled-out number fails');
  assert.deepEqual(countProblems('x', `Try all ${KITS.length} kits and ${KITS.length + 1} packages and ${EXAMPLES} examples.`), []);
});
