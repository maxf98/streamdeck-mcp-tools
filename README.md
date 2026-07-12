# Stream Deck MCP Tool Packs

This repository is the official catalog of tool packs for [Stream Deck MCP Studio](https://github.com/maxf98/streamdeck-mcp-studio). Tool packs are local MCP servers that run as subprocesses inside the Studio's gateway, exposing tools that Stream Deck buttons can call at press time.

---

## What is a tool pack?

A tool pack is a focused, self-contained MCP server designed for **desktop automation workflows**. It runs locally on the user's machine, starts automatically when the Stream Deck plugin loads, and its tools are available to every button without any per-button configuration.

Think of tool packs as the building blocks for one-press Stream Deck actions: record a voice note, snap a window to the left half, send a Slack message, run a shell command, open a folder in VS Code.

### Design principles

- **Desktop-first** — tools should do things that make sense at a keyboard/Stream Deck: control apps, manage windows, interact with the clipboard, trigger workflows
- **Focused** — each pack does one thing well. Prefer multiple small packs over one large one
- **Fast** — tools are called at button-press time; they should return in under a few seconds
- **Node.js only** — packs must be Node.js ES modules (`server.mjs`). No Python, no uv, no Homebrew dependencies. The plugin ships a bundled Node.js runtime so packs work out of the box
- **No global installs** — all npm dependencies live in the pack's own `node_modules/`. The gateway runs `npm install` automatically on first use

---

## Pack structure

Each pack lives in `tools/<pack-id>/` and requires exactly three files:

```
tools/
  my-pack/
    manifest.json   ← metadata + launch config
    server.mjs      ← MCP server (ES module)
    package.json    ← npm dependencies
```

### `manifest.json`

```json
{
  "id": "my_pack",
  "name": "My Pack",
  "description": "One sentence: what does this pack let you do?",
  "version": "1.0.0",
  "command": "node",
  "args": ["server.mjs"],
  "install": "npm install",
  "platform": ["darwin"],
  "tags": ["keyword", "another-keyword"],
  "config_schema": {
    "MY_API_KEY": {
      "description": "API key for the service",
      "required": true,
      "secret": true
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | ✓ | Lowercase, **underscores only** (no hyphens). Becomes the tool namespace: `my_pack__tool_name` |
| `name` | ✓ | Human-readable name shown in the UI |
| `description` | ✓ | One sentence shown in the pack browser |
| `version` | ✓ | Semver |
| `command` | ✓ | Always `"node"` |
| `args` | ✓ | Always `["server.mjs"]` |
| `install` | ✓ | Always `"npm install"` |
| `platform` | ✓ | `["darwin"]`, `["win32"]`, `["linux"]`, or any combination |
| `tags` | ✓ | Used for search/discovery |
| `config_schema` | | Env vars the user must supply (API keys, vault paths, etc.) |

> **Important:** Pack IDs must use underscores, not hyphens. The gateway exposes tools as `{packId}__{toolName}` and button code references packs via `mcp.my_pack.tool_name()`. Hyphens break dot-notation access.

### `server.mjs`

Standard MCP server pattern using `@modelcontextprotocol/sdk`:

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'my_pack', version: '1.0.0' });

server.registerTool('do_something', {
  description: 'What this tool does. Be specific — the description is used for tool selection.',
  inputSchema: {
    text: z.string().describe('The text to process'),
  },
}, async ({ text }) => {
  const result = /* ... */;
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

await server.connect(new StdioServerTransport());
```

### `package.json`

```json
{
  "name": "my-pack",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "zod": "^3.23.8"
  }
}
```

All packs need `@modelcontextprotocol/sdk` and `zod`. Add other dependencies as needed — they install into the pack's own `node_modules/`.

---

## Adding a pack to the catalog

1. Create `tools/<your-pack-id>/` with the three required files
2. Add an entry to `index.json`:

```json
{
  "id": "your_pack_id",
  "name": "Your Pack",
  "description": "One sentence description.",
  "version": "1.0.0",
  "platform": ["darwin"],
  "tags": ["relevant", "tags"],
  "path": "tools/your_pack_id"
}
```

3. Open a pull request

---

## Local development (no push loop)

Normally the Studio downloads packs from this repo, so iterating would mean
committing + pushing on every change. To develop against a **local checkout**
instead, point the Studio at this repo's `tools/` directory.

If this repo sits next to `streamdeck-mcp-studio` (the default layout), just use the
convenience script from the studio repo — it resolves the sibling `tools/` dir for you:

```bash
cd streamdeck-mcp-studio
npm run dev:local
```

Or set the path explicitly (any layout):

```bash
STREAMDECK_MCP_LOCAL_PACKS=/absolute/path/to/streamdeck-mcp-tools/tools npm run dev
```

With this set, the Studio:

- Loads every pack under `tools/` straight from disk (**shadowing** any downloaded
  copy of the same id — local wins).
- Runs a pack's `install` step **lazily on first start**, only for packs actually
  used, and only if its `node_modules/` is missing (a fresh checkout is gitignored).
  Once installed it's skipped on later launches.
- **Live-reloads** a pack when you edit its files — no rebuild, no restart, no push.
- Excludes local packs from the update check, so a catalog version bump never
  offers to overwrite your in-repo edits.

Unset the variable to return to the normal download-from-catalog behavior.

---

## What makes a good tool pack?

**Good candidates:**
- Controls a macOS app (QuickTime, Terminal, VS Code, Finder)
- Reads/writes system state (clipboard, windows, processes)
- Calls a local API or service running on the user's machine
- Wraps a CLI tool the user already has installed
- Integrates with a local file-based app (Obsidian, Bear, etc.)

**Not a good fit:**
- Packs that require Docker, Python environments, or Homebrew to function
- Packs that are pure API wrappers for remote services — those belong in the registry as remote streamable-http servers
- Packs that take more than a few seconds to respond (Stream Deck buttons need snappy feedback)
- Packs with broad system access that aren't clearly scoped (prefer `launcher` over a generic `system` pack)

---

## Existing packs

| Pack | Platform | Description |
|---|---|---|
| `audio` | macOS | Live output/input volume + mute and audio-device switching as MCP resources |
| `bash` | macOS | Run shell commands, open Terminal windows |
| `clipboard` | macOS | Read, write and manage the clipboard |
| `launcher` | macOS | Open apps, folders, URLs, reveal in Finder |
| `obsidian` | cross | Read/write notes in an Obsidian vault |
| `openai` | cross | GPT structured output + Whisper transcription |
| `voice` | macOS | Record microphone audio (Stream Deck key + on-screen recorder popup as UI resources); saves a WebM file for transcription |
| `vscode` | cross | Control VS Code via the streamdeck-vscode extension |
| `window_management` | macOS | Move and resize windows across screens |
