import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ACTA_MAX_ATTEMPTS, createSync } from '../dist/index.js';
import { json } from './helpers.mjs';
import {
  actaPath, calendarBody, DAY, fakeApi, fakeClock, gamesFile, hasActa, HOUR, readJsonFile, reportBody, snapshot, stateFile, tempDir, testSync,
} from './sync-helpers.mjs';

const NOW = '2026-11-09T12:00:00.000Z';
const BASE_GAMES = [
  { id: 900501, date: '2026-11-01', time: '12:30', home: 900101, away: 900102 },
  { id: 900502, date: '2026-11-08', time: '17:00', home: 900102, away: 900103 },
  { id: 900503, date: '2026-11-15', time: '10:00', home: 900103, away: 900101 },
  { id: 900504, date: null, home: 900104, away: 900101 },
];
const CONFIG = { season: '2026/2027', scope: { leagues: [4811] }, levels: { games: true, actas: true } };

function setup({ games = BASE_GAMES, config = CONFIG, reports = { 900501: reportBody(900501) } } = {}) {
  const clock = fakeClock(NOW);
  const api = fakeApi({ calendars: { 4811: calendarBody(games) }, reports });
  const { sync, dataDir } = testSync(config, { api, clock });
  return { clock, api, sync, dataDir };
}

test('a first run fills the store: games, final actas and state', async () => {
  const { sync, api, dataDir } = setup();
  const result = await sync.init();
  assert.equal(result.status, 'ok');
  assert.equal(result.requests, 3); // calendar + the two games already played
  assert.deepEqual(api.calls.map((url) => new URL(url).pathname.split('/').at(-2) + ':' + new URL(url).searchParams.get('id')),
    ['calendar:4811', 'report:900501', 'report:900502']);

  const file = gamesFile(dataDir, 4811);
  assert.deepEqual(Object.keys(file.games).sort(), ['900501', '900502', '900503', '900504']);
  const game = file.games['900501'];
  assert.equal(game.startsAt, '2026-11-01T11:30:00.000Z');
  assert.equal(game.phaseName, 'LLIGA PROVA 1');
  assert.equal(game.firstSeenAt, NOW);
  assert.equal(game.updatedAt, NOW);
  assert.deepEqual([game.history, game.rescheduled, game.removedAt], [[], false, null]);
  // A game without a date is kept, and no acta is asked for it.
  assert.equal(file.games['900504'].date, null);

  const acta = readJsonFile(actaPath(dataDir, 900501));
  assert.equal(acta.matchId, 900501);
  assert.equal(acta.homeScore, 3);
  assert.equal(acta.home.length, 2);
  assert.equal(acta.away.length, 2);
  assert.deepEqual(acta.home.map((p) => p.isGoalkeeper), [true, false]);
  assert.deepEqual(acta.away.map((p) => p.isGoalkeeper), [false, true]);
  assert.equal(acta.venue, 'PAVELLO PROVA');
  assert.equal(hasActa(dataDir, 900502), false);

  assert.equal(result.changes.games.created.length, 4);
  assert.deepEqual(result.changes.actas.created.map((a) => a.matchId), [900501]);

  const state = stateFile(dataDir);
  assert.equal(state.seasons['2026/2027'].games.leagues['4811'].nextDueAt, '2026-11-10T12:00:00.000Z');
  assert.equal(state.seasons['2026/2027'].actas.pending['900502'].lastStatus, 'no-file');
  assert.equal(state.lastRun.status, 'ok');
  // Atomic writes leave no temp files behind.
  assert.deepEqual(Object.keys(snapshot(dataDir)).filter((name) => name.endsWith('.tmp') || name.endsWith('sync.lock')), []);
});

test('a second run with nothing due makes 0 HTTP requests', async () => {
  const { sync, api, clock } = setup();
  await sync.init();
  const before = api.calls.length;
  clock.advance(HOUR);
  const result = await sync.run();
  assert.equal(api.calls.length, before);
  assert.equal(result.requests, 0);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.changes, { games: { created: [], updated: [], removed: [] }, actas: { created: [], updated: [], removed: [] } });
  // Status reads local files only.
  const status = await sync.status();
  assert.equal(api.calls.length, before);
  assert.equal(status.games.due, 0);
  assert.equal(status.actas.stored, 1);
  assert.equal(status.actas.pending, 1);
  assert.equal(status.games.leagues[0].games, 4);
});

