import { FecapaError } from "../errors.js";
import { parseDate, toStartsAt } from "../time.js";
import type { ExpectTeams, Match, Participant, SourceName } from "../types.js";

export const clean = (value: string) => value.replace(/\s+/g, " ").trim();

export const TIME_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;

/** `DD/MM/YYYY` → `YYYY-MM-DD`, or null. */
export function fromSpanishDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match || value === "00/00/0000") return null;
  const date = `${match[3]}-${match[2]}-${match[1]}`;
  try { parseDate(date); } catch { return null; }
  return date;
}

type RawMatch = Omit<Match, "competitionId" | "startsAt" | "phaseId" | "phaseName" | "round" | "venue"> &
  Partial<Pick<Match, "phaseId" | "phaseName" | "round" | "venue">>;

export function buildMatch(competitionId: number, raw: RawMatch): Match {
  const match: Match = {
    competitionId,
    phaseId: raw.phaseId ?? null,
    phaseName: raw.phaseName ?? null,
    round: raw.round ?? null,
    homeId: raw.homeId,
    awayId: raw.awayId,
    homeName: raw.homeName,
    awayName: raw.awayName,
    date: raw.date,
    time: raw.time,
    startsAt: raw.date === null ? null : toStartsAt(raw.date, raw.time),
    venue: raw.venue ?? null,
  };
  if (raw.matchId !== undefined) match.matchId = raw.matchId;
  return match;
}

/** Trimmed text, or null when empty or a SIDGAD placeholder (`--`). */
export function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = clean(value);
  return text && text !== "--" ? text : null;
}

export function checkTeams(source: SourceName, actual: ExpectTeams, expected: ExpectTeams | undefined): void {
  if (!expected) return;
  if (clean(actual.home) !== clean(expected.home) || clean(actual.away) !== clean(expected.away)) {
    throw new FecapaError("TEAMS_MISMATCH", "The report belongs to different teams than expected", { source, expected, actual });
  }
}

export function checkLineup(source: SourceName, participants: Participant[]): void {
  if (!participants.length) throw new FecapaError("EMPTY_LINEUP", "The finished report has no players for this side", { source });
  checkDuplicates(source, participants);
}

export function checkDuplicates(source: SourceName, participants: Participant[]): void {
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
