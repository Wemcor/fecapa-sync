import { z } from "zod";
import { FecapaError } from "../errors.js";
import type { ExpectTeams, Match, Participant, Report, Side, SourceName } from "../types.js";
import { buildMatch, checkLineup, checkTeams, clean, formatChanged, fromSpanishDate, incompletePlayer, TIME_RE } from "./common.js";

// Only the fields we read are declared. Unknown fields are ignored, so SIDGAD
// adding data never breaks us; removing or retyping a field we use does.
const idValue = z.union([z.string(), z.number()]);
const countValue = z.union([z.number(), z.string()]).nullish();

export const calendarSchema = z.object({
  games: z.array(z.object({
    idp: idValue,
    dia_partido: z.string(),
    hora_partido: z.string().nullish(),
    home_name: z.string().nullish(),
    away_name: z.string().nullish(),
    home_id: idValue.nullish(),
    away_id: idValue.nullish(),
  })),
});

const rosterEntrySchema = z.object({
  player_id: idValue.nullish(),
  player_name: z.string().nullish(),
  goals: countValue,
  yellow_card: countValue,
  blue_card: countValue,
  red_card: countValue,
});

export const reportSchema = z.object({
  game_data: z.object({
    game_completed: z.union([z.string(), z.boolean()]),
    home_team_name: z.string(),
    away_team_name: z.string(),
    home_team_score: countValue,
    away_team_score: countValue,
    home_roster: z.array(rosterEntrySchema).nullish(),
    away_roster: z.array(rosterEntrySchema).nullish(),
  }),
});

// SIDGAD reports refusals as HTTP 200 with a bare `{"status": "..."}` body,
// e.g. "INVALID DOMAIN" (missing Origin) or "NO FILE" (unknown id).
const rejectionSchema = z.object({ status: z.string() });

function validate<T>(schema: z.ZodType<T>, input: unknown, source: SourceName, dataKey: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (input && typeof input === "object" && !(dataKey in input)) {
    const rejection = rejectionSchema.safeParse(input);
    if (rejection.success) {
      throw new FecapaError("SOURCE_REJECTED", `${source}: SIDGAD refused the request (${rejection.data.status})`, { source, status: rejection.data.status });
    }
  }
  const issue = parsed.error.issues[0];
  const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "schema mismatch";
  throw formatChanged(source, where);
}

const DIGITS = /^\d+$/;

export function parseCalendarJson(input: unknown, competitionId: number, source: SourceName): Match[] {
  const { games } = validate(calendarSchema, input, source, "games");
  const matches: Match[] = [];
  for (const game of games) {
    // Phase/round separators come as pseudo-games: idp "0", dia_partido "FASE"/"JORNADA", null ids.
    const id = String(game.idp);
    const homeId = String(game.home_id ?? "");
    const awayId = String(game.away_id ?? "");
    const date = fromSpanishDate(game.dia_partido);
    if (!DIGITS.test(id) || id === "0" || !DIGITS.test(homeId) || !DIGITS.test(awayId) || !date) continue;
    const homeName = clean(game.home_name ?? "");
    const awayName = clean(game.away_name ?? "");
    if (!homeName || !awayName) continue;
    const time = game.hora_partido ?? "";
    matches.push(buildMatch(competitionId, {
      matchId: Number(id), homeId: Number(homeId), awayId: Number(awayId), homeName, awayName,
      date, time: TIME_RE.test(time) ? time : null,
    }));
  }
  return matches;
}

function sidgadCount(value: unknown, source: SourceName, field: string): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && DIGITS.test(value)) return Number(value);
  throw formatChanged(source, `${field} is not a count`);
}

// SIDGAD writes names as "SURNAME(S),GIVEN".
function sidgadPlayerName(value: string | null | undefined, source: SourceName): string {
  if (typeof value !== "string") throw incompletePlayer(source, "missing name");
  const [surname, ...givenParts] = value.split(",");
  const given = clean(givenParts.join(" "));
  const cleanSurname = clean(surname ?? "");
  if (!given || !cleanSurname) throw incompletePlayer(source, "name is not SURNAME,GIVEN");
  return `${given} ${cleanSurname}`;
}

export type ReportRequest = { matchId: number; competitionId: number; side: Side; expectTeams?: ExpectTeams };

export function parseReportJson(input: unknown, request: ReportRequest, source: SourceName): Report | null {
  const { game_data: data } = validate(reportSchema, input, source, "game_data");
  if (String(data.game_completed) !== "true") return null;
  const homeName = clean(data.home_team_name);
  const awayName = clean(data.away_team_name);
  checkTeams(source, { home: homeName, away: awayName }, request.expectTeams);
  const roster = (request.side === "home" ? data.home_roster : data.away_roster) ?? [];
  const participants: Participant[] = roster.map((row) => {
    const id = row.player_id;
    const fecapaId = id === null || id === undefined || id === "" ? 0 : sidgadCount(id, source, "player_id");
    if (!fecapaId) throw incompletePlayer(source, "missing player id");
    return {
      fecapaId,
      name: sidgadPlayerName(row.player_name, source),
      goals: sidgadCount(row.goals, source, "goals"),
      yellowCards: sidgadCount(row.yellow_card, source, "yellow_card"),
      blueCards: sidgadCount(row.blue_card, source, "blue_card"),
      redCards: sidgadCount(row.red_card, source, "red_card"),
    };
  });
  checkLineup(source, participants);
  return {
    matchId: request.matchId,
    competitionId: request.competitionId,
    side: request.side,
    homeName,
    awayName,
    homeScore: sidgadCount(data.home_team_score, source, "home_team_score"),
    awayScore: sidgadCount(data.away_team_score, source, "away_team_score"),
    participants,
  };
}
