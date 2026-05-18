import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const server = new McpServer({ name: 'obsidian', version: '2.1.0' });

// ── Vault registry ───────────────────────────────────────────────────────────

function readVaultRegistry() {
  try {
    const raw = readFileSync(join(homedir(), 'Library/Application Support/obsidian/obsidian.json'), 'utf-8');
    const config = JSON.parse(raw);
    return Object.values(config.vaults ?? {}).map(v => ({ path: v.path, open: !!v.open }));
  } catch { return []; }
}

function defaultVaultPath() {
  const vaults = readVaultRegistry();
  return (vaults.find(v => v.open) ?? vaults[0])?.path ?? null;
}

// ── CLI helpers ──────────────────────────────────────────────────────────────

/**
 * Run an obsidian CLI command, return trimmed stdout.
 * Strips loader/update-warning lines that Obsidian writes to stdout before the
 * real output (e.g. "2026-05-17 11:00:00 Loading updated app package …" and
 * "Your Obsidian installer is out of date …").
 * Throws if the cleaned output starts with "Error:" (CLI error format).
 */
function cli(...args) {
  const result = spawnSync('obsidian', args, { encoding: 'utf8' });
  const cleaned = (result.stdout ?? '')
    .split('\n')
    .filter(l => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(l) && !l.startsWith('Your Obsidian installer'))
    .join('\n')
    .trim();
  if (cleaned.startsWith('Error:')) throw new Error(cleaned.replace(/^Error:\s*/, ''));
  return cleaned;
}

/** Run CLI and parse stdout as JSON. Returns parsed value, or [] / {} on empty. */
function cliJSON(fallback, ...args) {
  const out = cli(...args);
  if (!out || out === 'No backlinks found.' || out === 'No results found.') return fallback;
  return JSON.parse(out);
}

/** Parse "key\tvalue\n..." TSV vault info into an object. */
function parseTSV(text) {
  const obj = {};
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab !== -1) obj[line.slice(0, tab)] = line.slice(tab + 1).trim();
  }
  return obj;
}

// ── Tools ────────────────────────────────────────────────────────────────────

// ── Notes ────────────────────────────────────────────────────────────────────

server.registerTool('list_notes', {
  description: 'List markdown files in the vault or a sub-folder. Returns [{path, name}] sorted by path.',
  inputSchema: {
    folder: z.string().default('').describe('Sub-folder to filter by (empty = entire vault)'),
  },
  outputSchema: {
    results: z.array(z.object({ path: z.string(), name: z.string() })),
  },
}, ({ folder }) => {
  const args = ['files'];
  if (folder) args.push(`folder=${folder}`);
  const out = cli(...args);
  const results = out ? out.split('\n').filter(Boolean).map(p => ({
    path: p,
    name: p.split('/').pop().replace(/\.md$/, ''),
  })) : [];
  return { structuredContent: { results } };
});

server.registerTool('read_note', {
  description: 'Read a note by name (wikilink-style) or exact path. Returns {path, content}.',
  inputSchema: {
    file: z.string().describe('Note name (e.g. "My Note") — resolves like a wikilink across the vault'),
  },
  outputSchema: {
    path: z.string(),
    content: z.string(),
  },
}, ({ file }) => {
  const path = cli('file', `file=${file}`, 'info=path').trim();
  const content = cli('read', `file=${file}`);
  return { structuredContent: { path, content } };
});

server.registerTool('write_note', {
  description: 'Create a new note. Returns {path, created: true}.',
  inputSchema: {
    name: z.string().describe('Note name (without .md). Use slashes for sub-folders: "folder/Note Name"'),
    content: z.string().default('').describe('Initial markdown content'),
    overwrite: z.boolean().default(false).describe('Overwrite if the note already exists'),
  },
  outputSchema: {
    path: z.string(),
    created: z.boolean(),
  },
}, ({ name, content, overwrite }) => {
  const args = ['create', `name=${name}`, `content=${content}`];
  if (overwrite) args.push('overwrite');
  const out = cli(...args);
  // Output: "Created: folder/Note Name.md"
  const path = out.replace(/^Created:\s*/, '');
  return { structuredContent: { path, created: true } };
});

