import { z } from "zod";
import { FecapaError } from "../errors.js";
import type { ExpectTeams, FullReport, Match, Participant, Report, Side, SourceName } from "../types.js";
import { buildMatch, checkDuplicates, checkLineup, checkTeams, clean, formatChanged, fromSpanishDate, incompletePlayer, optionalText, TIME_RE } from "./common.js";

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
    pista: z.string().nullish(),
  })),
});

const rosterEntrySchema = z.object({
  player_id: idValue.nullish(),
  player_name: z.string().nullish(),
  player_role: z.string().nullish(),
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
    tournament_name: z.string().nullish(),
    venue_info: z.string().nullish(),
    home_roster: z.array(rosterEntrySchema).nullish(),
    away_roster: z.array(rosterEntrySchema).nullish(),
    home_goalies: z.array(rosterEntrySchema).nullish(),
    away_goalies: z.array(rosterEntrySchema).nullish(),
  }),
});

// SIDGAD reports refusals as HTTP 200 with a bare `{"status": "..."}` body,
// e.g. "INVALID DOMAIN" (missing Origin) or "NO FILE" (no report file).
const rejectionSchema = z.object({ status: z.string() });

/** The `status` of a bare `{"status": "..."}` SIDGAD answer, or null. */
function rejectionStatus(input: unknown, dataKey: string): string | null {
  if (!input || typeof input !== "object" || dataKey in input) return null;
  const rejection = rejectionSchema.safeParse(input);
  return rejection.success ? rejection.data.status : null;
}

function validate<T>(schema: z.ZodType<T>, input: unknown, source: SourceName, dataKey: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const status = rejectionStatus(input, dataKey);
  if (status !== null) {
    throw new FecapaError("SOURCE_REJECTED", `${source}: SIDGAD refused the request (${status})`, { source, status });
  }
  const issue = parsed.error.issues[0];
  const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "schema mismatch";
  throw formatChanged(source, where);
}

const DIGITS = /^\d+$/;
const NO_DATE = new Set(["", "00/00/0000"]);

/**
 * Maps a SIDGAD calendar. Besides games, the list has separator pseudo-games
 * (`idp` "0"): `dia_partido` "FASE" opens a group (`hora_partido` is its id,
 * `home_name` its name) and "JORNADA" opens a round (`home_name` "JORNADA n").
 * Games keep the group and round they appear under. A game without a date yet
 * is kept with `date: null`; placeholder rows without both teams are skipped.
 */
