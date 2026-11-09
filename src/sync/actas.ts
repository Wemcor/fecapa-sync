import type { FullReport, SourceName } from "../types.js";
import { DAY_MS, HOUR_MS } from "./duration.js";
import type { GameRecord } from "./games.js";

/** A final acta in the local store (`actas/<matchId>.json`). Never fetched again once stored. */
export type ActaRecord = FullReport & {
  homeId: number;
  awayId: number;
  /** Kickoff of the game when the acta was fetched. */
  startsAt: string | null;
  /** Which data source answered. */
  source: SourceName;
  firstSeenAt: string;
  updatedAt: string;
};

/** An acta that was requested but wasn't available yet. */
export type PendingActa = {
  competitionId: number;
  /** The game's kickoff when these attempts were made. A new kickoff starts over. */
  startsAt: string;
  attempts: number;
  lastAttemptAt: string;
  /** `null` once the sync has given up. */
  nextAttemptAt: string | null;
  lastStatus: "not-finished" | "no-file" | "error";
  /** Error code when `lastStatus` is `"error"`. */
  lastError?: string;
  gaveUp: boolean;
};

/** Wait after the kickoff before asking for an acta. */
export const ACTA_GRACE_MS = 3 * HOUR_MS;
/** Retries never wait longer than this. */
export const ACTA_MAX_RETRY_SPACING_MS = 7 * DAY_MS;
/** Requests per acta before giving up (until the game is rescheduled). */
export const ACTA_MAX_ATTEMPTS = 6;

/**
 * When an acta may first be requested: kickoff + 3 h. With no published time
 * the kickoff is unknown, so the end of that day (+ 3 h) is used instead.
 */
export function actaEligibleAt(game: Pick<GameRecord, "startsAt" | "time">): number | null {
  if (game.startsAt === null) return null;
  return Date.parse(game.startsAt) + (game.time === null ? DAY_MS : 0) + ACTA_GRACE_MS;
}

/** Wait after the `attempts`-th unsuccessful attempt: base, 2×base, 4×base…, capped at 7 days. */
export function actaRetrySpacing(attempts: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), ACTA_MAX_RETRY_SPACING_MS);
}

/** Records an unsuccessful attempt. */
export function recordActaAttempt(
  previous: PendingActa | undefined, game: GameRecord, outcome: { status: PendingActa["lastStatus"]; error?: string },
  now: Date, baseMs: number,
): PendingActa {
  const sameKickoff = previous && previous.startsAt === game.startsAt;
  const attempts = (sameKickoff ? previous.attempts : 0) + 1;
  const gaveUp = attempts >= ACTA_MAX_ATTEMPTS;
  const pending: PendingActa = {
    competitionId: game.competitionId,
    startsAt: game.startsAt!,
    attempts,
    lastAttemptAt: now.toISOString(),
    nextAttemptAt: gaveUp ? null : new Date(now.getTime() + actaRetrySpacing(attempts, baseMs)).toISOString(),
    lastStatus: outcome.status,
    gaveUp,
  };
  if (outcome.error) pending.lastError = outcome.error;
  return pending;
}

/** Whether an acta is due now. */
export function actaDue(game: GameRecord, pending: PendingActa | undefined, now: Date): boolean {
  if (game.removedAt !== null || game.matchId === null) return false;
  const eligibleAt = actaEligibleAt(game);
  if (eligibleAt === null || eligibleAt > now.getTime()) return false;
  if (!pending || pending.startsAt !== game.startsAt) return true;
  if (pending.gaveUp || pending.nextAttemptAt === null) return false;
  return Date.parse(pending.nextAttemptAt) <= now.getTime();
}
