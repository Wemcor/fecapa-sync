export type SourceName = "sidgad-api" | "portal-config" | "legacy-html";

export const SOURCE_NAMES: readonly SourceName[] = ["sidgad-api", "portal-config", "legacy-html"];

/** One fixture from a competition calendar. */
export type Match = {
  /** FECAPA/SIDGAD match id (`idp` / `partido`). Needed to fetch the report. */
  matchId?: number;
  /** Competition id (`liga` / `idc`) the calendar was read from. */
  competitionId: number;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  /** Local (Europe/Madrid) date, `YYYY-MM-DD`. */
  date: string;
  /** Local (Europe/Madrid) kickoff, `HH:MM`, or `null` when not published yet. */
  time: string | null;
  /** UTC instant of the kickoff (midnight Madrid time when `time` is null), ISO 8601. */
  startsAt: string;
};

/** One player of one side in a finished match report. */
export type Participant = {
  /** FECAPA player id. Stable across seasons and name changes. */
  fecapaId: number;
  /** Full name as `GIVEN SURNAME(S)`. */
  name: string;
  goals: number;
  yellowCards: number;
  blueCards: number;
  redCards: number;
};

export type Side = "home" | "away";

/** A finished match report ("acta"), reduced to one side's lineup. */
export type Report = {
  matchId: number;
  competitionId: number;
  side: Side;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  /** Players of `side`. Staff are excluded. */
  participants: Participant[];
};

export type ExpectTeams = { home: string; away: string };

export type CalendarResult = { source: SourceName; matches: Match[] };

/** `report` is `null` when the match is not finished yet. */
export type ReportResult = { source: SourceName; report: Report | null };
