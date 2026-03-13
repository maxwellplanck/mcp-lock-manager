#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  setProjectRoot,
  acquireLocks,
  releaseLocks,
  listLocks,
  cleanupStaleLocks,
} from "./lockStore.js";

// ── Configuration ──────────────────────────────────────────────────────────

function resolveProjectRoot(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--project-root");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return process.env.PROJECT_ROOT ?? process.cwd();
}

const projectRoot = resolveProjectRoot();
setProjectRoot(projectRoot);

const ownerPid = process.ppid;

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "lock-manager",
  version: "1.0.0",
});

// ── Tools ──────────────────────────────────────────────────────────────────

server.tool(
  "lock_acquire",
  "Acquire exclusive file locks. Fails with conflict details if any path is held by another live session. Always call this before editing files.",
  {
    paths: z.array(z.string()).describe("Project-relative file paths to lock (use forward slashes)"),
    owner: z.string().optional().describe("Optional label for this session (e.g. 'Agent A')"),
  },
  async ({ paths, owner }) => {
    const label = owner ?? `pid-${ownerPid}`;
    let result = await acquireLocks(paths, ownerPid, label);

    // If we hit a conflict, clean up stale locks and retry once.
    // This handles orphaned locks from crashed sessions where isPidAlive
    // may have been momentarily unreliable (e.g. PID reuse on Windows).
    if (!result.success) {
      await cleanupStaleLocks();
      result = await acquireLocks(paths, ownerPid, label);
    }

    if (result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Locked ${result.acquired.length} file(s):\n${result.acquired.map((p) => `  - ${p}`).join("\n")}`,
          },
        ],
      };
    }

    const conflictLines = result.conflicts
      .map(
        (c) =>
          `  - ${c.path} (held by ${c.heldBy.owner}, PID ${c.heldBy.pid}, alive: ${c.heldBy.alive}, since ${c.heldBy.acquiredAt})`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `CONFLICT: Cannot acquire locks (retried after stale-lock cleanup). The following files are held by another session:\n${conflictLines}\n\nDo NOT proceed with edits. Wait or ask the other session to release.`,
        },
      ],
      isError: true,
    };
  }
);

server.tool(
  "lock_release",
  "Release file locks. If paths are omitted, releases ALL locks for this session.",
  {
    paths: z
      .array(z.string())
      .optional()
      .describe("Paths to release, or omit to release all locks for this session"),
  },
  async ({ paths }) => {
    const result = await releaseLocks(paths ?? null, ownerPid);
    const lines: string[] = [];
    if (result.released.length > 0) {
      lines.push(
        `Released ${result.released.length} lock(s):\n${result.released.map((p) => `  - ${p}`).join("\n")}`
      );
    }
    if (result.notFound.length > 0) {
      lines.push(
        `Not found (already released or not owned by this session):\n${result.notFound.map((p) => `  - ${p}`).join("\n")}`
      );
    }
    if (lines.length === 0) {
      lines.push("No locks to release.");
    }
    return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
  }
);

server.tool(
  "lock_list",
  "List all current file locks with owner, PID, timestamp, and alive status.",
  {},
  async () => {
    const locks = await listLocks();
    if (locks.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No active locks." }],
      };
    }
    const lines = locks.map(
      (l) =>
        `  - ${l.path}  (owner: ${l.owner}, PID: ${l.pid}, alive: ${l.alive}, since: ${l.acquiredAt})`
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `${locks.length} lock(s):\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "lock_cleanup",
  "Force-remove all stale locks (dead PIDs). Use when lock_list shows locks with alive: false.",
  {},
  async () => {
    const result = await cleanupStaleLocks();
    const lines: string[] = [];
    if (result.removed.length > 0) {
      lines.push(
        `Cleaned up ${result.removed.length} stale lock(s):\n${result.removed.map((p) => `  - ${p}`).join("\n")}`
      );
    } else {
      lines.push("No stale locks found.");
    }
    lines.push(`${result.remaining} active lock(s) remaining.`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── Graceful shutdown ──────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    await releaseLocks(null, ownerPid);
  } catch {
    // Best-effort release on shutdown
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

// stdin close = Claude Code disconnected
process.stdin.on("close", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[lock-manager] Started. project-root=${projectRoot} owner-pid=${ownerPid}`
  );
}

main().catch((err) => {
  console.error("[lock-manager] Fatal error:", err);
  process.exit(1);
});
