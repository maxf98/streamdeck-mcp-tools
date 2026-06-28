import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
// Advertise resource subscription — the start/stop/watch process tools below
// expose each tracked process as a subscribable resource.
const server = new McpServer(
  { name: 'BashMCP', version: '1.1.0' },
  { capabilities: { resources: { subscribe: true }, tools: {} } },
);

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
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number(),
    success: z.boolean(),
    command: z.string(),
  }),
}, async ({ command, cwd, env, timeout }) => {
  const result = await runBash(command, cwd, env, timeout);
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('run_script', {
  description: 'Run a multi-line bash script and return its output. Identical to run_command but intended for multi-line scripts. Returns {stdout, stderr, exit_code, success, command}.',
  inputSchema: {
    script: z.string().describe('Multi-line bash script'),
    cwd: z.string().default('').describe('Working directory for the script. Supports ~ and $ENV_VAR.'),
    env: z.record(z.string()).optional().describe('Extra environment variables'),
    timeout: z.number().int().default(60).describe('Max seconds (default 60)'),
  },
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number(),
    success: z.boolean(),
    command: z.string(),
  }),
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
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } finally {
    try { await unlink(scriptPath); } catch {}
  }
});

server.registerTool('open_in_terminal', {
  description: 'Open Terminal.app and optionally run a command interactively. Great for interactive programs like `claude`, `python`, `ssh`. Returns {success, message}.',
  inputSchema: {
    command: z.string().default('').describe('Command to run in the terminal. Leave empty to just open a shell.'),
    cwd: z.string().default('').describe('Directory to open in. Supports ~ and $ENV_VAR. Defaults to $HOME.'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
}, async ({ command, cwd }) => {
  const resolved = resolveCwd(cwd) ?? os.homedir();
  const shellCmd = `cd ${resolved.replace(/ /g, '\\ ')}` + (command ? ` && ${command}` : '');
  const asStr = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const script = `tell application "Terminal"\n  activate\n  do script ${asStr(shellCmd)}\nend tell`;

  try {
    await execFileAsync('osascript', ['-e', script]);
    const msg = `Opened Terminal` + (cwd ? ` in ${resolved}` : '') + (command ? ` running: ${command}` : '');
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: msg }) }], structuredContent: { success: true, message: msg } };
  } catch (e) {
    const result = { success: false, message: String(e.message) };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
});

