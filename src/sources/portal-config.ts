import { formatChanged } from "../parsers/common.js";
import { apiBaseFromConfig, extractSidgadConfig, sidgadUrl } from "../parsers/portal-config.js";
import { parseCalendarJson, parseReportJson } from "../parsers/sidgad-json.js";
import type { CalendarSource, ReportSource, SourceContext } from "./types.js";
import { calendarPageUrl, reportPageUrl, sidgadHeaders } from "./types.js";

const NAME = "portal-config" as const;

/** Reads the public `SIDGAD_API_CONFIG` (API location + public token) from a portal page. */
async function configFrom(pageUrl: string, ctx: SourceContext) {
  const config = extractSidgadConfig(await ctx.getPage(pageUrl));
  if (!config) throw formatChanged(NAME, "page has no SIDGAD_API_CONFIG");
  return { apiBase: apiBaseFromConfig(config), token: config.token };
}

export const portalConfigCalendar: CalendarSource = {
  name: NAME,
  canRun: () => true,
  async getCalendar(competitionId, ctx) {
    const { apiBase, token } = await configFrom(calendarPageUrl(ctx.baseUrl, competitionId), ctx);
    const url = sidgadUrl(apiBase, "calendar", competitionId, token);
    return parseCalendarJson(await ctx.http.getJson(url, NAME, sidgadHeaders(ctx)), competitionId, NAME);
  },
};

export const portalConfigReport: ReportSource = {
  name: NAME,
  canRun: () => true,
  async getReport(request, ctx) {
    const { apiBase, token } = await configFrom(reportPageUrl(ctx.baseUrl, request.competitionId, request.matchId), ctx);
    const url = sidgadUrl(apiBase, "report", request.matchId, token);
    return parseReportJson(await ctx.http.getJson(url, NAME, sidgadHeaders(ctx)), request, NAME);
  },
};
