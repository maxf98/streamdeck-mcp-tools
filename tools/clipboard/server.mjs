/**
 * Clipboard MCP — text + image clipboard management for macOS.
 * Uses pbcopy/pbpaste for text and osascript for image detection.
 * In-memory clipboard history tracked for the lifetime of the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'ClipboardMCP', version: '1.0.0' });

// ── History ──────────────────────────────────────────────────────────────────

const MAX_HISTORY = 100;
const _history = [];

function addToHistory(text, source = 'system') {
  if (_history.length && _history[0].text === text) return;
  _history.unshift({ text, source, timestamp: new Date().toISOString() });
  if (_history.length > MAX_HISTORY) _history.pop();
}

// ── Clipboard I/O ────────────────────────────────────────────────────────────

async function getClipboardText() {
  try {
    const { stdout } = await execFileAsync('pbpaste');
    return stdout;
  } catch {
    return '';
  }
}

async function setClipboardText(text) {
  await new Promise((resolve, reject) => {
    const child = execFile('pbcopy', (err) => err ? reject(err) : resolve());
    child.stdin.end(text);
  });
}

async function getClipboardTypes() {
  // osascript clipboard info returns lines like: «class utf8», «class HTML», etc.
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', 'clipboard info']);
    const types = [];
    const text = stdout.toLowerCase();
    if (text.includes('utf8') || text.includes('string')) types.push('plain_text');
    if (text.includes('html')) types.push('html');
    if (text.includes('rtf')) types.push('rtf');
    if (text.includes('png') || text.includes('tiff')) types.push('image');
    if (text.includes('furl') || text.includes('file url')) types.push('file_url');
    return types;
  } catch {
    return [];
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('get_clipboard', {
  description: 'Get the current text contents of the system clipboard. Returns {text, length, available_types}.',
  inputSchema: {},
}, async () => {
  const text = await getClipboardText();
  const types = await getClipboardTypes();
  if (text) addToHistory(text);
  return { content: [{ type: 'text', text: JSON.stringify({ text, length: text.length, available_types: types }) }] };
});

server.registerTool('set_clipboard', {
  description: 'Set the system clipboard to the given plain text. Returns {success, message, length}.',
  inputSchema: {
    text: z.string().describe('The text to place on the clipboard'),
  },
}, async ({ text }) => {
  await setClipboardText(text);
  addToHistory(text, 'set_clipboard');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Clipboard set (${text.length} chars)`, length: text.length }) }] };
});

server.registerTool('get_clipboard_info', {
  description: 'Get information about all data types currently on the clipboard. Returns {types, has_text, has_image, has_file_urls, type_count}.',
  inputSchema: {},
}, async () => {
  const types = await getClipboardTypes();
  return { content: [{ type: 'text', text: JSON.stringify({
    types,
    has_text: types.includes('plain_text'),
    has_image: types.includes('image'),
    has_file_urls: types.includes('file_url'),
    type_count: types.length,
  }) }] };
});

server.registerTool('get_clipboard_image_info', {
  description: 'Check if there is an image on the clipboard and return its type. Returns {has_image, format} or {has_image: false}.',
  inputSchema: {},
}, async () => {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', 'clipboard info']);
    const text = stdout.toLowerCase();
    const hasPng = text.includes('png');
    const hasTiff = text.includes('tiff');
    if (hasPng || hasTiff) {
      return { content: [{ type: 'text', text: JSON.stringify({ has_image: true, format: hasPng ? 'png' : 'tiff' }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ has_image: false }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ has_image: false }) }] };
  }
});

server.registerTool('clear_clipboard', {
  description: 'Clear the system clipboard of all content. Returns {success, message}.',
  inputSchema: {},
}, async () => {
  await setClipboardText('');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Clipboard cleared' }) }] };
});

server.registerTool('append_to_clipboard', {
  description: 'Append text to the current clipboard text contents. Returns {success, message, length}.',
  inputSchema: {
    text: z.string().describe('The text to append'),
    separator: z.string().default('\n').describe('Separator between existing content and new text (default: newline)'),
  },
}, async ({ text, separator }) => {
  const current = await getClipboardText();
  const newText = current + separator + text;
  await setClipboardText(newText);
  addToHistory(newText, 'append_to_clipboard');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Appended to clipboard (${newText.length} chars total)`, length: newText.length }) }] };
});

server.registerTool('prepend_to_clipboard', {
  description: 'Prepend text to the current clipboard text contents. Returns {success, message, length}.',
  inputSchema: {
    text: z.string().describe('The text to prepend'),
    separator: z.string().default('\n').describe('Separator between new text and existing content (default: newline)'),
  },
}, async ({ text, separator }) => {
  const current = await getClipboardText();
  const newText = text + separator + current;
  await setClipboardText(newText);
  addToHistory(newText, 'prepend_to_clipboard');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Prepended to clipboard (${newText.length} chars total)`, length: newText.length }) }] };
});

server.registerTool('transform_clipboard', {
  description: 'Apply a text transformation to the current clipboard contents in place. Operations: uppercase, lowercase, titlecase, trim, strip_newlines, sort_lines, unique_lines, reverse_lines, number_lines, remove_blank_lines. Returns {success, operation, length, preview}.',
  inputSchema: {
    operation: z.string().describe('Transformation to apply: uppercase | lowercase | titlecase | trim | strip_newlines | sort_lines | unique_lines | reverse_lines | number_lines | remove_blank_lines'),
  },
}, async ({ operation }) => {
  const current = await getClipboardText();
  if (!current) throw new Error('Clipboard is empty or has no text');

  const ops = {
    uppercase: t => t.toUpperCase(),
    lowercase: t => t.toLowerCase(),
    titlecase: t => t.replace(/\b\w/g, c => c.toUpperCase()),
    trim: t => t.trim(),
    strip_newlines: t => t.replace(/[\n\r]/g, ' '),
    sort_lines: t => t.split('\n').sort().join('\n'),
    unique_lines: t => [...new Set(t.split('\n'))].join('\n'),
    reverse_lines: t => t.split('\n').reverse().join('\n'),
    number_lines: t => t.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n'),
    remove_blank_lines: t => t.split('\n').filter(l => l.trim()).join('\n'),
  };

  if (!ops[operation]) throw new Error(`Unknown operation '${operation}'. Valid: ${Object.keys(ops).join(', ')}`);

  const transformed = ops[operation](current);
  await setClipboardText(transformed);
  addToHistory(transformed, `transform:${operation}`);
  const preview = transformed.slice(0, 200) + (transformed.length > 200 ? '...' : '');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, operation, length: transformed.length, preview }) }] };
});

server.registerTool('find_and_replace_clipboard', {
  description: 'Find and replace text in the current clipboard contents. Returns {success, replacements, length}.',
  inputSchema: {
    find: z.string().describe('The text to search for'),
    replace: z.string().describe('The text to replace it with'),
  },
}, async ({ find, replace }) => {
  const current = await getClipboardText();
  if (!current) throw new Error('Clipboard is empty or has no text');

  const count = current.split(find).length - 1;
  if (count === 0) return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'No matches found', replacements: 0 }) }] };

  const transformed = current.split(find).join(replace);
  await setClipboardText(transformed);
  addToHistory(transformed, 'find_and_replace');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, replacements: count, length: transformed.length }) }] };
});

server.registerTool('get_clipboard_history', {
  description: 'Get the in-memory clipboard history (entries tracked since the server started). Returns {entries, total_in_history}.',
  inputSchema: {
    limit: z.number().int().default(20).describe('Maximum number of history entries to return'),
  },
}, async ({ limit }) => {
  // Snapshot current clipboard
  const text = await getClipboardText();
  if (text) addToHistory(text);

  const entries = _history.slice(0, limit).map(e => ({
    text: e.text.slice(0, 500) + (e.text.length > 500 ? '...' : ''),
    full_length: e.text.length,
    timestamp: e.timestamp,
    source: e.source,
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ entries, total_in_history: _history.length }) }] };
});

server.registerTool('restore_from_history', {
  description: 'Restore a clipboard entry from history back to the system clipboard. Returns {success, message, preview, length}.',
  inputSchema: {
    index: z.number().int().describe('The 0-based index in the history (0 = most recent)'),
  },
}, async ({ index }) => {
  if (index < 0 || index >= _history.length)
    throw new Error(`Invalid index ${index}. History has ${_history.length} entries (0-${_history.length - 1}).`);
  const text = _history[index].text;
  await setClipboardText(text);
  const preview = text.slice(0, 200) + (text.length > 200 ? '...' : '');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Restored entry ${index} to clipboard`, preview, length: text.length }) }] };
});

server.registerTool('clear_clipboard_history', {
  description: 'Clear the in-memory clipboard history. Does not affect the current clipboard. Returns {success, message, entries_cleared}.',
  inputSchema: {},
}, async () => {
  const count = _history.length;
  _history.length = 0;
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Cleared ${count} history entries`, entries_cleared: count }) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