server.registerTool('which', {
  description: 'Find where a command is installed (like `which` in the shell). Returns {found, path, command}.',
  inputSchema: {
    command: z.string().describe('Command name to look up. Example: "git", "python3", "claude"'),
  },
  outputSchema: z.object({
    found: z.boolean(),
    path: z.string(),
    command: z.string(),
  }),
}, async ({ command }) => {
  try {
    const { stdout } = await execFileAsync('which', [command]);
    const result = { found: true, path: stdout.trim(), command };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch {
    const result = { found: false, path: '', command };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
});

server.registerTool('get_env', {
  description: 'Get environment variables from the shell. Returns dict of {variable_name: value}. Missing vars are omitted.',
  inputSchema: {
    keys: z.array(z.string()).optional().describe('List of variable names to fetch. If empty, returns a useful subset: PATH, HOME, USER, SHELL, PWD, LANG, TERM, etc.'),
  },
  outputSchema: z.record(z.string()),
}, async ({ keys }) => {
  const defaults = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'LANG', 'TERM', 'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV', 'NVM_DIR', 'GOPATH'];
  const wanted = keys?.length ? keys : defaults;
  const result = {};
  for (const k of wanted) {
    if (process.env[k] !== undefined) result[k] = process.env[k];
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

// ── Long-running processes: start, stop & OBSERVE by handle ────────────────────
//
// run_command is fire-and-forget; these track a process across calls. The design
// follows MCP's stateless-core direction: state is addressed by an EXPLICIT HANDLE
// (a process_id minted by start_process) and PERSISTED TO DISK, not held only in
// memory — so liveness is answered correctly even after this server is torn down
// and respawned (which the host does as buttons come and go). The resident-process
// `child.on('exit')` event is only an opportunistic instant-push optimization;
// truth is always recomputed from the OS on read.
//
//   start_process { command, cwd? } → { process_id, pid, running }
//   stop_process  { process_id }    → { process_id, running }
//   list_processes {}               → { processes: [...] }
//   resource://bash/process/{process_id} (subscribable) → { process_id, running,
//                                          pid, command, startedAt }

const PROC_DIR = nodePath.join(process.env.STREAMDECK_MCP_DIR ?? nodePath.join(os.homedir(), '.streamdeck-mcp'), 'bash-processes');
mkdirSync(PROC_DIR, { recursive: true });

const procPath = (id) => nodePath.join(PROC_DIR, `${id}.json`);
function readRecord(id) {
  try { return JSON.parse(readFileSync(procPath(id), 'utf8')); } catch { return null; }
}
function writeRecord(rec) { writeFileSync(procPath(rec.process_id), JSON.stringify(rec)); }
function deleteRecord(id) { try { unlinkSync(procPath(id)); } catch {} }
function allRecords() {
  let names = [];
  try { names = readdirSync(PROC_DIR).filter((n) => n.endsWith('.json')); } catch {}
  return names.map((n) => readRecord(n.slice(0, -5))).filter(Boolean);
}

// process.kill(pid, 0) tests existence without signalling: ESRCH = gone, EPERM =
// alive but unsignalable. PIDs are recycled, so we also verify identity against
// the live command line before claiming a process is still ours.
function pidExists(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function identityMatches(pid, command) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    if (!out) return false;
    const head = command.trim().split(/\s+/)[0];
    return head.length > 0 && out.includes(head);
  } catch {
    return true; // can't determine → don't report a false death
  }
}

// Find a live process whose FULL command line matches `command` exactly, returning
// its pid (or null). This is the ground-truth recovery path: our recorded pid can
// be lost even though the process lives — e.g. this server (the child's parent) is
// torn down by the host between presses, firing child 'exit' while the DETACHED
// process keeps running and reparents to launchd. pgrep -f matches against the full
// argv, and we require an exact command match so we don't adopt an unrelated process.
function findPidByCommand(command) {
  try {
    const out = execFileSync('pgrep', ['-f', command], { encoding: 'utf8' }).trim();
    const pids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n !== process.pid);
    for (const pid of pids) {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      // Exact match: the live argv is exactly our command (pgrep -f also matches
      // substrings/our own grep, so confirm via ps and require equality).
      if (cmd === command) return pid;
    }
  } catch { /* pgrep exits non-zero when nothing matches */ }
  return null;
}

// Authoritative status from disk + the OS right now. Self-healing: if the recorded
// pid is gone but a live process still matches the command, ADOPT it (the process
// outlived our handle). null when there's no record for this handle.
function statusFor(id) {
  const rec = readRecord(id);
  if (!rec) return null;
  let alive = pidExists(rec.pid) && identityMatches(rec.pid, rec.command);
  if (!alive && rec.command) {
    // Recover a detached process whose pid we lost (e.g. parent torn down).
    const found = findPidByCommand(rec.command);
    if (found) { rec.pid = found; alive = true; }
  }
  if (rec.running !== alive || (alive && rec.pid == null)) {
    rec.running = alive;
    if (!alive) rec.pid = null;
    writeRecord(rec);
  } else if (alive && readRecord(id)?.pid !== rec.pid) {
    writeRecord(rec); // persist an adopted pid
  }
  return { process_id: rec.process_id, running: rec.running, pid: rec.pid ?? null, command: rec.command, startedAt: rec.startedAt ?? null };
}

const PROC_URI_PREFIX = 'resource://bash/process/';
const procUri = (id) => `${PROC_URI_PREFIX}${id}`;
const idFromUri = (uri) => { const m = new RegExp(`^${PROC_URI_PREFIX}(.+)$`).exec(uri); return m ? m[1] : null; };

const subscribedProcs = new Set();
function notifyProcUpdated(id) {
  const uri = procUri(id);
  if (subscribedProcs.has(uri)) server.server.sendResourceUpdated({ uri }).catch(() => {});
}

server.registerResource(
  'process',
  new ResourceTemplate(`${PROC_URI_PREFIX}{process_id}`, {
    list: async () => ({
      resources: allRecords().map((rec) => ({
        uri: procUri(rec.process_id),
        name: `Process ${rec.process_id}`,
        description: `Live status of: ${rec.command}`,
        mimeType: 'application/json',
      })),
    }),
  }),
  { description: 'Live { running, pid, command } status of a process started by start_process, by its handle.' },
  async (uri, variables) => {
    const id = variables.process_id;
    const status = statusFor(id) ?? { process_id: id, running: false, pid: null, command: null, startedAt: null };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(status) }] };
  },
);

