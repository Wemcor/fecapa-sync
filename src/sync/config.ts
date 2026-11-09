import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FecapaError } from "../errors.js";
import { currentSeason } from "../time.js";
import { DAY_MS, formatDuration, HOUR_MS, parseDuration } from "./duration.js";

export const LEVELS = ["leagues", "categories", "teams", "clubs", "games", "actas", "players"] as const;
export type Level = (typeof LEVELS)[number];

/** Levels this version can sync. */
export const AVAILABLE_LEVELS = ["games", "actas"] as const;
export type AvailableLevel = (typeof AVAILABLE_LEVELS)[number];

/** The milestone in which each level that isn't available yet is planned. */
export const PLANNED_IN: Partial<Record<Level, string>> = {
  leagues: "0.3", categories: "0.3", teams: "0.3", clubs: "0.3", players: "0.4",
};

/**
 * Levels each level needs. `games` also needs leagues; in 0.2 they come from
 * the explicit `scope.leagues` ids, so the `leagues` level isn't required.
 */
export const DEPENDS_ON: Partial<Record<Level, Level[]>> = { actas: ["games"], players: ["actas"] };

/**
 * Minimum refresh interval per level, enforced by the library: a configured
 * value below the floor is raised to it. For `actas`, the interval is the
 * spacing before the first retry of an acta that wasn't available yet.
 */
export const REFRESH_FLOORS: Record<Level, number> = {
  leagues: DAY_MS, categories: 7 * DAY_MS, teams: DAY_MS, clubs: 7 * DAY_MS,
  games: 12 * HOUR_MS, actas: 6 * HOUR_MS, players: DAY_MS,
};

/** Default refresh interval per level. */
export const REFRESH_DEFAULTS: Record<Level, number> = {
  leagues: 7 * DAY_MS, categories: 30 * DAY_MS, teams: 7 * DAY_MS, clubs: 30 * DAY_MS,
  games: DAY_MS, actas: 12 * HOUR_MS, players: 7 * DAY_MS,
};

export const DEFAULT_MAX_REQUESTS_PER_RUN = 200;
/** One operation (calendar or acta) can take up to 3 requests when sources fall back. */
export const MIN_MAX_REQUESTS_PER_RUN = 5;
export const DEFAULT_SYNC_DELAY_MS = 1000;
/** Pause between requests during a sync. Lower values are raised to this. */
export const MIN_SYNC_DELAY_MS = 1000;
export const DEFAULT_DATA_DIR = "./fecapa-data";
export const DEFAULT_CONFIG_FILE = "fecapa-sync.config.json";

const positiveId = z.number().int().positive();
const levelFlags = z.object(Object.fromEntries(LEVELS.map((level) => [level, z.boolean().optional()])) as Record<Level, z.ZodOptional<z.ZodBoolean>>).strict();
const refreshValues = z.object(Object.fromEntries(LEVELS.map((level) => [level, z.string().optional()])) as Record<Level, z.ZodOptional<z.ZodString>>).strict();

export const configSchema = z.object({
  $schema: z.string().optional(),
  /** `"2026/2027"`. Defaults to the current season (it changes on 1 July). */
  season: z.string().regex(/^\d{4}\/\d{4}$/, 'expected "YYYY/YYYY"').optional(),
  /** Where the local store lives. Relative to the config file, or to the working directory for an in-code config. */
  dataDir: z.string().min(1).optional(),
  scope: z.object({
    /** Competition ids (`liga` in the portal URL). Required in 0.2. */
    leagues: z.array(positiveId).min(1, "list at least one league id (scope.leagues)"),
    /** Team ids. When set, only games involving one of these teams are kept. */
    teams: z.array(positiveId).optional(),
    categories: z.array(z.string()).optional(),
    clubs: z.array(z.union([z.string(), positiveId])).optional(),
  }).strict(),
  levels: levelFlags.optional(),
  refresh: refreshValues.optional(),
  limits: z.object({
    maxRequestsPerRun: z.number().int().min(MIN_MAX_REQUESTS_PER_RUN).optional(),
    delayMs: z.number().int().min(0).optional(),
  }).strict().optional(),
  /** SIDGAD token. Prefer the `FECAPA_SIDGAD_TOKEN` environment variable; never commit a token. */
  token: z.string().min(1).nullable().optional(),
}).strict();

/** The config file / object, as written by the user. */
export type SyncConfig = z.input<typeof configSchema>;

/** The config after validation, defaults, floors and dependencies. */
export type ResolvedConfig = {
  season: string;
  /** Season directory name, e.g. `"2026-2027"`. */
  seasonDir: string;
  /** Absolute path of the store root. */
  dataDir: string;
  leagues: number[];
  teams: number[];
  levels: Record<AvailableLevel, boolean>;
  /** Effective refresh intervals, in ms. */
  refreshMs: Record<AvailableLevel, number>;
  maxRequestsPerRun: number;
  delayMs: number;
  token: string | null;
  /** Human-readable notes about values that were raised to a floor or levels turned on as dependencies. */
  notes: string[];
};

