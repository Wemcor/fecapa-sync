import { access } from "node:fs/promises";
import path from "node:path";
import { createClient, type ClientOptions } from "../client.js";
import { FecapaError, isFecapaError } from "../errors.js";
import type { FetchLike } from "../http.js";
import { actaDue, recordActaAttempt, type ActaRecord, type PendingActa } from "./actas.js";
import { loadConfigFile, resolveConfig, type ResolvedConfig, type SyncConfig } from "./config.js";
import { formatDuration } from "./duration.js";
import { acquireLock, listFiles, readJson, writeJsonAtomic } from "./fs.js";
import { inTeamScope, mergeCalendar, type GameRecord, type GamesFile } from "./games.js";
import { backoffDelay, emptySeason, parseState, type Backoff, type LeagueState, type RunError, type RunSummary, type SyncState } from "./state.js";

/** Created, updated and removed records of one level in one run. */
export type LevelChanges<T> = { created: T[]; updated: T[]; removed: T[] };

/** What a run changed in the local store. Apply it instead of re-reading everything. */
export type Changeset = { games: LevelChanges<GameRecord>; actas: LevelChanges<ActaRecord> };

export type SyncResult = {
  /**
   * - `ok`: everything that was due is done (possibly nothing, with 0 requests).
   * - `partial`: the request budget ran out; the rest continues next run.
   * - `skipped`: no request was made because of a backoff or another running sync.
   * - `failed`: the run stopped on an error. No data file was changed and a backoff was recorded.
   */
  status: "ok" | "partial" | "skipped" | "failed";
  reason: "budget" | "backoff" | "locked" | null;
  startedAt: string;
  finishedAt: string;
  /** HTTP requests made by this run. */
  requests: number;
  changes: Changeset;
  /** When the next run may make requests again, if a backoff is active. */
  backoffUntil: string | null;
  error: RunError | null;
  /** Non-fatal problems, e.g. an acta that failed validation and will be retried. */
  warnings: string[];
  /** Config adjustments (values raised to a floor, levels turned on as dependencies). */
  notes: string[];
};

export type LeagueStatus = {
  id: number;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  games: number;
  removed: number;
  rescheduled: number;
};

export type SyncStatus = {
  season: string;
  dataDir: string;
  levels: { games: boolean; actas: boolean };
  refresh: { games: string; actas: string };
  maxRequestsPerRun: number;
  locked: boolean;
  backoff: Backoff | null;
  lastRun: RunSummary | null;
  games: { leagues: LeagueStatus[]; due: number };
  actas: { stored: number; pending: number; gaveUp: number; due: number; nextAttemptAt: string | null };
  notes: string[];
};

export type Sync = {
  /** One-time full sync of the configured scope: every league is refetched now, whatever its refresh interval. */
  init(): Promise<SyncResult>;
  /** Scheduled incremental sync. Only fetches what is due; with nothing due it makes no request. */
  run(): Promise<SyncResult>;
  /** Last and next sync per level, backoff and store counts. Reads local files only. */
  status(): Promise<SyncStatus>;
};

export type CreateSyncOptions = { configPath: string } | SyncConfig;

/** Injection points, mostly for tests. */
export type SyncRuntime = Pick<ClientOptions, "baseUrl" | "apiUrl" | "userAgent" | "sources" | "timeoutMs" | "sleep"> & {
  fetch?: FetchLike;
  /** Clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Base directory for a relative `dataDir` of an in-code config. Default: the working directory. */
  baseDir?: string;
  /** Environment used for `FECAPA_SIDGAD_TOKEN`. Default: `process.env`. */
  env?: Record<string, string | undefined>;
};

/** Worst case for one calendar or acta: token API, portal page, portal API. */
const OPERATION_COST = 3;

/** Problems with one acta's content; the acta is retried later instead of failing the run. */
const ACTA_DATA_ERRORS = new Set<string>(["INCOMPLETE_PLAYER", "DUPLICATE_LINEUP", "EMPTY_LINEUP", "TEAMS_MISMATCH"]);