server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  if (req.params?.uri && idFromUri(req.params.uri)) subscribedProcs.add(req.params.uri);
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  if (req.params?.uri) subscribedProcs.delete(req.params.uri);
  return {};
});

server.registerTool('start_process', {
  description:
    'Start a long-running process under a handle (process_id). Pass your OWN stable id (e.g. a button id) so a face ' +
    'can bind to resource://bash/process/{id} at author time and you can toggle it later; omit id to get a random one. ' +
    'Idempotent: if a process for that id is already running, this is a no-op and returns it. The command runs detached ' +
    'so it outlives this server. Use run_command for one-shot work.',
  inputSchema: {
    command: z.string().describe('Shell command to run, e.g. "python3 -m http.server 8000".'),
    id: z.string().optional().describe('Stable handle to use (e.g. the button id). Omit for a random one.'),
    cwd: z.string().default('').describe('Working directory. Supports ~ and $ENV_VAR. Defaults to $HOME.'),
  },
  outputSchema: z.object({ process_id: z.string(), pid: z.number().nullable(), running: z.boolean(), alreadyRunning: z.boolean() }),
}, async ({ command, id, cwd }) => {
  const process_id = id || randomUUID();

  // Idempotent: if this handle already has a live process, don't start another.
  const cur = statusFor(process_id);
  if (cur && cur.running) {
    const result = { process_id, pid: cur.pid, running: true, alreadyRunning: true };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }

  const resolved = resolveCwd(cwd) ?? os.homedir();
  // `exec` so bash REPLACES itself with the command: the pid we record is the
  // actual leaf process (e.g. python), not a bash wrapper whose death would
  // diverge from a reparented grandchild. Detached + unref so it outlives us.
  const child = spawn('bash', ['-c', `exec ${command}`], { cwd: resolved, detached: true, stdio: 'ignore' });
  child.unref();
  const rec = { process_id, pid: child.pid ?? null, command, startedAt: Date.now(), running: true };
  writeRecord(rec);
  // Opportunistic instant-push if we're still resident when it dies; statusFor()
  // recomputes truth from the OS regardless, so this is latency-only.
  child.on('exit', () => {
    // 'exit' fires both when the process really dies AND when WE (its parent) are
    // torn down by the host while the DETACHED process keeps running. So don't
    // trust it — verify against the OS. Only mark dead if the pid is truly gone
    // and no live process still matches the command (statusFor does both).
    const r = readRecord(process_id);
    if (r && r.pid === child.pid && !pidExists(child.pid) && !findPidByCommand(command)) {
      r.running = false; r.pid = null; writeRecord(r);
      notifyProcUpdated(process_id);
    }
  });
  notifyProcUpdated(process_id);
  const result = { process_id, pid: rec.pid, running: true, alreadyRunning: false };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('stop_process', {
  description: 'Stop a process started by start_process, by its process_id handle. Clears its persisted state.',
  inputSchema: { process_id: z.string().describe('The handle returned by start_process.') },
  outputSchema: z.object({ process_id: z.string(), running: z.boolean() }),
}, async ({ process_id }) => {
  // statusFor recovers the live pid by command if our recorded one was lost (e.g.
  // the process outlived a prior server teardown), so stop works even then.
  const status = statusFor(process_id);
  const pid = status?.pid;
  if (pid && pidExists(pid)) {
    // Detached spawn ⇒ the child leads its own process group; kill the group so
    // grandchildren (e.g. a shell's subprocess) die too.
    try { process.kill(-pid, 'SIGTERM'); }
    catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
  deleteRecord(process_id);
  notifyProcUpdated(process_id);
  const result = { process_id, running: false };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('list_processes', {
  description: 'List all processes started by start_process with their current live status.',
  inputSchema: {},
  outputSchema: z.object({
    processes: z.array(z.object({
      process_id: z.string(), running: z.boolean(), pid: z.number().nullable(),
      command: z.string().nullable(), startedAt: z.number().nullable(),
    })),
  }),
}, async () => {
  const processes = allRecords().map((rec) => statusFor(rec.process_id)).filter(Boolean);
  return { content: [{ type: 'text', text: JSON.stringify({ processes }) }], structuredContent: { processes } };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
