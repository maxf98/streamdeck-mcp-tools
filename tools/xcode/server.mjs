/**
 * Xcode — drive the running Xcode session via AppleScript.
 *
 * Xcode ships a real scripting dictionary (`sdef /Applications/Xcode.app`), so
 * unlike a CLI-only pack this talks to the IDE the user is actually looking at:
 * the *active* scheme, the *active* workspace, the real build log, and the
 * structured errors/warnings/test-failures Xcode itself surfaces. `xcodebuild`
 * can't see any of that — it builds its own out-of-band copy.
 *
 * Shape of the dictionary (the bits that matter here):
 *   application
 *     └─ active workspace document ──┐
 *        workspace document          │  build / clean / run / test / stop / debug / attach
 *          ├─ loaded (boolean)       │  → each returns a `scheme action result`
 *          ├─ active scheme          │
 *          ├─ last scheme action result
 *          ├─ schemes, run destinations, projects
 *        scheme action result
 *          ├─ completed, status, error message, build log
 *          └─ build errors / build warnings / analyzer issues / test failures
 *               (each a `scheme action issue`: message, file path, line/column)
 *
 * ── VERIFIED QUIRKS (probed against Xcode 26.3, build 17C529) ────────────────
 * These are load-bearing; they're why this file looks the way it does.
 *
 *  1. Scheme actions are ASYNCHRONOUS. `build` returns a result object
 *     immediately; you poll `completed`. We poll inside one long-lived osascript
 *     (see asPoll) rather than re-entering osascript per tick — each re-entry
 *     pays a fresh Apple-event round trip and can outlive the button press.
 *
 *  2. Messages to a workspace document error out until `loaded` is true (Xcode's
 *     own docs say so, and a fresh `open` reproduces it). Every action waits for
 *     load first — see the WAIT_LOADED snippet.
 *
 *  3. `active run destination` is BROKEN in 26.3: reading it yields `missing
 *     value`, and writing it fails with "AppleEvent handler failed". So we never
 *     read or set it. `set_destination` instead persists a *specifier string*
 *     locally and passes it to `debug ... run destination specifier "..."`,
 *     which the dictionary documents and which does work. `list_destinations`
 *     still enumerates `run destinations` (that part works) so the specifier can
 *     be built from real values.
 *
 *  4. `active scheme` reads and writes fine — but only via an element reference
 *     (`set active scheme of aw to (first scheme of aw whose name is "X")`).
 *
 *  5. `text document "Name"` raises "Can't get text document" even when the doc
 *     is open; iterating `document i` and matching `name` works. Same for
 *     reading `text`. So openFile/goto address documents positionally.
 *
 *  6. A list-typed property coerced with `as text` CONCATENATES with no
 *     delimiter — `{1, 8}` becomes "18". `selected character range` must be read
 *     element-by-element (`item 1 of ...`), never `as text`.
 *
 *  7. `operating system version` is `missing value` on generic run destinations
 *     ("Any Mac"), and `device` can be `missing value` too. Every optional
 *     property goes through the `orNull` AppleScript helper.
 *
 *  8. A `build configuration` can carry ~1500 resolved build settings, which is
 *     far too much for a tool result. get_build_settings filters and caps.
 *
 *  9. A top-level handler called from inside a `tell application "Xcode"` block is
 *     sent to XCODE as an event ("Can't continue orNull"), not called locally.
 *     Every call must be `my orNull(...)`.
 *
 * 10. `target` is a term in Xcode's own dictionary (class `tarR`), so using it as
 *     a variable name fails with "Access not allowed". Same trap as `st` (the
 *     `1st` ordinal). Variable names here are deliberately unusual.
 *
 * 11. Xcode names a `.xcodeproj` document after the PROJECT ("ObjcPlugin"), not
 *     the bundle ("ObjcPlugin.xcodeproj") — so open_workspace matches on `path`
 *     first and falls back to either name form.
 *
 * 12. A REFUSED scheme action (e.g. `test` on a scheme with no test target) is
 *     reported as a result that never completes and carries an `error message`,
 *     not as an AppleScript error. runAction turns that into a thrown error.
 *
 * The gateway may tear this server down between presses, so nothing important
 * lives only in memory: the chosen destination specifier is persisted to disk
 * (see PREFS_PATH), and build state is always re-read from Xcode.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const server = new McpServer(
  { name: 'xcode', version: '1.0.0' },
  { capabilities: { resources: { subscribe: true }, tools: {} } },
);

// ── Resource + surface URIs ──────────────────────────────────────────────────

const URI_BUILD = 'resource://xcode/build';
const URI_WORKSPACE = 'resource://xcode/workspace';

const URI_UI_KEY = 'ui://xcode/key';
const URI_UI_DIAL = 'ui://xcode/dial';
const URI_UI_POPUP = 'ui://xcode/popup';

const SURFACE_NS = 'io.streamdeck/surfaces';
const APP_MIME = 'text/html;profile=mcp-app';

// ── AppleScript plumbing ─────────────────────────────────────────────────────

// Xcode is slow to answer while indexing or building, and a scheme action can
// run for minutes. Callers pass an explicit budget; the `with timeout` wrapper
// inside the script must exceed it or AppleScript aborts first (-1712).
async function osa(script, timeoutMs = 20000, { allowLaunch = false } = {}) {
  // Any `tell application "Xcode"` LAUNCHES Xcode if it isn't running, which is a
  // slow surprise for a button press. Gate every Xcode-directed script on Xcode
  // already running; only the tools whose job is to open something opt out via
  // allowLaunch. Scripts aimed elsewhere (System Events) are unaffected.
  if (!allowLaunch && /application "Xcode"/.test(script)) await requireXcode();
  const secs = Math.ceil(timeoutMs / 1000) + 5;
  // HELPERS is hoisted ABOVE the `with timeout` block: AppleScript handler
  // definitions are only legal at the top level of a script, so putting them
  // inside the block fails to compile ("Expected end but found on").
  const wrapped = `${HELPERS}\nwith timeout of ${secs} seconds\n${script}\nend timeout`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', wrapped], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || String(err)).trim();
        reject(new Error(translateError(msg)));
      } else {
        resolve(stdout.replace(/\n$/, ''));
      }
    });
  });
}

/** Turn raw AppleScript/TCC failures into something a button author can act on. */
function translateError(raw) {
  // osascript prefixes every failure with a character range and trails an error
  // number — "249:281: execution error: … (-2700)". Neither helps a button author.
  // Match against the RAW text (it carries the OSStatus code), but return the
  // cleaned one — so the code-based branches below still fire.
  const full = String(raw);
  const msg = full
    .replace(/^\s*\d+:\d+:\s*(execution|syntax) error:\s*/i, '')
    .replace(/\s*\(-?\d+\)\s*$/, '')
    .trim();
  if (/Application isn.t running|-600/.test(full)) {
    return 'Xcode is not running. Open Xcode (or call open_workspace) first.';
  }
  if (/not allowed to send Apple events|-1743/.test(full)) {
    return 'Not permitted to control Xcode. Grant automation access in System Settings › '
      + 'Privacy & Security › Automation (allow the Stream Deck app to control Xcode), then retry.';
  }
  if (/-1712/.test(full) || /timed out/i.test(msg)) {
    return 'Xcode did not answer in time (it may be indexing or mid-build). Retry, or raise the timeout.';
  }
  if (/Can.t get active workspace document/.test(full)) {
    return 'No workspace or project is open in Xcode. Call open_workspace first.';
  }
  return msg;
}

// AppleScript has no JSON writer, so results come back as delimited records and
// are parsed here. The delimiters are chosen to be absent from paths and
// compiler messages; RS/US are the ASCII record/unit separators.
const RS = '';
const US = '';

/**
 * AppleScript helpers injected into every script.
 *
 * `orNull` collapses `missing value` (and any property whose getter throws — see
 * quirk 7) to the empty string, so a record's arity is stable and one flaky
 * property can't abort a whole listing.
 */
const HELPERS = `
on orNull(v)
  try
    if v is missing value then return ""
    return v as text
  on error
    return ""
  end try
end orNull
`.trim();

/**
 * Wait for the active workspace document to finish loading (quirk 2), then bind
 * it to `aw`. Every action-bearing script starts with this.
 */
const WAIT_LOADED = `
set aw to active workspace document
if aw is missing value then error "No workspace is open in Xcode."
repeat 120 times
  try
    if loaded of aw is true then exit repeat
  end try
  delay 0.5
end repeat
if loaded of aw is false then error "Xcode workspace did not finish loading within 60s."
`.trim();

/** Run a script in the Xcode `tell` context with helpers + workspace binding. */
function xcodeScript(body, { needWorkspace = true } = {}) {
  return `tell application "Xcode"\n${needWorkspace ? WAIT_LOADED : ''}\n${body}\nend tell`;
}