server.registerTool('append_to_note', {
  description: 'Append text to an existing note. Returns {path}.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
    content: z.string().describe('Text to append'),
  },
  outputSchema: { path: z.string() },
}, ({ file, content }) => {
  const out = cli('append', `file=${file}`, `content=${content}`);
  // Output: "Appended to: DS Team/folder/Note.md"
  const path = out.replace(/^Appended to:\s*/, '');
  return { structuredContent: { path } };
});

server.registerTool('prepend_to_note', {
  description: 'Prepend text to an existing note. Returns {path}.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
    content: z.string().describe('Text to prepend'),
  },
  outputSchema: { path: z.string() },
}, ({ file, content }) => {
  const out = cli('prepend', `file=${file}`, `content=${content}`);
  const path = out.replace(/^Prepended to:\s*/, '');
  return { structuredContent: { path } };
});

server.registerTool('delete_note', {
  description: 'Move a note to the Obsidian trash. Returns {path, deleted}.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
  },
  outputSchema: { path: z.string(), deleted: z.boolean() },
}, ({ file }) => {
  const out = cli('delete', `file=${file}`);
  const path = out.replace(/^Deleted:\s*/, '');
  return { structuredContent: { path, deleted: true } };
});

server.registerTool('move_note', {
  description: 'Move or rename a note within the vault. Returns {old_path, new_path}.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
    to: z.string().describe('Destination path relative to vault root (e.g. "Archive/Note.md")'),
  },
  outputSchema: { old_path: z.string(), new_path: z.string() },
}, ({ file, to }) => {
  const old_path = cli('file', `file=${file}`, 'info=path');
  cli('move', `file=${file}`, `to=${to}`);
  return { structuredContent: { old_path, new_path: to } };
});

// ── Search ───────────────────────────────────────────────────────────────────

server.registerTool('search_notes', {
  description: 'Full-text search with matching line context. Returns [{file, matches:[{line, text}]}].',
  inputSchema: {
    query: z.string().describe('Search string'),
    folder: z.string().optional().describe('Limit search to this sub-folder'),
    limit: z.number().int().default(20).describe('Max number of matching files to return'),
    case_sensitive: z.boolean().default(false).describe('Case-sensitive search'),
  },
  outputSchema: {
    results: z.array(z.object({
      file: z.string(),
      matches: z.array(z.object({ line: z.number(), text: z.string() })),
    })),
  },
}, ({ query, folder, limit, case_sensitive }) => {
  const args = ['search:context', `query=${query}`, `limit=${limit}`, 'format=json'];
  if (folder) args.push(`path=${folder}`);
  if (case_sensitive) args.push('case');
  const raw = cliJSON([], ...args);
  // Normalise line numbers from strings to integers
  const results = raw.map(r => ({
    file: r.file,
    matches: r.matches.map(m => ({ line: parseInt(m.line, 10), text: m.text })),
  }));
  return { structuredContent: { results } };
});

// ── Structure ────────────────────────────────────────────────────────────────

server.registerTool('list_folders', {
  description: 'List all folders in the vault. Returns array of folder paths.',
  inputSchema: {
    folder: z.string().optional().describe('Filter by parent folder'),
  },
  outputSchema: { folders: z.array(z.string()) },
}, ({ folder }) => {
  const args = ['folders'];
  if (folder) args.push(`folder=${folder}`);
  const out = cli(...args);
  const folders = out ? out.split('\n').filter(Boolean) : [];
  return { structuredContent: { folders } };
});

