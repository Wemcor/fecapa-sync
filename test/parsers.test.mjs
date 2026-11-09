import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCalendarHtml, parseReportHtml } from '../dist/parsers/legacy-html.js';
import { apiBaseFromConfig, extractSidgadConfig, sidgadUrl } from '../dist/parsers/portal-config.js';
import { parseCalendarJson, parseReportJson } from '../dist/parsers/sidgad-json.js';
import { reportHtml } from '../fixtures/legacy-html/report-fixture.mjs';
import { fixture, jsonFixture } from './helpers.mjs';

const BASE = 'https://www.hoqueipatins.fecapa.cat';
const names = { home: 'CP PROVA', away: 'CH FICTICI' };
const request = (side, expectTeams = names) => ({ matchId: 900501, competitionId: 4811, side, expectTeams });

// legacy-html: report

test('legacy-html report: extracts player IDs, goals and all three card colours; excludes staff and opponents', () => {
  assert.deepEqual(parseReportHtml(reportHtml(), request('home')), {
    matchId: 900501, competitionId: 4811, side: 'home', homeName: 'CP PROVA', awayName: 'CH FICTICI', homeScore: 2, awayScore: 0,
    participants: [{ fecapaId: 900001, name: 'JÚLIA PROVA TEST', goals: 2, yellowCards: 1, blueCards: 2, redCards: 1 }],
  });
  assert.equal(parseReportHtml(reportHtml(), request('away')).participants[0].fecapaId, 999999);
});

test('legacy-html report: an unfinished match is null, a page without the period marker is a format change', () => {
  assert.equal(parseReportHtml(reportHtml({ final: false }), request('home')), null);
  assert.throws(() => parseReportHtml(reportHtml({ period: false }), request('home')), { code: 'SOURCE_FORMAT_CHANGED', source: 'legacy-html' });
});

test('legacy-html report: refuses wrong-team, incomplete, duplicated or changed-format reports with stable codes', () => {
  const cases = [
    [reportHtml({ home: 'WRONG' }), 'TEAMS_MISMATCH'],
    [reportHtml({ players: [] }), 'EMPTY_LINEUP'],
    [reportHtml().replace('id_player="900001"', ''), 'INCOMPLETE_PLAYER'],
    [reportHtml({ players: [{ id: 900001, given: '', surname: 'PROVA' }] }), 'INCOMPLETE_PLAYER'],
    [reportHtml().replace('>G</th>', '>Other</th>'), 'SOURCE_FORMAT_CHANGED'],
    [reportHtml().replace('<td>2</td>', '<td>?</td>'), 'SOURCE_FORMAT_CHANGED'],
  ];
  for (const [html, code] of cases) assert.throws(() => parseReportHtml(html, request('home')), { code }, code);
  const player = { id: 900005, given: 'TEST', surname: 'FICTICI' };
  assert.throws(() => parseReportHtml(reportHtml({ players: [player, player] }), request('home')), { code: 'DUPLICATE_LINEUP', fecapaId: 900005 });
});

test('legacy-html report: team names are only checked when expectTeams is given', () => {
  const report = parseReportHtml(reportHtml({ home: 'ALTRE' }), { matchId: 900501, competitionId: 4811, side: 'home' });
  assert.equal(report.homeName, 'ALTRE');
});

// legacy-html: calendar

test('legacy-html calendar: old team_class rows keep the report ID even when competition IDs change between phases', () => {
  const matches = parseCalendarHtml(fixture('legacy-html/2025-calendar-team-class.html'), 4787, BASE);
  assert.deepEqual(matches[0], {
    matchId: 900123, competitionId: 4787, homeId: 900101, awayId: 900102, homeName: 'CP PROVA', awayName: 'CH FICTICI',
    date: '2026-10-25', time: '17:00', startsAt: '2026-10-25T16:00:00.000Z',
  });
});

test('legacy-html calendar: reads the partido query parameter as the match id', () => {
  const [, second] = parseCalendarHtml(fixture('legacy-html/2025-calendar-team-class.html'), 4787, BASE);
  assert.equal(second.matchId, 900834);
  assert.equal(second.time, '11:45');
});

test('legacy-html calendar: accepts the labelled table while retaining stable team and report IDs', () => {
  assert.deepEqual(parseCalendarHtml(fixture('legacy-html/2026-calendar-table.html'), 4811, BASE), [{
    matchId: 900456, competitionId: 4811, homeId: 900111, awayId: 900112, homeName: 'CP PROVA B', awayName: 'CH FICTICI',
    date: '2026-11-14', time: '10:00', startsAt: '2026-11-14T09:00:00.000Z',
  }]);
});

test('legacy-html calendar: a page with neither layout yields no matches', () => {
  assert.deepEqual(parseCalendarHtml(fixture('portal-config/2026-11-calendar-page.html'), 4811, BASE), []);
});

// portal-config

test('portal-config: extracts the public SIDGAD config and builds calendar and report URLs', () => {
  const config = extractSidgadConfig(fixture('portal-config/2026-11-calendar-page.html'));
  const apiBase = apiBaseFromConfig(config);
  assert.equal(apiBase, 'https://api.sidgad.test/fecapa/v1/hp');
  assert.equal(sidgadUrl(apiBase, 'calendar', 4811, config.token), 'https://api.sidgad.test/fecapa/v1/hp/calendar/?id=4811&jwt=public-token');
  assert.equal(sidgadUrl(apiBase, 'report', 149834, config.token), 'https://api.sidgad.test/fecapa/v1/hp/report/?id=149834&jwt=public-token');
});

