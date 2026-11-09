export type SourceName = "sidgad-api" | "portal-config" | "legacy-html";

export const SOURCE_NAMES: readonly SourceName[] = ["sidgad-api", "portal-config", "legacy-html"];

/** One fixture from a competition calendar. */
export type Match = {
  /** FECAPA/SIDGAD match id (`idp` / `partido`). Needed to fetch the report. */
  matchId?: number;
  /** Competition id (`liga` / `idc`) the calendar was read from. */
  competitionId: number;
  /**
   * Group/phase id inside the competition. SIDGAD lists one competition as
   * several groups ("FASE" rows), each with its own id and name. `null` when the
   * source doesn't say (legacy HTML).
   */
  phaseId: number | null;
  /** Group/phase name as published, e.g. `"BENJAMÍ PLATA 1"`. `null` when unknown. */
  phaseName: string | null;
  /** Round number ("JORNADA n"), or `null` when unknown. */
  round: number | null;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  /** Local (Europe/Madrid) date, `YYYY-MM-DD`, or `null` when the federation hasn't set one yet. */
  date: string | null;
  /** Local (Europe/Madrid) kickoff, `HH:MM`, or `null` when not published yet. */
  time: string | null;
  /** UTC instant of the kickoff (midnight Madrid time when `time` is null), ISO 8601. `null` when `date` is null. */
  startsAt: string | null;
  /** Venue (rink) as published in the calendar, or `null`. Most competitions leave it empty. */
  venue: string | null;
};

/** One player of one side in a finished match report. */
export type Participant = {
  /** FECAPA player id. Stable across seasons and name changes. */
  fecapaId: number;
  /** Full name as `GIVEN SURNAME(S)`. */
  name: string;
  /**
   * Listed as a goalkeeper ("P") in this report. The acta is the only place
   * the federation records it, and it can change from one game to the next.
   */
  isGoalkeeper: boolean;
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

/** A finished match report with both lineups. */
export type FullReport = {
  matchId: number;
  competitionId: number;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  /** Venue as written in the report, or `null`. */
  venue: string | null;
  /** Group/phase name as written in the report (`tournament_name`), or `null`. */
  phaseName: string | null;
  /** Home players. Staff are excluded. */
  home: Participant[];
  /** Away players. Staff are excluded. */
  away: Participant[];
};

/**
 * - `final`: the match is finished and the report is final.
 * - `not-finished`: the report exists but the match isn't finished.
 * - `no-file`: SIDGAD has no report file (`{"status":"NO FILE"}`). Seen for
 *   future matches, for played matches whose acta isn't uploaded yet, and for
 *   unknown ids alike.
 */
export type ReportStatus = "final" | "not-finished" | "no-file";

export type ExpectTeams = { home: string; away: string };

export type CalendarResult = { source: SourceName; matches: Match[] };

/** `report` is `null` unless `status` is `"final"`. */
export type ReportResult =
  | { source: SourceName; status: "final"; report: Report }
  | { source: SourceName; status: "not-finished" | "no-file"; report: null };

/** `report` is `null` unless `status` is `"final"`. */
export type FullReportResult =
  | { source: SourceName; status: "final"; report: FullReport }
  | { source: SourceName; status: "not-finished" | "no-file"; report: null };

/**
 * Reserved for the `teams` level (0.3); nothing sets it in 0.2. FECAPA has no
 * gender field. The only rule: a team in a `FEM…` category, or in a league
 * whose name contains "Femenina", is a women's team. Everything else is
 * `"unknown"`, because youth leagues can be mixed.
 */
export type Gender = "female" | "unknown";

/** Reserved field shape for team records (0.3). */
export type GenderInfo = { gender: Gender; genderSource: "inferred" };
