import { isFecapaError } from "../errors.js";
import { formatChanged } from "../parsers/common.js";
import { apiBaseFromConfig, extractSidgadConfig, sidgadUrl } from "../parsers/portal-config.js";
import { parseCalendarJson, parseReportOutcomeJson } from "../parsers/sidgad-json.js";
import type { CalendarSource, ReportSource, SourceContext } from "./types.js";
import { calendarPageUrl, reportPageUrl, sidgadHeaders } from "./types.js";

const NAME = "portal-config" as const;
const CACHE_KEY = "portal-config";

type ApiConfig = { apiBase: string; token: string };

/**
 * Reads the public `SIDGAD_API_CONFIG` (API location + public token) from a
 * portal page. The page is large and the config is the same on every page, so
 * it is read once per client and reused.
 */
async function configFrom(pageUrl: string, ctx: SourceContext): Promise<ApiConfig> {
  const cached = ctx.cache.get(CACHE_KEY) as ApiConfig | undefined;
  if (cached) return cached;
  const config = extractSidgadConfig(await ctx.getPage(pageUrl));
  if (!config) throw formatChanged(NAME, "page has no SIDGAD_API_CONFIG");
  const value = { apiBase: apiBaseFromConfig(config), token: config.token };
  ctx.cache.set(CACHE_KEY, value);
  return value;
}

/** A refusal may mean the public token changed: read the page again next time. */
async function withConfig<T>(pageUrl: string, ctx: SourceContext, call: (config: ApiConfig) => Promise<T>): Promise<T> {
  const config = await configFrom(pageUrl, ctx);
  try {
    return await call(config);
  } catch (error) {
    if (isFecapaError(error, "SOURCE_REJECTED")) ctx.cache.delete(CACHE_KEY);
    throw error;
  }
}

export const portalConfigCalendar: CalendarSource = {
  name: NAME,
  canRun: () => true,
  getCalendar(competitionId, ctx) {
    return withConfig(calendarPageUrl(ctx.baseUrl, competitionId), ctx, async ({ apiBase, token }) => {
      const url = sidgadUrl(apiBase, "calendar", competitionId, token);
      return parseCalendarJson(await ctx.http.getJson(url, NAME, sidgadHeaders(ctx)), competitionId, NAME);
    });
  },
};

export const portalConfigReport: ReportSource = {
  name: NAME,
  canRun: () => true,
  getReport(request, ctx) {
    return withConfig(reportPageUrl(ctx.baseUrl, request.competitionId, request.matchId), ctx, async ({ apiBase, token }) => {
      const url = sidgadUrl(apiBase, "report", request.matchId, token);
      return parseReportOutcomeJson(await ctx.http.getJson(url, NAME, sidgadHeaders(ctx)), request, NAME);
    });
  },
};