test('games are refetched only after their refresh interval (default 24h)', async () => {
  const { sync, api, clock } = setup({ reports: {} , config: { ...CONFIG, levels: { games: true } } });
  await sync.run();
  assert.equal(api.calls.length, 1);
  clock.advance(23 * HOUR);
  await sync.run();
  assert.equal(api.calls.length, 1);
  clock.advance(HOUR);
  await sync.run();
  assert.equal(api.calls.length, 2);
});

test('a game whose date changes keeps its history, is marked rescheduled and is not duplicated', async () => {
  const { sync, api, clock, dataDir } = setup({ config: { ...CONFIG, levels: { games: true } } });
  await sync.run();
  clock.advance(DAY);
  const moved = BASE_GAMES.map((game) => (game.id === 900503 ? { ...game, date: '2026-11-22', time: '18:00', venue: 'PAVELLO NOU' } : game));
  api.calendars[4811] = calendarBody(moved);
  const result = await sync.run();
  assert.equal(result.changes.games.updated.length, 1);
  assert.equal(result.changes.games.created.length, 0);
  const file = gamesFile(dataDir, 4811);
  assert.equal(Object.keys(file.games).length, 4);
  const game = file.games['900503'];
  assert.deepEqual([game.date, game.time, game.venue, game.startsAt], ['2026-11-22', '18:00', 'PAVELLO NOU', '2026-11-22T17:00:00.000Z']);
  assert.deepEqual(game.history, [{
    date: '2026-11-15', time: '10:00', startsAt: '2026-11-15T09:00:00.000Z', venue: null, homeId: 900103, awayId: 900101,
    observedAt: '2026-11-10T12:00:00.000Z',
  }]);
  assert.equal(game.rescheduled, true);
  assert.equal(game.rescheduleCount, 1);
  assert.equal(game.firstSeenAt, NOW);
  assert.equal(game.updatedAt, '2026-11-10T12:00:00.000Z');
});

test('publishing a missing time or a first date is history but not a reschedule', async () => {
  const { sync, api, clock, dataDir } = setup({ config: { ...CONFIG, levels: { games: true } } });
  await sync.run();
  clock.advance(DAY);
  api.calendars[4811] = calendarBody(BASE_GAMES.map((game) => (game.id === 900504 ? { ...game, date: '2026-12-06', time: '11:00' } : game)));
  await sync.run();
  const game = gamesFile(dataDir, 4811).games['900504'];
  assert.equal(game.history.length, 1);
  assert.equal(game.history[0].date, null);
  assert.equal(game.rescheduled, false);
});

test('a fixture republished under a new id with swapped sides is updated in place (sameFixture), not duplicated', async () => {
  const { sync, api, clock, dataDir } = setup({ config: { ...CONFIG, levels: { games: true } } });
  await sync.run();
  clock.advance(DAY);
  api.calendars[4811] = calendarBody(BASE_GAMES.map((game) => (game.id === 900503 ? { ...game, id: 900603, date: '2026-11-16', home: 900101, away: 900103 } : game)));
  const result = await sync.run();
  const file = gamesFile(dataDir, 4811);
  assert.deepEqual(Object.keys(file.games).sort(), ['900501', '900502', '900504', '900603']);
  assert.equal(file.games['900603'].matchId, 900603);
  assert.equal(file.games['900603'].firstSeenAt, NOW);
  assert.equal(file.games['900603'].history[0].homeId, 900103);
  assert.deepEqual([result.changes.games.created.length, result.changes.games.updated.length, result.changes.games.removed.length], [0, 1, 0]);
});

