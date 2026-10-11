import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('review 5: cached verification reuses byte-matching fixtures', {skip: !process.env.HONESTY_KIT_ROOT}, () => {
  // This optional preparation path runs in the documented cached-fixture profile.
  // Ordinary npm-ci runs test installed packages and do not require this helper.
  const prepare = () => execFileSync('python3', ['tools/prepare-cached-kits.py'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(prepare(), prepare());
});
