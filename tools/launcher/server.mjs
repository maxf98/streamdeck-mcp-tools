/**
 * Launcher — open apps, folders, URLs and reveal files in Finder.
 * Uses macOS `open` command. No dependencies beyond the SDK.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'launcher', version: '1.0.0' });

// ── Helpers ──────────────────────────────────────────────────────────────────

async function open(...args) {
  await execFileAsync('open', args);
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('open_app', {
  description: 'Launch a macOS application by name (e.g. "Safari", "Spotify", "Cursor"). ' +
    'Brings the app to the front if already running. Returns {success}.',
  inputSchema: {
    name: z.string().describe('Application name as it appears in /Applications (without .app)'),
  },
}, async ({ name }) => {
  await open('-a', name);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, app: name }) }] };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('open_folder', {
  description: 'Open a folder in Finder. Returns {success, path}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the folder'),
  },
}, async ({ path }) => {
  await open(path);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, path }) }] };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('open_url', {
  description: 'Open a URL in the default browser, or in a specific browser by name ' +
    '(e.g. "Safari", "Google Chrome", "Firefox"). Returns {success, url}.',
  inputSchema: {
    url: z.string().describe('URL to open'),
    browser: z.string().default('').describe('Browser app name (empty = default browser)'),
  },
}, async ({ url, browser }) => {
  if (browser.trim()) {
    await open('-a', browser.trim(), url);
  } else {
    await open(url);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, url }) }] };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('reveal_in_finder', {
  description: 'Reveal a file or folder in Finder (selects it in its parent folder). ' +
    'Returns {success, path}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the file or folder to reveal'),
  },
}, async ({ path }) => {
  await open('-R', path);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, path }) }] };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('open_with', {
  description: 'Open a file or folder with a specific application ' +
    '(e.g. open a folder in Cursor, or an image in Photoshop). Returns {success, path, app}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the file or folder'),
    app:  z.string().describe('Application name (e.g. "Cursor", "Photoshop", "Visual Studio Code")'),
  },
}, async ({ path, app }) => {
  await open('-a', app, path);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, path, app }) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
