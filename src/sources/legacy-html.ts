import { formatChanged } from "../parsers/common.js";
import { parseCalendarHtml, parseFullReportHtml } from "../parsers/legacy-html.js";
import type { CalendarSource, ReportSource } from "./types.js";
import { calendarPageUrl, reportPageUrl } from "./types.js";

const NAME = "legacy-html" as const;

/** Parses calendars and reports rendered server-side into the portal page (pre-2026 portal). */
export const legacyHtmlCalendar: CalendarSource = {
  name: NAME,
  canRun: () => true,
  async getCalendar(competitionId, ctx) {
    const html = await ctx.getPage(calendarPageUrl(ctx.baseUrl, competitionId));
    const matches = parseCalendarHtml(html, competitionId, ctx.baseUrl);
    // An HTML page with no recognisable rows can't be told apart from a layout change.
    if (!matches.length) throw formatChanged(NAME, "no calendar rows found");
    return matches;
  },
};

export const legacyHtmlReport: ReportSource = {
  name: NAME,
  canRun: () => true,
  async getReport(request, ctx) {
    const html = await ctx.getPage(reportPageUrl(ctx.baseUrl, request.competitionId, request.matchId));
    return parseFullReportHtml(html, request);
  },
};