test('a game that disappears from the calendar is kept and marked removed; it is restored if it comes back', async () => {
  const { sync, api, clock, dataDir } = setup({ config: { ...CONFIG, levels: { games: true } } });
  await sync.run();
  clock.advance(DAY);
  api.calendars[4811] = calendarBody(BASE_GAMES.filter((game) => game.id !== 900503));
  const result = await sync.run();
  assert.deepEqual(result.changes.games.removed.map((game) => game.key), ['900503']);
  const removed = gamesFile(dataDir, 4811).games['900503'];
  assert.equal(removed.removedAt, '2026-11-10T12:00:00.000Z');
  assert.equal((await sync.status()).games.leagues[0].removed, 1);

  clock.advance(DAY);
  api.calendars[4811] = calendarBody(BASE_GAMES);
  const back = await sync.run();
  assert.deepEqual(back.changes.games.updated.map((game) => game.key), ['900503']);
  assert.equal(gamesFile(dataDir, 4811).games['900503'].removedAt, null);
});

test('a finished acta is never requested again, even on a forced full sync', async () => {
  const { sync, api, clock } = setup();
  await sync.init();
  assert.equal(api.calls.filter((url) => url.includes('/report/') && url.includes('id=900501')).length, 1);
  clock.advance(30 * DAY);
  await sync.init();
  await sync.run();
  assert.equal(api.calls.filter((url) => url.includes('/report/') && url.includes('id=900501')).length, 1);
});

test('an acta is only requested 3 h after kickoff', async () => {
  const clock = fakeClock('2026-11-08T16:00:00.000Z'); // 17:00 Madrid, kickoff of 900502
  const api = fakeApi({ calendars: { 4811: calendarBody(BASE_GAMES) }, reports: { 900501: reportBody(900501), 900502: reportBody(900502) } });
  const { sync } = testSync(CONFIG, { api, clock });
  await sync.run();
  clock.advance(3 * HOUR - 60_000);
  await sync.init();
  assert.equal(api.calls.some((url) => url.includes('id=900502')), false);
  clock.advance(60_000);
  await sync.init();
  assert.equal(api.calls.some((url) => url.includes('report/?id=900502')), true);
});

test('an acta that is not available yet (NO FILE or not finished) is retried with growing spacing, then given up', async () => {
  const { sync, api, clock } = setup();
  await sync.run();
  const attempts = () => api.calls.filter((url) => url.includes('report/?id=900502')).length;
  assert.equal(attempts(), 1);
  // Spacing after attempt n: 12h, 24h, 48h, 96h, 7d (capped).
  const spacings = [12, 24, 48, 96, 168];
  for (const [i, hours] of spacings.entries()) {
    clock.advance((hours - 1) * HOUR);
    await sync.run();
    assert.equal(attempts(), i + 1, `not before ${hours}h`);
    clock.advance(HOUR);
    if (i === 1) api.reports[900502] = { game_data: { ...reportBody(900502).game_data, game_completed: 'false' } };
    await sync.run();
    assert.equal(attempts(), i + 2, `retried after ${hours}h`);
  }
  assert.equal(attempts(), ACTA_MAX_ATTEMPTS);
  clock.advance(60 * DAY);
  await sync.run();
  assert.equal(attempts(), ACTA_MAX_ATTEMPTS, 'gave up');
  const status = await sync.status();
  assert.equal(status.actas.gaveUp, 1);
});

test('a given-up acta is tried again when its game is rescheduled', async () => {
  const { sync, api, clock, dataDir } = setup({ config: { ...CONFIG, refresh: { games: '30d' } } });
  await sync.run();
  const attempts = () => api.calls.filter((url) => url.includes('report/?id=900502')).length;
  for (let i = 0; i < 10; i++) {
    clock.advance(8 * DAY);
    await sync.run();
  }
  assert.equal(attempts(), ACTA_MAX_ATTEMPTS);
  assert.equal(stateFile(dataDir).seasons['2026/2027'].actas.pending['900502'].gaveUp, true);
  api.calendars[4811] = calendarBody(BASE_GAMES.map((game) => (game.id === 900502 ? { ...game, date: '2026-12-20' } : game)));
  await sync.init();
  assert.equal(attempts(), ACTA_MAX_ATTEMPTS + 1);
});

