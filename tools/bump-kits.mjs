// Move kits to new published versions everywhere the site pins them:
// demos.mjs (what the page loads), package.json devDependencies (what the
// tests run and the build copies) and package-lock.json (what `npm ci`
// installs in the deploy). The test suite asserts the first two match; this
// runs `npm install` to refresh the lockfile and node_modules, then checks
// npm's signatures.
//
//   node tools/bump-kits.mjs grounding-kit@0.2.1 trust-core@0.2.1 ...
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const specs = process.argv.slice(2).map((s) => {
  const at = s.lastIndexOf('@');
  if (at <= 0) throw new Error(`expected <kit>@<version>, got ${s}`);
  return { id: s.slice(0, at), version: s.slice(at + 1) };
});
if (!specs.length) throw new Error('usage: node tools/bump-kits.mjs <kit>@<version> ...');

let demos = readFileSync('demos.mjs', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const { id, version } of specs) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version ${version}`);
  const re = new RegExp(`(id: '${id}',\\n\\s+version: ')[^']+(')`);
  if (!re.test(demos)) throw new Error(`no demo entry for ${id}`);
  demos = demos.replace(re, `$1${version}$2`);
  if (id in (pkg.devDependencies ?? {})) pkg.devDependencies[id] = version;
  console.log(`${id} -> ${version}`);
}
writeFileSync('demos.mjs', demos);
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--no-fund', '--no-audit'], { stdio: 'inherit' });
execFileSync(npm, ['audit', 'signatures'], { stdio: 'inherit' });
