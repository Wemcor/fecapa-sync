import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, toStartsAt } from '../dist/index.js';
import { parseCalendarJson, parseReportJson } from '../dist/parsers/sidgad-json.js';
import { fakeFetch, json, jsonFixture } from './helpers.mjs';
import { fakeApi, fakeClock, stateFile, testSync } from './sync-helpers.mjs';

for (const field of ['home_team_score', 'away_team_score']) {
  for (const value of [null, undefined, '', -1, 1.5, '9007199254740993']) {
    test(`finished report rejects ${field}=${String(value)}`, () => {
      const data = jsonFixture('sidgad-api/2026-11-report-finished.json');
      data.game_data[field] = value;
      assert.throws(() => parseReportJson(data, { matchId: 900501, competitionId: 4811, side: 'home' }, 'sidgad-api'),
        { code: 'SOURCE_FORMAT_CHANGED' });
    });
  }
}

test('a real 0–0 remains a final result and absent optional card counts stay zero', () => {
  const data = jsonFixture('sidgad-api/2026-11-report-finished.json');
  data.game_data.home_team_score = 0; data.game_data.away_team_score = '0';
  data.game_data.home_roster[0].yellow_card = null;
  const result = parseReportJson(data, { matchId: 900501, competitionId: 4811, side: 'home' }, 'sidgad-api');
  assert.deepEqual([result.homeScore, result.awayScore], [0, 0]);
  assert.equal(result.participants[0].yellowCards, 0);
});

for (const status of [403, 429]) {
  test(`HTTP ${status} stops before fallback and exposes Retry-After without leaking JWT`, async () => {
    const { fetch, calls } = fakeFetch([['api.sidgad.com', () => new Response('refused', { status, headers: { 'retry-after': '3600' } })]]);
    const client = createClient({ token: 'test-secret', delayMs: 0, fetch });
    await assert.rejects(client.getCalendar(4811), error => {
      assert.equal(error.code, 'HTTP_ERROR'); assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 3600000);
      assert.doesNotMatch(error.message + error.url, /test-secret/);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('Retry-After accepts an HTTP date', async () => {
  const until = new Date(Date.now() + 120000).toUTCString();
  const { fetch, calls } = fakeFetch([['api.sidgad.com', () => new Response('refused', { status: 429, headers: { 'retry-after': until } })]]);
  await assert.rejects(createClient({ token: 't', delayMs: 0, fetch }).getCalendar(4811), error => {
    assert.ok(error.retryAfterMs > 110000 && error.retryAfterMs <= 120000); return true;
  });
  assert.equal(calls.length, 1);
});

test('INVALID DOMAIN stops before trying another transport', async () => {
  const { fetch, calls } = fakeFetch([['api.sidgad.com', () => json({ status: 'INVALID DOMAIN' })]]);
  await assert.rejects(createClient({ token: 't', delayMs: 0, fetch }).getCalendar(4811), { code: 'SOURCE_REJECTED', status: 'INVALID DOMAIN' });
  assert.equal(calls.length, 1);
});

test('sync persists Retry-After when it is longer than its own backoff', async () => {
  const clock = fakeClock('2026-11-09T12:00:00.000Z');
  const api = fakeApi({ calendars: { 4811: () => new Response('refused', { status: 429, headers: { 'retry-after': '10800' } }) } });
  const { sync, dataDir } = testSync({ season: '2026/2027', scope: { leagues: [4811] }, levels: { games: true } }, { api, clock });
  const failed = await sync.run();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.backoffUntil, '2026-11-09T15:00:00.000Z');
  assert.equal(stateFile(dataDir).backoff.lastError.retryAfterMs, 10800000);
  clock.advance(2 * 3600000);
  const skipped = await sync.run();
  assert.equal(skipped.reason, 'backoff');
  assert.equal(skipped.requests, 0);
  assert.equal(api.calls.length, 1);
});

for (const date of ['2026-02-31', '2026-02-29', '2026-00-12', '2026-13-01', '2026-1107']) {
  test(`invalid date ${date} cannot silently roll into another day`, () => {
    assert.throws(() => toStartsAt(date, '18:00'), { code: 'INVALID_ARGUMENT', argument: 'date' });
  });
}

for (const time of ['24:00', '23:60', '99:99']) {
  test(`invalid time ${time} is rejected`, () => {
    assert.throws(() => toStartsAt('2026-11-07', time), { code: 'INVALID_ARGUMENT', argument: 'time' });
  });
}

test('valid leap date remains supported', () => {
  assert.equal(toStartsAt('2028-02-29', '18:00'), '2028-02-29T17:00:00.000Z');
});

test('invalid published calendar date raises a format error', () => {
  const data = jsonFixture('sidgad-api/2026-11-calendar.json');
  const game = data.games.find(g => String(g.idp) !== '0');
  game.dia_partido = '31/02/2026';
  assert.throws(() => parseCalendarJson(data, 4811, 'sidgad-api'), { code: 'SOURCE_FORMAT_CHANGED' });
});

test('invalid published calendar time raises a format error', () => {
  const data = jsonFixture('sidgad-api/2026-11-calendar.json');
  const game = data.games.find(g => String(g.idp) !== '0');
  game.hora_partido = '99:99';
  assert.throws(() => parseCalendarJson(data, 4811, 'sidgad-api'), { code: 'SOURCE_FORMAT_CHANGED' });
});
