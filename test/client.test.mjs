import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, DEFAULT_USER_AGENT, FecapaError } from '../dist/index.js';
import { reportHtml } from '../fixtures/legacy-html/report-fixture.mjs';
import { fakeFetch, fixture, html, json, jsonFixture } from './helpers.mjs';

const PORTAL = 'https://www.hoqueipatins.fecapa.cat';
const PAGE = `${PORTAL}/?liga=4811&vista=calendar`;
const TOKEN_API = 'https://api.sidgad.com/fecapa/v1/hp/';
const PORTAL_API = 'https://api.sidgad.test/fecapa/v1/hp/';

const isPortal = (url) => url.startsWith(PORTAL);
const client = (fetch, opts = {}) => createClient({ fetch, delayMs: 0, ...opts });

test('sends the honest default User-Agent on every request, and never a browser one', async () => {
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [PORTAL_API, () => json(jsonFixture('sidgad-api/2026-11-calendar.json'))],
  ]);
  await client(fetch).getCalendar(4811);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.headers['user-agent'], DEFAULT_USER_AGENT);
    assert.match(call.headers['user-agent'], /^fecapa-sync\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/jmedinafruitos\/fecapa-sync\)$/);
    assert.doesNotMatch(call.headers['user-agent'], /Mozilla|Safari/);
  }
});

test('a custom userAgent replaces the default', async () => {
  const { fetch, calls } = fakeFetch([[TOKEN_API, () => json(jsonFixture('sidgad-api/2026-11-calendar.json'))]]);
  await client(fetch, { token: 't', userAgent: 'my-club-sync/1.0 (admin@example.org)' }).getCalendar(4811);
  assert.equal(calls[0].headers['user-agent'], 'my-club-sync/1.0 (admin@example.org)');
});

test('SIDGAD API calls send the portal Origin (required) and no Referer; portal pages send neither', async () => {
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [PORTAL_API, () => json(jsonFixture('sidgad-api/2026-11-calendar.json'))],
  ]);
  await client(fetch).getCalendar(4811);
  const [page, api] = calls;
  assert.equal(page.url, PAGE);
  assert.equal(page.headers.origin, undefined);
  assert.equal(page.headers.referer, undefined);
  assert.equal(api.headers.origin, PORTAL);
  assert.equal(api.headers.referer, undefined);
});

