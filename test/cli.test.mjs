import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from './sync-helpers.mjs';

// These tests never reach the network: they cover usage, config errors,
// status (local files only) and runs that stop before any request.
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const run = async (args, cwd) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FECAPA_SIDGAD_TOKEN: '' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

const writeConfig = (dir, config) => {
  const file = path.join(dir, 'fecapa-sync.config.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
};

test('package.json exposes the fecapa-sync bin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin['fecapa-sync'], './dist/cli.js');
  assert.match(readFileSync(CLI, 'utf8'), /^#!\/usr\/bin\/env node/);
});

test('usage errors exit 2', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['export'])).code, 2);
  assert.equal((await run(['sync', '--nope'])).code, 2);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /init/);
});

test('init without a config file writes a template and makes no request', async () => {
  const dir = tempDir();
  const result = await run(['init'], dir);
  assert.equal(result.code, 0);
  const config = JSON.parse(readFileSync(path.join(dir, 'fecapa-sync.config.json'), 'utf8'));
  assert.deepEqual(config.scope.leagues, [4811]);
  assert.equal(config.token, null);
  assert.equal(existsSync(path.join(dir, 'fecapa-data')), false);
});

test('an invalid config exits 2 with a clear message', async () => {
  const dir = tempDir();
  const file = writeConfig(dir, { scope: { leagues: [4811] }, levels: { games: true, teams: true } });
  const result = await run(['sync', '--config', file]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /"teams" \(0\.3\)/);
});

test('status reads the local store and exits 0', async () => {
  const dir = tempDir();
  const file = writeConfig(dir, { season: '2026/2027', scope: { leagues: [4811] }, levels: { actas: true } });
  const result = await run(['status', '--config', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /season 2026\/2027/);
  assert.match(result.stdout, /league 4811: 0 games/);
  assert.match(result.stdout, /levels\.games turned on/);
  const json = await run(['status', '--config', file, '--json']);
  assert.equal(JSON.parse(json.stdout).refresh.games, '24h');
});

test('sync during a backoff makes no request, prints why and exits 0', async () => {
  const dir = tempDir();
  const file = writeConfig(dir, { season: '2026/2027', dataDir: './store', scope: { leagues: [4811] } });
  mkdirSync(path.join(dir, 'store'));
  const until = new Date(Date.now() + 3_600_000).toISOString();
  writeFileSync(path.join(dir, 'store', 'state.json'), JSON.stringify({
    version: 1, seasons: {}, lastRun: null,
    backoff: { failures: 1, until, lastError: { code: 'HTTP_ERROR', message: 'HTTP 503' } },
  }));
  const result = await run(['sync', '--config', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /skipped \(backoff\), 0 requests/);
  assert.match(result.stdout, new RegExp(`no requests before ${until}`));
});

test('sync exits 1 when the run fails', async () => {
  const dir = tempDir();
  const file = writeConfig(dir, { season: '2026/2027', dataDir: './store', scope: { leagues: [4811] } });
  mkdirSync(path.join(dir, 'store'));
  writeFileSync(path.join(dir, 'store', 'state.json'), '{ broken');
  const result = await run(['sync', '--config', file]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /STORE_CORRUPT/);
});