const asRecords = (out) => (out ? out.split(RS).filter(Boolean).map((r) => r.split(US)) : []);
const nullable = (s) => (s === '' ? null : s);
const asNum = (s) => (s === '' || s == null ? null : Number(s));
const asBool = (s) => s === 'true';

/** Escape a JS string for embedding in an AppleScript double-quoted literal. */
const q = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ── Persisted prefs (survive a server restart) ───────────────────────────────
// Quirk 3: we can't ask Xcode for the active run destination, so the user's
// choice is ours to remember. Disk, not memory — the host respawns this server.

const STATE_DIR = join(process.env.STREAMDECK_MCP_DIR ?? join(homedir(), '.streamdeck-mcp'), 'xcode');
mkdirSync(STATE_DIR, { recursive: true });
const PREFS_PATH = join(STATE_DIR, 'prefs.json');

function readPrefs() {
  try { return JSON.parse(readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; }
}
function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  try { writeFileSync(PREFS_PATH, JSON.stringify(next)); } catch { /* best effort */ }
  return next;
}

// ── Result helpers ───────────────────────────────────────────────────────────

function ok(data, summary) {
  return {
    content: [{ type: 'text', text: summary ?? JSON.stringify(data) }],
    structuredContent: data,
  };
}

// ── Reading Xcode state ──────────────────────────────────────────────────────

/**
 * The active workspace: name, path, active scheme, and the status of the last
 * scheme action. Deliberately does NOT touch `active run destination` (quirk 3)
 * — reading it throws and would take the whole snapshot down with it.
 */
const WORKSPACE_SNAPSHOT = `
set schemeName to ""
try
  set schemeName to my orNull(name of active scheme of aw)
end try
set lastStatus to ""
set lastCompleted to ""
set nErr to 0
set nWarn to 0
set nTestFail to 0
try
  set ar to last scheme action result of aw
  if ar is not missing value then
    set lastStatus to my orNull(status of ar)
    set lastCompleted to (completed of ar) as text
    try
      set nErr to count of build errors of ar
    end try
    try
      set nWarn to count of build warnings of ar
    end try
    try
      set nTestFail to count of test failures of ar
    end try
  end if
end try
return my orNull(name of aw) & "${US}" & my orNull(path of aw) & "${US}" & schemeName & "${US}" & lastStatus & "${US}" & lastCompleted & "${US}" & (nErr as text) & "${US}" & (nWarn as text) & "${US}" & (nTestFail as text)
`.trim();

async function readWorkspace(timeoutMs = 70000) {
  const out = await osa(xcodeScript(WORKSPACE_SNAPSHOT), timeoutMs);
  const [name, path, scheme, status, completed, nErr, nWarn, nTestFail] = out.split(US);
  const prefs = readPrefs();
  return {
    name: nullable(name),
    path: nullable(path),
    scheme: nullable(scheme),
    // The remembered specifier, since Xcode won't tell us (quirk 3).
    destination: prefs.destinationName ?? null,
    destination_specifier: prefs.destinationSpecifier ?? null,
    status: nullable(status),
    running: completed === 'false',
    errors: Number(nErr || 0),
    warnings: Number(nWarn || 0),
    test_failures: Number(nTestFail || 0),
  };
}

// ── Live build resource ──────────────────────────────────────────────────────
// A button face binds this to show build state on the key. Xcode pushes no
// events, so we poll — but ONLY while something is subscribed, and faster while
// an action is actually running (idle Xcode costs one cheap Apple event / 3s).

const subscribed = new Set();
let buildState = null;
let pollTimer = null;
let pollBusy = false;

const POLL_IDLE_MS = 3000;
const POLL_ACTIVE_MS = 700;

function buildSnapshot(ws) {
  const running = !!ws?.running;
  const status = ws?.status ?? null;
  return {
    scheme: ws?.scheme ?? null,
    workspace: ws?.name ?? null,
    status,
    running,
    errors: ws?.errors ?? 0,
    warnings: ws?.warnings ?? 0,
    test_failures: ws?.test_failures ?? 0,
    label: running ? 'Building…' : status ? String(status) : 'Idle',
    at: Date.now(),
  };
}

function notifyUpdated(uri) {
  if (subscribed.has(uri)) void server.server.sendResourceUpdated({ uri });
}

function setBuildState(next) {
  const sig = (s) => (s ? `${s.scheme}|${s.status}|${s.running}|${s.errors}|${s.warnings}|${s.test_failures}` : '');
  if (sig(buildState) === sig(next)) {
    buildState = next; // refresh `at` without waking the face
    return;
  }
  buildState = next;
  notifyUpdated(URI_BUILD);
  notifyUpdated(URI_WORKSPACE);
}

async function pollOnce() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    // Don't launch Xcode just to poll: if it isn't running there's nothing to
    // report, and an Apple event would boot the whole IDE.
    if (!(await isXcodeRunning())) {
      setBuildState(buildSnapshot(null));
      return;
    }
    setBuildState(buildSnapshot(await readWorkspace(20000)));
  } catch {
    // Xcode busy/closing/no workspace — keep the last good snapshot.
  } finally {
    pollBusy = false;
    schedulePoll();
  }
}

function schedulePoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (subscribed.size === 0) return;
  pollTimer = setTimeout(() => void pollOnce(), buildState?.running ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

function startPolling() {
  if (pollTimer || subscribed.size === 0) return;
  void pollOnce();
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

/**
 * Is Xcode running? Asked via System Events so we never auto-launch it — a
 * `tell application "Xcode"` would boot the IDE as a side effect of a poll.
 */
async function isXcodeRunning() {
  try {
    const out = await osa('tell application "System Events" to return (name of processes) contains "Xcode"', 8000);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Guard for every tool that talks to Xcode. Without it, the first
 * `tell application "Xcode"` LAUNCHES Xcode as a side effect — a surprising and
 * slow outcome for a button press. open_workspace is the one tool allowed to
 * start Xcode, because that's what the user asked for.
 */
async function requireXcode() {
  if (!(await isXcodeRunning())) {
    throw new Error('Xcode is not running. Open it, or call open_workspace with a project path.');
  }
}

async function ensureBuildState() {
  if (!buildState) {
    try { setBuildState(buildSnapshot((await isXcodeRunning()) ? await readWorkspace(25000) : null)); }
    catch { setBuildState(buildSnapshot(null)); }
  }
  return buildState;
}

// io.streamdeck/resourceSchema — the Studio host reads this from `_meta` to
// generate a typed accessor; a plain MCP client ignores it.
const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    scheme: { type: 'string' },
    workspace: { type: 'string' },
    status: { type: 'string' },
    running: { type: 'boolean' },
    errors: { type: 'number' },
    warnings: { type: 'number' },
    test_failures: { type: 'number' },
    label: { type: 'string' },
    at: { type: 'number' },
  },
  required: ['running', 'errors', 'warnings', 'label'],
};

const WORKSPACE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    path: { type: 'string' },
    scheme: { type: 'string' },
    destination: { type: 'string' },
    status: { type: 'string' },
    running: { type: 'boolean' },
    errors: { type: 'number' },
    warnings: { type: 'number' },
    test_failures: { type: 'number' },
  },
  required: ['running'],
};

server.registerResource(
  'Build state', URI_BUILD,
  {
    description: 'Live build state of the active Xcode workspace: status, running flag, and error/warning/test-failure counts. Bind a key or dial to this to show build state on the hardware.',
    mimeType: 'application/json',
    _meta: { 'io.streamdeck/resourceSchema': BUILD_SCHEMA },
  },
  async (uri) => {
    const s = await ensureBuildState();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s) }] };
  },
);

server.registerResource(
  'Active workspace', URI_WORKSPACE,
  {
    description: 'The active Xcode workspace: name, path, active scheme, chosen run destination, and last action status.',
    mimeType: 'application/json',
    _meta: { 'io.streamdeck/resourceSchema': WORKSPACE_SCHEMA },
  },
  async (uri) => {
    // A resource read must always yield a snapshot: a face bound to this can't do
    // anything with an exception, and "Xcode closed" / "no workspace open" are
    // normal states, not failures. Tools still report those as errors.
    const prefs = readPrefs();
    const EMPTY = {
      name: null, path: null, scheme: null,
      destination: prefs.destinationName ?? null,
      destination_specifier: prefs.destinationSpecifier ?? null,
      status: null, running: false, errors: 0, warnings: 0, test_failures: 0,
    };
    let ws = EMPTY;
    if (await isXcodeRunning()) {
      try { ws = await readWorkspace(); } catch { ws = EMPTY; }
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ws) }] };
  },
);

// ── Surfaces (io.streamdeck/surfaces) ────────────────────────────────────────
// Key: build status + press to build. Dial: rotate through schemes, press to
// build the previewed one. Popup: full build panel with the issue list.
// Each view's JSX lives in a sibling .view.jsx, read at request time.

function readViewFile(name) {
  try { return readFileSync(join(HERE, name), 'utf8'); }
  catch { return `function Face(){ return null; } /* missing view: ${name} */`; }
}

