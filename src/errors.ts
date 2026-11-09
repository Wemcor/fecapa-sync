import type { SourceName } from "./types.js";

/**
 * Stable error codes. Match on `error.code`, never on `error.message`:
 * messages may be reworded, codes only change in a major release.
 */
export const ErrorCode = {
  /** The server answered with a non-2xx HTTP status. Context: `status`, `url`. */
  HTTP_ERROR: "HTTP_ERROR",
  /** The request failed before any response (DNS, TLS, timeout...). Context: `url`. */
  NETWORK_ERROR: "NETWORK_ERROR",
  /** The server answered 2xx with an empty body. Context: `url`. */
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  /** The response no longer has the shape this source expects. Context: `source`. */
  SOURCE_FORMAT_CHANGED: "SOURCE_FORMAT_CHANGED",
  /** SIDGAD answered with `{"status": "..."}` instead of data (bad token, unknown id...). Context: `status`. */
  SOURCE_REJECTED: "SOURCE_REJECTED",
  /** The report belongs to other teams than `expectTeams`. Context: `expected`, `actual`. */
  TEAMS_MISMATCH: "TEAMS_MISMATCH",
  /** A lineup row has no player id or no full name. */
  INCOMPLETE_PLAYER: "INCOMPLETE_PLAYER",
  /** The same player id appears twice in one lineup. Context: `fecapaId`. */
  DUPLICATE_LINEUP: "DUPLICATE_LINEUP",
  /** A finished report has no players for the requested side. */
  EMPTY_LINEUP: "EMPTY_LINEUP",
  /** More than one source was tried and every one failed. Context: `attempts`. */
  ALL_SOURCES_FAILED: "ALL_SOURCES_FAILED",
  /** No configured source could run (e.g. only `sidgad-api` and no token). */
  NO_SOURCE_AVAILABLE: "NO_SOURCE_AVAILABLE",
  /** A caller passed an invalid argument. Context: `argument`. */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  /** The sync configuration is invalid or asks for something not available yet. Context: `detail`. */
  INVALID_CONFIG: "INVALID_CONFIG",
  /** A file in the local store can't be read as what it should be. Context: `detail` (the path). */
  STORE_CORRUPT: "STORE_CORRUPT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type SourceAttempt = { source: SourceName; error: FecapaError };

export type FecapaErrorContext = {
  /** Retry-After delay in milliseconds, for the caller's persistent backoff. */
  retryAfterMs?: number;
  source?: SourceName;
  status?: number | string;
  url?: string;
  expected?: { home: string; away: string };
  actual?: { home: string; away: string };
  fecapaId?: number;
  argument?: string;
  attempts?: SourceAttempt[];
  /** Free-form detail, e.g. which field failed validation. Not stable. */
  detail?: string;
};

export class FecapaError extends Error {
  declare readonly retryAfterMs?: number;
  readonly code: ErrorCode;
  declare readonly source?: SourceName;
  declare readonly status?: number | string;
  declare readonly url?: string;
  declare readonly expected?: { home: string; away: string };
  declare readonly actual?: { home: string; away: string };
  declare readonly fecapaId?: number;
  declare readonly argument?: string;
  declare readonly attempts?: SourceAttempt[];
  declare readonly detail?: string;

  constructor(code: ErrorCode, message: string, context: FecapaErrorContext = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FecapaError";
    this.code = code;
    Object.assign(this, stripUndefined(context));
  }
}

export function isFecapaError(value: unknown, code?: ErrorCode): value is FecapaError {
  return value instanceof FecapaError && (code === undefined || value.code === code);
}

function stripUndefined(context: FecapaErrorContext): FecapaErrorContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}

/** Removes the SIDGAD token from a URL so it never ends up in logs or errors. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("jwt")) parsed.searchParams.set("jwt", "REDACTED");
    return parsed.toString();
  } catch {
    return url.replace(/([?&]jwt=)[^&#]*/g, "$1REDACTED");
  }
}
