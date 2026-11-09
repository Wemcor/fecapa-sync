import { randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FecapaError } from "../errors.js";

/**
 * Writes JSON atomically: a temp file in the same directory, flushed to disk,
 * then renamed over the target. A crash leaves either the old file or the new
 * one, never half of one.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Parsed JSON, or `null` when the file doesn't exist. Unparseable JSON is `STORE_CORRUPT`. */
export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FecapaError("STORE_CORRUPT", `${file} is not valid JSON`, { detail: file }, { cause: error });
  }
}

/** File names in a directory, or `[]` when it doesn't exist. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** A lock older than this is stale even if its process can't be checked. */
export const LOCK_STALE_MS = 6 * 3_600_000;

type LockInfo = { pid: number; hostname: string; startedAt: string; token: string };

export type Lock = { release(): Promise<void> };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(file: string, info: LockInfo | null, now: Date): Promise<boolean> {
  // Unreadable content: either a run that crashed while writing it, or one
  // writing it right now. Only the first is still unreadable a minute later.
  if (!info) {
    const stats = await stat(file).catch(() => null);
    return !stats || Date.now() - stats.mtimeMs > 60_000;
  }
  const age = now.getTime() - Date.parse(info.startedAt);
  if (!(age < LOCK_STALE_MS)) return true;
  return info.hostname === os.hostname() && !isAlive(info.pid);
}

async function readLock(file: string): Promise<LockInfo | null | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = JSON.parse(text) as LockInfo;
    return typeof info?.token === "string" && typeof info.startedAt === "string" ? info : null;
  } catch {
    return null;
  }
}

/**
 * Takes `sync.lock` with an exclusive create. Returns `null` when another run
 * holds it. A stale lock (its process is gone on this host, or it is older
 * than 6 h) is moved aside with a rename, which only one contender can win; if
 * the moved file turns out not to be the stale one, it is put back.
 */
export async function acquireLock(file: string, now: Date): Promise<Lock | null> {
  await mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), startedAt: now.toISOString(), token: randomBytes(8).toString("hex") };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify(info), "utf8");
      } finally {
        await handle.close();
      }
      return {
        async release() {
          const current = await readLock(file);
          if (current && current.token === info.token) await unlink(file).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readLock(file);
    if (existing === undefined) continue; // released meanwhile
    if (!(await isStale(file, existing, now))) return null;
    const aside = `${file}.stale-${info.token}`;
    try {
      await rename(file, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const moved = await readLock(aside);
    const same = existing === null ? moved === null : moved?.token === existing.token;
    if (!same) {
      // Another contender replaced the stale lock first: put its lock back.
      await link(aside, file).catch(() => undefined);
      await unlink(aside).catch(() => undefined);
      return null;
    }
    await unlink(aside).catch(() => undefined);
  }
  return null;
}
