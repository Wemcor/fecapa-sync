import type { Participant } from "./types.js";

/** Uppercase, accent-free, letters and digits only: `"Júlia Prova-Test"` → `"JULIAPROVATEST"`. */
export function normalizePlayerName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A player in your own roster that a report participant can be matched to. */
export type RosterPlayer = {
  name: string;
  /** Previous or alternative spellings of `name`. */
  aliases?: readonly string[];
  /** FECAPA player id, once known. `null`/absent means "not linked yet". */
  fecapaId?: number | null;
};

/**
 * Finds the roster player behind a report participant. Conservative on purpose:
 * 1. exactly one roster player already linked to the participant's FECAPA id wins;
 * 2. otherwise exactly one *unlinked* player whose name or alias normalizes to
 *    the participant's full name;
 * 3. otherwise `null` (no match, or ambiguous). Partial names never match.
 */
export function matchPlayer<T extends RosterPlayer>(participant: Pick<Participant, "fecapaId" | "name">, roster: readonly T[]): T | null {
  const linked = roster.filter((player) => player.fecapaId === participant.fecapaId);
  if (linked.length === 1) return linked[0]!;
  const name = normalizePlayerName(participant.name);
  const matches = roster.filter((player) => (player.fecapaId ?? null) === null &&
    [player.name, ...(player.aliases ?? [])].some((alias) => normalizePlayerName(alias) === name));
  return matches.length === 1 ? matches[0]! : null;
}