const UI_VIEWS = {
  [URI_UI_KEY]: {
    name: 'Xcode build key',
    description: 'Key: shows build status + error/warning counts; press builds, long-press stops.',
    file: 'key.view.jsx',
    meta: { key: { resourceUri: URI_UI_KEY, mode: 'persistent', bind: URI_BUILD, handles: ['press'] } },
  },
  [URI_UI_DIAL]: {
    name: 'Xcode scheme dial',
    description: 'Dial: rotate to preview schemes, press to build the previewed one.',
    file: 'dial.view.jsx',
    meta: { encoder: { resourceUri: URI_UI_DIAL, mode: 'persistent', bind: URI_BUILD, handles: ['rotate', 'dialPress', 'touchTap'] } },
  },
  [URI_UI_POPUP]: {
    name: 'Xcode build panel',
    description: 'Popup: build/run/test/stop controls plus the current error and warning list; click an issue to open it in Xcode.',
    file: 'popup.view.jsx',
    meta: { popup: { resourceUri: URI_UI_POPUP, mode: 'on-demand', bind: URI_BUILD } },
  },
};

for (const [uri, v] of Object.entries(UI_VIEWS)) {
  server.registerResource(
    uri.replace('ui://', '').replace(/\//g, '-'),
    uri,
    { description: v.description, mimeType: APP_MIME, _meta: { [SURFACE_NS]: v.meta } },
    async (u) => ({
      contents: [{
        uri: u.href,
        mimeType: APP_MIME,
        text: JSON.stringify({ jsx: readViewFile(v.file), _meta: { [SURFACE_NS]: v.meta } }),
      }],
    }),
  );
}

// Only the data resources are pollable; the ui:// views are static reads.
const LIVE_URIS = new Set([URI_BUILD, URI_WORKSPACE]);

server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  const uri = req.params?.uri;
  if (uri && LIVE_URIS.has(uri)) {
    subscribed.add(uri);
    startPolling();
  }
  return {};
});

server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  const uri = req.params?.uri;
  if (uri) {
    subscribed.delete(uri);
    if (subscribed.size === 0) stopPolling();
  }
  return {};
});

// =============================================================================
// SCHEME ACTIONS — build / run / test / clean / stop
// =============================================================================

/**
 * Build the AppleScript for a scheme action.
 *
 * `wait: false` fires the action and returns immediately — the right default for
 * a Stream Deck press, which must not block for a multi-minute build (the face
 * tracks progress through resource://xcode/build instead).
 *
 * `wait: true` polls `completed` INSIDE this one script (quirk 1): re-entering
 * osascript per tick would pay an Apple-event round trip each time and can
 * outlive the press.
 *
 * Issue collection is capped — a broken build can produce hundreds of errors and
 * the full set would swamp a tool result.
 */
function actionScript(action, { wait, timeoutSecs, extraParams = '', collectIssues = true, maxIssues = 25 }) {
  const poll = wait ? `
set waited to 0
repeat
  if completed of ar is true then exit repeat
  if waited > ${timeoutSecs} then exit repeat
  delay 0.5
  set waited to waited + 0.5
end repeat
` : '';

  const issues = wait && collectIssues ? `
set issueOut to ""
set kinds to {"error", "warning", "testFailure"}
repeat with kindIndex from 1 to 3
  set kindName to item kindIndex of kinds
  try
    if kindIndex is 1 then
      set issueList to build errors of ar
    else if kindIndex is 2 then
      set issueList to build warnings of ar
    else
      set issueList to test failures of ar
    end if
    set n to count of issueList
    if n > ${maxIssues} then set n to ${maxIssues}
    repeat with j from 1 to n
      set iss to item j of issueList
      set issueOut to issueOut & kindName & "${US}" & my orNull(message of iss) & "${US}" & my orNull(file path of iss) & "${US}" & my orNull(starting line number of iss) & "${US}" & my orNull(starting column number of iss) & "${RS}"
    end repeat
  end try
end repeat
` : 'set issueOut to ""';

  return xcodeScript(`
set ar to ${action} aw${extraParams}
${poll}
set actStatus to ""
set cp to ""
set em to ""
set nErr to 0
set nWarn to 0
set nTestFail to 0
try
  set actStatus to my orNull(status of ar)
  set cp to (completed of ar) as text
  set em to my orNull(error message of ar)
  try
    set nErr to count of build errors of ar
  end try
  try
    set nWarn to count of build warnings of ar
  end try
  try
    set nTestFail to count of test failures of ar
  end try
end try
${issues}
return my orNull(id of ar) & "${US}" & actStatus & "${US}" & cp & "${US}" & em & "${US}" & (nErr as text) & "${US}" & (nWarn as text) & "${US}" & (nTestFail as text) & "${US}" & my orNull(name of active scheme of aw) & "${RS}${RS}" & issueOut
`);
}

function parseActionResult(out) {
  // header RS RS issues… — the double separator keeps an empty issue list from
  // looking like a malformed header.
  const [head, tail = ''] = out.split(`${RS}${RS}`);
  const [id, status, completed, errorMessage, nErr, nWarn, nTestFail, scheme] = head.split(US);
  const issues = asRecords(tail).map(([kind, message, file, line, column]) => ({
    kind,
    message,
    file: nullable(file),
    line: asNum(line),
    column: asNum(column),
  }));
  return {
    id: nullable(id),
    scheme: nullable(scheme),
    status: nullable(status),
    completed: asBool(completed),
    error_message: nullable(errorMessage),
    errors: Number(nErr || 0),
    warnings: Number(nWarn || 0),
    test_failures: Number(nTestFail || 0),
    issues,
  };
}

const ACTION_OUTPUT = {
  id: z.string().nullable(),
  scheme: z.string().nullable(),
  status: z.string().nullable(),
  completed: z.boolean(),
  error_message: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
  test_failures: z.number(),
  issues: z.array(z.object({
    kind: z.string(),
    message: z.string(),
    file: z.string().nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
  })),
};

/** Nudge the polled resource right after an action so the face reacts at once. */
function kickPoll() {
  if (subscribed.size > 0) {
    stopPolling();
    void pollOnce();
  }
}

async function runAction(action, { wait, timeout, extraParams = '', maxIssues = 25 }) {
  const timeoutSecs = Math.max(5, Number(timeout) || 300);
  // Give osascript headroom beyond the in-script poll budget so the script's own
  // timeout wins and we get a partial result instead of a killed process.
  const budgetMs = wait ? (timeoutSecs + 30) * 1000 : 45000;
  const out = await osa(actionScript(action, { wait, timeoutSecs, extraParams, maxIssues }), budgetMs);
  const result = parseActionResult(out);
  kickPoll();
  // Xcode reports a REFUSED action (e.g. `test` on a scheme with no test target)
  // as a result that never completes and carries an error message — which would
  // otherwise read as "started fine" to a caller that only checks isError. A
  // completed-but-failed action keeps its data: the issues list is the point.
  if (!result.completed && result.error_message) {
    throw new Error(`Xcode would not ${action} this scheme: ${result.error_message}`);
  }
  return result;
}

function actionSummary(verb, r) {
  if (!r.completed) return `${verb} started (scheme ${r.scheme ?? '?'}). Status: ${r.status ?? 'running'}.`;
  const bits = [];
  if (r.errors) bits.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
  if (r.warnings) bits.push(`${r.warnings} warning${r.warnings === 1 ? '' : 's'}`);
  if (r.test_failures) bits.push(`${r.test_failures} test failure${r.test_failures === 1 ? '' : 's'}`);
  const detail = bits.length ? ` — ${bits.join(', ')}` : '';
  const err = r.error_message ? ` (${r.error_message})` : '';
  return `${verb} ${r.status ?? 'finished'}${detail}${err}.`;
}

const WAIT_INPUT = {
  wait: z.boolean().default(false).describe('Wait for the action to finish and return its errors/warnings. False (default) returns as soon as the action starts — the right choice for a button press, since a build can take minutes; track progress via resource://xcode/build instead.'),
  timeout: z.number().int().default(300).describe('Max seconds to wait when wait=true (default 300).'),
};

