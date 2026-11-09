import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSync } from '../dist/index.js';
import { json } from './helpers.mjs';

export const API = 'https://api.sidgad.com/fecapa/v1/hp/';

export const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'fecapa-sync-test-'));

/** A fake clock starting at `iso`. */
export function fakeClock(iso) {
  let now = Date.parse(iso);
  return {
    now: () => new Date(now),
    advance(ms) { now += ms; },
    set(value) { now = Date.parse(value); },
  };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** `YYYY-MM-DD` → `DD/MM/YYYY` as SIDGAD writes it. */
const spanish = (date) => (date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '');

/**
 * A SIDGAD calendar body. Every identity is invented. `games` entries:
 * `{ id, date, time?, home, away, venue? }` with team ids from TEAMS.
 */
export const TEAMS = { 900101: 'CP PROVA B', 900102: 'CH FICTICI', 900103: 'CLUB IMAGINARI', 900104: 'PATIN INVENTAT' };

export function calendarBody(games, { phaseId = 4951, phaseName = 'LLIGA PROVA 1' } = {}) {
  const separator = (dia, hora, name) => ({ idp: '0', dia_partido: dia, hora_partido: hora, home_name: name, away_name: '--', home_id: null, away_id: null, pista: null });
  return {
    games: [
      separator('FASE', String(phaseId), phaseName),
      separator('JORNADA', '_', 'JORNADA 1'),
      ...games.map((game) => ({
        idp: String(game.id), dia_partido: spanish(game.date), hora_partido: game.time ?? '',
        home_name: TEAMS[game.home], away_name: TEAMS[game.away], home_id: String(game.home), away_id: String(game.away),
        result: '', pista: game.venue ?? null,
      })),
    ],
  };
}

let nextPlayer = 900001;
const player = (role = null) => ({
  player_id: String(nextPlayer++), player_name: `PROVA ${nextPlayer},JUGADOR`, player_number: '1', player_role: role,
  goals: '1', yellow_card: 0, blue_card: 0, red_card: 0,
});

/** A finished SIDGAD report body with a goalkeeper on each side. */
export function reportBody(id, { home = 900101, away = 900102 } = {}) {
  return {
    game_data: {
      game_id: String(id), game_completed: 'true', tournament_name: 'LLIGA PROVA 1', venue_info: 'PAVELLO PROVA',
      home_team_id: String(home), away_team_id: String(away), home_team_name: TEAMS[home], away_team_name: TEAMS[away],
      home_team_score: '3', away_team_score: '2',
      home_roster: [player('P'), player()], away_roster: [player(), player('P')], home_goalies: [], away_goalies: [],
      home_staff: [], away_staff: [],
    },
  };
}

/**
 * A fake SIDGAD API. `calendars[idc]` is a calendar body (or a function
 * returning a Response/body); `reports[id]` likewise. Unknown reports answer
 * NO FILE, like SIDGAD does. Every request is counted in `calls`.
 */
export function fakeApi({ calendars = {}, reports = {} } = {}) {
  const calls = [];
  const answer = async (value) => {
    const resolved = await (typeof value === 'function' ? value() : value);
    return resolved instanceof Response ? resolved : json(resolved);
  };
  const fetch = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const id = parsed.searchParams.get('id');
    if (parsed.pathname.endsWith('/calendar/')) {
      if (!(id in calendars)) throw new Error(`Unexpected calendar request in test: ${id}`);
      return answer(calendars[id]);
    }
    if (parsed.pathname.endsWith('/report/')) return answer(id in reports ? reports[id] : { status: 'NO FILE' });
    throw new Error(`Unexpected request in test: ${url}`);
  };
  return { fetch, calls, calendars, reports };
}

/** A sync over a temp store with the token source only (1 request per operation) and no real waiting. */
export function testSync(config, { api, clock, dataDir = tempDir() }) {
  const sync = createSync({ token: 'test-token', dataDir, ...config }, {
    fetch: api.fetch, now: clock.now, sleep: async () => {}, env: {}, sources: ['sidgad-api'],
  });
  return { sync, dataDir };
}

export const readJsonFile = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const gamesFile = (dataDir, idc, season = '2026-2027') => readJsonFile(path.join(dataDir, season, 'games', `${idc}.json`));
export const actaPath = (dataDir, id, season = '2026-2027') => path.join(dataDir, season, 'actas', `${id}.json`);
export const stateFile = (dataDir) => readJsonFile(path.join(dataDir, 'state.json'));
export const hasActa = (dataDir, id) => existsSync(actaPath(dataDir, id));

/** Every file under a directory, recursively, with its content. */
export function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}