test('the request budget stops the run cleanly; the next run continues where it stopped', async () => {
  const clock = fakeClock(NOW);
  const calendars = Object.fromEntries([4811, 4812, 4813, 4814].map((idc) => [idc, calendarBody([{ id: idc * 1000, date: '2026-11-21', time: '10:00', home: 900101, away: 900102 }])]));
  const api = fakeApi({ calendars });
  const { sync, dataDir } = testSync({ season: '2026/2027', scope: { leagues: [4811, 4812, 4813, 4814] }, limits: { maxRequestsPerRun: 5 } }, { api, clock });
  const first = await sync.run();
  assert.equal(first.status, 'partial');
  assert.equal(first.reason, 'budget');
  assert.ok(first.requests <= 5);
  assert.equal(api.calls.length, 3); // a calendar may need up to 3 requests, so the 4th doesn't fit in what's left
  assert.equal(existsSync(path.join(dataDir, '2026-2027', 'games', '4814.json')), false);
  assert.equal(first.changes.games.created.length, 3);

  clock.advance(HOUR);
  const second = await sync.run();
  assert.equal(second.status, 'ok');
  assert.deepEqual(api.calls.slice(3).map((url) => new URL(url).searchParams.get('id')), ['4814']);
  assert.equal(gamesFile(dataDir, 4814).games['4814000'].homeId, 900101);
});

test('the budget is never exceeded, even when sources fall back', async () => {
  const clock = fakeClock(NOW);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return new Response('', { status: 200 });
  };
  const dataDir = tempDir();
  const sync = createSync({ season: '2026/2027', dataDir, token: 't', scope: { leagues: [4811] }, limits: { maxRequestsPerRun: 5 } },
    { fetch, now: clock.now, sleep: async () => {}, env: {}, baseUrl: 'https://portal.test' });
  const result = await sync.run();
  assert.equal(result.status, 'failed');
  assert.ok(calls.length <= 5);
});

for (const [label, response, code] of [
  ['HTTP 429', () => json({}, 429), 'HTTP_ERROR'],
  ['HTTP 503', () => json({}, 503), 'HTTP_ERROR'],
  ['a SIDGAD refusal', () => json({ status: 'INVALID DOMAIN' }), 'SOURCE_REJECTED'],
]) {
  test(`${label} stops the run, leaves the data untouched and records a growing backoff`, async () => {
    const { sync, api, clock, dataDir } = setup({ config: { ...CONFIG, levels: { games: true } } });
    await sync.run();
    const before = snapshot(path.join(dataDir, '2026-2027'));

    clock.advance(DAY);
    api.calendars[4811] = response;
    const failed = await sync.run();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, code);
    assert.equal(failed.requests, 1, 'no retry loop');
    assert.equal(failed.backoffUntil, '2026-11-10T13:00:00.000Z');
    assert.deepEqual(snapshot(path.join(dataDir, '2026-2027')), before);
    assert.equal(stateFile(dataDir).backoff.failures, 1);

    // During the backoff: no request at all.
    clock.advance(30 * 60_000);
    const skipped = await sync.run();
    assert.deepEqual([skipped.status, skipped.reason, skipped.requests], ['skipped', 'backoff', 0]);
    assert.equal(api.calls.length, 2);

    // After it: one more try, which fails again and doubles the wait.
    clock.advance(HOUR);
    const again = await sync.run();
    assert.equal(again.status, 'failed');
    assert.equal(stateFile(dataDir).backoff.failures, 2);
    assert.equal(Date.parse(again.backoffUntil) - clock.now().getTime(), 2 * HOUR);

    // A successful run clears it.
    clock.advance(3 * HOUR);
    api.calendars[4811] = calendarBody(BASE_GAMES);
    const ok = await sync.run();
    assert.equal(ok.status, 'ok');
    assert.equal(stateFile(dataDir).backoff, null);
  });
}

test('a failing acta request also backs off and keeps the games fetched in the same run out of the store', async () => {
  const { sync, api, dataDir } = setup({ reports: { 900501: () => json({}, 500) } });
  const result = await sync.run();
  assert.equal(result.status, 'failed');
  assert.equal(api.calls.length, 2);
  assert.equal(existsSync(path.join(dataDir, '2026-2027', 'games', '4811.json')), false);
  assert.equal(stateFile(dataDir).backoff.failures, 1);
});

