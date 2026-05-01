import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'BashMCP', version: '1.0.0' });

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveCwd(cwd) {
  if (!cwd) return null;
  const expanded = cwd.replace(/^~/, os.homedir()).replace(/\$(\w+)/g, (_, v) => process.env[v] ?? '');
  try { if (statSync(expanded).isDirectory()) return expanded; } catch {}
  return null;
}

function runBash(command, cwd, env, timeout) {
  return new Promise(resolve => {
    const resolved = resolveCwd(cwd) ?? os.homedir();
    const procEnv = { ...process.env, ...(env ?? {}) };
    const timer = setTimeout(() => {
      resolve({ stdout: '', stderr: `Command timed out after ${timeout}s`, exit_code: -1, success: false, command });
    }, timeout * 1000);

    execFile('bash', ['-c', command], { cwd: resolved, env: procEnv, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      const exit_code = err?.code ?? 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exit_code: typeof exit_code === 'number' ? exit_code : -1, success: !err, command });
    });
  });
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('run_command', {
  description: 'Run a shell command and return its output. Runs via bash -c so pipes, redirects, and builtins all work. Returns {stdout, stderr, exit_code, success, command}.',
  inputSchema: {
    command: z.string().describe('Shell command to run (e.g. "ls -la ~/Desktop", "git status")'),
    cwd: z.string().default('').describe('Working directory. Supports ~ and $ENV_VAR. Defaults to $HOME.'),
    env: z.record(z.string()).optional().describe('Extra environment variables to merge into the process env'),
    timeout: z.number().int().default(30).describe('Max seconds to wait (default 30)'),
  },
}, async ({ command, cwd, env, timeout }) => {
  const result = await runBash(command, cwd, env, timeout);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('run_script', {
  description: 'Run a multi-line bash script and return its output. Identical to run_command but intended for multi-line scripts. Returns {stdout, stderr, exit_code, success, command}.',
  inputSchema: {
    script: z.string().describe('Multi-line bash script'),
    cwd: z.string().default('').describe('Working directory for the script. Supports ~ and $ENV_VAR.'),
    env: z.record(z.string()).optional().describe('Extra environment variables'),
    timeout: z.number().int().default(60).describe('Max seconds (default 60)'),
  },
}, async ({ script, cwd, env, timeout }) => {
  const scriptPath = nodePath.join(os.tmpdir(), `streamdeck_${Date.now()}.sh`);
  try {
    await writeFile(scriptPath, script, { mode: 0o755 });
    const result = await new Promise(resolve => {
      const resolved = resolveCwd(cwd) ?? os.homedir();
      const procEnv = { ...process.env, ...(env ?? {}) };
      const timer = setTimeout(() => {
        resolve({ stdout: '', stderr: `Script timed out after ${timeout}s`, exit_code: -1, success: false, command: `<script (${script.split('\n').length} lines)>` });
      }, timeout * 1000);
      execFile('bash', [scriptPath], { cwd: resolved, env: procEnv, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        clearTimeout(timer);
        const exit_code = err?.code ?? 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exit_code: typeof exit_code === 'number' ? exit_code : -1, success: !err, command: `<script (${script.split('\n').length} lines)>` });
      });
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } finally {
    try { await unlink(scriptPath); } catch {}
  }
});

server.registerTool('open_in_terminal', {
  description: 'Open Terminal.app (or iTerm2) and optionally run a command interactively. Great for interactive programs like `claude`, `python`, `ssh`. Returns {success, app, message}.',
  inputSchema: {
    command: z.string().default('').describe('Command to run in the terminal. Leave empty to just open a shell.'),
    cwd: z.string().default('').describe('Directory to open in. Supports ~ and $ENV_VAR. Defaults to $HOME.'),
    app: z.string().default('auto').describe('Which terminal to use: "Terminal", "iTerm", or "auto" (auto picks iTerm if installed).'),
    new_window: z.boolean().default(true).describe('If true (default), open a new window. If false, open a new tab (Terminal.app only).'),
  },
}, async ({ command, cwd, app, new_window }) => {
  const resolved = resolveCwd(cwd) ?? os.homedir();

  // Auto-detect iTerm2
  if (app === 'auto') {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', 'tell application "System Events" to return (exists process "iTerm2")']);
      app = stdout.trim() === 'true' ? 'iTerm' : 'Terminal';
    } catch {
      app = 'Terminal';
    }
  }

  // AppleScript string quoting
  const asStr = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const shellCmd = `cd ${resolved.replace(/ /g, '\\ ')}` + (command ? ` && ${command}` : '');

  let script;
  if (app === 'iTerm') {
    script = `tell application "iTerm2"\n  activate\n  set w to (create window with default profile)\n  tell current session of w\n    write text ${asStr(shellCmd)}\n  end tell\nend tell`;
  } else if (new_window) {
    script = `tell application "Terminal"\n  activate\n  do script ${asStr(shellCmd)}\nend tell`;
  } else {
    script = `tell application "Terminal"\n  activate\n  tell front window\n    do script ${asStr(shellCmd)} in selected tab\n  end tell\nend tell`;
  }

  try {
    await execFileAsync('osascript', ['-e', script]);
    const msg = `Opened ${app}` + (cwd ? ` in ${resolved}` : '') + (command ? ` running: ${command}` : '');
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, app, message: msg }) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, app, message: String(e.message) }) }] };
  }
});

server.registerTool('which', {
  description: 'Find where a command is installed (like `which` in the shell). Returns {found, path, command}.',
  inputSchema: {
    command: z.string().describe('Command name to look up. Example: "git", "python3", "claude"'),
  },
}, async ({ command }) => {
  try {
    const { stdout } = await execFileAsync('which', [command]);
    return { content: [{ type: 'text', text: JSON.stringify({ found: true, path: stdout.trim(), command }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ found: false, path: '', command }) }] };
  }
});

server.registerTool('get_env', {
  description: 'Get environment variables from the shell. Returns dict of {variable_name: value}. Missing vars are omitted.',
  inputSchema: {
    keys: z.array(z.string()).optional().describe('List of variable names to fetch. If empty, returns a useful subset: PATH, HOME, USER, SHELL, PWD, LANG, TERM, etc.'),
  },
}, async ({ keys }) => {
  const defaults = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'LANG', 'TERM', 'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV', 'NVM_DIR', 'GOPATH'];
  const wanted = keys?.length ? keys : defaults;
  const result = {};
  for (const k of wanted) {
    if (process.env[k] !== undefined) result[k] = process.env[k];
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
