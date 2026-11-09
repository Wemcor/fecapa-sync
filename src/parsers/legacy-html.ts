import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { Match, Participant, Report } from "../types.js";
import { FecapaError } from "../errors.js";
import { buildMatch, checkDuplicates, checkTeams, clean, formatChanged, fromSpanishDate, incompletePlayer, optionalText, TIME_RE } from "./common.js";
import { toSideReport, type FullReportRequest, type ReportOutcome, type ReportRequest } from "./sidgad-json.js";

const SOURCE = "legacy-html" as const;

type RawMatch = Omit<Match, "competitionId" | "startsAt" | "phaseId" | "phaseName" | "round" | "venue"> & Partial<Pick<Match, "phaseName" | "venue">>;

/**
 * Parses a server-rendered calendar. Two layouts are known:
 * - the old fragment: `<tr class="team_{homeId} team_{awayId} team_class" gamedate="YYYYMMDD">`
 *   with names in `.nombre_junto_logo` (home first);
 * - a conventional table with Data/Hora/Local/Visitant headers (Catalan or Spanish).
 * Returns every match found; an empty array means neither layout matched.
 */
export function parseCalendarHtml(html: string, competitionId: number, baseUrl: string): Match[] {
  const $ = cheerio.load(html);
  const matches: RawMatch[] = [];

  $("tr.team_class").each((_, row) => {
    const ids = ($(row).attr("class") ?? "")
      .split(/\s+/)
      .filter((token) => /^team_\d+$/.test(token))
      .map((token) => Number(token.slice("team_".length)));
    if (ids.length < 2) return;
    const [homeId, awayId] = ids as [number, number];

    const gamedate = $(row).attr("gamedate");
    if (!gamedate || !/^\d{8}$/.test(gamedate)) return;
    // The portal printed games without a date as 00/00/0000 (`gamedate="00000000"`).
    const date = gamedate === "00000000" ? null : `${gamedate.slice(0, 4)}-${gamedate.slice(4, 6)}-${gamedate.slice(6, 8)}`;

    const names = $(row).find(".nombre_junto_logo").map((_, node) => clean($(node).text())).get();
    if (names.length < 2) return;
    const [homeName, awayName] = names as [string, string];

    // Time is matched by shape (HH:MM), not cell position: the row layout
    // isn't guaranteed stable across competition phases.
    let time: string | null = null;
    $(row).find("td.tabla_standard_less").each((_, cell) => {
      const text = $(cell).text().trim();
      if (TIME_RE.test(text)) time = text;
    });

    const reportId = $(row).find(".game_report[idp]").attr("idp");
    const matchId = reportId && /^\d+$/.test(reportId) ? Number(reportId) : calendarMatchId($, row, baseUrl);
    matches.push({
      matchId, homeId, awayId, homeName, awayName, date,
      time: date === null ? null : time,
    });
  });

  // Column labels are used rather than fixed indexes so Catalan/Spanish
  // labels and an optional venue/result column are harmless.
  if (!matches.length) {
    $("table").each((_, table) => {
      const headerRow = $(table).find("thead tr").last().length
        ? $(table).find("thead tr").last()
        : $(table).find("tr").filter((_, row) => $(row).find("th").length > 0).first();
      const headers = headerRow.find("th,td").map((_, cell) => clean($(cell).text()).toLowerCase()).get();
      const column = (...names: string[]) => headers.findIndex((header) => names.some((name) => header === name || header.startsWith(`${name} `)));
      const dateColumn = column("data", "fecha");
      const timeColumn = column("hora");
      const homeColumn = column("local");
      const awayColumn = column("visitant", "visitante");
      const venueColumn = column("pista");
      const competitionColumn = column("competició", "competición", "competicio", "competicion");
      if ([dateColumn, timeColumn, homeColumn, awayColumn].some((index) => index < 0)) return;

      $(table).find("tr").not(headerRow).each((_, row) => {
        const cells = $(row).children("td");
        const rawDate = clean(cells.eq(dateColumn).text());
        const date = rawDate === "00/00/0000" ? null : fromSpanishDate(rawDate);
        if (!date && rawDate !== "00/00/0000") return;
        const homeName = clean(cells.eq(homeColumn).text());
        const awayName = clean(cells.eq(awayColumn).text());
        if (!homeName || !awayName) return;
        const ids = calendarTeamIds($, row, cells.eq(homeColumn), cells.eq(awayColumn));
        if (!ids) return;
        const rawTime = clean(cells.eq(timeColumn).text());
        matches.push({
          matchId: calendarMatchId($, row, baseUrl),
          homeId: ids[0], awayId: ids[1], homeName, awayName, date,
          time: date !== null && TIME_RE.test(rawTime) ? rawTime : null,
          venue: venueColumn < 0 ? null : optionalText(cells.eq(venueColumn).text()),
          phaseName: competitionColumn < 0 ? null : optionalText(cells.eq(competitionColumn).text()),
        });
      });
    });
  }

  return matches.map((match) => buildMatch(competitionId, match));
}