class Budget {
  used = 0;
  spent = false;
  constructor(readonly max: number) {}
  wrap(fetch: FetchLike): FetchLike {
    return (url, init) => {
      if (this.used >= this.max) {
        this.spent = true;
        return Promise.reject(new Error("fecapa-sync: request budget for this run is spent"));
      }
      this.used++;
      return fetch(url, init);
    };
  }
  canAfford(requests: number): boolean {
    return this.max - this.used >= requests;
  }
}

const emptyChanges = (): Changeset => ({
  games: { created: [], updated: [], removed: [] },
  actas: { created: [], updated: [], removed: [] },
});

function toRunError(error: unknown): RunError {
  if (isFecapaError(error)) {
    const result: RunError = { code: error.code, message: error.message };
    if (error.status !== undefined) result.status = error.status;
    if (error.source !== undefined) result.source = error.source;
    return result;
  }
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
}

function isConfigPath(options: CreateSyncOptions): options is { configPath: string } {
  return typeof (options as { configPath?: unknown }).configPath === "string";
}

function parseGamesFile(input: unknown, file: string, competitionId: number): GamesFile {
  if (input === null) return { version: 1, competitionId, updatedAt: "", games: {} };
  const value = input as Partial<GamesFile>;
  if (value?.version !== 1 || typeof value.games !== "object" || value.games === null) {
    throw new FecapaError("STORE_CORRUPT", `${file} doesn't look like a fecapa-sync games file`, { detail: file });
  }
  return value as GamesFile;
}

const exists = (file: string) => access(file).then(() => true, () => false);

/**
 * Keeps a local JSON copy of the configured FECAPA data up to date.
 *
 * ```ts
 * const sync = createSync({ configPath: "./fecapa-sync.config.json" });
 * await sync.init();
 * const result = await sync.run();
 * ```
 */
