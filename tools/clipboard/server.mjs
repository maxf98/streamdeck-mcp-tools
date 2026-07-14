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
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

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

async function getClipboardImage() {
  const tmp = join(tmpdir(), `mcp-clip-img-${randomUUID()}.png`);
  try {
    await execFileAsync('osascript', ['-e',
      `set imgData to the clipboard as «class PNGf»
       set f to open for access (POSIX file "${tmp}") with write permission
       write imgData to f
       close access f`
    ]);
    const buf = await readFile(tmp);
    return buf.toString('base64');
  } catch {
    return null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
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
  description:
    'Get the current clipboard contents. Auto-detects content type: text is returned as `text` ' +
    '(and as a text content block), images as base64 image content (viewable by vision models). ' +
    'Also reports available_types so you know what else is on the clipboard.',
  inputSchema: {
    prefer: z.enum(['text', 'image']).optional().describe(
      'Which format to prefer when clipboard has both text and image (default: auto-detect primary type)'
    ),
  },
  outputSchema: z.object({
    type: z.string(),
    // The clipboard text, for the text case — a first-class structured field so
    // callers (and get_tool_schema) can rely on `result.text` instead of having to
    // dig it out of the content block. Absent for the image case.
    text: z.string().optional(),
    length: z.number().optional(),
    available_types: z.array(z.string()),
  }),
}, async ({ prefer }) => {
  const types = await getClipboardTypes();
  const hasImage = types.includes('image');
  const hasText = types.includes('plain_text');

  const wantImage = prefer === 'image' || (hasImage && !hasText) || (hasImage && prefer !== 'text');

  if (wantImage && hasImage) {
    const base64 = await getClipboardImage();
    if (base64) {
      return {
        content: [
          { type: 'image', data: base64, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ type: 'image', available_types: types }) },
        ],
        structuredContent: { type: 'image', available_types: types },
      };
    }
  }

  const text = await getClipboardText();
  if (text) addToHistory(text);
  // Include the text in structuredContent so `result.text` works directly — the
  // content block carries the same text (for vision models / display), but callers
  // shouldn't have to reach into it.
  const result = { type: 'text', text, length: text.length, available_types: types };
  return {
    content: [{ type: 'text', text: text || '(clipboard is empty)' }],
    structuredContent: result,
  };
});

server.registerTool('set_clipboard', {
  description:
    'Set the system clipboard. Supports multiple content types: ' +
    '"text" (plain text string), "html" (HTML string — also sets plain text fallback), ' +
    '"image_file" (path to an image file), "image_base64" (raw base64 PNG/JPEG data). ' +
    'Returns {success, message, type}.',
  inputSchema: {
    type: z.enum(['text', 'html', 'image_file', 'image_base64']).default('text').describe('Content type to set'),
    content: z.string().describe(
      'The content: plain text string, HTML string, absolute file path, or base64-encoded image data'
    ),
  },
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    type: z.string(),
  }),
}, async ({ type, content }) => {
  if (type === 'text') {
    await setClipboardText(content);
    addToHistory(content, 'set_clipboard');
    const result = { success: true, message: `Clipboard set to text (${content.length} chars)`, type };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }

  if (type === 'html') {
    await execFileAsync('osascript', ['-e',
      `set the clipboard to {text:\"${content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}\" as Unicode text, «class HTML»:«data HTML${Buffer.from(content).toString('hex')}»}`
    ]);
    addToHistory(content, 'set_clipboard_html');
    const result = { success: true, message: `Clipboard set to HTML (${content.length} chars)`, type };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }

  if (type === 'image_file') {
    await execFileAsync('osascript', ['-e',
      `set the clipboard to (read (POSIX file "${content}") as «class PNGf»)`
    ]);
    const result = { success: true, message: `Clipboard set to image from ${content}`, type };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }

  if (type === 'image_base64') {
    const tmp = join(tmpdir(), `mcp-clip-${randomUUID()}.png`);
    await writeFile(tmp, Buffer.from(content, 'base64'));
    try {
      await execFileAsync('osascript', ['-e',
        `set the clipboard to (read (POSIX file "${tmp}") as «class PNGf»)`
      ]);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    const result = { success: true, message: 'Clipboard set to image from base64 data', type };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }

  throw new Error(`Unknown type: ${type}`);
});