server.registerTool('get_outline', {
  description: 'Get the heading structure of a note. Returns [{level, heading, line}].',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
  },
  outputSchema: {
    headings: z.array(z.object({ level: z.number(), heading: z.string(), line: z.number() })),
  },
}, ({ file }) => {
  const raw = cliJSON([], 'outline', `file=${file}`, 'format=json');
  const headings = raw.map(h => ({ level: h.level, heading: h.heading, line: parseInt(h.line, 10) }));
  return { structuredContent: { headings } };
});

server.registerTool('get_backlinks', {
  description: 'List notes that link to a given note. Returns [{file, count}].',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
  },
  outputSchema: {
    backlinks: z.array(z.object({ file: z.string(), count: z.number() })),
  },
}, ({ file }) => {
  const raw = cliJSON([], 'backlinks', `file=${file}`, 'counts', 'format=json');
  const backlinks = Array.isArray(raw)
    ? raw.map(b => ({ file: b.file, count: parseInt(b.count ?? '1', 10) }))
    : [];
  return { structuredContent: { backlinks } };
});

// ── Metadata ─────────────────────────────────────────────────────────────────

server.registerTool('get_properties', {
  description: 'Read the frontmatter properties of a note. Returns the properties as a key/value object.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
  },
  outputSchema: { properties: z.record(z.unknown()) },
}, ({ file }) => {
  const properties = cliJSON({}, 'properties', `file=${file}`, 'format=json');
  return { structuredContent: { properties } };
});

server.registerTool('set_property', {
  description: 'Set a frontmatter property on a note. Returns {file, name, value}.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
    name: z.string().describe('Property name'),
    value: z.string().describe('Property value'),
    type: z.enum(['text', 'list', 'number', 'checkbox', 'date', 'datetime']).default('text'),
  },
  outputSchema: { file: z.string(), name: z.string(), value: z.string() },
}, ({ file, name, value, type }) => {
  cli('property:set', `name=${name}`, `value=${value}`, `type=${type}`, `file=${file}`);
  return { structuredContent: { file, name, value } };
});

server.registerTool('list_tags', {
  description: 'List all tags in the vault (or in a specific note) with occurrence counts. Returns [{tag, count}].',
  inputSchema: {
    file: z.string().optional().describe('Limit to a specific note (wikilink-style)'),
  },
  outputSchema: {
    tags: z.array(z.object({ tag: z.string(), count: z.number() })),
  },
}, ({ file }) => {
  const args = ['tags', 'format=json', 'counts'];
  if (file) args.push(`file=${file}`);
  const raw = cliJSON([], ...args);
  const tags = raw.map(t => ({ tag: t.tag, count: parseInt(t.count, 10) }));
  return { structuredContent: { tags } };
});

// ── Tasks ────────────────────────────────────────────────────────────────────

server.registerTool('list_tasks', {
  description: 'List tasks across the vault or in a specific note. Returns [{status, text, file, line}].',
  inputSchema: {
    file: z.string().optional().describe('Limit to a specific note (wikilink-style)'),
    filter: z.enum(['all', 'todo', 'done']).default('all').describe('Filter by completion status'),
  },
  outputSchema: {
    tasks: z.array(z.object({
      status: z.string().describe('Status character: space = todo, x = done, other = custom'),
      text: z.string(),
      file: z.string(),
      line: z.number(),
    })),
  },
}, ({ file, filter }) => {
  const args = ['tasks', 'format=json'];
  if (file) args.push(`file=${file}`);
  if (filter === 'todo') args.push('todo');
  if (filter === 'done') args.push('done');
  const raw = cliJSON([], ...args);
  const tasks = raw.map(t => ({
    status: t.status,
    text: t.text,
    file: t.file,
    line: parseInt(t.line, 10),
  }));
  return { structuredContent: { tasks } };
});

