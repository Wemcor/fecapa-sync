import { sameFixture } from "../fixtures.js";
import type { Match } from "../types.js";

/** Previous schedule values of a game, kept when FECAPA changes them. */
export type GameHistoryEntry = {
  date: string | null;
  time: string | null;
  startsAt: string | null;
  venue: string | null;
  homeId: number;
  awayId: number;
  /** When the sync saw these values replaced (ISO 8601). */
  observedAt: string;
};

/**
 * A game in the local store. FECAPA never marks a game as postponed or
 * cancelled: the only signal is that its date, time or venue changes, or that
 * it disappears from the calendar. Both are kept.
 */
export type GameRecord = {
  /** Store key: the match id as a string. */
  key: string;
  matchId: number | null;
  competitionId: number;
  phaseId: number | null;
  phaseName: string | null;
  round: number | null;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  date: string | null;
  time: string | null;
  startsAt: string | null;
  venue: string | null;
  /** Previous schedule values, oldest first. */
  history: GameHistoryEntry[];
  /** How many times an already published date, time or venue changed. A first publication (null → value) doesn't count. */
  rescheduleCount: number;
  /** `rescheduleCount > 0`. */
  rescheduled: boolean;
  /** When the game was last seen missing from its league calendar, or null. Removed games are kept. */
  removedAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
};

export type GamesFile = {
  version: 1;
  competitionId: number;
  updatedAt: string;
  games: Record<string, GameRecord>;
};

export type MergeResult = {
  games: Record<string, GameRecord>;
  created: GameRecord[];
  updated: GameRecord[];
  removed: GameRecord[];
};

const SCHEDULE_FIELDS = ["date", "time", "startsAt", "venue", "homeId", "awayId"] as const;
const OTHER_FIELDS = ["matchId", "phaseId", "phaseName", "round", "homeName", "awayName"] as const;

function keyOf(match: Match): string {
  return match.matchId !== undefined
    ? String(match.matchId)
    : `fixture:${match.homeId}-${match.awayId}-${match.date ?? "nodate"}`;
}

function newRecord(match: Match, now: string): GameRecord {
  return {
    key: keyOf(match),
    matchId: match.matchId ?? null,
    competitionId: match.competitionId,
    phaseId: match.phaseId,
    phaseName: match.phaseName,
    round: match.round,
    homeId: match.homeId,
    awayId: match.awayId,
    homeName: match.homeName,
    awayName: match.awayName,
    date: match.date,
    time: match.time,
    startsAt: match.startsAt,
    venue: match.venue,
    history: [],
    rescheduleCount: 0,
    rescheduled: false,
    removedAt: null,
    firstSeenAt: now,
    updatedAt: now,
  };
}

const changedFrom = (previous: string | null, next: string | null) => previous !== null && previous !== next;

/** Applies a fresh calendar entry to a stored record. Returns null when nothing changed. */
function applyMatch(record: GameRecord, match: Match, now: string): GameRecord | null {
  const next = newRecord(match, now);
  const scheduleChanged = SCHEDULE_FIELDS.some((field) => record[field] !== next[field]);
  const otherChanged = OTHER_FIELDS.some((field) => record[field] !== next[field]) || record.key !== next.key;
  if (!scheduleChanged && !otherChanged && record.removedAt === null) return null;
  const updated: GameRecord = {
    ...next,
    history: record.history,
    rescheduleCount: record.rescheduleCount,
    rescheduled: record.rescheduled,
    firstSeenAt: record.firstSeenAt,
  };
  if (scheduleChanged) {
    updated.history = [...record.history, {
      date: record.date, time: record.time, startsAt: record.startsAt, venue: record.venue,
      homeId: record.homeId, awayId: record.awayId, observedAt: now,
    }];
    if (changedFrom(record.date, next.date) || changedFrom(record.time, next.time) || changedFrom(record.venue, next.venue)) {
      updated.rescheduleCount = record.rescheduleCount + 1;
      updated.rescheduled = true;
    }
  }
  return updated;
}

/**
 * Merges a league calendar into the stored games of that league.
 *
 * - An entry with a known match id updates that record in place.
 * - An entry with an unknown id that is `sameFixture` as a stored game no
 *   longer in the calendar (FECAPA republished it) updates that game and moves
 *   it to the new key, instead of creating a duplicate.
 * - A stored game missing from the calendar gets `removedAt`; it is never
 *   deleted. It is restored if it comes back.
 */
export function mergeCalendar(existing: Record<string, GameRecord>, matches: Match[], now: string): MergeResult {
  const games: Record<string, GameRecord> = {};
  const created: GameRecord[] = [];
  const updated: GameRecord[] = [];
  const removed: GameRecord[] = [];
  const unmatched = new Map(Object.entries(existing));
  const pending: Match[] = [];

  const store = (previous: GameRecord, match: Match) => {
    const next = applyMatch(previous, match, now);
    const record = next ?? previous;
    games[record.key] = record;
    if (next) updated.push(next);
  };

  for (const match of matches) {
    const key = keyOf(match);
    if (games[key]) continue; // the same id twice in one calendar: keep the first
    const previous = unmatched.get(key);
    if (previous) {
      unmatched.delete(key);
      store(previous, match);
    } else {
      pending.push(match);
    }
  }
  for (const match of pending) {
    if (games[keyOf(match)]) continue;
    const candidates = [...unmatched.values()].filter((record) => sameFixture(record, match));
    const previous = candidates.find((record) => record.removedAt === null) ?? candidates[0];
    if (previous) {
      unmatched.delete(previous.key);
      store(previous, match);
    } else {
      const record = newRecord(match, now);
      games[record.key] = record;
      created.push(record);
    }
  }
  for (const record of unmatched.values()) {
    if (record.removedAt === null) {
      const gone = { ...record, removedAt: now, updatedAt: now };
      games[gone.key] = gone;
      removed.push(gone);
    } else {
      games[record.key] = record;
    }
  }
  return { games, created, updated, removed };
}

/** Whether a calendar entry is in scope for a `scope.teams` filter (empty = all). */
export function inTeamScope(match: Pick<Match, "homeId" | "awayId">, teams: readonly number[]): boolean {
  return !teams.length || teams.includes(match.homeId) || teams.includes(match.awayId);
}