test('with a token, sidgad-api is tried first and wins', async () => {
  const { fetch, calls } = fakeFetch([[TOKEN_API, () => json(jsonFixture('sidgad-api/2026-11-calendar.json'))]]);
  const result = await client(fetch, { token: 'secret-token' }).getCalendar(4811);
  assert.equal(result.source, 'sidgad-api');
  assert.equal(result.matches.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TOKEN_API}calendar/?id=4811&jwt=secret-token`);
});

test('without a token, sidgad-api is skipped and portal-config answers', async () => {
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [PORTAL_API, () => json(jsonFixture('sidgad-api/2026-11-calendar.json'))],
  ]);
  const result = await client(fetch).getCalendar(4811);
  assert.equal(result.source, 'portal-config');
  assert.equal(result.matches[0].competitionId, 4811);
  assert.deepEqual(calls.map((c) => c.url), [PAGE, `${PORTAL_API}calendar/?id=4811&jwt=public-token`]);
});

test('falls back in order: sidgad-api fails, portal-config fails, legacy-html answers; the portal page is downloaded once', async () => {
  const { fetch, calls } = fakeFetch([
    [TOKEN_API, () => json({}, 500)],
    [isPortal, () => html(fixture('legacy-html/2025-calendar-team-class.html'))],
  ]);
  const result = await client(fetch, { token: 't' }).getCalendar(4811);
  assert.equal(result.source, 'legacy-html');
  assert.equal(result.matches.length, 2);
  assert.deepEqual(calls.map((c) => c.url), [`${TOKEN_API}calendar/?id=4811&jwt=t`, PAGE]);
});

test('the sources option sets the order and the subset', async () => {
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('legacy-html/2026-calendar-table.html'))],
  ]);
  const result = await client(fetch, { token: 't', sources: ['legacy-html', 'sidgad-api'] }).getCalendar(4811);
  assert.equal(result.source, 'legacy-html');
  assert.equal(calls.length, 1);
  assert.throws(() => createClient({ fetch, sources: ['nope'] }), { code: 'INVALID_ARGUMENT', argument: 'sources' });
});

test('a zod schema failure is SOURCE_FORMAT_CHANGED naming the source', async () => {
  const { fetch } = fakeFetch([[TOKEN_API, () => json({ games: [{ idp: 1, dia_partido: null }] })]]);
  await assert.rejects(client(fetch, { token: 't', sources: ['sidgad-api'] }).getCalendar(4811), (error) => {
    assert.ok(error instanceof FecapaError);
    assert.equal(error.code, 'SOURCE_FORMAT_CHANGED');
    assert.equal(error.source, 'sidgad-api');
    return true;
  });
  const report = fakeFetch([[TOKEN_API, () => json({ game_data: { game_completed: 'true' } })]]);
  await assert.rejects(client(report.fetch, { token: 't', sources: ['sidgad-api'] }).getReport(900501, { idc: 4811, side: 'home' }),
    { code: 'SOURCE_FORMAT_CHANGED', source: 'sidgad-api' });
});

test('when several sources fail, ALL_SOURCES_FAILED lists every attempt in order', async () => {
  const { fetch } = fakeFetch([
    [TOKEN_API, () => json({ status: 'INVALID DOMAIN' })],
    [isPortal, () => html('<html><body>maintenance</body></html>')],
  ]);
  await assert.rejects(client(fetch, { token: 't' }).getCalendar(4811), (error) => {
    assert.equal(error.code, 'ALL_SOURCES_FAILED');
    assert.deepEqual(error.attempts.map((a) => [a.source, a.error.code]), [
      ['sidgad-api', 'SOURCE_REJECTED'],
      ['portal-config', 'SOURCE_FORMAT_CHANGED'],
      ['legacy-html', 'SOURCE_FORMAT_CHANGED'],
    ]);
    return true;
  });
});

test('HTTP errors carry the status and never leak the token', async () => {
  const { fetch } = fakeFetch([[TOKEN_API, () => json({}, 503)]]);
  await assert.rejects(client(fetch, { token: 'secret-token', sources: ['sidgad-api'] }).getCalendar(4811), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.source, 'sidgad-api');
    assert.doesNotMatch(`${error.message} ${error.url}`, /secret-token/);
    return true;
  });
});

test('network failures and empty bodies have their own codes', async () => {
  const down = fakeFetch([[TOKEN_API, () => { throw new TypeError('fetch failed'); }]]);
  await assert.rejects(client(down.fetch, { token: 't', sources: ['sidgad-api'] }).getCalendar(4811), { code: 'NETWORK_ERROR' });
  const empty = fakeFetch([[TOKEN_API, () => new Response('  ')]]);
  await assert.rejects(client(empty.fetch, { token: 't', sources: ['sidgad-api'] }).getCalendar(4811), { code: 'EMPTY_RESPONSE' });
  const notJson = fakeFetch([[TOKEN_API, () => html('<html>')]]);
  await assert.rejects(client(notJson.fetch, { token: 't', sources: ['sidgad-api'] }).getCalendar(4811), { code: 'SOURCE_FORMAT_CHANGED' });
});

test('only sidgad-api configured and no token is NO_SOURCE_AVAILABLE, without any request', async () => {
  const { fetch, calls } = fakeFetch([]);
  await assert.rejects(client(fetch, { sources: ['sidgad-api'] }).getCalendar(4811), { code: 'NO_SOURCE_AVAILABLE' });
  assert.equal(calls.length, 0);
});

test('getReport returns the requested side and which source answered', async () => {
  const { fetch, calls } = fakeFetch([[TOKEN_API, () => json(jsonFixture('sidgad-api/2026-11-report-finished.json'))]]);
  const result = await client(fetch, { token: 't' }).getReport(900501, { idc: 4811, side: 'away', expectTeams: { home: 'CP PROVA B', away: 'CH FICTICI' } });
  assert.equal(result.source, 'sidgad-api');
  assert.equal(result.report.participants[0].fecapaId, 900003);
  assert.equal(calls[0].url, `${TOKEN_API}report/?id=900501&jwt=t`);
});

test('getReport: portal-config reads the config from the match page; an unfinished match is null', async () => {
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [PORTAL_API, () => json(jsonFixture('sidgad-api/2026-11-report-pending.json'))],
  ]);
  const result = await client(fetch).getReport(900501, { idc: 4811, side: 'home' });
  assert.deepEqual(result, { source: 'portal-config', status: 'not-finished', report: null });
  assert.deepEqual(calls.map((c) => c.url), [`${PAGE}&partido=900501`, `${PORTAL_API}report/?id=900501&jwt=public-token`]);
});

test('getReport: legacy-html parses the server-rendered acta', async () => {
  const { fetch } = fakeFetch([[isPortal, () => html(reportHtml())]]);
  const result = await client(fetch, { sources: ['legacy-html'] }).getReport(900501, { idc: 4811, side: 'home' });
  assert.equal(result.source, 'legacy-html');
  assert.equal(result.report.participants[0].name, 'JÚLIA PROVA TEST');
});

test('data errors such as TEAMS_MISMATCH stop immediately instead of trying the next source', async () => {
  const { fetch, calls } = fakeFetch([[TOKEN_API, () => json(jsonFixture('sidgad-api/2026-11-report-finished.json'))]]);
  await assert.rejects(client(fetch, { token: 't' }).getReport(900501, { idc: 4811, side: 'home', expectTeams: { home: 'A', away: 'B' } }),
    { code: 'TEAMS_MISMATCH', source: 'sidgad-api' });
  assert.equal(calls.length, 1);
});

test('rejects invalid arguments before any request', async () => {
  const { fetch, calls } = fakeFetch([]);
  const c = client(fetch);
  await assert.rejects(c.getCalendar('4811'), { code: 'INVALID_ARGUMENT', argument: 'idc' });
  await assert.rejects(c.getReport(900501, { idc: 0, side: 'home' }), { code: 'INVALID_ARGUMENT', argument: 'idc' });
  await assert.rejects(c.getReport(900501, { idc: 4811, side: 'both' }), { code: 'INVALID_ARGUMENT', argument: 'side' });
  assert.equal(calls.length, 0);
});

test('requests run one at a time with the configured delay between them', async () => {
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const fetch = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    starts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return json(jsonFixture('sidgad-api/2026-11-calendar.json'));
  };
  const c = createClient({ fetch, token: 't', delayMs: 40 });
  await Promise.all([c.getCalendar(1), c.getCalendar(2), c.getCalendar(3)]);
  assert.equal(maxActive, 1);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 40, `gap ${starts[i] - starts[i - 1]}ms`);
});

test('getReport and getFullReport: SIDGAD "NO FILE" is status no-file, answered by the first source without falling back', async () => {
  const { fetch, calls } = fakeFetch([[TOKEN_API, () => json({ status: 'NO FILE' })]]);
  const c = client(fetch, { token: 't' });
  assert.deepEqual(await c.getReport(900501, { idc: 4811, side: 'home' }), { source: 'sidgad-api', status: 'no-file', report: null });
  assert.deepEqual(await c.getFullReport(900501, { idc: 4811 }), { source: 'sidgad-api', status: 'no-file', report: null });
  assert.equal(calls.length, 2);
});

test('getFullReport returns both lineups from one request', async () => {
  const { fetch, calls } = fakeFetch([[TOKEN_API, () => json(jsonFixture('sidgad-api/2026-11-report-finished.json'))]]);
  const result = await client(fetch, { token: 't' }).getFullReport(900501, { idc: 4811 });
  assert.equal(result.status, 'final');
  assert.equal(result.report.home.length, 2);
  assert.equal(result.report.away.length, 1);
  assert.equal(calls.length, 1);
});

test('portal-config reads the public config page once per client and reuses it', async () => {
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [PORTAL_API, (url) => json(jsonFixture(url.includes('/calendar/') ? 'sidgad-api/2026-11-calendar.json' : 'sidgad-api/2026-11-report-finished.json'))],
  ]);
  const c = client(fetch);
  await c.getCalendar(4811);
  await c.getFullReport(900501, { idc: 4811 });
  await c.getCalendar(4812);
  assert.deepEqual(calls.map((call) => call.url), [
    PAGE, `${PORTAL_API}calendar/?id=4811&jwt=public-token`, `${PORTAL_API}report/?id=900501&jwt=public-token`, `${PORTAL_API}calendar/?id=4812&jwt=public-token`,
  ]);
});

test('portal-config reads the page again after a refusal (the public token may have changed)', async () => {
  let refuse = true;
  const { fetch, calls } = fakeFetch([
    [isPortal, () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [PORTAL_API, () => json(refuse ? { status: 'INVALID TOKEN' } : jsonFixture('sidgad-api/2026-11-calendar.json'))],
  ]);
  const c = client(fetch, { sources: ['portal-config'] });
  await assert.rejects(c.getCalendar(4811), { code: 'SOURCE_REJECTED' });
  refuse = false;
  await c.getCalendar(4811);
  assert.equal(calls.filter((call) => isPortal(call.url)).length, 2);
});