test('portal-config: no config is null, a broken config is a format change', () => {
  assert.equal(extractSidgadConfig('<html></html>'), null);
  assert.throws(() => extractSidgadConfig('const SIDGAD_API_CONFIG = {"url":"x",};'), { code: 'SOURCE_FORMAT_CHANGED', source: 'portal-config' });
  assert.throws(() => extractSidgadConfig('const SIDGAD_API_CONFIG = {"url":"https://a.test","cliente":"fecapa"};'), { code: 'SOURCE_FORMAT_CHANGED' });
});

// sidgad JSON

test('sidgad JSON calendar: skips phase/round separators and maps games', () => {
  assert.deepEqual(parseCalendarJson(jsonFixture('sidgad-api/2026-11-calendar.json'), 4811, 'sidgad-api'), [
    { matchId: 900501, competitionId: 4811, homeId: 900101, awayId: 900102, homeName: 'CP PROVA B', awayName: 'CH FICTICI', date: '2026-09-26', time: '12:30', startsAt: '2026-09-26T10:30:00.000Z' },
    { matchId: 900502, competitionId: 4811, homeId: 900102, awayId: 900103, homeName: 'CH FICTICI', awayName: 'CLUB IMAGINARI', date: '2026-11-08', time: null, startsAt: '2026-11-07T23:00:00.000Z' },
  ]);
  assert.deepEqual(parseCalendarJson({ games: [] }, 4811, 'sidgad-api'), []);
});

test('sidgad JSON calendar: schema failures are SOURCE_FORMAT_CHANGED with the source name', () => {
  for (const input of [null, [], {}, { games: {} }, { games: [{ idp: '1' }] }, { games: [{ idp: '1', dia_partido: 26 }] }]) {
    assert.throws(() => parseCalendarJson(input, 4811, 'portal-config'), { code: 'SOURCE_FORMAT_CHANGED', source: 'portal-config' });
  }
});

test('sidgad JSON: a bare {status} body is SOURCE_REJECTED', () => {
  const rejected = jsonFixture('sidgad-api/2026-11-rejected-invalid-domain.json');
  assert.throws(() => parseCalendarJson(rejected, 4811, 'sidgad-api'), { code: 'SOURCE_REJECTED', status: 'INVALID DOMAIN', source: 'sidgad-api' });
  assert.throws(() => parseReportJson({ status: 'NO FILE' }, request('home'), 'sidgad-api'), { code: 'SOURCE_REJECTED', status: 'NO FILE' });
});

test('sidgad JSON report: parses the lineup of the requested side', () => {
  const data = jsonFixture('sidgad-api/2026-11-report-finished.json');
  const expectTeams = { home: 'CP PROVA B', away: 'CH FICTICI' };
  assert.deepEqual(parseReportJson(data, request('away', expectTeams), 'sidgad-api'), {
    matchId: 900501, competitionId: 4811, side: 'away', homeName: 'CP PROVA B', awayName: 'CH FICTICI', homeScore: 2, awayScore: 8,
    participants: [{ fecapaId: 900003, name: 'NIL PROVA TERCER', goals: 3, yellowCards: 0, blueCards: 2, redCards: 0 }],
  });
  assert.deepEqual(parseReportJson(data, request('home', expectTeams), 'sidgad-api').participants, [
    { fecapaId: 900001, name: 'JÚLIA PROVA TEST', goals: 2, yellowCards: 1, blueCards: 0, redCards: 0 },
    { fecapaId: 900002, name: 'PAU FICTICI SEGON', goals: 0, yellowCards: 0, blueCards: 0, redCards: 0 },
  ]);
});

test('sidgad JSON report: an unfinished match is null', () => {
  assert.equal(parseReportJson(jsonFixture('sidgad-api/2026-11-report-pending.json'), request('home'), 'sidgad-api'), null);
});

test('sidgad JSON report: refuses wrong teams, incomplete players, duplicates and bad counts', () => {
  const data = jsonFixture('sidgad-api/2026-11-report-finished.json');
  const expectTeams = { home: 'CP PROVA B', away: 'CH FICTICI' };
  const withHome = (roster) => ({ game_data: { ...data.game_data, home_roster: roster } });
  const row = data.game_data.home_roster[0];
  assert.throws(() => parseReportJson(data, request('home', { home: 'X', away: 'Y' }), 'sidgad-api'),
    { code: 'TEAMS_MISMATCH', expected: { home: 'X', away: 'Y' }, actual: expectTeams });
  assert.throws(() => parseReportJson(withHome([{ ...row, player_id: '' }]), request('home', expectTeams), 'sidgad-api'), { code: 'INCOMPLETE_PLAYER' });
  assert.throws(() => parseReportJson(withHome([{ ...row, player_name: 'NOCOMMA' }]), request('home', expectTeams), 'sidgad-api'), { code: 'INCOMPLETE_PLAYER' });
  assert.throws(() => parseReportJson(withHome([row, row]), request('home', expectTeams), 'sidgad-api'), { code: 'DUPLICATE_LINEUP', fecapaId: 900001 });
  assert.throws(() => parseReportJson(withHome([]), request('home', expectTeams), 'sidgad-api'), { code: 'EMPTY_LINEUP' });
  assert.throws(() => parseReportJson(withHome([{ ...row, goals: 'dos' }]), request('home', expectTeams), 'sidgad-api'), { code: 'SOURCE_FORMAT_CHANGED' });
  assert.throws(() => parseReportJson({ game_data: { ...data.game_data, home_team_name: 7 } }, request('home'), 'sidgad-api'), { code: 'SOURCE_FORMAT_CHANGED' });
});
