import { FecapaError, type SourceAttempt } from "./errors.js";
import { HttpClient, type FetchLike } from "./http.js";
import { toSideReport, type FullReportRequest } from "./parsers/sidgad-json.js";
import { legacyHtmlCalendar, legacyHtmlReport } from "./sources/legacy-html.js";
import { portalConfigCalendar, portalConfigReport } from "./sources/portal-config.js";
import { sidgadApiCalendar, sidgadApiReport } from "./sources/sidgad-api.js";
import type { CalendarSource, ReportSource, SourceContext } from "./sources/types.js";
import { SOURCE_NAMES, type CalendarResult, type ExpectTeams, type FullReportResult, type ReportResult, type Side, type SourceName } from "./types.js";
import { DEFAULT_USER_AGENT } from "./version.js";

export const DEFAULT_BASE_URL = "https://www.hoqueipatins.fecapa.cat";
export const DEFAULT_API_URL = "https://api.sidgad.com/fecapa/v1/hp";
export const DEFAULT_DELAY_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type ClientOptions = {
  /** Public portal origin. Default `https://www.hoqueipatins.fecapa.cat`. */
  baseUrl?: string;
  /** SIDGAD API base used by the `sidgad-api` source. Default `https://api.sidgad.com/fecapa/v1/hp`. */
  apiUrl?: string;
  /** SIDGAD token for the `sidgad-api` source. Without it that source is skipped. Never commit it. */
  token?: string;
  /** Defaults to `fecapa-sync/<version> (+https://github.com/jmedinafruitos/fecapa-sync)`. */
  userAgent?: string;
  /** Inject a fetch implementation (tests, proxies). Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Sources to try, in order. Default `["sidgad-api", "portal-config", "legacy-html"]`. */
  sources?: SourceName[];
  /** Pause between consecutive requests, in ms. Requests never run in parallel. Default 1000. */
  delayMs?: number;
  /** Per-request timeout, in ms. Default 20000. */
  timeoutMs?: number;
  /** How to wait `delayMs` between requests. For tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type GetReportOptions = {
  /** Competition id (`liga`) the match belongs to. */
  idc: number;
  /** Which lineup to return. */
  side: Side;
  /** If given, the report must be for exactly these team names, or `TEAMS_MISMATCH` is thrown. */
  expectTeams?: ExpectTeams;
};

export type GetFullReportOptions = Omit<GetReportOptions, "side">;

export type FecapaClient = {
  /** All fixtures of a competition. */
  getCalendar(idc: number): Promise<CalendarResult>;
  /** One side of a match report. `report` is `null` unless `status` is `"final"`. */
  getReport(matchId: number, options: GetReportOptions): Promise<ReportResult>;
  /** Both lineups of a match report, in one request. `report` is `null` unless `status` is `"final"`. */
  getFullReport(matchId: number, options: GetFullReportOptions): Promise<FullReportResult>;
};

const CALENDAR_SOURCES: Record<SourceName, CalendarSource> = {
  "sidgad-api": sidgadApiCalendar,
  "portal-config": portalConfigCalendar,
  "legacy-html": legacyHtmlCalendar,
};

const REPORT_SOURCES: Record<SourceName, ReportSource> = {
  "sidgad-api": sidgadApiReport,
  "portal-config": portalConfigReport,
  "legacy-html": legacyHtmlReport,
};

// Errors about the source itself: try the next one. Anything else (wrong
// teams, a broken lineup) is about the data and would be the same everywhere.
const FALL_THROUGH = new Set<string>(["HTTP_ERROR", "NETWORK_ERROR", "EMPTY_RESPONSE", "SOURCE_FORMAT_CHANGED", "SOURCE_REJECTED"]);

function positiveInteger(value: unknown, argument: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new FecapaError("INVALID_ARGUMENT", `${argument} must be a positive integer`, { argument });
  }
  return value;
}

export function createClient(options: ClientOptions = {}): FecapaClient {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new FecapaError("INVALID_ARGUMENT", "No fetch implementation available", { argument: "fetch" });
  const sources = options.sources ?? [...SOURCE_NAMES];
  for (const name of sources) {
    if (!SOURCE_NAMES.includes(name)) throw new FecapaError("INVALID_ARGUMENT", `Unknown source "${name}"`, { argument: "sources" });
  }
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!(delayMs >= 0)) throw new FecapaError("INVALID_ARGUMENT", "delayMs must be >= 0", { argument: "delayMs" });

  const http = new HttpClient({
    fetch: fetchImpl,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    delayMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const cache = new Map<string, unknown>();
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");

  const newContext = (): SourceContext => {
    const pages = new Map<string, Promise<string>>();
    const ctx: SourceContext = {
      http, baseUrl, apiUrl, cache,
      getPage(url) {
        let page = pages.get(url);
        if (!page) {
          page = http.getText(url, { accept: "text/html" });
          pages.set(url, page);
        }
        return page;
      },
    };
    if (options.token) ctx.token = options.token;
    return ctx;
  };

  async function run<S extends CalendarSource | ReportSource, T>(
    registry: Record<SourceName, S>, call: (source: S, ctx: SourceContext) => Promise<T>,
  ): Promise<{ source: SourceName; value: T }> {
    const ctx = newContext();
    const attempts: SourceAttempt[] = [];
    for (const name of sources) {
      const source = registry[name];
      if (!source.canRun(ctx)) continue;
      try {
        return { source: name, value: await call(source, ctx) };
      } catch (error) {
        if (!(error instanceof FecapaError)) throw error;
        if (error.source === undefined) (error as { source?: SourceName }).source = name;
        if (!FALL_THROUGH.has(error.code)) throw error;
        attempts.push({ source: name, error });
      }
    }
    if (!attempts.length) {
      throw new FecapaError("NO_SOURCE_AVAILABLE", "No configured source can run (sidgad-api needs a token)", { attempts });
    }
    if (attempts.length === 1) throw attempts[0]!.error;
    const summary = attempts.map((attempt) => `${attempt.source}: ${attempt.error.code}`).join("; ");
    throw new FecapaError("ALL_SOURCES_FAILED", `All sources failed (${summary})`, { attempts });
  }

  function fullRequest(matchId: number, opts: GetFullReportOptions | undefined): FullReportRequest {
    const request: FullReportRequest = {
      matchId: positiveInteger(matchId, "matchId"),
      competitionId: positiveInteger(opts?.idc, "idc"),
    };
    if (opts?.expectTeams) request.expectTeams = opts.expectTeams;
    return request;
  }

  return {
    async getCalendar(idc) {
      const competitionId = positiveInteger(idc, "idc");
      const { source, value } = await run(CALENDAR_SOURCES, (s, ctx) => s.getCalendar(competitionId, ctx));
      return { source, matches: value };
    },
    async getReport(matchId, opts) {
      const request = fullRequest(matchId, opts);
      const side = opts?.side;
      if (side !== "home" && side !== "away") {
        throw new FecapaError("INVALID_ARGUMENT", 'side must be "home" or "away"', { argument: "side" });
      }
      const { source, value } = await run(REPORT_SOURCES, (s, ctx) => s.getReport(request, ctx));
      if (value.status !== "final") return { source, status: value.status, report: null };
      return { source, status: "final", report: toSideReport(value.report, side, source) };
    },
    async getFullReport(matchId, opts) {
      const request = fullRequest(matchId, opts);
      const { source, value } = await run(REPORT_SOURCES, (s, ctx) => s.getReport(request, ctx));
      return value.status === "final" ? { source, status: "final", report: value.report } : { source, status: value.status, report: null };
    },
  };
}