export function createSync(options: CreateSyncOptions, runtime: SyncRuntime = {}): Sync {
  const clock = runtime.now ?? (() => new Date());
  let configPromise: Promise<ResolvedConfig> | undefined;
  const config = () => {
    configPromise ??= isConfigPath(options)
      ? loadConfigFile(options.configPath, { now: clock(), ...(runtime.env ? { env: runtime.env } : {}) })
      : Promise.resolve().then(() => resolveConfig(options, { now: clock(), ...(runtime.baseDir ? { baseDir: runtime.baseDir } : {}), ...(runtime.env ? { env: runtime.env } : {}) }));
    return configPromise;
  };

  const paths = (cfg: ResolvedConfig) => {
    const season = path.join(cfg.dataDir, cfg.seasonDir);
    return {
      state: path.join(cfg.dataDir, "state.json"),
      lock: path.join(cfg.dataDir, "sync.lock"),
      games: (idc: number) => path.join(season, "games", `${idc}.json`),
      actasDir: path.join(season, "actas"),
      acta: (key: string) => path.join(season, "actas", `${key}.json`),
    };
  };

  async function loadGames(cfg: ResolvedConfig): Promise<Map<number, GamesFile>> {
    const files = new Map<number, GamesFile>();
    for (const idc of cfg.leagues) {
      const file = paths(cfg).games(idc);
      files.set(idc, parseGamesFile(await readJson(file), file, idc));
    }
    return files;
  }

  async function storedActas(cfg: ResolvedConfig): Promise<Set<string>> {
    const names = await listFiles(paths(cfg).actasDir);
    return new Set(names.filter((name) => /^\d+\.json$/.test(name)).map((name) => name.slice(0, -".json".length)));
  }

  const leagueDue = (league: LeagueState | undefined, now: Date) =>
    !league?.nextDueAt || Date.parse(league.nextDueAt) <= now.getTime();

  async function execute(force: boolean): Promise<SyncResult> {
    const cfg = await config();
    const files = paths(cfg);
    const startedAt = clock();
    const result: SyncResult = {
      status: "ok", reason: null, startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), requests: 0,
      changes: emptyChanges(), backoffUntil: null, error: null, warnings: [], notes: cfg.notes,
    };
    const finish = () => {
      result.finishedAt = clock().toISOString();
      return result;
    };

    const lock = await acquireLock(files.lock, startedAt);
    if (!lock) {
      result.status = "skipped";
      result.reason = "locked";
      return finish();
    }
    try {
      const state = parseState(await readJson(files.state), files.state);
      if (state.backoff && Date.parse(state.backoff.until) > startedAt.getTime()) {
        result.status = "skipped";
        result.reason = "backoff";
        result.backoffUntil = state.backoff.until;
        return finish();
      }

      // Everything below is staged in memory and written only if the run doesn't fail.
      const draft: SyncState = structuredClone(state);
      const season = (draft.seasons[cfg.season] ??= emptySeason());
      const writes = new Map<string, unknown>();
      const budget = new Budget(cfg.maxRequestsPerRun);
      const fetchImpl = runtime.fetch ?? globalThis.fetch.bind(globalThis);
      const client = createClient({
        fetch: budget.wrap(fetchImpl),
        delayMs: cfg.delayMs,
        ...(cfg.token ? { token: cfg.token } : {}),
        ...Object.fromEntries(Object.entries({
          baseUrl: runtime.baseUrl, apiUrl: runtime.apiUrl, userAgent: runtime.userAgent,
          sources: runtime.sources, timeoutMs: runtime.timeoutMs, sleep: runtime.sleep,
        }).filter(([, value]) => value !== undefined)),
      });
      const changes = emptyChanges();

      try {
        const games = await loadGames(cfg);

        if (cfg.levels.games) {
          const due = cfg.leagues
            .filter((idc) => force || leagueDue(season.games.leagues[idc], startedAt))
            .sort((a, b) => (season.games.leagues[a]?.nextDueAt ?? "").localeCompare(season.games.leagues[b]?.nextDueAt ?? ""));
          for (const idc of due) {
            if (!budget.canAfford(OPERATION_COST)) {
              result.reason = "budget";
              break;
            }
            const league = (season.games.leagues[idc] ??= { lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null, source: null });
            league.lastAttemptAt = clock().toISOString();
            let calendar;
            try {
              calendar = await client.getCalendar(idc);
            } catch (error) {
              if (budget.spent) {
                result.reason = "budget";
                break;
              }
              throw error;
            }
            const now = clock();
            const merged = mergeCalendar(games.get(idc)!.games, calendar.matches.filter((match) => inTeamScope(match, cfg.teams)), now.toISOString());
            const file: GamesFile = { version: 1, competitionId: idc, updatedAt: now.toISOString(), games: merged.games };
            games.set(idc, file);
            writes.set(files.games(idc), file);
            changes.games.created.push(...merged.created);
            changes.games.updated.push(...merged.updated);
            changes.games.removed.push(...merged.removed);
            league.lastSuccessAt = now.toISOString();
            league.nextDueAt = new Date(now.getTime() + cfg.refreshMs.games).toISOString();
            league.source = calendar.source;
          }
        }

        if (cfg.levels.actas && result.reason === null) {
          const stored = await storedActas(cfg);
          const pending = season.actas.pending;
          const now = clock();
          const due = [...games.values()]
            .flatMap((file) => Object.values(file.games))
            .filter((game) => !stored.has(game.key) && actaDue(game, pending[game.key], now))
            .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));
          for (const game of due) {
            if (!budget.canAfford(OPERATION_COST)) {
              result.reason = "budget";
              break;
            }
            const key = game.key;
            let outcome;
            try {
              outcome = await client.getFullReport(game.matchId!, { idc: game.competitionId });
            } catch (error) {
              if (budget.spent) {
                result.reason = "budget";
                break;
              }
              if (isFecapaError(error) && ACTA_DATA_ERRORS.has(error.code)) {
                pending[key] = recordActaAttempt(pending[key], game, { status: "error", error: error.code }, clock(), cfg.refreshMs.actas);
                result.warnings.push(`acta ${key}: ${error.code} (${error.message}); attempt ${pending[key].attempts}`);
                continue;
              }
              throw error;
            }
            if (outcome.status === "final") {
              const at = clock().toISOString();
              const record: ActaRecord = {
                ...outcome.report, homeId: game.homeId, awayId: game.awayId, startsAt: game.startsAt,
                source: outcome.source, firstSeenAt: at, updatedAt: at,
              };
              writes.set(files.acta(key), record);
              changes.actas.created.push(record);
              delete pending[key];
            } else {
              pending[key] = recordActaAttempt(pending[key], game, { status: outcome.status }, clock(), cfg.refreshMs.actas);
            }
          }
        }
      } catch (error) {
        // Leave every data file as it was; only record the failure and back off.
        const failures = (state.backoff?.failures ?? 0) + 1;
        const now = clock();
        const runError = toRunError(error);
        const backoff: Backoff = { failures, until: new Date(now.getTime() + backoffDelay(failures)).toISOString(), lastError: runError };
        result.status = "failed";
        result.reason = null;
        result.requests = budget.used;
        result.error = runError;
        result.backoffUntil = backoff.until;
        finish();
        await writeJsonAtomic(files.state, {
          ...state, backoff,
          lastRun: { startedAt: result.startedAt, finishedAt: result.finishedAt, status: "failed", requests: budget.used, error: runError },
        } satisfies SyncState);
        return result;
      }

      for (const [file, data] of writes) await writeJsonAtomic(file, data);
      result.requests = budget.used;
      result.changes = changes;
      if (result.reason === "budget") result.status = "partial";
      if (budget.used > 0) draft.backoff = null;
      finish();
      const summary: RunSummary = { startedAt: result.startedAt, finishedAt: result.finishedAt, status: result.status, requests: result.requests };
      if (result.reason) summary.reason = result.reason;
      draft.lastRun = summary;
      await writeJsonAtomic(files.state, draft);
      return result;
    } finally {
      await lock.release();
    }
  }

  return {
    init: () => execute(true),
    run: () => execute(false),
    async status() {
      const cfg = await config();
      const files = paths(cfg);
      const now = clock();
      const state = parseState(await readJson(files.state), files.state);
      const season = state.seasons[cfg.season] ?? emptySeason();
      const games = await loadGames(cfg);
      const stored = await storedActas(cfg);
      const pendingList: Array<[string, PendingActa]> = Object.entries(season.actas.pending);
      const allGames = [...games.values()].flatMap((file) => Object.values(file.games));
      const nextAttempts = pendingList.map(([, p]) => p.nextAttemptAt).filter((at): at is string => at !== null).sort();
      return {
        season: cfg.season,
        dataDir: cfg.dataDir,
        levels: cfg.levels,
        refresh: { games: formatDuration(cfg.refreshMs.games), actas: formatDuration(cfg.refreshMs.actas) },
        maxRequestsPerRun: cfg.maxRequestsPerRun,
        locked: await exists(files.lock),
        backoff: state.backoff,
        lastRun: state.lastRun,
        games: {
          due: cfg.levels.games ? cfg.leagues.filter((idc) => leagueDue(season.games.leagues[idc], now)).length : 0,
          leagues: cfg.leagues.map((id) => {
            const records = Object.values(games.get(id)!.games);
            const league = season.games.leagues[id];
            return {
              id,
              lastSuccessAt: league?.lastSuccessAt ?? null,
              nextDueAt: league?.nextDueAt ?? null,
              games: records.filter((game) => game.removedAt === null).length,
              removed: records.filter((game) => game.removedAt !== null).length,
              rescheduled: records.filter((game) => game.rescheduled).length,
            };
          }),
        },
        actas: {
          stored: stored.size,
          pending: pendingList.filter(([, p]) => !p.gaveUp).length,
          gaveUp: pendingList.filter(([, p]) => p.gaveUp).length,
          due: cfg.levels.actas ? allGames.filter((game) => !stored.has(game.key) && actaDue(game, season.actas.pending[game.key], now)).length : 0,
          nextAttemptAt: nextAttempts[0] ?? null,
        },
        notes: cfg.notes,
      };
    },
  };
}
