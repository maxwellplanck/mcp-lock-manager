import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LockEntry {
  path: string;
  pid: number;
  owner: string;
  acquiredAt: string;
}

export interface LockFile {
  locks: LockEntry[];
}

export interface LockConflict {
  path: string;
  heldBy: { pid: number; owner: string; acquiredAt: string; alive: boolean };
}

export interface AcquireResult {
  success: boolean;
  acquired: string[];
  conflicts: LockConflict[];
}

export interface ReleaseResult {
  released: string[];
  notFound: string[];
}

export interface LockInfo extends LockEntry {
  alive: boolean;
}

export interface CleanupResult {
  removed: string[];
  remaining: number;
}

// ── Configuration ──────────────────────────────────────────────────────────

let projectRoot = process.cwd();

export function setProjectRoot(root: string): void {
  projectRoot = path.resolve(root);
}

function locksDir(): string {
  return path.join(projectRoot, ".locks");
}

function locksFilePath(): string {
  return path.join(locksDir(), "locks.json");
}

function mutexDir(): string {
  return path.join(locksDir(), ".mutex");
}

// ── Path normalization ─────────────────────────────────────────────────────

export function normalizeLockPath(p: string): string {
  // Convert backslashes to forward slashes
  let normalized = p.replace(/\\/g, "/");
  // Strip leading ./
  normalized = normalized.replace(/^\.\//, "");
  // Lowercase on Windows for case-insensitive matching
  if (os.platform() === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

// ── PID liveness check ─────────────────────────────────────────────────────

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Mutex (atomic mkdir spinlock) ──────────────────────────────────────────

const MUTEX_RETRY_MS = 50;
const MUTEX_TIMEOUT_MS = 5000;
const MUTEX_STALE_MS = 10000;

async function acquireMutex(): Promise<void> {
  const dir = mutexDir();
  const deadline = Date.now() + MUTEX_TIMEOUT_MS;

  // Ensure .locks/ directory exists
  await fs.mkdir(locksDir(), { recursive: true });

  while (true) {
    try {
      await fs.mkdir(dir);
      return; // Acquired
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Check for stale mutex
      try {
        const stat = await fs.stat(dir);
        if (Date.now() - stat.mtimeMs > MUTEX_STALE_MS) {
          // Stale mutex — force remove and retry immediately
          try {
            await fs.rmdir(dir);
          } catch {
            // Another process may have already removed it
          }
          continue;
        }
      } catch {
        // stat failed — directory may have been removed, retry
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Mutex acquisition timed out after ${MUTEX_TIMEOUT_MS}ms`
        );
      }

      await sleep(MUTEX_RETRY_MS);
    }
  }
}

async function releaseMutex(): Promise<void> {
  try {
    await fs.rmdir(mutexDir());
  } catch {
    // Already removed — safe to ignore
  }
}

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  await acquireMutex();
  try {
    return await fn();
  } finally {
    await releaseMutex();
  }
}

// ── Lock file I/O ──────────────────────────────────────────────────────────

async function readLockFile(): Promise<LockFile> {
  try {
    const data = await fs.readFile(locksFilePath(), "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && Array.isArray(parsed.locks)) {
      return parsed as LockFile;
    }
    return { locks: [] };
  } catch {
    // File doesn't exist or is corrupted
    return { locks: [] };
  }
}

async function writeLockFile(lockFile: LockFile): Promise<void> {
  await fs.mkdir(locksDir(), { recursive: true });
  await fs.writeFile(locksFilePath(), JSON.stringify(lockFile, null, 2), "utf-8");
}

// ── Core operations ────────────────────────────────────────────────────────

export async function acquireLocks(
  paths: string[],
  pid: number,
  owner: string
): Promise<AcquireResult> {
  const normalizedPaths = paths.map(normalizeLockPath);

  return withMutex(async () => {
    const lockFile = await readLockFile();

    // Auto-clean stale locks first
    lockFile.locks = lockFile.locks.filter((entry) => isPidAlive(entry.pid));

    // Check for conflicts (locks held by other PIDs)
    const conflicts: LockConflict[] = [];
    for (const reqPath of normalizedPaths) {
      const existing = lockFile.locks.find(
        (entry) => entry.path === reqPath && entry.pid !== pid
      );
      if (existing) {
        conflicts.push({
          path: reqPath,
          heldBy: {
            pid: existing.pid,
            owner: existing.owner,
            acquiredAt: existing.acquiredAt,
            alive: isPidAlive(existing.pid),
          },
        });
      }
    }

    if (conflicts.length > 0) {
      return { success: false, acquired: [], conflicts };
    }

    // All-or-nothing acquire
    const now = new Date().toISOString();
    const acquired: string[] = [];

    for (const reqPath of normalizedPaths) {
      // Remove any existing lock by this PID for this path (re-acquire)
      lockFile.locks = lockFile.locks.filter(
        (entry) => !(entry.path === reqPath && entry.pid === pid)
      );
      lockFile.locks.push({ path: reqPath, pid, owner, acquiredAt: now });
      acquired.push(reqPath);
    }

    await writeLockFile(lockFile);
    return { success: true, acquired, conflicts: [] };
  });
}

export async function releaseLocks(
  paths: string[] | null,
  pid: number
): Promise<ReleaseResult> {
  return withMutex(async () => {
    const lockFile = await readLockFile();
    const released: string[] = [];
    const notFound: string[] = [];

    if (paths === null) {
      // Release all locks for this PID
      const owned = lockFile.locks.filter((entry) => entry.pid === pid);
      released.push(...owned.map((e) => e.path));
      lockFile.locks = lockFile.locks.filter((entry) => entry.pid !== pid);
    } else {
      const normalizedPaths = paths.map(normalizeLockPath);
      for (const reqPath of normalizedPaths) {
        const idx = lockFile.locks.findIndex(
          (entry) => entry.path === reqPath && entry.pid === pid
        );
        if (idx >= 0) {
          released.push(reqPath);
          lockFile.locks.splice(idx, 1);
        } else {
          notFound.push(reqPath);
        }
      }
    }

    await writeLockFile(lockFile);
    return { released, notFound };
  });
}

export async function listLocks(): Promise<LockInfo[]> {
  return withMutex(async () => {
    const lockFile = await readLockFile();
    return lockFile.locks.map((entry) => ({
      ...entry,
      alive: isPidAlive(entry.pid),
    }));
  });
}

export async function cleanupStaleLocks(): Promise<CleanupResult> {
  return withMutex(async () => {
    const lockFile = await readLockFile();
    const stale = lockFile.locks.filter((entry) => !isPidAlive(entry.pid));
    const removed = stale.map((e) => e.path);

    lockFile.locks = lockFile.locks.filter((entry) => isPidAlive(entry.pid));
    await writeLockFile(lockFile);

    return { removed, remaining: lockFile.locks.length };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
