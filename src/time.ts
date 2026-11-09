import { FecapaError } from "./errors.js";

const MADRID = "Europe/Madrid";

// Resolves the UTC instant for a Europe/Madrid wall-clock time, correcting
// for CET/CEST via a couple of format-and-compare passes (the offset only
// ever takes two values, so this converges in at most two iterations).
function madridInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(target);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: MADRID, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(dtf.formatToParts(guess).map((p) => [p.type, p.value]));
    const seenAsUTC = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
    const diff = target - seenAsUTC;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

/** Parses `YYYY-MM-DD` (or the legacy `YYYYMMDD`) into numbers. */
export function parseDate(date: string): { year: number; month: number; day: number } {
  const normalized = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new FecapaError("INVALID_ARGUMENT", `Invalid date "${date}", expected YYYY-MM-DD`, { argument: "date" });
  const [, year, month, day] = match;
  const result = { year: Number(year), month: Number(month), day: Number(day) };
  const check = new Date(0);
  check.setUTCFullYear(result.year, result.month - 1, result.day);
  if (result.year < 1 || check.getUTCFullYear() !== result.year
      || check.getUTCMonth() + 1 !== result.month || check.getUTCDate() !== result.day) {
    throw new FecapaError("INVALID_ARGUMENT", `Invalid calendar date "${date}"`, { argument: "date" });
  }
  return result;
}

/**
 * FECAPA prints kickoffs as a Barcelona wall clock with no zone. Returns the
 * ISO UTC instant for that Europe/Madrid time. A missing time means midnight.
 *
 * @param date `YYYY-MM-DD` (`YYYYMMDD` is also accepted)
 * @param time `HH:MM` / `H:MM`, or `null`
 */
export function toStartsAt(date: string, time: string | null): string {
  const { year, month, day } = parseDate(date);
  const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time ?? "00:00");
  if (!timeMatch) throw new FecapaError("INVALID_ARGUMENT", `Invalid time "${time}", expected HH:MM`, { argument: "time" });
  return madridInstant(year, month, day, Number(timeMatch[1]), Number(timeMatch[2])).toISOString();
}

/** The sports season changes on 1 July, Madrid time. Returns e.g. `"2026/2027"`. */
export function currentSeason(now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", { timeZone: MADRID, year: "numeric", month: "numeric" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year) - (Number(parts.month) < 7 ? 1 : 0);
  return `${year}/${year + 1}`;
}
