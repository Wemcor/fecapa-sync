import { FecapaError } from "../errors.js";

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const HOUR_MS = UNIT_MS.h;
export const DAY_MS = UNIT_MS.d;

/** `"30m"`, `"24h"`, `"7d"` → milliseconds. */
export function parseDuration(value: string, argument = "duration"): number {
  const match = /^\s*(\d+)\s*([mhd])\s*$/.exec(value);
  if (!match || Number(match[1]) <= 0) {
    throw new FecapaError("INVALID_CONFIG", `${argument}: "${value}" is not a duration like "30m", "24h" or "7d"`, { detail: argument });
  }
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Milliseconds → `"…d"` from 2 days, else `"…h"`, else `"…m"`. */
export function formatDuration(ms: number): string {
  if (ms % DAY_MS === 0 && ms > DAY_MS) return `${ms / DAY_MS}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  return `${Math.round(ms / UNIT_MS.m)}m`;
}