function numericAttribute($: cheerio.CheerioAPI, node: AnyNode, names: string[]): number | undefined {
  for (const candidate of [node, ...$(node).find("*").toArray()]) {
    for (const name of names) {
      const value = $(candidate).attr(name);
      if (value && /^\d+$/.test(value)) return Number(value);
    }
  }
  return undefined;
}

function calendarMatchId($: cheerio.CheerioAPI, row: AnyNode, baseUrl: string): number | undefined {
  const direct = numericAttribute($, row, ["idp", "data-idp", "data-match-id", "data-partido-id"]);
  if (direct) return direct;
  for (const link of $(row).find("a[href]").toArray()) {
    const href = $(link).attr("href");
    if (!href) continue;
    try {
      const value = new URL(href, baseUrl).searchParams.get("partido");
      if (value && /^\d+$/.test(value)) return Number(value);
    } catch {
      // Ignore malformed third-party links in the federation's markup.
    }
  }
  return undefined;
}

function calendarTeamId($: cheerio.CheerioAPI, cell: cheerio.Cheerio<AnyNode>): number | undefined {
  const nodes = [cell.get(0), ...cell.find("*").toArray()].filter((node): node is AnyNode => Boolean(node));
  for (const node of nodes) {
    const direct = numericAttribute($, node, ["data-team-id", "data-equipo-id", "ide", "id_equipo"]);
    if (direct) return direct;
    const text = `${$(node).attr("class") ?? ""} ${$(node).attr("href") ?? ""}`;
    const match = /(?:team_|(?:ide|id_equipo)=)(\d+)/.exec(text);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function calendarTeamIds($: cheerio.CheerioAPI, row: AnyNode, home: cheerio.Cheerio<AnyNode>, away: cheerio.Cheerio<AnyNode>): [number, number] | null {
  const homeId = calendarTeamId($, home);
  const awayId = calendarTeamId($, away);
  if (homeId && awayId) return [homeId, awayId];
  const rowIds = ($(row).attr("class") ?? "").match(/team_(\d+)/g)?.map((value) => Number(value.slice(5))) ?? [];
  return rowIds.length >= 2 ? [rowIds[0]!, rowIds[1]!] : null;
}

function count(value: string, blankIsZero = true): number {
  const text = clean(value);
  if (!text && blankIsZero) return 0;
  if (!/^\d+$/.test(text)) throw formatChanged(SOURCE, "a numeric cell is not a count");
  return Number(text);
}

/**
 * Parses the server-rendered report summary (`#div_ficha_resumen`), which has
 * yellow cards and stable player ids (the printable version has no yellows).
 * Both lineups are returned. The second column of a player row holds "P" for
 * a goalkeeper.
 */
export function parseFullReportHtml(html: string, request: FullReportRequest): ReportOutcome {
  const $ = cheerio.load(html);
  // Original behaviour returned null whenever `.periodo_fin` was missing, which
  // also hid a page without any report markup. Only a present-but-unfinished
  // period marker means "not finished"; no marker at all means a format change.
  const period = $("#game_period");
  if (!period.length) throw formatChanged(SOURCE, "no #game_period");
  if (!period.hasClass("periodo_fin")) return { status: "not-finished" };

  const homeName = clean($(".nombre1").text());
  const awayName = clean($(".nombre2").text());
  checkTeams(SOURCE, { home: homeName, away: awayName }, request.expectTeams);

  const tables = $("#div_ficha_resumen table.competiciones_tabla_basic").filter((_, table) => $(table).find(".nombre_equipo_thickbox_stats").length === 1);
  if (tables.length !== 2) throw formatChanged(SOURCE, "expected two lineup tables");
  const [home, away] = [tables.eq(0), tables.eq(1)].map((table) => parseLineup($, table));
  if (!home!.length && !away!.length) throw new FecapaError("EMPTY_LINEUP", "The finished report has no players on either side", { source: SOURCE });

  return {
    status: "final",
    report: {
      matchId: request.matchId,
      competitionId: request.competitionId,
      homeName,
      awayName,
      homeScore: count($("#home_score").text(), false),
      awayScore: count($("#away_score").text(), false),
      venue: null,
      phaseName: null,
      home: home!,
      away: away!,
    },
  };
}

function parseLineup($: cheerio.CheerioAPI, table: cheerio.Cheerio<AnyNode>): Participant[] {
  const heading = table.find("thead tr").filter((_, row) => $(row).find("th").first().text().trim() === "Nº").first();
  const headers = heading.children("th");
  // Check the columns before reading blank cells as zeros.
  if (headers.length !== 14 || headers.eq(1).text().trim() !== "P" || headers.eq(5).text().trim() !== "G" ||
      !headers.eq(11).find('[style*="#FFCC00"]').length ||
      !headers.eq(12).find(".game_view_incidencias_azul").length ||
      !headers.eq(13).find(".game_view_incidencias_roja").length) {
    throw formatChanged(SOURCE, "lineup columns changed");
  }

  const numberedRows = table.find("tbody tr").filter((_, row) => /^\d+$/.test($(row).children("td").first().text().trim()));
  const playerNodes = table.find(".player_season_stats[id_player]");
  if (numberedRows.length !== playerNodes.length) throw incompletePlayer(SOURCE, "a lineup row has no player id");

  const participants: Participant[] = playerNodes.toArray().map((node) => {
    const cells = $(node).closest("tr").children("td");
    if (cells.length !== 15 || !/^\d+$/.test(cells.eq(0).text().trim())) throw formatChanged(SOURCE, "player row has an unexpected shape");
    const nameNode = $(node).clone();
    const givenName = clean(nameNode.find("span.texto_gris_11").text());
    // `<spam>` (sic) holds the nationality flag in FECAPA's markup.
    nameNode.find("spam, span").remove();
    const surname = clean(nameNode.text());
    const rawId = $(node).attr("id_player") ?? "";
    const fecapaId = /^\d+$/.test(rawId) ? Number(rawId) : 0;
    if (!givenName || !surname || !fecapaId) throw incompletePlayer(SOURCE, "missing id or name");
    return {
      fecapaId, name: `${givenName} ${surname}`, isGoalkeeper: clean(cells.eq(1).text()).toUpperCase() === "P",
      goals: count(cells.eq(6).text()),
      yellowCards: count(cells.eq(12).text()), blueCards: count(cells.eq(13).text()), redCards: count(cells.eq(14).text()),
    };
  });
  checkDuplicates(SOURCE, participants);
  return participants;
}

/** One side of the server-rendered report, or null while the match is not finished. */
export function parseReportHtml(html: string, request: ReportRequest): Report | null {
  const outcome = parseFullReportHtml(html, request);
  return outcome.status === "final" ? toSideReport(outcome.report, request.side, SOURCE) : null;
}
