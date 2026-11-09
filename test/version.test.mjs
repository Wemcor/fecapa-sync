import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_USER_AGENT, VERSION } from '../dist/index.js';

test('VERSION matches package.json and appears in the default User-Agent', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(DEFAULT_USER_AGENT, `fecapa-sync/${pkg.version} (+https://github.com/jmedinafruitos/fecapa-sync)`);
});
