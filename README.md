# mcp-lock-manager

An MCP server that provides file-level exclusive locking across multiple Claude Code instances. Prevents conflicts when multiple agents edit files in the same project simultaneously.

## How It Works

When multiple Claude Code sessions share a project, they can clobber each other's edits. This MCP server acts as a mutex — each session acquires a lock before editing a file and releases it when done. Locks are stored in a local `.locks/` directory using atomic filesystem operations.

Stale locks from crashed sessions are automatically detected via PID liveness checks and cleaned up.

## Setup

### 1. Install & Build

```bash
git clone https://github.com/maxwellplanck/mcp-lock-manager.git
cd mcp-lock-manager
npm install
npm run build
```

### 2. Configure Claude Code

Add to your `.claude/settings.json` (project or user-level):

```json
{
  "mcpServers": {
    "lock-manager": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-lock-manager/build/index.js", "--project-root", "/absolute/path/to/your/project"]
    }
  }
}
```

The `--project-root` flag tells the server which project directory to manage locks for. If omitted, it defaults to the current working directory.

You can also set the project root via environment variable:

```json
{
  "mcpServers": {
    "lock-manager": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-lock-manager/build/index.js"],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

## Tools

### `lock_acquire`

Acquire exclusive locks on one or more files before editing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | `string[]` | Yes | Project-relative file paths (use forward slashes) |
| `owner` | `string` | No | Label for this session (e.g. `"Agent A"`) |

Acquires all-or-nothing — if any file is already locked by another live session, the entire request fails with conflict details.

### `lock_release`

Release file locks when done editing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | `string[]` | No | Paths to release. Omit to release all locks for this session. |

### `lock_list`

List all active locks with owner, PID, alive status, and timestamp. Takes no parameters.

### `lock_cleanup`

Force-remove all stale locks held by dead processes. Takes no parameters. Useful when `lock_list` shows locks with `alive: false`.

## Adding to Your Workflow

For best results, add instructions to your project's `CLAUDE.md` telling Claude to use locks:

```markdown
## File Locking

This project uses mcp-lock-manager for multi-session coordination.
Before editing any file, acquire a lock with `lock_acquire`. Release locks with `lock_release` when done.
If a lock conflict occurs, do not proceed — wait or ask the other session to release.
```

## License

MIT