test('a format change fails the run loudly and leaves the previous data untouched', async () => {
  const { sync, api, clock, dataDir } = setup();
  await sync.init();
  const before = snapshot(path.join(dataDir, '2026-2027'));
  clock.advance(DAY);
  api.calendars[4811] = { games: [{ idp: 1, dia_partido: null }] };
  const result = await sync.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SOURCE_FORMAT_CHANGED');
  assert.deepEqual(snapshot(path.join(dataDir, '2026-2027')), before);
});

test('an acta with invalid content is a warning and a counted attempt, not a failed run', async () => {
  const broken = reportBody(900501);
  broken.game_data.home_roster[0].player_id = '';
  const { sync } = setup({ reports: { 900501: broken } });
  const result = await sync.run();
  assert.equal(result.status, 'ok');
  assert.match(result.warnings[0], /acta 900501: INCOMPLETE_PLAYER/);
});

test('scope.teams keeps only games involving those teams', async () => {
  const { sync, dataDir } = setup({ config: { ...CONFIG, levels: { games: true }, scope: { leagues: [4811], teams: [900104] } } });
  await sync.run();
  assert.deepEqual(Object.keys(gamesFile(dataDir, 4811).games), ['900504']);
});

test('a lock held by another run skips the run without any request; a stale lock is taken over', async () => {
  const { sync, api, dataDir, clock } = setup();
  mkdirSync(dataDir, { recursive: true });
  const lock = path.join(dataDir, 'sync.lock');
  writeFileSync(lock, JSON.stringify({ pid: 1, hostname: 'another-host.test', startedAt: new Date(clock.now().getTime() - HOUR).toISOString(), token: 'abc' }));
  const skipped = await sync.run();
  assert.deepEqual([skipped.status, skipped.reason, skipped.requests], ['skipped', 'locked', 0]);
  assert.equal(api.calls.length, 0);
  assert.ok(existsSync(lock), 'someone else\'s lock is left alone');
  assert.equal((await sync.status()).locked, true);

  writeFileSync(lock, JSON.stringify({ pid: 1, hostname: 'another-host.test', startedAt: new Date(clock.now().getTime() - 7 * HOUR).toISOString(), token: 'abc' }));
  const run = await sync.run();
  assert.equal(run.status, 'ok');
  assert.equal(existsSync(lock), false, 'released after the run');
  assert.deepEqual(readdirSync(dataDir).filter((name) => name.includes('lock')), []);
});

test('a lock left by a dead process on this host is stale at once', async () => {
  const { sync, dataDir, clock } = setup();
  mkdirSync(dataDir, { recursive: true });
  // A pid far above any real one: kill(pid, 0) answers ESRCH.
  writeFileSync(path.join(dataDir, 'sync.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: clock.now().toISOString(), token: 'abc' }));
  assert.equal((await sync.run()).status, 'ok');
});

test('two overlapping runs: the second is skipped', async () => {
  const clock = fakeClock(NOW);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = fakeApi({ calendars: { 4811: async () => { await gate; return json(calendarBody(BASE_GAMES)); } } });
  const dataDir = tempDir();
  const make = () => createSync({ ...CONFIG, levels: { games: true }, token: 't', dataDir }, { fetch: api.fetch, now: clock.now, sleep: async () => {}, env: {}, sources: ['sidgad-api'] });
  const first = make().run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await make().run();
  assert.equal(second.reason, 'locked');
  release();
  assert.equal((await first).status, 'ok');
});

test('a corrupt state file is STORE_CORRUPT, never silently reset', async () => {
  const { sync, dataDir } = setup();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'state.json'), '{"nope":');
  await assert.rejects(sync.run(), { code: 'STORE_CORRUPT' });
  assert.equal(readFileSync(path.join(dataDir, 'state.json'), 'utf8'), '{"nope":');
  assert.equal(existsSync(path.join(dataDir, 'sync.lock')), false);
});
