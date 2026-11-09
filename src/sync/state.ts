import { z } from "zod";
import { FecapaError } from "../errors.js";
import type { SourceName } from "../types.js";
import type { PendingActa } from "./actas.js";
import { DAY_MS, HOUR_MS } from "./duration.js";

export type LeagueState = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  source: SourceName | null;
};

export type SeasonState = {
  games: { leagues: Record<string, LeagueState> };
  actas: { pending: Record<string, PendingActa> };
};

export type RunError = { code: string; message: string; status?: number | string; source?: string; retryAfterMs?: number };

export type Backoff = {
  /** Consecutive failed runs. */
  failures: number;
  /** No request is made before this instant. */
  until: string;
  lastError: RunError;
};

export type RunSummary = {
  startedAt: string;
  finishedAt: string;
  status: "ok" | "partial" | "skipped" | "failed";
  reason?: string;
  requests: number;
  error?: RunError;
};

/** `state.json`: what was synced when, what is due, and the backoff. */
export type SyncState = {
  version: 1;
  seasons: Record<string, SeasonState>;
  backoff: Backoff | null;
  lastRun: RunSummary | null;
};

/** First backoff after a failed run. */
export const BACKOFF_BASE_MS = HOUR_MS;
/** Backoff never grows beyond this. */
export const BACKOFF_MAX_MS = 7 * DAY_MS;

/** 1 h after the first failed run, then 2 h, 4 h, … up to 7 days. */
export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

const stateSchema = z.object({
  version: z.literal(1),
  seasons: z.record(z.string(), z.object({
    games: z.object({ leagues: z.record(z.string(), z.object({}).passthrough()) }),
    actas: z.object({ pending: z.record(z.string(), z.object({}).passthrough()) }),
  }).passthrough()),
  backoff: z.object({ failures: z.number(), until: z.string() }).passthrough().nullable(),
  lastRun: z.object({}).passthrough().nullable(),
}).passthrough();

export function emptyState(): SyncState {
  return { version: 1, seasons: {}, backoff: null, lastRun: null };
}

export function emptySeason(): SeasonState {
  return { games: { leagues: {} }, actas: { pending: {} } };
}

export function parseState(input: unknown, file: string): SyncState {
  if (input === null) return emptyState();
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success) throw new FecapaError("STORE_CORRUPT", `${file} doesn't look like a fecapa-sync state file`, { detail: file });
  return parsed.data as unknown as SyncState;
}
