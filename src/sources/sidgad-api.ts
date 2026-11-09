import { sidgadUrl } from "../parsers/portal-config.js";
import { parseCalendarJson, parseReportJson } from "../parsers/sidgad-json.js";
import type { CalendarSource, ReportSource } from "./types.js";
import { sidgadHeaders } from "./types.js";

const NAME = "sidgad-api" as const;

/** Calls the SIDGAD JSON API directly with a caller-supplied token. Skipped without a token. */
export const sidgadApiCalendar: CalendarSource = {
  name: NAME,
  canRun: (ctx) => Boolean(ctx.token),
  async getCalendar(competitionId, ctx) {
    const url = sidgadUrl(ctx.apiUrl, "calendar", competitionId, ctx.token!);
    return parseCalendarJson(await ctx.http.getJson(url, NAME, sidgadHeaders(ctx)), competitionId, NAME);
  },
};

export const sidgadApiReport: ReportSource = {
  name: NAME,
  canRun: (ctx) => Boolean(ctx.token),
  async getReport(request, ctx) {
    const url = sidgadUrl(ctx.apiUrl, "report", request.matchId, ctx.token!);
    return parseReportJson(await ctx.http.getJson(url, NAME, sidgadHeaders(ctx)), request, NAME);
  },
};
