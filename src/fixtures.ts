import { parseDate } from "./time.js";
import type { Match } from "./types.js";

export type FixtureKey = Pick<Match, "competitionId" | "homeId" | "awayId" | "date">;

const DAY_MS = 86_400_000;

/**
 * Whether two calendar entries describe the same real fixture. FECAPA sometimes
 * republishes a match with a shifted date or swapped home/away sides, so the
 * rule is: same competition, same unordered pair of teams, and dates no more
 * than `windowDays` (default 3) apart. A real rematch later in the season falls
 * outside the window. Without a date on either side there is nothing to
 * compare, so the answer is `false`.
 */
export function sameFixture(a: FixtureKey, b: FixtureKey, options: { windowDays?: number } = {}): boolean {
  const windowDays = options.windowDays ?? 3;
  if (a.competitionId !== b.competitionId) return false;
  const pairA = [Math.min(a.homeId, a.awayId), Math.max(a.homeId, a.awayId)];
  const pairB = [Math.min(b.homeId, b.awayId), Math.max(b.homeId, b.awayId)];
  if (pairA[0] !== pairB[0] || pairA[1] !== pairB[1]) return false;
  if (a.date === null || b.date === null) return false;
  return Math.abs(dayNumber(a.date) - dayNumber(b.date)) <= windowDays;
}

function dayNumber(date: string): number {
  const { year, month, day } = parseDate(date);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}