export function parseCalendarJson(input: unknown, competitionId: number, source: SourceName): Match[] {
  const { games } = validate(calendarSchema, input, source, "games");
  const matches: Match[] = [];
  let phaseId: number | null = null;
  let phaseName: string | null = null;
  let round: number | null = null;
  for (const game of games) {
    const id = String(game.idp);
    const day = clean(game.dia_partido);
    if (!DIGITS.test(id) || id === "0") {
      if (day === "FASE") {
        const rawId = clean(game.hora_partido ?? "");
        phaseId = DIGITS.test(rawId) ? Number(rawId) : null;
        const name = optionalText(game.home_name);
        phaseName = name === "0" ? null : name;
        round = null;
      } else if (day === "JORNADA") {
        const number = /(\d+)\s*$/.exec(game.home_name ?? "")?.[1];
        round = number ? Number(number) : null;
      }
      continue;
    }
    const homeId = String(game.home_id ?? "");
    const awayId = String(game.away_id ?? "");
    const homeName = clean(game.home_name ?? "");
    const awayName = clean(game.away_name ?? "");
    if (!DIGITS.test(homeId) || !DIGITS.test(awayId) || !homeName || !awayName) continue;
    const date = NO_DATE.has(day) ? null : fromSpanishDate(day);
    if (date === null && !NO_DATE.has(day)) throw formatChanged(source, `games: unexpected dia_partido "${day}"`);
    const time = clean(game.hora_partido ?? "");
    if (date !== null && time && !TIME_RE.test(time)) throw formatChanged(source, "games: invalid hora_partido");
    matches.push(buildMatch(competitionId, {
      matchId: Number(id), homeId: Number(homeId), awayId: Number(awayId), homeName, awayName,
      date, time: date !== null && TIME_RE.test(time) ? time : null,
      phaseId, phaseName, round, venue: optionalText(game.pista),
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

/** Missing optional counters may mean zero; a missing final score never does. */
function sidgadScore(value: unknown, source: SourceName, field: string): number {
  if (value === null || value === undefined || value === "") {
    throw formatChanged(source, `${field} is missing from a finished report`);
  }
  const score = sidgadCount(value, source, field);
  if (!Number.isSafeInteger(score)) throw formatChanged(source, `${field} is not a safe integer`);
  return score;
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

/** A report request for both sides. */
export type FullReportRequest = Omit<ReportRequest, "side">;

/** What a report source answers: a final report, or why there isn't one yet. */
export type ReportOutcome =
  | { status: "final"; report: FullReport }
  | { status: "not-finished" | "no-file" };

type RosterEntry = z.infer<typeof rosterEntrySchema>;

function playerId(row: RosterEntry, source: SourceName): number {
  const id = row.player_id;
  const fecapaId = id === null || id === undefined || id === "" ? 0 : sidgadCount(id, source, "player_id");
  if (!fecapaId) throw incompletePlayer(source, "missing player id");
  return fecapaId;
}

function toParticipant(row: RosterEntry, isGoalkeeper: boolean, source: SourceName): Participant {
  return {
    fecapaId: playerId(row, source),
    name: sidgadPlayerName(row.player_name, source),
    isGoalkeeper,
    goals: sidgadCount(row.goals, source, "goals"),
    yellowCards: sidgadCount(row.yellow_card, source, "yellow_card"),
    blueCards: sidgadCount(row.blue_card, source, "blue_card"),
    redCards: sidgadCount(row.red_card, source, "red_card"),
  };
}

/**
 * Goalkeepers: the portal's roller hockey acta prints "P" in its second column
 * when `player_role` is `"P"`. `*_goalies` is empty in every roller hockey
 * acta checked (other SIDGAD sports use it), but a player listed there is a
 * goalkeeper too, and is added if missing from the roster.
 */
function lineup(roster: RosterEntry[] | null | undefined, goalies: RosterEntry[] | null | undefined, source: SourceName): Participant[] {
  const goalieIds = new Set((goalies ?? []).map((row) => playerId(row, source)));
  const players = (roster ?? []).map((row) => {
    const role = clean(row.player_role ?? "").toUpperCase();
    return toParticipant(row, role === "P" || goalieIds.has(playerId(row, source)), source);
  });
  const listed = new Set(players.map((player) => player.fecapaId));
  for (const row of goalies ?? []) {
    if (!listed.has(playerId(row, source))) players.push(toParticipant(row, true, source));
  }
  checkDuplicates(source, players);
  return players;
}

/** Parses a SIDGAD report with both lineups. `{"status":"NO FILE"}` is `no-file`, not an error. */
export function parseReportOutcomeJson(input: unknown, request: FullReportRequest, source: SourceName): ReportOutcome {
  if (rejectionStatus(input, "game_data") === "NO FILE") return { status: "no-file" };
  const { game_data: data } = validate(reportSchema, input, source, "game_data");
  if (String(data.game_completed) !== "true") return { status: "not-finished" };
  const homeName = clean(data.home_team_name);
  const awayName = clean(data.away_team_name);
  checkTeams(source, { home: homeName, away: awayName }, request.expectTeams);
  const home = lineup(data.home_roster, data.home_goalies, source);
  const away = lineup(data.away_roster, data.away_goalies, source);
  if (!home.length && !away.length) throw new FecapaError("EMPTY_LINEUP", "The finished report has no players on either side", { source });
  return {
    status: "final",
    report: {
      matchId: request.matchId,
      competitionId: request.competitionId,
      homeName,
      awayName,
      homeScore: sidgadScore(data.home_team_score, source, "home_team_score"),
      awayScore: sidgadScore(data.away_team_score, source, "away_team_score"),
      venue: optionalText(data.venue_info),
      phaseName: optionalText(data.tournament_name),
      home,
      away,
    },
  };
}

/** Reduces a full report to one side. A side without players is `EMPTY_LINEUP`. */
export function toSideReport(report: FullReport, side: Side, source: SourceName): Report {
  const participants = side === "home" ? report.home : report.away;
  checkLineup(source, participants);
  return {
    matchId: report.matchId,
    competitionId: report.competitionId,
    side,
    homeName: report.homeName,
    awayName: report.awayName,
    homeScore: report.homeScore,
    awayScore: report.awayScore,
    participants,
  };
}

/** One side of a SIDGAD report, or null when there is no final report yet. */
export function parseReportJson(input: unknown, request: ReportRequest, source: SourceName): Report | null {
  const outcome = parseReportOutcomeJson(input, request, source);
  return outcome.status === "final" ? toSideReport(outcome.report, request.side, source) : null;
}
