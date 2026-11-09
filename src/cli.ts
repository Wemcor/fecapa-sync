#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { isFecapaError } from "./errors.js";
import { DEFAULT_CONFIG_FILE, exampleConfig } from "./sync/config.js";
import { createSync, type SyncResult, type SyncStatus } from "./sync/engine.js";

const USAGE = `Usage: fecapa-sync <command> [--config <file>] [--json]

Commands:
  init     One-time full sync. Creates a config template first if the file doesn't exist.
  sync     Incremental sync; only fetches what is due. Call this from cron.
  status   Last and next sync per level, backoff and store counts. No network.

Options:
  --config <file>  Config file (default: ${DEFAULT_CONFIG_FILE})
  --json           Print the full result as JSON

Exit codes: 0 ok (including nothing due, budget spent, backoff or another
run in progress), 1 the run failed, 2 usage or config error.`;

type Args = { command: string | undefined; config: string; json: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, config: DEFAULT_CONFIG_FILE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config" || arg === "-c") {
      const value = argv[++i];
      if (!value) throw new UsageError("--config needs a file path");
      args.config = value;
    } else if (arg.startsWith("--config=")) {
      args.config = arg.slice("--config=".length);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.command = "help";
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option ${arg}`);
    } else if (args.command === undefined) {
      args.command = arg;
    } else {
      throw new UsageError(`Unexpected argument ${arg}`);
    }
  }
  return args;
}

class UsageError extends Error {}

const count = (changes: { created: unknown[]; updated: unknown[]; removed: unknown[] }) =>
  `+${changes.created.length} ~${changes.updated.length} -${changes.removed.length}`;

function formatResult(command: string, result: SyncResult): string {
  const lines: string[] = [];
  const reason = result.reason ? ` (${result.reason})` : "";
  lines.push(`fecapa-sync ${command}: ${result.status}${reason}, ${result.requests} request${result.requests === 1 ? "" : "s"}`);
  if (result.status !== "skipped" && result.status !== "failed") {
    lines.push(`  games ${count(result.changes.games)}, actas ${count(result.changes.actas)}`);
  }
  if (result.status === "partial") lines.push("  request budget spent; the rest continues next run");
  if (result.error) lines.push(`  error: ${result.error.code}: ${result.error.message}`);
  if (result.backoffUntil) lines.push(`  backoff: no requests before ${result.backoffUntil}`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  for (const note of result.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

function formatStatus(status: SyncStatus): string {
  const lines = [`fecapa-sync status: season ${status.season}, store ${status.dataDir}`];
  lines.push(`  levels: ${Object.entries(status.levels).filter(([, on]) => on).map(([level]) => level).join(", ")}; refresh games ${status.refresh.games}, actas ${status.refresh.actas}; max ${status.maxRequestsPerRun} requests/run`);
  if (status.locked) lines.push("  a sync is running (sync.lock present)");
  if (status.backoff) lines.push(`  backoff: ${status.backoff.failures} failed run(s), no requests before ${status.backoff.until} (${status.backoff.lastError.code})`);
  if (status.lastRun) lines.push(`  last run: ${status.lastRun.status}${status.lastRun.reason ? ` (${status.lastRun.reason})` : ""} at ${status.lastRun.finishedAt}, ${status.lastRun.requests} requests`);
  for (const league of status.games.leagues) {
    lines.push(`  league ${league.id}: ${league.games} games (${league.rescheduled} rescheduled, ${league.removed} removed), last ${league.lastSuccessAt ?? "never"}, next due ${league.nextDueAt ?? "now"}`);
  }
  if (status.levels.actas) {
    lines.push(`  actas: ${status.actas.stored} stored, ${status.actas.due} due now, ${status.actas.pending} waiting, ${status.actas.gaveUp} given up${status.actas.nextAttemptAt ? `, next retry ${status.actas.nextAttemptAt}` : ""}`);
  }
  for (const note of status.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

async function main(argv: string[], out: (text: string) => void = console.log, err: (text: string) => void = console.error): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.command === "help") {
    out(USAGE);
    return 0;
  }
  if (!["init", "sync", "status"].includes(args.command ?? "")) {
    err(args.command ? `Unknown command "${args.command}"\n\n${USAGE}` : USAGE);
    return 2;
  }

  const configPath = path.resolve(args.config);
  if (args.command === "init" && !(await access(configPath).then(() => true, () => false))) {
    await writeFile(configPath, `${JSON.stringify(exampleConfig(), null, 2)}\n`, { flag: "wx" });
    out(`Created ${configPath}. Edit scope.leagues (and scope.teams) for your competitions, then run "fecapa-sync init" again.`);
    return 0;
  }

  try {
    const sync = createSync({ configPath });
    if (args.command === "status") {
      const status = await sync.status();
      out(args.json ? JSON.stringify(status, null, 2) : formatStatus(status));
      return 0;
    }
    const result = args.command === "init" ? await sync.init() : await sync.run();
    out(args.json ? JSON.stringify(result, null, 2) : formatResult(args.command!, result));
    return result.status === "failed" ? 1 : 0;
  } catch (error) {
    if (isFecapaError(error, "INVALID_CONFIG")) {
      err(error.message);
      return 2;
    }
    err(`fecapa-sync ${args.command}: ${isFecapaError(error) ? `${error.code}: ` : ""}${(error as Error).message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
