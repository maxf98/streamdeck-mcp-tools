/**
 * Apple Notes — read and write notes via AppleScript
 *
 * Tools: list_notes, get_note, create_note, append_to_note, update_note,
 *        search_notes, list_folders, delete_note
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'apple_notes', version: '1.0.0' });

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function as(script, timeoutMs = 30000) {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    const msg = err?.stderr?.trim() ?? err?.message ?? String(err);
    throw new Error(msg || 'AppleScript error');
  }
}

function parseNotes(raw) {
  return raw.split('|||').filter(Boolean).map(entry => {
    const [id, name, folder, modified] = entry.split(':::');
    return { id, name, folder, modified };
  });
}

// ── tools ─────────────────────────────────────────────────────────────────────

server.registerTool('list_notes', {
  description: 'List notes in Apple Notes. Optionally filter by folder name. Returns [{id, name, folder, modified}].',
  inputSchema: {
    folder: z.string().default('').describe('Folder name to filter by (empty = all folders)'),
    limit:  z.number().default(50).describe('Maximum number of notes to return'),
  },
}, async ({ folder, limit }) => {
  let script;
  if (folder) {
    script = `
tell application "Notes"
  set output to ""
  set n to 0
  try
    set f to first folder whose name is "${esc(folder)}"
    repeat with aNote in notes of f
      if n >= ${limit} then exit repeat
      set output to output & (id of aNote) & ":::" & (name of aNote) & ":::${esc(folder)}:::" & (modification date of aNote as text) & "|||"
      set n to n + 1
    end repeat
  end try
  return output
end tell`;
  } else {
    script = `
tell application "Notes"
  set output to ""
  set n to 0
  repeat with f in folders
    set fname to name of f
    repeat with aNote in notes of f
      if n >= ${limit} then exit repeat
      set output to output & (id of aNote) & ":::" & (name of aNote) & ":::" & fname & ":::" & (modification date of aNote as text) & "|||"
      set n to n + 1
    end repeat
    if n >= ${limit} then exit repeat
  end repeat
  return output
end tell`;
  }
  const raw = await as(script, 60000);
  const notes = parseNotes(raw);
  return { content: [{ type: 'text', text: JSON.stringify({ count: notes.length, notes }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_note', {
  description: 'Get the full content of a note by name. Returns {id, name, folder, body (HTML), plaintext, modified}.',
  inputSchema: {
    name:   z.string().describe('Note title (exact or partial match)'),
    folder: z.string().default('').describe('Folder name to narrow search (optional)'),
  },
}, async ({ name, folder }) => {
  let findExpr;
  if (folder) {
    findExpr = `first note of (first folder whose name is "${esc(folder)}") whose name contains "${esc(name)}"`;
  } else {
    findExpr = `first note of default account whose name contains "${esc(name)}"`;
  }
  const raw = await as(`
tell application "Notes"
  try
    set n to ${findExpr}
    set f to container of n
    return (id of n) & ":::" & (name of n) & ":::" & (name of f) & ":::" & (modification date of n as text) & ":::" & (body of n) & ":::" & (plaintext of n)
  on error e
    return "ERROR:::" & e
  end try
end tell`, 30000);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  const idx = raw.indexOf(':::');
  const id = raw.slice(0, idx);
  const rest1 = raw.slice(idx + 3);
  const idx2 = rest1.indexOf(':::');
  const noteName = rest1.slice(0, idx2);
  const rest2 = rest1.slice(idx2 + 3);
  const idx3 = rest2.indexOf(':::');
  const folderName = rest2.slice(0, idx3);
  const rest3 = rest2.slice(idx3 + 3);
  const idx4 = rest3.indexOf(':::');
  const modified = rest3.slice(0, idx4);
  const rest4 = rest3.slice(idx4 + 3);
  const idx5 = rest4.indexOf(':::');
  const body = rest4.slice(0, idx5);
  const plaintext = rest4.slice(idx5 + 3);
  return { content: [{ type: 'text', text: JSON.stringify({ id, name: noteName, folder: folderName, modified, body, plaintext }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('create_note', {
  description: 'Create a new note in Apple Notes. Returns {id, name, folder}.',
  inputSchema: {
    name:   z.string().describe('Note title'),
    body:   z.string().default('').describe('Note body (plain text or HTML)'),
    folder: z.string().default('').describe('Folder to create the note in (empty = default Notes folder)'),
  },
}, async ({ name, body, folder }) => {
  const target = folder ? `first folder whose name is "${esc(folder)}"` : `default account`;
  const raw = await as(`
tell application "Notes"
  try
    set t to ${target}
    set n to make new note at t with properties {name:"${esc(name)}", body:"${esc(body)}"}
    set f to container of n
    return (id of n) & ":::" & (name of n) & ":::" & (name of f)
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  const [id, noteName, folderName] = raw.split(':::');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, name: noteName, folder: folderName }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('append_to_note', {
  description: 'Append text to an existing note. Creates the note if it does not exist.',
  inputSchema: {
    name:   z.string().describe('Note title to find'),
    text:   z.string().describe('Text to append'),
    folder: z.string().default('').describe('Folder name to narrow search (optional)'),
  },
}, async ({ name, text, folder }) => {
  let findExpr;
  if (folder) {
    findExpr = `first note of (first folder whose name is "${esc(folder)}") whose name contains "${esc(name)}"`;
  } else {
    findExpr = `first note of default account whose name contains "${esc(name)}"`;
  }
  const raw = await as(`
tell application "Notes"
  try
    set n to ${findExpr}
    set body of n to (body of n) & "<br>" & "${esc(text)}"
    return (id of n) & ":::" & (name of n)
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  const [id, noteName] = raw.split(':::');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, name: noteName }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('update_note', {
  description: 'Update the title or body of an existing note.',
  inputSchema: {
    name:     z.string().describe('Current note title (exact or partial match)'),
    new_name: z.string().default('').describe('New title (empty = keep current)'),
    new_body: z.string().default('').describe('New body content (empty = keep current)'),
    folder:   z.string().default('').describe('Folder name to narrow search (optional)'),
  },
}, async ({ name, new_name, new_body, folder }) => {
  let findExpr;
  if (folder) {
    findExpr = `first note of (first folder whose name is "${esc(folder)}") whose name contains "${esc(name)}"`;
  } else {
    findExpr = `first note of default account whose name contains "${esc(name)}"`;
  }
  const updates = [];
  if (new_name) updates.push(`set name of n to "${esc(new_name)}"`);
  if (new_body) updates.push(`set body of n to "${esc(new_body)}"`);
  if (!updates.length) throw new Error('Provide new_name and/or new_body to update.');
  const raw = await as(`
tell application "Notes"
  try
    set n to ${findExpr}
    ${updates.join('\n    ')}
    return (id of n) & ":::" & (name of n)
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  const [id, noteName] = raw.split(':::');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, name: noteName }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('search_notes', {
  description: 'Search notes by title or body content. Returns [{id, name, folder, modified}].',
  inputSchema: {
    query: z.string().describe('Search string (case-insensitive substring match)'),
    limit: z.number().default(20).describe('Maximum number of results'),
  },
}, async ({ query, limit }) => {
  const raw = await as(`
tell application "Notes"
  set output to ""
  set n to 0
  set q to "${esc(query.toLowerCase())}"
  repeat with f in folders
    set fname to name of f
    repeat with aNote in notes of f
      if n >= ${limit} then exit repeat
      set noteName to name of aNote
      try
        set notePlain to plaintext of aNote
        if notePlain is missing value then set notePlain to ""
      on error
        set notePlain to ""
      end try
      if (noteName contains q) or (notePlain contains q) then
        set output to output & (id of aNote) & ":::" & noteName & ":::" & fname & ":::" & (modification date of aNote as text) & "|||"
        set n to n + 1
      end if
    end repeat
    if n >= ${limit} then exit repeat
  end repeat
  return output
end tell`, 60000);
  const notes = parseNotes(raw);
  return { content: [{ type: 'text', text: JSON.stringify({ count: notes.length, notes }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('list_folders', {
  description: 'List all folders in Apple Notes. Returns [{name, note_count}].',
  inputSchema: {},
}, async () => {
  const raw = await as(`
tell application "Notes"
  set output to ""
  repeat with f in folders
    set output to output & (name of f) & ":::" & (count of notes of f) & "|||"
  end repeat
  return output
end tell`);
  const folders = raw.split('|||').filter(Boolean).map(entry => {
    const [name, count] = entry.split(':::');
    return { name, note_count: parseInt(count) || 0 };
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: folders.length, folders }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('delete_note', {
  description: 'Delete a note by name. This is permanent — use with care.',
  inputSchema: {
    name:   z.string().describe('Note title (exact or partial match)'),
    folder: z.string().default('').describe('Folder name to narrow search (optional)'),
  },
}, async ({ name, folder }) => {
  let findExpr;
  if (folder) {
    findExpr = `first note of (first folder whose name is "${esc(folder)}") whose name contains "${esc(name)}"`;
  } else {
    findExpr = `first note of default account whose name contains "${esc(name)}"`;
  }
  const raw = await as(`
tell application "Notes"
  try
    set n to ${findExpr}
    set noteName to name of n
    delete n
    return noteName
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: raw }) }] };
});

// ── start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