server.registerTool('toggle_task', {
  description: 'Toggle a task between done and todo by file and line number. Returns {file, line, done}.',
  inputSchema: {
    file: z.string().describe('Note name (wikilink-style)'),
    line: z.number().int().describe('Line number of the task (from list_tasks)'),
  },
  outputSchema: { file: z.string(), line: z.number(), done: z.boolean() },
}, ({ file, line }) => {
  const before = cliJSON([], 'tasks', `file=${file}`, 'format=json');
  const task = before.find(t => parseInt(t.line, 10) === line);
  const wasDone = task?.status === 'x';
  cli('task', 'toggle', `file=${file}`, `line=${line}`);
  return { structuredContent: { file, line, done: !wasDone } };
});

// ── Daily notes ──────────────────────────────────────────────────────────────

server.registerTool('daily_read', {
  description: "Read today's daily note. Returns {path, content}.",
  inputSchema: {},
  outputSchema: { path: z.string(), content: z.string() },
}, () => {
  const path = cli('daily:path');
  const content = cli('daily:read');
  return { structuredContent: { path, content } };
});

server.registerTool('daily_append', {
  description: "Append text to today's daily note (creates it if it doesn't exist). Returns {path}.",
  inputSchema: {
    content: z.string().describe('Text to append'),
  },
  outputSchema: { path: z.string() },
}, ({ content }) => {
  const out = cli('daily:append', `content=${content}`);
  const path = out.replace(/^Appended to:\s*/, '');
  return { structuredContent: { path } };
});

server.registerTool('daily_prepend', {
  description: "Prepend text to today's daily note. Returns {path}.",
  inputSchema: {
    content: z.string().describe('Text to prepend'),
  },
  outputSchema: { path: z.string() },
}, ({ content }) => {
  const out = cli('daily:prepend', `content=${content}`);
  const path = out.replace(/^Prepended to:\s*/, '');
  return { structuredContent: { path } };
});

// ── Vault ────────────────────────────────────────────────────────────────────

server.registerTool('list_vaults', {
  description: 'List all Obsidian vaults registered on this machine. Returns [{path, open}] where open=true is the currently active vault.',
  inputSchema: {},
  outputSchema: {
    vaults: z.array(z.object({ path: z.string(), open: z.boolean() })),
  },
}, () => {
  return { structuredContent: { vaults: readVaultRegistry() } };
});

server.registerTool('get_vault_stats', {
  description: 'Return vault statistics. Returns {name, path, files, folders, size_bytes}.',
  inputSchema: {},
  outputSchema: {
    name: z.string(),
    path: z.string(),
    files: z.number(),
    folders: z.number(),
    size_bytes: z.number(),
  },
}, () => {
  const raw = parseTSV(cli('vault'));
  return { structuredContent: {
    name: raw.name ?? '',
    path: raw.path ?? '',
    files: parseInt(raw.files ?? '0', 10),
    folders: parseInt(raw.folders ?? '0', 10),
    size_bytes: parseInt(raw.size ?? '0', 10),
  } };
});

// ── Commands ─────────────────────────────────────────────────────────────────

server.registerTool('execute_command', {
  description: 'Execute any Obsidian command by its ID (e.g. "daily-notes:goto-today"). Use list_commands to discover IDs.',
  inputSchema: {
    id: z.string().describe('Command ID'),
  },
  outputSchema: { ok: z.boolean() },
}, ({ id }) => {
  cli('command', `id=${id}`);
  return { structuredContent: { ok: true } };
});

server.registerTool('list_commands', {
  description: 'List available Obsidian commands. Returns [{id, name}].',
  inputSchema: {
    filter: z.string().optional().describe('Filter by ID prefix (e.g. "daily-notes")'),
  },
  outputSchema: {
    commands: z.array(z.object({ id: z.string(), name: z.string() })),
  },
}, ({ filter }) => {
  const args = ['commands'];
  if (filter) args.push(`filter=${filter}`);
  const out = cli(...args);
  // Output is one "id\tname" per line
  const commands = out ? out.split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    return tab !== -1
      ? { id: line.slice(0, tab).trim(), name: line.slice(tab + 1).trim() }
      : { id: line.trim(), name: line.trim() };
  }) : [];
  return { structuredContent: { commands } };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