server.registerTool('get_clipboard_info', {
  description: 'Get information about all data types currently on the clipboard without reading the content. Returns {types, has_text, has_image, has_file_urls, type_count}.',
  inputSchema: {},
  outputSchema: z.object({
    types: z.array(z.string()),
    has_text: z.boolean(),
    has_image: z.boolean(),
    has_file_urls: z.boolean(),
    type_count: z.number(),
  }),
}, async () => {
  const types = await getClipboardTypes();
  const result = {
    types,
    has_text: types.includes('plain_text'),
    has_image: types.includes('image'),
    has_file_urls: types.includes('file_url'),
    type_count: types.length,
  };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('clear_clipboard', {
  description: 'Clear the system clipboard of all content. Returns {success, message}.',
  inputSchema: {},
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
}, async () => {
  await setClipboardText('');
  const result = { success: true, message: 'Clipboard cleared' };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('append_to_clipboard', {
  description: 'Append text to the current clipboard text contents. Returns {success, message, length}.',
  inputSchema: {
    text: z.string().describe('The text to append'),
    separator: z.string().default('\n').describe('Separator between existing content and new text (default: newline)'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    length: z.number(),
  }),
}, async ({ text, separator }) => {
  const current = await getClipboardText();
  const newText = current + separator + text;
  await setClipboardText(newText);
  addToHistory(newText, 'append_to_clipboard');
  const result = { success: true, message: `Appended to clipboard (${newText.length} chars total)`, length: newText.length };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('prepend_to_clipboard', {
  description: 'Prepend text to the current clipboard text contents. Returns {success, message, length}.',
  inputSchema: {
    text: z.string().describe('The text to prepend'),
    separator: z.string().default('\n').describe('Separator between new text and existing content (default: newline)'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    length: z.number(),
  }),
}, async ({ text, separator }) => {
  const current = await getClipboardText();
  const newText = text + separator + current;
  await setClipboardText(newText);
  addToHistory(newText, 'prepend_to_clipboard');
  const result = { success: true, message: `Prepended to clipboard (${newText.length} chars total)`, length: newText.length };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('transform_clipboard', {
  description: 'Apply a text transformation to the current clipboard contents in place. Operations: uppercase, lowercase, titlecase, trim, strip_newlines, sort_lines, unique_lines, reverse_lines, number_lines, remove_blank_lines. Returns {success, operation, length, preview}.',
  inputSchema: {
    operation: z.string().describe('Transformation to apply: uppercase | lowercase | titlecase | trim | strip_newlines | sort_lines | unique_lines | reverse_lines | number_lines | remove_blank_lines'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    operation: z.string(),
    length: z.number(),
    preview: z.string(),
  }),
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
  const result = { success: true, operation, length: transformed.length, preview };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('find_and_replace_clipboard', {
  description: 'Find and replace text in the current clipboard contents. Returns {success, replacements, length}.',
  inputSchema: {
    find: z.string().describe('The text to search for'),
    replace: z.string().describe('The text to replace it with'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    replacements: z.number(),
    length: z.number().optional(),
    message: z.string().optional(),
  }),
}, async ({ find, replace }) => {
  const current = await getClipboardText();
  if (!current) throw new Error('Clipboard is empty or has no text');

  const count = current.split(find).length - 1;
  if (count === 0) {
    const result = { success: true, message: 'No matches found', replacements: 0 };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }

  const transformed = current.split(find).join(replace);
  await setClipboardText(transformed);
  addToHistory(transformed, 'find_and_replace');
  const result = { success: true, replacements: count, length: transformed.length };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('get_clipboard_history', {
  description: 'Get the in-memory clipboard history (entries tracked since the server started). Returns {entries, total_in_history}.',
  inputSchema: {
    limit: z.number().int().default(20).describe('Maximum number of history entries to return'),
  },
  outputSchema: z.object({
    entries: z.array(z.object({
      text: z.string(),
      full_length: z.number(),
      timestamp: z.string(),
      source: z.string(),
    })),
    total_in_history: z.number(),
  }),
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
  const result = { entries, total_in_history: _history.length };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('restore_from_history', {
  description: 'Restore a clipboard entry from history back to the system clipboard. Returns {success, message, preview, length}.',
  inputSchema: {
    index: z.number().int().describe('The 0-based index in the history (0 = most recent)'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    preview: z.string(),
    length: z.number(),
  }),
}, async ({ index }) => {
  if (index < 0 || index >= _history.length)
    throw new Error(`Invalid index ${index}. History has ${_history.length} entries (0-${_history.length - 1}).`);
  const text = _history[index].text;
  await setClipboardText(text);
  const preview = text.slice(0, 200) + (text.length > 200 ? '...' : '');
  const result = { success: true, message: `Restored entry ${index} to clipboard`, preview, length: text.length };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('clear_clipboard_history', {
  description: 'Clear the in-memory clipboard history. Does not affect the current clipboard. Returns {success, message, entries_cleared}.',
  inputSchema: {},
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    entries_cleared: z.number(),
  }),
}, async () => {
  const count = _history.length;
  _history.length = 0;
  const result = { success: true, message: `Cleared ${count} history entries`, entries_cleared: count };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
