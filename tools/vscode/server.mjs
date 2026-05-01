/**
 * VS Code — control VS Code windows via the streamdeck-vscode extension
 * (nicollasr.vscode-streamdeck / nicollasricas/vscode-deck).
 *
 * The VS Code extension connects as a WebSocket CLIENT to this server on
 * port 48969. Install the extension in VS Code, then this pack will receive
 * connections automatically when VS Code opens.
 *
 * Wire format (both directions):
 *   { "id": "<MessageClassName>", "data": "<JSON-stringified payload>" }
 *
 * Common execute_command IDs:
 *   workbench.action.toggleSidebarVisibility
 *   workbench.action.togglePanel
 *   workbench.action.terminal.toggleTerminal
 *   workbench.action.terminal.new
 *   workbench.action.terminal.kill
 *   workbench.action.toggleActivityBarVisibility
 *   workbench.action.toggleStatusbarVisibility
 *   workbench.action.toggleZenMode
 *   workbench.action.files.save
 *   workbench.action.closeActiveEditor
 *   workbench.action.closeAllEditors
 *   workbench.action.openRecent
 *   workbench.action.showCommands           (open command palette)
 *   workbench.action.gotoSymbol
 *   editor.action.formatDocument
 *   git.commitAll
 *   claude.openPanel  (or check Claude Code extension's command ID)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WS_PORT = 48969;
const server = new McpServer({ name: 'vscode', version: '1.0.0' });

// ── WebSocket server ──────────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → ws
let activeSessionId = null;

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const sessionId = req.headers['x-vssessionid'] || `session-${Date.now()}`;
  sessions.set(sessionId, ws);
  if (!activeSessionId) activeSessionId = sessionId;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      if (msg.id === 'ChangeActiveSessionMessage') {
        const newId = payload.sessionId || sessionId;
        activeSessionId = newId;
        // Notify other windows they are no longer active
        for (const [sid, other] of sessions) {
          if (sid !== newId) {
            sendTo(other, 'ActiveSessionChangedMessage', { sessionId: newId });
          }
        }
      }
    } catch { /* malformed message */ }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
    if (activeSessionId === sessionId) {
      activeSessionId = sessions.size > 0 ? sessions.keys().next().value : null;
    }
  });
});

function sendTo(ws, id, payload) {
  ws.send(JSON.stringify({ id, data: JSON.stringify(payload) }));
}

function sendToActive(id, payload) {
  if (!activeSessionId || !sessions.has(activeSessionId)) {
    throw new Error('No VS Code window connected. Make sure the streamdeck-vscode extension is installed and VS Code is open.');
  }
  sendTo(sessions.get(activeSessionId), id, payload);
}

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool('get_status', {
  description: 'Check whether any VS Code windows are connected and which is active. Returns {connected, session_count, active_session}.',
  inputSchema: {},
}, async () => {
  return { content: [{ type: 'text', text: JSON.stringify({
    connected: sessions.size > 0,
    session_count: sessions.size,
    active_session: activeSessionId,
  }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('execute_command', {
  description: 'Execute any VS Code command in the active window. ' +
    'Common commands: workbench.action.toggleSidebarVisibility, ' +
    'workbench.action.togglePanel, workbench.action.terminal.toggleTerminal, ' +
    'workbench.action.terminal.new, workbench.action.toggleZenMode, ' +
    'workbench.action.showCommands, editor.action.formatDocument, ' +
    'workbench.action.closeActiveEditor, workbench.action.files.save. ' +
    'Returns {success}.',
  inputSchema: {
    command: z.string().describe('VS Code command ID (e.g. "workbench.action.toggleSidebarVisibility")'),
    arguments: z.array(z.unknown()).default([]).describe('Optional command arguments'),
  },
}, async ({ command, arguments: args }) => {
  sendToActive('ExecuteCommandMessage', {
    command,
    arguments: args.length > 0 ? JSON.stringify(args) : null,
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, command }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('create_terminal', {
  description: 'Create a new integrated terminal in VS Code. Returns {success}.',
  inputSchema: {
    name:             z.string().default('').describe('Terminal tab name'),
    working_directory:z.string().default('').describe('Starting directory (default: workspace root)'),
    shell_path:       z.string().default('').describe('Shell executable path (default: user default shell)'),
    preserve_focus:   z.boolean().default(false).describe('If true, keep focus on the editor instead of the terminal'),
  },
}, async ({ name, working_directory, shell_path, preserve_focus }) => {
  sendToActive('CreateTerminalMessage', {
    name: name || undefined,
    workingDirectory: working_directory || undefined,
    shellPath: shell_path || undefined,
    preserveFocus: preserve_focus,
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('run_in_terminal', {
  description: 'Send a shell command to the active integrated terminal in VS Code. Returns {success}.',
  inputSchema: {
    command: z.string().describe('Shell command to run in the active terminal'),
  },
}, async ({ command }) => {
  sendToActive('ExecuteTerminalCommandMessage', { command });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, command }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('open_folder', {
  description: 'Open a folder in VS Code. Returns {success}.',
  inputSchema: {
    path:       z.string().describe('Absolute path to the folder'),
    new_window: z.boolean().default(false).describe('Open in a new VS Code window'),
  },
}, async ({ path, new_window }) => {
  sendToActive('OpenFolderMessage', { path, newWindow: new_window });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, path }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('change_language', {
  description: 'Change the language mode of the active editor (e.g. "typescript", "python", "json"). Returns {success}.',
  inputSchema: {
    language_id: z.string().describe('VS Code language ID (e.g. "typescript", "python", "markdown")'),
  },
}, async ({ language_id }) => {
  sendToActive('ChangeLanguageMessage', { languageId: language_id });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, language_id }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('insert_snippet', {
  description: 'Insert a named snippet into the active editor. Returns {success}.',
  inputSchema: {
    name: z.string().describe('Snippet name as defined in VS Code'),
  },
}, async ({ name }) => {
  sendToActive('InsertSnippetMessage', { name });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, name }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('search_commands', {
  description: 'Search VS Code command IDs across all installed extensions. ' +
    'Returns matching commands with their IDs and titles. ' +
    'Pass an empty query to list all commands for a specific extension (e.g. extension="claude"). ' +
    'Use the returned command IDs with execute_command.',
  inputSchema: {
    query:     z.string().default('').describe('Search term matched against command ID and title (case-insensitive)'),
    extension: z.string().default('').describe('Filter to a specific extension by folder name prefix (e.g. "anthropic", "claude", "ms-vscode")'),
  },
}, async ({ query, extension }) => {
  const extensionDirs = [
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-server', 'extensions'),
    '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions',
  ];

  const results = [];
  const q = query.toLowerCase();
  const ext = extension.toLowerCase();

  for (const baseDir of extensionDirs) {
    let entries;
    try { entries = await readdir(baseDir); } catch { continue; }

    for (const entry of entries) {
      if (ext && !entry.toLowerCase().includes(ext)) continue;
      try {
        const pkgPath = join(baseDir, entry, 'package.json');
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
        const commands = pkg.contributes?.commands ?? [];
        for (const cmd of commands) {
          const id = cmd.command ?? '';
          const title = (typeof cmd.title === 'object' ? cmd.title.value : cmd.title) ?? '';
          if (!q || id.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
            results.push({ command: id, title, extension: entry });
          }
        }
      } catch { /* no package.json or no commands */ }
    }
  }

  results.sort((a, b) => a.command.localeCompare(b.command));
  return { content: [{ type: 'text', text: JSON.stringify({ count: results.length, commands: results }) }] };
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