server.registerTool('build', {
  icons: [{ src: 'https://api.iconify.design/mdi/hammer.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Build the active scheme of the active Xcode workspace (⌘B). Returns {status, completed, errors, warnings, issues}. With wait=false (default) it returns immediately after starting.',
  inputSchema: { ...WAIT_INPUT },
  outputSchema: ACTION_OUTPUT,
}, async ({ wait, timeout }) => {
  const r = await runAction('build', { wait, timeout });
  return ok(r, actionSummary('Build', r));
});

server.registerTool('run', {
  icons: [{ src: 'https://api.iconify.design/mdi/play.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Run the active scheme (⌘R) — builds then launches. Returns {status, completed, errors, warnings, issues}.',
  inputSchema: {
    command_line_arguments: z.array(z.string()).default([]).describe('Extra command line arguments to pass to the launched process.'),
    ...WAIT_INPUT,
  },
  outputSchema: ACTION_OUTPUT,
}, async ({ command_line_arguments, wait, timeout }) => {
  const args = command_line_arguments.length
    ? ` with command line arguments {${command_line_arguments.map(q).join(', ')}}`
    : '';
  const r = await runAction('run', { wait, timeout, extraParams: args });
  return ok(r, actionSummary('Run', r));
});

server.registerTool('test', {
  icons: [{ src: 'https://api.iconify.design/mdi/test-tube.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Run the active scheme\'s tests (⌘U). Returns {status, completed, test_failures, issues} — each test failure carries its message, file and line.',
  inputSchema: {
    command_line_arguments: z.array(z.string()).default([]).describe('Extra command line arguments for the test run.'),
    ...WAIT_INPUT,
  },
  outputSchema: ACTION_OUTPUT,
}, async ({ command_line_arguments, wait, timeout }) => {
  const args = command_line_arguments.length
    ? ` with command line arguments {${command_line_arguments.map(q).join(', ')}}`
    : '';
  const r = await runAction('test', { wait, timeout, extraParams: args });
  return ok(r, actionSummary('Test', r));
});

server.registerTool('clean', {
  icons: [{ src: 'https://api.iconify.design/mdi/broom.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Clean the active scheme\'s build folder (⇧⌘K). Returns {status, completed}.',
  inputSchema: { ...WAIT_INPUT },
  outputSchema: ACTION_OUTPUT,
}, async ({ wait, timeout }) => {
  const r = await runAction('clean', { wait, timeout });
  return ok(r, actionSummary('Clean', r));
});

server.registerTool('stop', {
  icons: [{ src: 'https://api.iconify.design/mdi/stop.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Stop the running scheme action or debug session (⌘.). Returns {stopped}.',
  inputSchema: {},
  outputSchema: { stopped: z.boolean() },
}, async () => {
  await osa(xcodeScript('stop aw\nreturn "ok"'), 30000);
  kickPoll();
  return ok({ stopped: true }, 'Stopped the active scheme action.');
});

server.registerTool('debug', {
  icons: [{ src: 'https://api.iconify.design/mdi/bug.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Start a debug session, optionally overriding the scheme and run destination for this launch only. '
    + 'This is also the ONLY reliable way to target a specific destination: Xcode\'s `active run destination` property '
    + 'cannot be set via AppleScript (broken in Xcode 26.x), but this command accepts a destination specifier string. '
    + 'Omit destination_specifier to use the one saved by set_destination. Set skip_building=true for "Run Without Building".',
  inputSchema: {
    scheme: z.string().default('').describe('Scheme name to debug. Empty uses the active scheme.'),
    destination_specifier: z.string().default('').describe('xcodebuild-style destination, e.g. "platform=macOS,arch=arm64" or "platform=iOS Simulator,name=iPhone 17 Pro". Empty uses the one saved by set_destination (if any).'),
    skip_building: z.boolean().default(false).describe('Run without building.'),
    ...WAIT_INPUT,
  },
  outputSchema: ACTION_OUTPUT,
}, async ({ scheme, destination_specifier, skip_building, wait, timeout }) => {
  const spec = destination_specifier || readPrefs().destinationSpecifier || '';
  let extra = '';
  if (scheme) extra += ` scheme ${q(scheme)}`;
  if (spec) extra += ` run destination specifier ${q(spec)}`;
  if (skip_building) extra += ' skip building true';
  const r = await runAction('debug', { wait, timeout, extraParams: extra });
  return ok(r, actionSummary('Debug', r));
});

server.registerTool('attach', {
  icons: [{ src: 'https://api.iconify.design/mdi/link-variant.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Attach Xcode\'s debugger to an already-running process by pid. Returns {attached, pid}.',
  inputSchema: {
    pid: z.number().int().describe('Process identifier to attach to.'),
    suspended: z.boolean().default(false).describe('Start the debug session suspended.'),
  },
  outputSchema: { attached: z.boolean(), pid: z.number() },
}, async ({ pid, suspended }) => {
  await osa(xcodeScript(`attach aw to process identifier ${pid} suspended ${suspended}\nreturn "ok"`), 40000);
  return ok({ attached: true, pid }, `Attached the debugger to pid ${pid}.`);
});

// =============================================================================
// BUILD RESULTS — read the last action without re-running it
// =============================================================================

server.registerTool('get_build_status', {
  icons: [{ src: 'https://api.iconify.design/mdi/information-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Get the status of the most recent scheme action (build/run/test) without starting a new one: {status, running, errors, warnings, test_failures, scheme, workspace}. Cheap — safe to call on a button face refresh.',
  inputSchema: {},
  outputSchema: {
    scheme: z.string().nullable(),
    workspace: z.string().nullable(),
    status: z.string().nullable(),
    running: z.boolean(),
    errors: z.number(),
    warnings: z.number(),
    test_failures: z.number(),
    label: z.string(),
  },
}, async () => {
  if (!(await isXcodeRunning())) throw new Error('Xcode is not running.');
  const ws = await readWorkspace();
  const snap = buildSnapshot(ws);
  setBuildState(snap);
  const { at, ...rest } = snap;
  return ok(rest, `${snap.label}${snap.errors ? ` — ${snap.errors} error(s)` : ''}${snap.warnings ? `, ${snap.warnings} warning(s)` : ''}.`);
});

server.registerTool('get_issues', {
  icons: [{ src: 'https://api.iconify.design/mdi/alert-circle-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Get the errors, warnings, analyzer issues and test failures from the last scheme action, each with message, file path, line and column. Use this after a failed build to see what broke.',
  inputSchema: {
    kinds: z.array(z.enum(['errors', 'warnings', 'analyzer', 'test_failures'])).default(['errors', 'warnings', 'test_failures'])
      .describe('Which issue kinds to include.'),
    limit: z.number().int().default(50).describe('Max issues per kind (default 50).'),
  },
  outputSchema: {
    count: z.number(),
    issues: z.array(z.object({
      kind: z.string(),
      message: z.string(),
      file: z.string().nullable(),
      line: z.number().nullable(),
      column: z.number().nullable(),
    })),
  },
}, async ({ kinds, limit }) => {
  const cap = Math.max(1, Math.min(500, limit));
  // AppleScript can't take a list of element names dynamically, so each kind is
  // a separate guarded block; a kind Xcode doesn't populate is simply skipped.
  const blocks = {
    errors: { label: 'error', accessor: 'build errors' },
    warnings: { label: 'warning', accessor: 'build warnings' },
    analyzer: { label: 'analyzer', accessor: 'analyzer issues' },
    test_failures: { label: 'testFailure', accessor: 'test failures' },
  };
  const body = kinds.map((k) => {
    const b = blocks[k];
    return `
try
  set issueList to ${b.accessor} of ar
  set n to count of issueList
  if n > ${cap} then set n to ${cap}
  repeat with j from 1 to n
    set iss to item j of issueList
    set out to out & "${b.label}" & "${US}" & my orNull(message of iss) & "${US}" & my orNull(file path of iss) & "${US}" & my orNull(starting line number of iss) & "${US}" & my orNull(starting column number of iss) & "${RS}"
  end repeat
end try`;
  }).join('\n');

  const out = await osa(xcodeScript(`
set ar to last scheme action result of aw
if ar is missing value then error "No build has run yet in this workspace."
set out to ""
${body}
return out
`), 60000);

  const issues = asRecords(out).map(([kind, message, file, line, column]) => ({
    kind, message, file: nullable(file), line: asNum(line), column: asNum(column),
  }));
  return ok({ count: issues.length, issues },
    issues.length ? `${issues.length} issue(s) from the last action.` : 'No issues in the last action.');
});

server.registerTool('get_build_log', {
  icons: [{ src: 'https://api.iconify.design/mdi/text-box-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Get the raw build log text of the last scheme action. Logs run to hundreds of KB, so this returns the TAIL by default — set head=true for the beginning.',
  inputSchema: {
    max_chars: z.number().int().default(8000).describe('Max characters to return (default 8000).'),
    head: z.boolean().default(false).describe('Return the start of the log instead of the end.'),
  },
  outputSchema: { text: z.string(), total_length: z.number(), truncated: z.boolean() },
}, async ({ max_chars, head }) => {
  const cap = Math.max(200, Math.min(200000, max_chars));
  // Slice inside AppleScript: a 200KB+ log crossing the osascript boundary just
  // to be trimmed here is wasted copying (this project's logs measured ~208KB).
  const out = await osa(xcodeScript(`
set ar to last scheme action result of aw
if ar is missing value then error "No build has run yet in this workspace."
set logText to ""
try
  set logText to my orNull(build log of ar)
end try
set L to length of logText
if L = 0 then return "0" & "${US}" & ""
if L > ${cap} then
  ${head
    ? `set slice to characters 1 thru ${cap} of logText as text`
    : `set slice to characters (L - ${cap} + 1) thru L of logText as text`}
else
  set slice to logText
end if
return (L as text) & "${US}" & slice
`), 60000);

  const sep = out.indexOf(US);
  const total = Number(out.slice(0, sep) || 0);
  const text = out.slice(sep + 1);
  return ok({ text, total_length: total, truncated: total > text.length },
    `Build log: ${text.length} of ${total} chars (${head ? 'head' : 'tail'}).`);
});

// =============================================================================
// SCHEMES, DESTINATIONS, WORKSPACES
// =============================================================================

server.registerTool('get_workspace', {
  icons: [{ src: 'https://api.iconify.design/mdi/folder-open-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Get the active workspace/project: {name, path, scheme, destination, status, errors, warnings}.',
  inputSchema: {},
  outputSchema: {
    name: z.string().nullable(),
    path: z.string().nullable(),
    scheme: z.string().nullable(),
    destination: z.string().nullable(),
    destination_specifier: z.string().nullable(),
    status: z.string().nullable(),
    running: z.boolean(),
    errors: z.number(),
    warnings: z.number(),
    test_failures: z.number(),
  },
}, async () => {
  if (!(await isXcodeRunning())) throw new Error('Xcode is not running.');
  const ws = await readWorkspace();
  return ok(ws, `${ws.name ?? 'No workspace'}${ws.scheme ? ` — scheme ${ws.scheme}` : ''}.`);
});

server.registerTool('list_workspaces', {
  icons: [{ src: 'https://api.iconify.design/mdi/format-list-bulleted-square.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List all workspace/project documents currently open in Xcode, flagging the active one.',
  inputSchema: {},
  outputSchema: {
    count: z.number(),
    workspaces: z.array(z.object({
      name: z.string(),
      path: z.string().nullable(),
      loaded: z.boolean(),
      active: z.boolean(),
    })),
  },
}, async () => {
  // No WAIT_LOADED here: listing must work even while a document is still
  // loading — that's exactly when you want to see it.
  const out = await osa(xcodeScript(`
set activeName to ""
try
  set activeName to my orNull(name of active workspace document)
end try
set out to ""
repeat with d in workspace documents
  set isLoaded to "false"
  try
    set isLoaded to (loaded of d) as text
  end try
  set nm to my orNull(name of d)
  set isActive to "false"
  if nm is equal to activeName then set isActive to "true"
  set out to out & nm & "${US}" & my orNull(path of d) & "${US}" & isLoaded & "${US}" & isActive & "${RS}"
end repeat
return out
`, { needWorkspace: false }), 30000);

  const workspaces = asRecords(out).map(([name, path, loaded, active]) => ({
    name, path: nullable(path), loaded: asBool(loaded), active: asBool(active),
  }));
  return ok({ count: workspaces.length, workspaces }, `${workspaces.length} workspace(s) open.`);
});

server.registerTool('open_workspace', {
  icons: [{ src: 'https://api.iconify.design/mdi/folder-open.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open a .xcodeproj, .xcworkspace, Package.swift or folder in Xcode (launching Xcode if needed) and wait for it to finish loading. Returns {name, path, loaded}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the .xcodeproj / .xcworkspace / Package.swift / folder.'),
    activate: z.boolean().default(true).describe('Bring Xcode to the front.'),
  },
  outputSchema: { name: z.string().nullable(), path: z.string().nullable(), loaded: z.boolean() },
}, async ({ path, activate }) => {
  const expanded = path.replace(/^~/, homedir());
  // `open` is documented as unreliable about returning the new document, so we
  // ignore its result and find the document by name afterwards.
  const out = await osa(`tell application "Xcode"
  ${activate ? 'activate' : ''}
  open ${q(expanded)}
  set wantName to ${q(basename(expanded))}
  set wantPath to ${q(expanded)}
  set found to missing value
  repeat 120 times
    repeat with d in workspace documents
      -- Match on path first: Xcode names a .xcodeproj document after the project
      -- ("ObjcPlugin"), not after the bundle ("ObjcPlugin.xcodeproj"), so the
      -- basename alone doesn't always match. Fall back to either name form.
      if my orNull(path of d) is equal to wantPath then
        set found to d
        exit repeat
      end if
      if (name of d) is equal to wantName then
        set found to d
        exit repeat
      end if
    end repeat
    if found is not missing value then
      try
        if loaded of found is true then exit repeat
      end try
    end if
    delay 0.5
  end repeat
  if found is missing value then error "Xcode did not open a workspace for that path within 60s."
  set isLoaded to "false"
  try
    set isLoaded to (loaded of found) as text
  end try
  return my orNull(name of found) & "${US}" & my orNull(path of found) & "${US}" & isLoaded
end tell`, 80000, { allowLaunch: true });

  const [name, wsPath, loaded] = out.split(US);
  kickPoll();
  return ok({ name: nullable(name), path: nullable(wsPath), loaded: asBool(loaded) },
    `Opened ${name}${asBool(loaded) ? '' : ' (still loading)'}.`);
});

server.registerTool('list_schemes', {
  icons: [{ src: 'https://api.iconify.design/mdi/view-list.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List the schemes of the active workspace, flagging the active one. Use with set_scheme or the scheme dial.',
  inputSchema: {},
  outputSchema: {
    count: z.number(),
    active: z.string().nullable(),
    schemes: z.array(z.object({ name: z.string(), id: z.string().nullable(), active: z.boolean() })),
  },
}, async () => {
  const out = await osa(xcodeScript(`
set activeName to ""
try
  set activeName to my orNull(name of active scheme of aw)
end try
set out to ""
repeat with s in schemes of aw
  set nm to my orNull(name of s)
  set isActive to "false"
  if nm is equal to activeName then set isActive to "true"
  set out to out & nm & "${US}" & my orNull(id of s) & "${US}" & isActive & "${RS}"
end repeat
return activeName & "${RS}${RS}" & out
`), 40000);

  const [active = '', tail = ''] = out.split(`${RS}${RS}`);
  const schemes = asRecords(tail).map(([name, id, isActive]) => ({
    name, id: nullable(id), active: asBool(isActive),
  }));
  return ok({ count: schemes.length, active: nullable(active), schemes },
    `${schemes.length} scheme(s); active: ${active || 'none'}.`);
});

server.registerTool('set_scheme', {
  icons: [{ src: 'https://api.iconify.design/mdi/swap-horizontal.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Set the active scheme of the active workspace by name (the scheme subsequent build/run/test actions use). Returns {scheme}.',
  inputSchema: { scheme: z.string().describe('Scheme name, exactly as shown by list_schemes.') },
  outputSchema: { scheme: z.string().nullable() },
}, async ({ scheme }) => {
  // Assignment must use an element reference; a plain string is rejected.
  const out = await osa(xcodeScript(`
set matched to missing value
repeat with s in schemes of aw
  if (name of s) is equal to ${q(scheme)} then set matched to s
end repeat
if matched is missing value then error "No scheme named " & ${q(scheme)} & " in this workspace."
set active scheme of aw to matched
return my orNull(name of active scheme of aw)
`), 40000);
  kickPoll();
  return ok({ scheme: nullable(out) }, `Active scheme set to ${out}.`);
});

server.registerTool('list_destinations', {
  icons: [{ src: 'https://api.iconify.design/mdi/cellphone-link.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List the run destinations available to the active workspace (devices, simulators, My Mac), each with architecture, platform and a ready-to-use destination specifier for set_destination / debug. '
    + 'Note: Xcode does not report which destination is active (the AppleScript property is broken in Xcode 26.x) — get_workspace reports the one saved by set_destination instead.',
  inputSchema: {},
  outputSchema: {
    count: z.number(),
    destinations: z.array(z.object({
      name: z.string(),
      architecture: z.string().nullable(),
      platform: z.string().nullable(),
      device_name: z.string().nullable(),
      device_identifier: z.string().nullable(),
      os_version: z.string().nullable(),
      model: z.string().nullable(),
      generic: z.boolean(),
      specifier: z.string(),
    })),
  },
}, async () => {
  // Every device property is wrapped: `device` and `operating system version`
  // come back as `missing value` for generic destinations like "Any Mac".
  const out = await osa(xcodeScript(`
set out to ""
repeat with d in run destinations of aw
  set devName to ""
  set devId to ""
  set devOs to ""
  set devModel to ""
  set isGeneric to "false"
  try
    set dv to device of d
    if dv is not missing value then
      set devName to my orNull(name of dv)
      set devId to my orNull(device identifier of dv)
      set devOs to my orNull(operating system version of dv)
      set devModel to my orNull(device model of dv)
      try
        set isGeneric to (generic of dv) as text
      end try
    end if
  end try
  set out to out & my orNull(name of d) & "${US}" & my orNull(architecture of d) & "${US}" & my orNull(platform of d) & "${US}" & devName & "${US}" & devId & "${US}" & devOs & "${US}" & devModel & "${US}" & isGeneric & "${RS}"
end repeat
return out
`), 40000);

  const destinations = asRecords(out).map(([name, arch, platform, devName, devId, devOs, model, generic]) => ({
    name,
    architecture: nullable(arch),
    platform: nullable(platform),
    device_name: nullable(devName),
    device_identifier: nullable(devId),
    os_version: nullable(devOs),
    model: nullable(model),
    generic: asBool(generic),
    specifier: buildSpecifier({ platform, arch, devName, devId, generic: asBool(generic) }),
  }));
  return ok({ count: destinations.length, destinations }, `${destinations.length} run destination(s).`);
});

/**
 * Compose an xcodebuild-style `-destination` specifier from a run destination.
 * Xcode's `platform` property is an internal identifier ("macosx",
 * "iphonesimulator"); the specifier grammar wants the display form ("macOS",
 * "iOS Simulator"), so it's mapped here.
 */
function buildSpecifier({ platform, arch, devName, devId, generic }) {
  const PLATFORMS = {
    macosx: 'macOS',
    iphoneos: 'iOS',
    iphonesimulator: 'iOS Simulator',
    appletvos: 'tvOS',
    appletvsimulator: 'tvOS Simulator',
    watchos: 'watchOS',
    watchsimulator: 'watchOS Simulator',
    xros: 'visionOS',
    xrsimulator: 'visionOS Simulator',
  };
  const p = PLATFORMS[platform] ?? platform ?? '';
  const parts = [`platform=${p}`];
  if (p === 'macOS') {
    // Mac destinations differ only by architecture (arm64 vs the Rosetta slice),
    // so arch is the distinguishing key rather than a device id.
    if (arch && arch !== 'undefined_arch') parts.push(`arch=${arch}`);
  } else if (!generic) {
    if (devId) parts.push(`id=${devId}`);
    else if (devName) parts.push(`name=${devName}`);
  }
  return parts.join(',');
}

server.registerTool('set_destination', {
  icons: [{ src: 'https://api.iconify.design/mdi/target.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Remember a run destination for later debug calls, by destination name (from list_destinations) or an explicit specifier. '
    + 'IMPORTANT: this does NOT change the destination shown in Xcode\'s toolbar — Xcode\'s `active run destination` property cannot be written via AppleScript (broken in Xcode 26.x). '
    + 'The saved specifier is passed to the `debug` tool, which does honour it. build/run/test always use whatever the Xcode toolbar shows.',
  inputSchema: {
    destination: z.string().default('').describe('Destination name exactly as listed by list_destinations, e.g. "My Mac" or "iPhone 17 Pro".'),
    specifier: z.string().default('').describe('Explicit specifier instead of a name, e.g. "platform=iOS Simulator,name=iPhone 17 Pro".'),
  },
  outputSchema: { destination: z.string().nullable(), specifier: z.string(), applied_in_xcode_ui: z.boolean() },
}, async ({ destination, specifier }) => {
  if (!destination && !specifier) throw new Error('Pass either a destination name or an explicit specifier.');

  let name = destination || null;
  let spec = specifier;

  if (!spec) {
    const out = await osa(xcodeScript(`
set out to ""
repeat with d in run destinations of aw
  if (name of d) is equal to ${q(destination)} then
    set devName to ""
    set devId to ""
    set isGeneric to "false"
    try
      set dv to device of d
      if dv is not missing value then
        set devName to my orNull(name of dv)
        set devId to my orNull(device identifier of dv)
        try
          set isGeneric to (generic of dv) as text
        end try
      end if
    end try
    set out to my orNull(architecture of d) & "${US}" & my orNull(platform of d) & "${US}" & devName & "${US}" & devId & "${US}" & isGeneric
  end if
end repeat
if out is "" then error "No run destination named " & ${q(destination)} & ". Use list_destinations to see valid names."
return out
`), 40000);
    const [arch, platform, devName, devId, generic] = out.split(US);
    spec = buildSpecifier({ platform, arch, devName, devId, generic: asBool(generic) });
  }

  writePrefs({ destinationName: name, destinationSpecifier: spec });
  kickPoll();
  return ok({ destination: name, specifier: spec, applied_in_xcode_ui: false },
    `Saved destination ${name ?? spec} (used by the debug tool; Xcode's toolbar is unchanged).`);
});

// =============================================================================
// PROJECT MODEL — projects, targets, build settings
// =============================================================================

server.registerTool('list_targets', {
  icons: [{ src: 'https://api.iconify.design/mdi/target-variant.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List the projects in the active workspace with their targets and build configurations (Debug/Release/…).',
  inputSchema: {},
  outputSchema: {
    count: z.number(),
    projects: z.array(z.object({
      name: z.string(),
      id: z.string().nullable(),
      targets: z.array(z.string()),
      configurations: z.array(z.string()),
    })),
  },
}, async () => {
  // Targets and configs are flattened into one delimited stream (proj/target/
  // config rows) and regrouped here — nested loops would need nested delimiters.
  const out = await osa(xcodeScript(`
set out to ""
repeat with p in projects of aw
  set pname to my orNull(name of p)
  set out to out & "proj" & "${US}" & pname & "${US}" & my orNull(id of p) & "${RS}"
  try
    repeat with t in targets of p
      set out to out & "target" & "${US}" & pname & "${US}" & my orNull(name of t) & "${RS}"
    end repeat
  end try
  try
    repeat with c in build configurations of p
      set out to out & "config" & "${US}" & pname & "${US}" & my orNull(name of c) & "${RS}"
    end repeat
  end try
end repeat
return out
`), 40000);

  const projects = [];
  const byName = new Map();
  for (const [kind, pname, value] of asRecords(out)) {
    if (kind === 'proj') {
      const entry = { name: pname, id: nullable(value), targets: [], configurations: [] };
      byName.set(pname, entry);
      projects.push(entry);
    } else if (kind === 'target') byName.get(pname)?.targets.push(value);
    else if (kind === 'config') byName.get(pname)?.configurations.push(value);
  }
  return ok({ count: projects.length, projects }, `${projects.length} project(s).`);
});

server.registerTool('get_build_settings', {
  icons: [{ src: 'https://api.iconify.design/mdi/cog-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Read build settings for a project or target configuration. A configuration resolves ~1500 settings, so a name filter is strongly recommended (e.g. filter="PRODUCT_" or "SWIFT"). Set resolved=true for fully-resolved values rather than the ones explicitly set in the config.',
  inputSchema: {
    configuration: z.string().default('Debug').describe('Build configuration name, e.g. "Debug" or "Release".'),
    project: z.string().default('').describe('Project name. Empty uses the first project in the workspace.'),
    target: z.string().default('').describe('Target name. Empty reads the project-level configuration.'),
    filter: z.string().default('').describe('Case-insensitive substring the setting NAME must contain. Strongly recommended.'),
    resolved: z.boolean().default(false).describe('Read fully-resolved settings (includes inherited/default values) instead of only those set in this configuration.'),
    limit: z.number().int().default(80).describe('Max settings to return (default 80).'),
  },
  outputSchema: {
    project: z.string().nullable(),
    target: z.string().nullable(),
    configuration: z.string(),
    resolved: z.boolean(),
    count: z.number(),
    total_available: z.number(),
    truncated: z.boolean(),
    settings: z.array(z.object({ name: z.string(), value: z.string() })),
  },
}, async ({ configuration, project, target, filter, resolved, limit }) => {
  const cap = Math.max(1, Math.min(400, limit));
  const accessor = resolved ? 'resolved build settings' : 'build settings';
  // Filtering happens inside AppleScript: shipping 1476 settings across the
  // boundary to drop most of them is pure overhead.
  const out = await osa(xcodeScript(`
set p to missing value
${project
    ? `repeat with cand in projects of aw
  if (name of cand) is equal to ${q(project)} then set p to cand
end repeat
if p is missing value then error "No project named " & ${q(project)} & " in this workspace."`
    : `if (count of projects of aw) is 0 then error "The active workspace has no projects."
set p to project 1 of aw`}

set owner to p
set ownerTarget to ""
${target
    ? `set matchedTarget to missing value
repeat with t in targets of p
  if (name of t) is equal to ${q(target)} then set matchedTarget to t
end repeat
if matchedTarget is missing value then error "No target named " & ${q(target)} & " in that project."
set owner to matchedTarget
set ownerTarget to ${q(target)}`
    : ''}

set cfg to missing value
repeat with c in build configurations of owner
  if (name of c) is equal to ${q(configuration)} then set cfg to c
end repeat
if cfg is missing value then error "No build configuration named " & ${q(configuration)} & "."

set allSettings to ${accessor} of cfg
set total to count of allSettings
set out to ""
set kept to 0
repeat with s in allSettings
  if kept < ${cap} then
    set sname to my orNull(name of s)
    set keep to true
    ${filter ? `if sname does not contain ${q(filter)} then set keep to false` : ''}
    if keep then
      set out to out & sname & "${US}" & my orNull(value of s) & "${RS}"
      set kept to kept + 1
    end if
  end if
end repeat
return my orNull(name of p) & "${US}" & ownerTarget & "${US}" & (total as text) & "${RS}${RS}" & out
`), 60000);

  const [head, tail = ''] = out.split(`${RS}${RS}`);
  const [pname, tname, total] = head.split(US);
  const settings = asRecords(tail).map(([name, value]) => ({ name, value: value ?? '' }));
  const data = {
    project: nullable(pname),
    target: nullable(tname),
    configuration,
    resolved,
    count: settings.length,
    total_available: Number(total || 0),
    truncated: settings.length >= cap,
    settings,
  };
  return ok(data, `${settings.length} setting(s)${filter ? ` matching "${filter}"` : ''} of ${total} in ${configuration}.`);
});

// =============================================================================
// EDITOR — open files, jump to a line, read/replace text
// =============================================================================

// AppleScript can't reliably fetch `text document "Name"` (quirk 5), so every
// editor tool locates the document by iterating `document i` and matching name
// or path. This snippet binds `doc`; callers supply MATCH_EXPR.
function findDocScript(matchExpr, body) {
  return `tell application "Xcode"
  set doc to missing value
  repeat with i from 1 to (count of documents)
    set d to document i
    try
      if ${matchExpr} then
        set doc to d
        exit repeat
      end if
    end try
  end repeat
${body}
end tell`;
}

const MATCH_BY_PATH_OR_NAME = (target) =>
  `((my orNull(path of d) is equal to ${target}) or ((name of d) is equal to ${target}))`;

server.registerTool('open_file', {
  icons: [{ src: 'https://api.iconify.design/mdi/file-document-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open a file in Xcode\'s editor, optionally scrolling to a line (and selecting it). Great for jumping straight to a build error from a button. Returns {path, name, line}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the file.'),
    line: z.number().int().default(0).describe('1-based line to reveal and select. 0 (default) just opens the file.'),
    activate: z.boolean().default(true).describe('Bring Xcode to the front.'),
  },
  outputSchema: { path: z.string(), name: z.string().nullable(), line: z.number().nullable() },
}, async ({ path, line, activate }) => {
  const expanded = path.replace(/^~/, homedir());
  const target = q(expanded);
  const name = basename(expanded);

  // `hack` is the dictionary's (hidden, Instruments-facing) reveal command: it
  // selects a line range and scrolls it into view. It's the only scripted way to
  // jump to a line, and it does work — verified on 26.3.
  const reveal = line > 0 ? `
  if doc is not missing value then
    try
      hack document doc start ${line} stop ${line}
    end try
  end if` : '';

  const out = await osa(`tell application "Xcode"
  ${activate ? 'activate' : ''}
  open ${target}
  set doc to missing value
  repeat 40 times
    repeat with i from 1 to (count of documents)
      set d to document i
      try
        if ${MATCH_BY_PATH_OR_NAME(target)} or ((name of d) is equal to ${q(name)}) then
          set doc to d
          exit repeat
        end if
      end try
    end repeat
    if doc is not missing value then exit repeat
    delay 0.25
  end repeat
  if doc is missing value then error "Xcode did not open " & ${target} & " within 10s."
${reveal}
  return my orNull(name of doc) & "${US}" & my orNull(path of doc)
end tell`, 40000, { allowLaunch: true });

  const [docName] = out.split(US);
  return ok({ path: expanded, name: nullable(docName), line: line > 0 ? line : null },
    `Opened ${docName}${line > 0 ? ` at line ${line}` : ''}.`);
});

server.registerTool('list_open_documents', {
  icons: [{ src: 'https://api.iconify.design/mdi/file-multiple-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List the editor documents open in Xcode (excluding workspaces), with modified state and the selected line.',
  inputSchema: {},
  outputSchema: {
    count: z.number(),
    documents: z.array(z.object({
      name: z.string(),
      path: z.string().nullable(),
      modified: z.boolean(),
      selected_line: z.number().nullable(),
    })),
  },
}, async () => {
  // `selected paragraph range` is a LIST — read item 1, never `as text`
  // (quirk 6: `{12, 12} as text` yields "1212").
  const out = await osa(`tell application "Xcode"
  set out to ""
  repeat with i from 1 to (count of documents)
    set d to document i
    set cls to ""
    try
      set cls to (class of d) as text
    end try
    if cls is not "workspace document" then
      set selLine to ""
      try
        set pr to selected paragraph range of d
        set selLine to (item 1 of pr) as text
      end try
      set isMod to "false"
      try
        set isMod to (modified of d) as text
      end try
      set out to out & my orNull(name of d) & "${US}" & my orNull(path of d) & "${US}" & isMod & "${US}" & selLine & "${RS}"
    end if
  end repeat
  return out
end tell`, 30000);

  const documents = asRecords(out).map(([name, path, modified, line]) => ({
    name, path: nullable(path), modified: asBool(modified), selected_line: asNum(line),
  }));
  return ok({ count: documents.length, documents }, `${documents.length} open document(s).`);
});

server.registerTool('get_document_text', {
  icons: [{ src: 'https://api.iconify.design/mdi/text-box-search-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Read the text of an open editor document — the live BUFFER, so it includes unsaved edits (that\'s the point; read the file from disk otherwise). Identify it by absolute path or file name. '
    + 'Pass start_line/end_line to read just a range, which is what you usually want after get_issues hands you a file and a line.',
  inputSchema: {
    path: z.string().describe('Absolute path, or just the file name, of an open document.'),
    start_line: z.number().int().default(0).describe('First line to return (1-based). 0 means start at the top.'),
    end_line: z.number().int().default(0).describe('Last line to return (1-based, inclusive). 0 means read to the end.'),
    max_chars: z.number().int().default(20000).describe('Max characters to return (default 20000).'),
  },
  outputSchema: {
    name: z.string().nullable(),
    path: z.string().nullable(),
    text: z.string(),
    start_line: z.number(),
    total_length: z.number(),
    truncated: z.boolean(),
    selected_line: z.number().nullable(),
  },
}, async ({ path, start_line, end_line, max_chars }) => {
  const target = q(path.replace(/^~/, homedir()));
  const cap = Math.max(200, Math.min(500000, max_chars));
  const from = Math.max(0, start_line);
  const to = Math.max(0, end_line);
  if (from && to && to < from) throw new Error('end_line must be >= start_line.');
  const out = await osa(findDocScript(
    `${MATCH_BY_PATH_OR_NAME(target)}`,
    `  if doc is missing value then error "No open document matching " & ${target} & ". Call open_file first, or list_open_documents to see what's open."
  set t to ""
  try
    set t to text of doc
  on error
    error "Xcode would not return the text of that document (it may not be a text editor document)."
  end try
  set firstLine to 1
  ${from || to ? `-- Slice by line. \`paragraphs of\` is AppleScript's line splitter; joining
  -- with linefeed round-trips exactly for LF files, which source files are.
  set paras to paragraphs of t
  set nLines to count of paras
  set lo to ${from || 1}
  set hi to ${to ? `${to}` : 'nLines'}
  if lo > nLines then error "start_line " & (lo as text) & " is past the end of the document (" & (nLines as text) & " lines)."
  if hi > nLines then set hi to nLines
  set firstLine to lo
  set saveDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set t to (items lo thru hi of paras) as text
  set AppleScript's text item delimiters to saveDelims` : ''}
  set L to length of t
  if L > ${cap} then
    set slice to characters 1 thru ${cap} of t as text
  else
    set slice to t
  end if
  set selLine to ""
  try
    set pr to selected paragraph range of doc
    set selLine to (item 1 of pr) as text
  end try
  return my orNull(name of doc) & "${US}" & my orNull(path of doc) & "${US}" & (L as text) & "${US}" & selLine & "${US}" & (firstLine as text) & "${RS}${RS}" & slice`,
  ), 40000);

  const [head, text = ''] = out.split(`${RS}${RS}`);
  const [name, docPath, total, selLine, firstLine] = head.split(US);
  // total_length is the length of the requested REGION (the whole buffer when no
  // range was given), so `truncated` reflects the max_chars cap only.
  const totalLen = Number(total || 0);
  const startedAt = Number(firstLine || 1);
  return ok({
    name: nullable(name),
    path: nullable(docPath),
    text,
    start_line: startedAt,
    total_length: totalLen,
    truncated: totalLen > text.length,
    selected_line: asNum(selLine),
  }, `Read ${text.length} of ${totalLen} chars from ${name}${from || to ? ` (from line ${startedAt})` : ''}.`);
});

server.registerTool('set_document_text', {
  icons: [{ src: 'https://api.iconify.design/mdi/file-edit-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Replace the entire text of an open editor document. This edits the BUFFER, leaving the document dirty — pass save=true to write it to disk. Destructive: the previous contents are gone (undo still works in the Xcode UI).',
  inputSchema: {
    path: z.string().describe('Absolute path, or file name, of an open document.'),
    text: z.string().describe('The new full contents of the document.'),
    save: z.boolean().default(false).describe('Save to disk after replacing.'),
  },
  outputSchema: { name: z.string().nullable(), path: z.string().nullable(), length: z.number(), saved: z.boolean() },
}, async ({ path, text, save }) => {
  const target = q(path.replace(/^~/, homedir()));
  const out = await osa(findDocScript(
    `${MATCH_BY_PATH_OR_NAME(target)}`,
    `  if doc is missing value then error "No open document matching " & ${target} & ". Call open_file first."
  set text of doc to ${q(text)}
  ${save ? 'try\n    save doc\n  end try' : ''}
  return my orNull(name of doc) & "${US}" & my orNull(path of doc)`,
  ), 40000);

  const [name, docPath] = out.split(US);
  return ok({ name: nullable(name), path: nullable(docPath), length: text.length, saved: save },
    `Replaced ${name} (${text.length} chars)${save ? ' and saved' : ' — unsaved'}.`);
});

server.registerTool('save_documents', {
  icons: [{ src: 'https://api.iconify.design/mdi/content-save.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Save open editor documents that have unsaved changes (⌘S / Save All). Returns {saved: [names]}.',
  inputSchema: {
    path: z.string().default('').describe('Save only the document at this path/name. Empty saves every modified document.'),
  },
  outputSchema: { count: z.number(), saved: z.array(z.string()) },
}, async ({ path }) => {
  const target = path ? q(path.replace(/^~/, homedir())) : '';
  const out = await osa(`tell application "Xcode"
  set out to ""
  repeat with i from 1 to (count of documents)
    set d to document i
    set cls to ""
    try
      set cls to (class of d) as text
    end try
    if cls is not "workspace document" then
      set shouldSave to false
      try
        if modified of d is true then set shouldSave to true
      end try
      ${target ? `if not ${MATCH_BY_PATH_OR_NAME(target)} then set shouldSave to false` : ''}
      if shouldSave then
        try
          save d
          set out to out & my orNull(name of d) & "${RS}"
        end try
      end if
    end if
  end repeat
  return out
end tell`, 40000);

  const saved = out.split(RS).filter(Boolean);
  return ok({ count: saved.length, saved },
    saved.length ? `Saved ${saved.join(', ')}.` : 'Nothing to save.');
});

// =============================================================================
// SIMULATORS — simctl (no AppleScript equivalent exists)
// =============================================================================
// Xcode's dictionary exposes simulators only as read-only run destinations, so
// booting/shutting one down has to go through `xcrun simctl`. This is the one
// place a CLI is the only option, not a shortcut.

function xcrun(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('xcrun', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

server.registerTool('list_simulators', {
  icons: [{ src: 'https://api.iconify.design/mdi/cellphone-cog.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List available iOS/tvOS/watchOS/visionOS simulators with their boot state and runtime, via simctl. Use booted=true to see only running ones.',
  inputSchema: {
    booted_only: z.boolean().default(false).describe('Only return booted simulators.'),
    name_filter: z.string().default('').describe('Case-insensitive substring the simulator name must contain.'),
  },
  outputSchema: {
    count: z.number(),
    simulators: z.array(z.object({
      name: z.string(),
      udid: z.string(),
      state: z.string(),
      runtime: z.string(),
      available: z.boolean(),
    })),
  },
}, async ({ booted_only, name_filter }) => {
  const raw = await xcrun(['simctl', 'list', 'devices', 'available', '-j'], 45000);
  const parsed = JSON.parse(raw);
  const needle = name_filter.toLowerCase();
  const sims = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    // "com.apple.CoreSimulator.SimRuntime.iOS-26-3" → "iOS 26.3"
    const pretty = runtime.replace(/^.*SimRuntime\./, '').replace(/-/g, ' ').replace(/(\d) (\d)/, '$1.$2');
    for (const d of devices) {
      if (booted_only && d.state !== 'Booted') continue;
      if (needle && !String(d.name).toLowerCase().includes(needle)) continue;
      sims.push({
        name: d.name, udid: d.udid, state: d.state, runtime: pretty, available: d.isAvailable !== false,
      });
    }
  }
  return ok({ count: sims.length, simulators: sims }, `${sims.length} simulator(s).`);
});

server.registerTool('boot_simulator', {
  icons: [{ src: 'https://api.iconify.design/mdi/cellphone-play.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Boot a simulator by name or UDID and open the Simulator app. Idempotent — an already-booted simulator is reported as such rather than erroring.',
  inputSchema: {
    simulator: z.string().describe('Simulator name (e.g. "iPhone 17 Pro") or UDID.'),
    open_app: z.boolean().default(true).describe('Also open the Simulator app window.'),
  },
  outputSchema: { udid: z.string(), name: z.string(), state: z.string(), already_booted: z.boolean() },
}, async ({ simulator, open_app }) => {
  const sim = await resolveSimulator(simulator);
  let already = sim.state === 'Booted';
  if (!already) {
    try {
      await xcrun(['simctl', 'boot', sim.udid], 90000);
    } catch (e) {
      // simctl races with an in-flight boot; treat that as success.
      if (/current state: Booted|Unable to boot device in current state: Booted/i.test(e.message)) already = true;
      else throw e;
    }
  }
  if (open_app) {
    await new Promise((resolve) => execFile('open', ['-a', 'Simulator'], () => resolve()));
  }
  return ok({ udid: sim.udid, name: sim.name, state: 'Booted', already_booted: already },
    already ? `${sim.name} was already booted.` : `Booted ${sim.name}.`);
});

server.registerTool('shutdown_simulator', {
  icons: [{ src: 'https://api.iconify.design/mdi/cellphone-off.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Shut down a simulator by name or UDID, or all booted simulators with all=true.',
  inputSchema: {
    simulator: z.string().default('').describe('Simulator name or UDID. Ignored when all=true.'),
    all: z.boolean().default(false).describe('Shut down every booted simulator.'),
  },
  outputSchema: { shutdown: z.array(z.string()) },
}, async ({ simulator, all }) => {
  if (all) {
    await xcrun(['simctl', 'shutdown', 'all'], 60000);
    return ok({ shutdown: ['all'] }, 'Shut down all booted simulators.');
  }
  if (!simulator) throw new Error('Pass a simulator name/UDID, or all=true.');
  const sim = await resolveSimulator(simulator);
  if (sim.state !== 'Booted') return ok({ shutdown: [] }, `${sim.name} was not booted.`);
  await xcrun(['simctl', 'shutdown', sim.udid], 60000);
  return ok({ shutdown: [sim.name] }, `Shut down ${sim.name}.`);
});

/** Resolve a name-or-UDID to a simulator record, preferring a booted match. */
async function resolveSimulator(needle) {
  const raw = await xcrun(['simctl', 'list', 'devices', 'available', '-j'], 45000);
  const parsed = JSON.parse(raw);
  const all = Object.values(parsed.devices ?? {}).flat();
  const byUdid = all.find((d) => d.udid === needle);
  if (byUdid) return byUdid;
  const named = all.filter((d) => d.name === needle);
  if (named.length === 0) {
    const loose = all.filter((d) => String(d.name).toLowerCase().includes(needle.toLowerCase()));
    if (loose.length === 0) throw new Error(`No available simulator matching "${needle}". Use list_simulators to see valid names.`);
    return loose.find((d) => d.state === 'Booted') ?? loose[0];
  }
  // Same name can exist per-runtime; prefer one that's already running.
  return named.find((d) => d.state === 'Booted') ?? named[0];
}

server.registerTool('list_devices', {
  icons: [{ src: 'https://api.iconify.design/mdi/cellphone-link.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List physical devices paired for development (iPhone/iPad/…) with their connection state, via devicectl.',
  inputSchema: {},
  outputSchema: {
    count: z.number(),
    devices: z.array(z.object({
      name: z.string(),
      identifier: z.string(),
      model: z.string().nullable(),
      state: z.string().nullable(),
      os_version: z.string().nullable(),
    })),
  },
}, async () => {
  // devicectl's `--json-output -` still prints the table to stdout on some
  // versions, so write JSON to a temp file and read that instead.
  const tmp = join(STATE_DIR, 'devices.json');
  await xcrun(['devicectl', 'list', 'devices', '--json-output', tmp], 60000);
  let parsed;
  try { parsed = JSON.parse(readFileSync(tmp, 'utf8')); }
  catch { throw new Error('Could not read devicectl output. Is a device paired and Xcode set up for development?'); }

  const devices = (parsed?.result?.devices ?? []).map((d) => ({
    name: d?.deviceProperties?.name ?? d?.hardwareProperties?.marketingName ?? 'Unknown',
    identifier: d?.identifier ?? d?.hardwareProperties?.udid ?? '',
    model: d?.hardwareProperties?.marketingName ?? null,
    state: d?.connectionProperties?.tunnelState ?? d?.connectionProperties?.pairingState ?? null,
    os_version: d?.deviceProperties?.osVersionNumber ?? null,
  }));
  return ok({ count: devices.length, devices }, `${devices.length} paired device(s).`);
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
