import { FecapaError } from "../errors.js";
import { toStartsAt } from "../time.js";
import type { ExpectTeams, Match, Participant, SourceName } from "../types.js";

export const clean = (value: string) => value.replace(/\s+/g, " ").trim();

export const TIME_RE = /^\d{1,2}:\d{2}$/;

/** `DD/MM/YYYY` → `YYYY-MM-DD`, or null. */
export function fromSpanishDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match || value === "00/00/0000") return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function buildMatch(competitionId: number, raw: Omit<Match, "competitionId" | "startsAt">): Match {
  const match: Match = {
    competitionId,
    homeId: raw.homeId,
    awayId: raw.awayId,
    homeName: raw.homeName,
    awayName: raw.awayName,
    date: raw.date,
    time: raw.time,
    startsAt: toStartsAt(raw.date, raw.time),
  };
  if (raw.matchId !== undefined) match.matchId = raw.matchId;
  return match;
}

export function checkTeams(source: SourceName, actual: ExpectTeams, expected: ExpectTeams | undefined): void {
  if (!expected) return;
  if (clean(actual.home) !== clean(expected.home) || clean(actual.away) !== clean(expected.away)) {
    throw new FecapaError("TEAMS_MISMATCH", "The report belongs to different teams than expected", { source, expected, actual });
  }
}

export function checkLineup(source: SourceName, participants: Participant[]): void {
  if (!participants.length) throw new FecapaError("EMPTY_LINEUP", "The finished report has no players for this side", { source });
  const seen = new Set<number>();
  for (const participant of participants) {
    if (seen.has(participant.fecapaId)) {
      throw new FecapaError("DUPLICATE_LINEUP", "The same player appears twice in the lineup", { source, fecapaId: participant.fecapaId });
    }
    seen.add(participant.fecapaId);
  }
}

export function formatChanged(source: SourceName, detail: string): FecapaError {
  return new FecapaError("SOURCE_FORMAT_CHANGED", `${source}: unexpected format (${detail})`, { source, detail });
}

export function incompletePlayer(source: SourceName, detail: string): FecapaError {
  return new FecapaError("INCOMPLETE_PLAYER", `${source}: incomplete player identity (${detail})`, { source, detail });
}
