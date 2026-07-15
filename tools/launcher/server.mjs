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
  icons: [{ src: 'https://api.iconify.design/mdi/rocket-launch.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Launch a macOS application by name (e.g. "Safari", "Spotify", "Cursor"). ' +
    'Brings the app to the front if already running. Returns {success}.',
  inputSchema: {
    name: z.string().describe('Application name as it appears in /Applications (without .app)'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    app: z.string(),
  }),
}, async ({ name }) => {
  await open('-a', name);
  const result = { success: true, app: name };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('open_folder', {
  icons: [{ src: 'https://api.iconify.design/mdi/folder-open.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open a folder in Finder. Returns {success, path}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the folder'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
  }),
}, async ({ path }) => {
  await open(path);
  const result = { success: true, path };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('open_url', {
  icons: [{ src: 'https://api.iconify.design/mdi/web.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open a URL in the default browser, or in a specific browser by name ' +
    '(e.g. "Safari", "Google Chrome", "Firefox"). Returns {success, url}.',
  inputSchema: {
    url: z.string().describe('URL to open'),
    browser: z.string().default('').describe('Browser app name (empty = default browser)'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    url: z.string(),
  }),
}, async ({ url, browser }) => {
  if (browser.trim()) {
    await open('-a', browser.trim(), url);
  } else {
    await open(url);
  }
  const result = { success: true, url };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('reveal_in_finder', {
  icons: [{ src: 'https://api.iconify.design/mdi/folder-search.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Reveal a file or folder in Finder (selects it in its parent folder). ' +
    'Returns {success, path}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the file or folder to reveal'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
  }),
}, async ({ path }) => {
  await open('-R', path);
  const result = { success: true, path };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('open_with', {
  icons: [{ src: 'https://api.iconify.design/mdi/open-in-app.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open a file or folder with a specific application ' +
    '(e.g. open a folder in Cursor, or an image in Photoshop). Returns {success, path, app}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the file or folder'),
    app:  z.string().describe('Application name (e.g. "Cursor", "Photoshop", "Visual Studio Code")'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    app: z.string(),
  }),
}, async ({ path, app }) => {
  await open('-a', app, path);
  const result = { success: true, path, app };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
