import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, readdir, stat, unlink, rename, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';

const server = new McpServer({ name: 'obsidian', version: '1.0.0' });

// ── Vault helpers ────────────────────────────────────────────────────────────

function getVault() {
  const vp = (process.env.OBSIDIAN_VAULT_PATH || '').trim();
  if (!vp) throw new Error('OBSIDIAN_VAULT_PATH is not set. Configure it via install_tool_pack or configure_tool_pack.');
  const p = nodePath.resolve(vp.replace(/^~/, os.homedir()));
  if (!existsSync(p) || !statSync(p).isDirectory())
    throw new Error(`Vault path does not exist or is not a directory: ${p}`);
  return p;
}

function safePath(vaultRoot, rel) {
  if (!rel.endsWith('.md')) rel = rel + '.md';
  const candidate = nodePath.resolve(vaultRoot, rel);
  if (!candidate.startsWith(vaultRoot)) throw new Error(`Path traversal rejected: ${rel}`);
  return candidate;
}

async function* walkMd(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.obsidian') yield* walkMd(full);
    } else if (entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

async function* walkDirs(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.obsidian') continue;
    const full = nodePath.join(dir, entry.name);
    yield full;
    yield* walkDirs(full);
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('list_notes', {
  description: 'List all Markdown notes in the vault (or a sub-folder). Returns [{path, name, modified}] sorted by modification time descending.',
  inputSchema: {
    folder: z.string().default('').describe('Relative path to a sub-folder (empty = entire vault)'),
  },
}, async ({ folder }) => {
  const root = getVault();
  const base = folder ? nodePath.resolve(root, folder) : root;
  const results = [];
  for await (const f of walkMd(base)) {
    const s = await stat(f);
    results.push({
      path: nodePath.relative(root, f),
      name: nodePath.basename(f, '.md'),
      modified: new Date(s.mtimeMs).toISOString(),
    });
  }
  results.sort((a, b) => b.modified.localeCompare(a.modified));
  return { content: [{ type: 'text', text: JSON.stringify(results) }] };
});

server.registerTool('read_note', {
  description: 'Read a note from the vault. Returns {path, name, content, modified}.',
  inputSchema: {
    path: z.string().describe('Relative path to the note (e.g. "folder/My Note.md" or "My Note")'),
  },
}, async ({ path: notePath }) => {
  const root = getVault();
  const full = safePath(root, notePath);
  if (!existsSync(full)) throw new Error(`Note not found: ${notePath}`);
  const content = await readFile(full, 'utf8');
  const s = await stat(full);
  return { content: [{ type: 'text', text: JSON.stringify({
    path: nodePath.relative(root, full),
    name: nodePath.basename(full, '.md'),
    content,
    modified: new Date(s.mtimeMs).toISOString(),
  }) }] };
});

server.registerTool('write_note', {
  description: 'Create or overwrite a note in the vault. Returns {path, created}.',
  inputSchema: {
    path: z.string().describe('Relative path (e.g. "folder/My Note.md" or "My Note")'),
    content: z.string().describe('Full Markdown content'),
    overwrite: z.boolean().default(true).describe('If false, raises an error when the note already exists'),
  },
}, async ({ path: notePath, content, overwrite }) => {
  const root = getVault();
  const full = safePath(root, notePath);
  const existed = existsSync(full);
  if (existed && !overwrite) throw new Error(`Note already exists: ${notePath}`);
  await mkdir(nodePath.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return { content: [{ type: 'text', text: JSON.stringify({
    path: nodePath.relative(root, full),
    created: !existed,
  }) }] };
});

server.registerTool('append_to_note', {
  description: "Append text to an existing note (creates it if it doesn't exist). Returns {path, length}.",
  inputSchema: {
    path: z.string().describe('Relative path to the note'),
    text: z.string().describe('Text to append (a newline is added before it if needed)'),
  },
}, async ({ path: notePath, text }) => {
  const root = getVault();
  const full = safePath(root, notePath);
  await mkdir(nodePath.dirname(full), { recursive: true });
  const existing = existsSync(full) ? await readFile(full, 'utf8') : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const newContent = existing + separator + text;
  await writeFile(full, newContent, 'utf8');
  return { content: [{ type: 'text', text: JSON.stringify({
    path: nodePath.relative(root, full),
    length: newContent.length,
  }) }] };
});

server.registerTool('delete_note', {
  description: 'Delete a note from the vault. Returns {path, deleted}.',
  inputSchema: {
    path: z.string().describe('Relative path to the note'),
  },
}, async ({ path: notePath }) => {
  const root = getVault();
  const full = safePath(root, notePath);
  if (!existsSync(full))
    return { content: [{ type: 'text', text: JSON.stringify({ path: notePath, deleted: false, reason: 'not found' }) }] };
  await unlink(full);
  return { content: [{ type: 'text', text: JSON.stringify({ path: nodePath.relative(root, full), deleted: true }) }] };
});

server.registerTool('search_notes', {
  description: 'Full-text search across all notes in the vault. Returns [{path, name, snippet, matches}] sorted by match count descending.',
  inputSchema: {
    query: z.string().describe('Search string (case-insensitive)'),
    folder: z.string().default('').describe('Limit search to this sub-folder (empty = entire vault)'),
    max_results: z.number().int().default(20).describe('Maximum number of results to return'),
  },
}, async ({ query, folder, max_results }) => {
  const root = getVault();
  const base = folder ? nodePath.resolve(root, folder) : root;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'gi');
  const results = [];
  for await (const f of walkMd(base)) {
    let text;
    try { text = await readFile(f, 'utf8'); } catch { continue; }
    const matchesArr = text.match(pattern);
    if (!matchesArr) continue;
    const firstIdx = text.search(new RegExp(escaped, 'i'));
    const start = Math.max(0, firstIdx - 80);
    const end = Math.min(text.length, firstIdx + query.length + 80);
    const snippet = '...' + text.slice(start, end).replace(/\n/g, ' ').trim() + '...';
    results.push({
      path: nodePath.relative(root, f),
      name: nodePath.basename(f, '.md'),
      snippet,
      matches: matchesArr.length,
    });
  }
  results.sort((a, b) => b.matches - a.matches);
  return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, max_results)) }] };
});