function invalid(message: string, detail?: string): FecapaError {
  return new FecapaError("INVALID_CONFIG", `Invalid fecapa-sync config: ${message}`, detail ? { detail } : {});
}

export function resolveConfig(input: unknown, options: { baseDir?: string; now?: Date; env?: Record<string, string | undefined> } = {}): ResolvedConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.join(".") || "(root)";
    throw invalid(`${where}: ${issue.message}`, where);
  }
  const config = parsed.data;
  const notes: string[] = [];

  const season = config.season ?? currentSeason(options.now);
  const [start, end] = season.split("/").map(Number) as [number, number];
  if (end !== start + 1) throw invalid(`season "${season}" must be two consecutive years`, "season");

  if (config.scope.categories?.length) throw invalid("scope.categories is not available until 0.3; list league ids in scope.leagues", "scope.categories");
  if (config.scope.clubs?.length) throw invalid("scope.clubs is not available until 0.3; use scope.teams with team ids", "scope.clubs");

  // Turn on what the requested levels depend on.
  const enabled = new Set<Level>(LEVELS.filter((level) => config.levels?.[level] === true));
  if (!config.levels) enabled.add("games");
  for (let changed = true; changed;) {
    changed = false;
    for (const level of [...enabled]) {
      for (const dependency of DEPENDS_ON[level] ?? []) {
        if (!enabled.has(dependency)) {
          if (config.levels?.[dependency] === false) throw invalid(`levels.${level} needs levels.${dependency}, which is set to false`, `levels.${dependency}`);
          enabled.add(dependency);
          changed = true;
          notes.push(`levels.${dependency} turned on because levels.${level} needs it`);
        }
      }
    }
  }
  const unavailable = [...enabled].filter((level) => PLANNED_IN[level]);
  if (unavailable.length) {
    const list = unavailable.map((level) => `"${level}" (${PLANNED_IN[level]})`).join(", ");
    throw invalid(`level ${list} is not available yet in this version; only "games" and "actas" can be synced. Set it to false.`, `levels.${unavailable[0]}`);
  }
  if (!enabled.size) throw invalid('no level is enabled; enable at least "games"', "levels");

  const refreshMs = {} as Record<AvailableLevel, number>;
  for (const level of LEVELS) {
    const raw = config.refresh?.[level];
    const value = raw === undefined ? REFRESH_DEFAULTS[level] : parseDuration(raw, `refresh.${level}`);
    const effective = Math.max(value, REFRESH_FLOORS[level]);
    if (raw !== undefined && effective > value) {
      notes.push(`refresh.${level} "${raw}" raised to the minimum "${formatDuration(effective)}"`);
    }
    if ((AVAILABLE_LEVELS as readonly string[]).includes(level)) refreshMs[level as AvailableLevel] = effective;
  }

  const delay = config.limits?.delayMs ?? DEFAULT_SYNC_DELAY_MS;
  if (delay < MIN_SYNC_DELAY_MS) notes.push(`limits.delayMs ${delay} raised to the minimum ${MIN_SYNC_DELAY_MS}`);

  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? process.cwd();
  return {
    season,
    seasonDir: season.replace("/", "-"),
    dataDir: path.resolve(baseDir, config.dataDir ?? DEFAULT_DATA_DIR),
    leagues: [...new Set(config.scope.leagues)],
    teams: [...new Set(config.scope.teams ?? [])],
    levels: { games: enabled.has("games"), actas: enabled.has("actas") },
    refreshMs,
    maxRequestsPerRun: config.limits?.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN,
    delayMs: Math.max(delay, MIN_SYNC_DELAY_MS),
    token: config.token ?? env.FECAPA_SIDGAD_TOKEN ?? null,
    notes,
  };
}

/** Reads and resolves a JSON config file. `dataDir` is relative to the file. */
export async function loadConfigFile(configPath: string, options: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<ResolvedConfig> {
  const absolute = path.resolve(configPath);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new FecapaError("INVALID_CONFIG", `Cannot read config file ${absolute}`, { detail: absolute }, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FecapaError("INVALID_CONFIG", `Config file ${absolute} is not valid JSON`, { detail: absolute }, { cause: error });
  }
  return resolveConfig(json, { ...options, baseDir: path.dirname(absolute) });
}

/** A starting config for `fecapa-sync init`. */
export function exampleConfig(): SyncConfig {
  return {
    season: currentSeason(),
    dataDir: DEFAULT_DATA_DIR,
    scope: { leagues: [4811], teams: [] },
    levels: { games: true, actas: false },
    refresh: { games: "24h" },
    limits: { maxRequestsPerRun: DEFAULT_MAX_REQUESTS_PER_RUN, delayMs: DEFAULT_SYNC_DELAY_MS },
    token: null,
  };
}
