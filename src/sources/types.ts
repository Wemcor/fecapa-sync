import type { HttpClient } from "../http.js";
import type { FullReportRequest, ReportOutcome } from "../parsers/sidgad-json.js";
import type { Match, SourceName } from "../types.js";

/** Everything a source needs for one client operation. */
export type SourceContext = {
  http: HttpClient;
  /** Public portal, e.g. `https://www.hoqueipatins.fecapa.cat`. */
  baseUrl: string;
  /** SIDGAD API base including client/version/modality, e.g. `https://api.sidgad.com/fecapa/v1/hp`. */
  apiUrl: string;
  token?: string;
  /**
   * GET a portal page as text. Memoised for the duration of one operation, so
   * `portal-config` and `legacy-html` share a single download of the same page.
   */
  getPage(url: string): Promise<string>;
  /** Values kept for the lifetime of the client (e.g. the portal's public SIDGAD config). */
  cache: Map<string, unknown>;
};

export interface CalendarSource {
  readonly name: SourceName;
  /** False when the source cannot run with this configuration (e.g. no token). */
  canRun(ctx: SourceContext): boolean;
  getCalendar(competitionId: number, ctx: SourceContext): Promise<Match[]>;
}

export interface ReportSource {
  readonly name: SourceName;
  canRun(ctx: SourceContext): boolean;
  /** Both lineups of a final report, or why there is none yet. */
  getReport(request: FullReportRequest, ctx: SourceContext): Promise<ReportOutcome>;
}

export const calendarPageUrl = (baseUrl: string, competitionId: number) =>
  `${baseUrl}/?liga=${competitionId}&vista=calendar`;

export const reportPageUrl = (baseUrl: string, competitionId: number, matchId: number) =>
  `${calendarPageUrl(baseUrl, competitionId)}&partido=${matchId}`;

/**
 * Headers for SIDGAD API calls.
 *
 * `Origin` is required: checked live on 2026-11-09, the API answers
 * HTTP 200 `{"status":"INVALID DOMAIN"}` when it is absent, and real data when
 * it names the public portal. It is the same value a visitor's browser sends
 * when the portal itself calls the API; we send nothing else browser-like.
 * `Referer` is not required (a Referer-only request was refused the same way),
 * so we don't send it.
 */
export function sidgadHeaders(ctx: SourceContext): Record<string, string> {
  return { origin: new URL(ctx.baseUrl).origin };
}