server.registerTool('list_folders', {
  description: 'List all sub-folders in the vault (excluding .obsidian internals). Returns sorted list of relative folder paths.',
  inputSchema: {},
}, async () => {
  const root = getVault();
  const folders = [];
  for await (const d of walkDirs(root)) {
    folders.push(nodePath.relative(root, d));
  }
  folders.sort();
  return { content: [{ type: 'text', text: JSON.stringify(folders) }] };
});

server.registerTool('move_note', {
  description: 'Move (rename) a note within the vault. Returns {old_path, new_path}.',
  inputSchema: {
    path: z.string().describe('Current relative path'),
    new_path: z.string().describe('New relative path'),
  },
}, async ({ path: notePath, new_path: newNotePath }) => {
  const root = getVault();
  const src = safePath(root, notePath);
  const dst = safePath(root, newNotePath);
  if (!existsSync(src)) throw new Error(`Note not found: ${notePath}`);
  await mkdir(nodePath.dirname(dst), { recursive: true });
  await rename(src, dst);
  return { content: [{ type: 'text', text: JSON.stringify({
    old_path: nodePath.relative(root, src),
    new_path: nodePath.relative(root, dst),
  }) }] };
});

server.registerTool('get_vault_stats', {
  description: 'Return statistics about the vault. Returns {note_count, folder_count, vault_path, total_size_bytes}.',
  inputSchema: {},
}, async () => {
  const root = getVault();
  let noteCount = 0, totalSize = 0, folderCount = 0;
  async function walkStats(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.obsidian') continue;
        folderCount++;
        await walkStats(full);
      } else if (entry.name.endsWith('.md')) {
        noteCount++;
        const s = await stat(full);
        totalSize += s.size;
      }
    }
  }
  await walkStats(root);
  return { content: [{ type: 'text', text: JSON.stringify({
    note_count: noteCount,
    folder_count: folderCount,
    vault_path: root,
    total_size_bytes: totalSize,
  }) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
