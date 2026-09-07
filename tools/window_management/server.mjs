#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { run } from '@jxa/run';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import plist from 'plist';
import * as z from 'zod/v4';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPACES_PLIST = join(homedir(), 'Library/Preferences/com.apple.spaces.plist');

// Stream Deck surfaces (io.streamdeck/surfaces extension). The app-switcher key,
// dial and popup ship as ui:// MCP-App resources whose _meta binds each to a live
// app-list resource. The key/dial declare `handles` (in-component handlers), so the
// host injects the hardware event into the live face — the useKeyPress/useDialRotate
// handler registered inside its Face runs and calls a tool directly. No preview/commit "controller" tools: the dial's
// preview cursor lives in the view's React state; committing calls activate_application.
const SURFACE_NS = 'io.streamdeck/surfaces';
const URI_APPS = 'resource://windows/apps';
const URI_WINDOWS = 'resource://windows/open';
const URI_UI_KEY = 'ui://windows/key';
const URI_UI_DIAL = 'ui://windows/dial';
const URI_UI_POPUP = 'ui://windows/popup';

// =============================================================================
// HELPERS
// =============================================================================

function readSpacesConfig() {
  const data = plist.parse(readFileSync(SPACES_PLIST, 'utf8'));
  const monitors = data.SpacesDisplayConfiguration['Management Data'].Monitors;
  const displays = [];
  for (const monitor of monitors) {
    if (!monitor['Current Space']) continue;
    const current = monitor['Current Space'];
    const spaces = (monitor.Spaces || []).map((s, i) => ({
      index: i + 1,
      id: s.ManagedSpaceID,
      uuid: s.uuid,
      type: s.type ?? 0,
      is_current: s.uuid === current.uuid,
    }));
    const currentIndex = spaces.find(s => s.is_current)?.index ?? null;
    displays.push({
      display: monitor['Display Identifier'] ?? 'Unknown',
      current_space_index: currentIndex,
      current_space_id: current.ManagedSpaceID,
      total_spaces: spaces.length,
      spaces,
    });
  }
  return { displays };
}

function sc(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

// =============================================================================
// WINDOW IDENTITY — stable handles over CoreGraphics window ids
// =============================================================================
// Every tool here used to address a window as (application, window_index), where the
// index is 1-based into System Events' window list. That list is FRONT-TO-BACK Z-ORDER:
// it reshuffles the moment focus changes, so an index captured a second ago can now
// point at a different window. A handle wraps `kCGWindowNumber` instead — a real OS
// window id, stable for the window's whole lifetime — and is resolved to a live AX
// index at call time. `window_index` still works, for callers that only have one.

/** Handles are opaque to callers but deliberately legible: "win:<cg_id>". Nothing is
 *  cached inside the token — resolution re-reads live CoreGraphics state, so a handle
 *  can never carry a stale title or geometry. */
function formatHandle(cgId) { return `win:${cgId}`; }

function parseHandle(handle) {
  const m = /^win:(\d+)$/.exec(String(handle).trim());
  if (!m) throw new Error(`bad window handle ${JSON.stringify(handle)} — expected "win:<id>" as returned by get_windows or new_window`);
  return Number(m[1]);
}

// Source injected into the JXA closures that need the CoreGraphics window list.
// @jxa/run serializes each closure with toString(), so it CANNOT capture helpers from
// this module's scope — the source travels as a string argument and is eval'd on the
// JXA side (as an object literal, so nothing depends on how eval hoists declarations).
const CG_SRC = `({
  // All layer-0 CoreGraphics windows, front-to-back. ~50ms for the whole system, vs
  // ~1s to enumerate windows through System Events — which is why the live resource
  // polls this and not Accessibility.
  // CoreGraphics needs an explicit signature: ObjC.import('CoreGraphics') alone
  // returns an untyped Ref that can't be indexed.
  all: function () {
    ObjC.import('Foundation');
    try { ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['unsigned int', 'unsigned int']]); } catch (e) {}
    var arr = $.CGWindowListCopyWindowInfo(16 /* kCGWindowListExcludeDesktopElements */, 0);
    var out = [];
    for (var i = 0; i < arr.count; i++) {
      var w = ObjC.deepUnwrap(arr.objectAtIndex(i));
      if (w.kCGWindowLayer !== 0) continue;
      var b = w.kCGWindowBounds || {};
      out.push({
        cg_id: w.kCGWindowNumber,
        pid: w.kCGWindowOwnerPID,
        // NOT the same string System Events reports: CoreGraphics says "Visual Studio
        // Code" where System Events' process is named "Code". pid is the join key.
        owner: w.kCGWindowOwnerName || null,
        // Redacted (empty) unless THIS process holds Screen Recording, so a null title
        // is expected, not an error — titles that matter come from Accessibility.
        title: w.kCGWindowName || null,
        onscreen: !!w.kCGWindowIsOnscreen,
        x: b.X, y: b.Y, width: b.Width, height: b.Height,
        alpha: w.kCGWindowAlpha,
      });
    }
    return out;
  },
  // The user-meaningful subset. kCGWindowListOptionOnScreenOnly would be cheaper but
  // MISSES every window on another Mission Control space — exactly the windows a window
  // manager cares about. The unfiltered layer-0 list is ~150 records, nearly all of them
  // offscreen zero-sized service windows (CursorUIViewService & co), so filter instead.
  real: function (list) {
    return list.filter(function (w) {
      return w.alpha > 0 && w.width >= 120 && w.height >= 60 && (w.onscreen || w.title);
    });
  },
  procByPid: function (pid) {
    try {
      var procs = Application('System Events').processes.whose({ unixId: pid })();
      return procs.length ? procs[0] : null;
    } catch (e) { return null; }
  },
  /** Read a process's AX windows once (titles + boxes), defensively per field. */
  axWindows: function (proc) {
    var rows = [];
    var n = 0;
    try { n = proc.windows.length; } catch (e) { return rows; }
    for (var i = 0; i < n; i++) {
      var w = proc.windows[i];
      var t = null, p = null, s = null;
      try { t = w.name(); } catch (e) {}
      try { p = w.position(); } catch (e) {}
      try { s = w.size(); } catch (e) {}
      rows.push({ index: i + 1, title: t, box: (p && s) ? [p[0], p[1], s[0], s[1]] : null });
    }
    return rows;
  },
  /** Join one CG record onto a process's AX windows, returning a 1-based AX index, or
   *  null when the evidence doesn't single one out.
   *
   *  Narrowing, never guessing. Title alone is not enough (two Safari windows that both
   *  failed to load are both titled "Failed to open page") and geometry alone is not
   *  either (two VS Code windows have byte-identical bounds), so each signal FILTERS the
   *  candidates and the answer must come out unique. Returning "the first match" would
   *  mean close_window closing an arbitrary one of two look-alike windows.
   *
   *  Per-pid z-order rank looks like a tempting last resort, and was tried: it is WRONG.
   *  Measured against the title-based join on two identical-geometry VS Code windows, CG
   *  rank and AX index disagreed and it handed each window the other's handle — exactly
   *  where it's needed, mutually-occluding siblings, is exactly where the two lists stop
   *  agreeing. Refusing (so the caller falls back to an index, i.e. today's behavior) is
   *  the only safe answer. The practical cost: with Screen Recording denied, CG titles are
   *  redacted and two same-size sibling windows can't be handled at all.
   *
   *  This is also what makes a stale handle safe. A closed window's CG record lingers for
   *  a moment; if "the app has only one window left" counted as a match, that dead handle
   *  would resolve onto an unrelated window. Nothing matches, so nothing happens. */
  axIndexOf: function (rows, rec) {
    var sameBox = function (r) {
      return r.box && r.box[0] === rec.x && r.box[1] === rec.y && r.box[2] === rec.width && r.box[3] === rec.height;
    };
    var byTitle = rec.title ? rows.filter(function (r) { return r.title === rec.title; }) : [];
    if (byTitle.length === 1) return byTitle[0].index;
    if (byTitle.length > 1) {
      var both = byTitle.filter(sameBox);
      return both.length === 1 ? both[0].index : null;
    }
    var byBox = rows.filter(sameBox);
    return byBox.length === 1 ? byBox[0].index : null;
  },
})`;

/** Read the CG window universe (cheap; no Accessibility, no Screen Recording). */
async function listWindowsCG() {
  const rows = await run((src) => { const H = eval(src); return H.real(H.all()); }, CG_SRC);
  return rows ?? [];
}

/** Resolve a handle to the (application, window_index) pair the AX-based tools take. */
async function resolveHandle(handle) {
  const cgId = parseHandle(handle);
  const res = await run((src, id) => {
    const H = eval(src);
    const all = H.all();
    const rec = all.find((w) => w.cg_id === id);
    if (!rec) return { error: 'gone' };
    const proc = H.procByPid(rec.pid);
    if (!proc) return { error: 'no_process' };
    let app = null;
    try { app = proc.name(); } catch (e) { return { error: 'no_process' }; }
    const index = H.axIndexOf(H.axWindows(proc), rec);
    if (index === null) return { error: 'unmatched', app };
    return { app, index, pid: rec.pid, title: rec.title };
  }, CG_SRC, cgId);

  if (res?.error === 'gone') throw new Error(`window ${formatHandle(cgId)} no longer exists (it was closed)`);
  if (res?.error === 'no_process') throw new Error(`the process owning ${formatHandle(cgId)} has quit`);
  if (res?.error === 'unmatched') throw new Error(`window ${formatHandle(cgId)} of ${res.app} could not be matched to an accessible window — pass application + window_index instead`);
  return { application: res.app, window_index: res.index };
}

/** Normalize either addressing form. Handles win; window_index is the fallback. */
async function resolveTarget({ window, application, window_index }) {
  if (window) return resolveHandle(window);
  if (!application) throw new Error('pass either `window` (a handle from get_windows or new_window) or `application`');
  return { application, window_index: window_index ?? 1 };
}

// =============================================================================
// APP-SWITCHER: ordered app list + live resource (backs the key/dial/popup surfaces)
// =============================================================================

/** Read the switchable GUI apps, ordered stably by name (so prev/next is
 *  predictable), with the frontmost flagged + its index. Shared by the
 *  get_running_applications tool and the live resource watcher. */
async function readAppList() {
  const raw = await run(() => {
    const se = Application('System Events');
    const out = [];
    // Snapshot the collection ONCE — `whose(...)()` is a live query, and re-reading it
    // per element races apps launching/quitting, which surfaces as "Invalid index.
    // (-1719)" / "Can't get object. (-1728)" from System Events.
    let procs;
    try { procs = se.processes.whose({ backgroundOnly: false })(); } catch { return out; }
    for (const p of procs) {
      // name() throws OR returns null for a process that vanished between the
      // snapshot and this read (and for a few Apple helpers that never expose one).
      // A null name used to reach localeCompare below and throw, killing the whole
      // poll — so an unnamed process must be SKIPPED, not carried through.
      let name = null;
      try { name = p.name(); } catch { continue; }
      if (typeof name !== 'string' || !name) continue;
      out.push({
        name,
        bundle_id: (() => { try { return p.bundleIdentifier() ?? null; } catch { return null; } })(),
        frontmost: (() => { try { return !!p.frontmost(); } catch { return false; } })(),
      });
    }
    return out;
  });
  // Defensive: the JXA side already filters, but a null here must never take the
  // poll down (it retries every 700ms, so a throw becomes an endless error storm).
  const apps = (raw ?? []).filter(a => a && typeof a.name === 'string');
  apps.sort((a, b) => a.name.localeCompare(b.name));
  let active_index = apps.findIndex(a => a.frontmost);
  if (active_index < 0) active_index = 0;
  return { applications: apps, active_index };
}

// The live app-list snapshot the surfaces bind to. Only the ordered list + frontmost
// index live here — server-owned live DATA. The dial's transient PREVIEW cursor does
// NOT live here; it's in the dial view's React state (in-component, repainted on
// dispatch). One source of truth per concern: list = resource, cursor = component.
let appsState = { applications: [], active_index: 0 };
const subscribed = new Set();

function appsSig(s) { return JSON.stringify({ a: s.applications.map(x => x.name), i: s.active_index }); }

/** Poll the app list; push resources/updated only when the ordered list or frontmost
 *  actually changed, so a bound face repaints the instant you switch apps by ANY
 *  means (not just via this pack). */
let _polling = false, _lastPollError = null;
async function pollApps() {
  if (_polling) return;
  _polling = true;
  try {
    const next = await readAppList();
    if (appsSig(next) !== appsSig(appsState)) {
      appsState = next;
      if (subscribed.has(URI_APPS)) {
        server.server.sendResourceUpdated({ uri: URI_APPS }).catch(() => {});
      }
    }
    _lastPollError = null;   // recovered — a later failure is news again
  } catch (err) {
    // Log a given failure ONCE. This polls every 700ms, so an error that persists
    // (or recurs, as a transient System Events -1719 does) otherwise floods stderr
    // with the same line forever. `_polledOk` alone didn't bound it: any failure
    // AFTER the first success logged on every tick.
    const msg = String(err?.message ?? err);
    if (msg !== _lastPollError) {
      _lastPollError = msg;
      process.stderr.write(`[window_management] readAppList failed: ${msg}\n`);
    }
  } finally {
    _polling = false;
  }
}

let _watcher = null;
function startWatching() {
  if (_watcher) return;
  const t = setInterval(pollApps, 700);
  t.unref?.();
  _watcher = { stop() { clearInterval(t); } };
}
function stopWatching() { if (_watcher) { _watcher.stop(); _watcher = null; } }

async function ensurePrimed() {
  startWatching();
  if (appsState.applications.length === 0) await pollApps();
}

// =============================================================================
// OPEN-WINDOWS: live window list (backs resource://windows/open)
// =============================================================================
// Backed by CoreGraphics, NOT Accessibility: enumerating windows through System Events
// costs ~1s, which cannot be polled at all, while the CG list costs ~50-80ms.

let windowsState = { windows: [], count: 0 };
// cg_id -> AX-sourced title. Only consulted for windows whose CG title came back
// redacted (i.e. no Screen Recording), so a machine that grants it never pays for AX.
const titleCache = new Map();
let _lastTitleFetch = 0;
const TITLE_TTL_MS = 10_000;

/** Titles via Accessibility for specific pids only — the whole point of taking pids
 *  rather than the whole system is that this is the expensive path. */
async function axTitles(pids) {
  return await run((src, pidList) => {
    const H = eval(src);
    const all = H.real(H.all());
    const out = {};
    for (const pid of pidList) {
      const proc = H.procByPid(pid);
      if (!proc) continue;
      const rows = H.axWindows(proc);
      const mine = all.filter((w) => w.pid === pid);
      for (let r = 0; r < mine.length; r++) {
        const idx = H.axIndexOf(rows, mine[r]);
        if (idx === null) continue;
        const row = rows.find((x) => x.index === idx);
        if (row && row.title) out[mine[r].cg_id] = row.title;
      }
    }
    return out;
  }, CG_SRC, pids);
}

async function readWindows() {
  const cg = await listWindowsCG();

  const missing = cg.filter((w) => !w.title);
  if (missing.length) {
    // Fetch when a window is new to us, and otherwise at most every TITLE_TTL_MS —
    // a title changes on its own (browser tab switch) with no CG-visible event, so it
    // can't be cached forever, but it also isn't worth an AX round trip every tick.
    const unknown = missing.some((w) => !titleCache.has(w.cg_id));
    if (unknown || Date.now() - _lastTitleFetch > TITLE_TTL_MS) {
      const pids = [...new Set(missing.map((w) => w.pid))];
      try {
        const titles = await axTitles(pids);
        for (const w of missing) {
          if (titles[w.cg_id] !== undefined) titleCache.set(w.cg_id, titles[w.cg_id]);
          else titleCache.delete(w.cg_id);
        }
        _lastTitleFetch = Date.now();
      } catch { /* keep whatever titles we have; the list is still useful */ }
    }
  }
  const live = new Set(cg.map((w) => w.cg_id));
  for (const id of [...titleCache.keys()]) if (!live.has(id)) titleCache.delete(id);

  // CoreGraphics returns the list front-to-back, but that only means anything for the
  // windows actually on screen — the offscreen ones (other spaces, minimized apps) have
  // no position in the current stack, so they get null rather than a made-up rank.
  const zOf = new Map();
  cg.filter((w) => w.onscreen).forEach((w, i) => zOf.set(w.cg_id, i));

  const windows = cg.map((w) => ({
    window: formatHandle(w.cg_id),
    cg_id: w.cg_id,
    // CoreGraphics' owner name, which is the app's display name — NOT always the name
    // System Events addresses the process by ("Visual Studio Code" vs "Code").
    app: w.owner,
    pid: w.pid,
    title: w.title ?? titleCache.get(w.cg_id) ?? null,
    x: w.x, y: w.y, width: w.width, height: w.height,
    onscreen: w.onscreen,
    z: zOf.has(w.cg_id) ? zOf.get(w.cg_id) : null,   // 0 = frontmost on the current space
  }));
  // Sorted by app then id so a bound face's rows keep their positions as focus moves;
  // `z` carries the ordering that actually changes.
  windows.sort((a, b) => (a.app ?? '').localeCompare(b.app ?? '') || a.cg_id - b.cg_id);
  return { windows, count: windows.length };
}

const windowsSubscribers = () => subscribed.has(URI_WINDOWS);
let _pollingWindows = false, _lastWindowsError = null;

async function pollWindows() {
  if (_pollingWindows) return;
  _pollingWindows = true;
  try {
    const next = await readWindows();
    if (JSON.stringify(next) !== JSON.stringify(windowsState)) {
      windowsState = next;
      if (windowsSubscribers()) server.server.sendResourceUpdated({ uri: URI_WINDOWS }).catch(() => {});
    }
    _lastWindowsError = null;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg !== _lastWindowsError) {   // log a given failure once — see pollApps
      _lastWindowsError = msg;
      process.stderr.write(`[window_management] readWindows failed: ${msg}\n`);
    }
  } finally {
    _pollingWindows = false;
  }
}

let _windowsWatcher = null;
function startWatchingWindows() {
  if (_windowsWatcher) return;
  const t = setInterval(pollWindows, 1000);
  t.unref?.();
  _windowsWatcher = { stop() { clearInterval(t); } };
}
function stopWatchingWindows() { if (_windowsWatcher) { _windowsWatcher.stop(); _windowsWatcher = null; } }

async function ensurePrimedWindows() {
  startWatchingWindows();
  if (windowsState.count === 0) await pollWindows();
}

// ── Surface views (ui:// MCP-App resources) ─────────────────────────────────
// Each view's JSX is read from a sibling .view.jsx at read time and wrapped in an
// envelope carrying io.streamdeck/surfaces _meta. key/dial use `handles` (in-component
// handlers); the popup drives itself (self-contained App, no trigger map).

function readViewFile(name) {
  try { return readFileSync(join(HERE, name), 'utf8'); }
  catch { return `function Face(){ return null; } /* missing view: ${name} */`; }
}

const UI_VIEWS = {
  [URI_UI_KEY]: {
    name: 'Window key',
    description: 'Key: shows the frontmost app; press cycles to the next.',
    file: 'key.view.jsx',
    meta: { key: { resourceUri: URI_UI_KEY, mode: 'persistent', bind: URI_APPS, handles: ['press'] } },
  },
  [URI_UI_DIAL]: {
    name: 'Window dial',
    description: 'Dial: prev|current|next strip; rotate previews (in-component), press commits.',
    file: 'dial.view.jsx',
    meta: { encoder: { resourceUri: URI_UI_DIAL, mode: 'persistent', bind: URI_APPS, handles: ['rotate', 'dialPress', 'touchTap'] } },
  },
  [URI_UI_POPUP]: {
    name: 'Window switcher',
    description: 'Popup app switcher: grid of all open apps; click one to activate it.',
    file: 'popup.view.jsx',
    meta: { popup: { resourceUri: URI_UI_POPUP, mode: 'on-demand', bind: URI_APPS } },
  },
};

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const SUCCESS_OUTPUT = { success: z.boolean(), message: z.string() };

// Two ways to name a window. Prefer the handle: `window_index` is a position in
// front-to-back z-order, so it silently addresses a DIFFERENT window once focus moves.
const WINDOW_INPUT = {
  window: z.string().optional().describe('Window handle from get_windows or new_window (e.g. "win:11950"). Stable for the window\'s lifetime — prefer this.'),
  application: z.string().optional().describe('App name, when addressing by index instead of by handle.'),
  window_index: z.number().optional().describe('1-based index into the app\'s windows in front-to-back z-order (default: 1). Shifts as windows are focused — use `window` to address a specific window reliably.'),
};

// =============================================================================
// SERVER
// =============================================================================

const server = new McpServer({ name: 'window-management', version: '1.0.0' });

// ---------------------------------------------------------------------------

server.registerTool('get_running_applications',
  {
    title: 'List Running Apps',
    icons: [{ src: 'https://api.iconify.design/mdi/apps.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the currently running GUI applications, ordered stably by name, with the frontmost one flagged. `active_index` is the frontmost app\'s position in `applications` (the ordering the app-switcher dial/key navigate).',
    inputSchema: {},
    outputSchema: {
      applications: z.array(z.object({
        name: z.string(),
        bundle_id: z.string().nullable(),
        frontmost: z.boolean(),
      })),
      active_index: z.number(),
    },
  },
  async () => {
    return sc(await readAppList());
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_windows',
  {
    title: 'List Windows',
    icons: [{ src: 'https://api.iconify.design/mdi/window-restore.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get a list of open windows, optionally filtered by application name. Each window carries a `window` handle — pass that (not `index`) to the move/resize/close/fullscreen tools, since `index` is z-order and shifts as windows are focused.',
    inputSchema: {
      application: z.string().optional().describe('Filter to this app name (e.g. "Safari"). Omit for all apps.'),
    },
    outputSchema: {
      windows: z.array(z.object({
        app_name: z.string(),
        title: z.string().nullable(),
        // null only for a window that couldn't be joined to a CoreGraphics record —
        // e.g. a minimized window, which drops off the CG list entirely.
        window: z.string().nullable().describe('Stable handle, e.g. "win:11950"'),
        pid: z.number().nullable(),
        index: z.number(),
        // null for a window that won't report geometry (e.g. mid fullscreen transition).
        x: z.number().nullable(), y: z.number().nullable(),
        width: z.number().nullable(), height: z.number().nullable(),
        fullscreen: z.boolean().describe('True for a native-fullscreen window (living in its own Mission Control space).'),
      })),
    },
  },
  async ({ application }) => {
    const windows = await run((src, appFilter) => {
      const H = eval(src);
      const se = Application('System Events');
      const procs = appFilter
        ? se.processes.whose({ name: appFilter, backgroundOnly: false })()
        : se.processes.whose({ backgroundOnly: false })();
      // One CoreGraphics read for the whole join (~50ms), then per process: match its
      // CG records onto its AX windows to mint a handle per AX index. Done in this
      // direction so an AX window with no CG record (a minimized one, which leaves the
      // CG list) is still reported — just without a handle.
      const cgReal = H.real(H.all());
      const result = [];
      for (const proc of procs) {
        const appName = proc.name();
        const pid = (() => { try { return proc.unixId(); } catch (e) { return null; } })();
        const handleByIndex = {};
        if (pid !== null) {
          const rows = H.axWindows(proc);
          const mine = cgReal.filter((w) => w.pid === pid);
          for (let r = 0; r < mine.length; r++) {
            const idx = H.axIndexOf(rows, mine[r]);
            // First writer wins: two CG records resolving to the same AX index means the
            // join was ambiguous, and overwriting would hand out a handle for the wrong one.
            if (idx !== null && handleByIndex[idx] === undefined) handleByIndex[idx] = mine[r].cg_id;
          }
        }
        for (let i = 0; i < proc.windows.length; i++) {
          const w = proc.windows[i];
          const cgId = handleByIndex[i + 1];
          // Geometry is read defensively PER FIELD: a window that won't report its
          // position/size used to be dropped from the list entirely, which made a
          // window invisible to callers rather than merely under-described. Report
          // it with null geometry instead — it still exists, and its index is what
          // the other tools here address it by.
          const pos = (() => { try { return w.position(); } catch { return null; } })();
          const size = (() => { try { return w.size(); } catch { return null; } })();
          result.push({
            app_name: appName,
            title: (() => { try { return w.name(); } catch { return null; } })(),
            window: cgId === undefined ? null : 'win:' + cgId,
            pid,
            index: i + 1,
            x: pos ? pos[0] : null, y: pos ? pos[1] : null,
            width: size ? size[0] : null, height: size ? size[1] : null,
            // Fullscreen is NOT inferable from geometry by a caller: a fullscreen
            // window reports the screen's full size on one display and its visible
            // frame on another, so only AXFullScreen answers it.
            fullscreen: (() => {
              try { return !!w.attributes.byName('AXFullScreen').value(); } catch { return false; }
            })(),
          });
        }
      }
      return result;
    }, CG_SRC, application || null);
    return sc({ windows });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_frontmost_application',
  {
    title: 'Frontmost App',
    icons: [{ src: 'https://api.iconify.design/mdi/application.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the name and window title of the frontmost (active) application.',
    inputSchema: {},
    outputSchema: {
      app_name: z.string(),
      bundle_id: z.string().nullable(),
      window_title: z.string().nullable(),
    },
  },
  async () => {
    const result = await run(() => {
      const proc = Application('System Events').processes.whose({ frontmost: true })()[0];
      return {
        app_name: proc.name(),
        bundle_id: (() => { try { return proc.bundleIdentifier(); } catch { return null; } })(),
        window_title: (() => { try { return proc.windows[0].name(); } catch { return null; } })(),
      };
    });
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('activate_application',
  {
    title: 'Activate App',
    icons: [{ src: 'https://api.iconify.design/mdi/open-in-app.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Bring an application to the front (activate it).',
    inputSchema: { application: z.string() },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application }) => {
    await run((app) => { Application(app).activate(); }, application);
    return sc({ success: true, message: `Activated ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('new_window',
  {
    title: 'New Window',
    icons: [{ src: 'https://api.iconify.design/mdi/window-maximize.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Open a new window in an application and return a stable handle to it, so the window can be moved/resized/closed straight afterwards without guessing an index. Browsers get a real new window (with the URL if given); every other app is sent Cmd-N.',
    inputSchema: {
      application: z.string().describe('App name as System Events knows it (e.g. "Safari", "Code", "Terminal")'),
      url: z.string().optional().describe('URL to load — only honoured for Safari / Google Chrome / Arc'),
    },
    outputSchema: {
      ...SUCCESS_OUTPUT,
      window: z.string().nullable().describe('Handle for the new window, e.g. "win:11950". null if no new window appeared.'),
      title: z.string().nullable(),
      x: z.number().nullable(), y: z.number().nullable(),
      width: z.number().nullable(), height: z.number().nullable(),
    },
  },
  async ({ application, url }) => {
    // Identifying the window we just made by title or geometry would be guesswork
    // (a second untitled window looks identical). Diffing CoreGraphics window IDS
    // around the action is exact, and needs no Screen Recording since only ids and
    // pids are read. All one JXA script, so the before-snapshot can't go stale.
    const res = await run((src, app, link) => {
      ObjC.import('Foundation');
      const H = eval(src);
      const sleep = (s) => $.NSThread.sleepForTimeInterval(s);
      const se = Application('System Events');

      let pid = null;
      try { pid = se.processes.byName(app).unixId(); } catch (e) { /* not running yet */ }
      const before = {};
      for (const w of H.all()) if (pid === null || w.pid === pid) before[w.cg_id] = true;

      let how;
      const browser = (app === 'Google Chrome' || app === 'Chrome') ? 'chrome'
        : (app === 'Safari') ? 'safari' : (app === 'Arc') ? 'arc' : null;
      if (browser) {
        const target = Application(browser === 'chrome' ? 'Google Chrome' : app);
        target.activate();
        if (browser === 'chrome') {
          const win = target.Window().make();
          if (link) win.tabs[0].url = link;
        } else if (browser === 'safari') {
          if (link) target.Document({ url: link }).make();
          else target.Document().make();
        } else {
          // Arc has no scriptable window maker; Cmd-N then navigate.
          se.keystroke('n', { using: 'command down' });
          if (link) { sleep(0.4); target.openLocation(link); }
        }
        how = 'scripted';
      } else {
        // Cmd-N is the only portable "new window" — an app that doesn't bind it (or
        // binds it to something else) is reported as a failure below, not guessed at.
        try { se.processes.byName(app).frontmost = true; } catch (e) { Application(app).activate(); }
        sleep(0.3);
        se.keystroke('n', { using: 'command down' });
        how = 'cmd-n';
      }

      // The window appears asynchronously, and a cold app launch can take seconds.
      // Returning the FIRST new CG record is wrong: Safari briefly stages a window
      // offscreen (observed titled "Untitled" at x=-1576) and then discards it for a
      // different window id, so the handle would be dead on arrival. The test a
      // candidate must pass is therefore the guarantee the handle itself makes — that it
      // joins to a real accessible window. On-screen candidates are preferred, but not
      // required: a freshly made Safari window reports kCGWindowIsOnscreen false for a
      // while, so requiring it loses the window we just asked for.
      for (let tries = 0; tries < 40; tries++) {
        sleep(0.2);
        if (pid === null) { try { pid = se.processes.byName(app).unixId(); } catch (e) {} }
        if (pid === null) continue;
        const real = H.real(H.all());
        const fresh = real.filter((w) => !before[w.cg_id] && w.pid === pid)
          .sort((a, b) => (a.onscreen === b.onscreen) ? 0 : (a.onscreen ? -1 : 1));
        if (!fresh.length) continue;
        const proc = H.procByPid(pid);
        if (!proc) continue;
        const rows = H.axWindows(proc);
        for (const w of fresh) {                       // CG order, so frontmost first
          if (H.axIndexOf(rows, w) === null) continue;
          return { how, cg_id: w.cg_id, title: w.title, x: w.x, y: w.y, width: w.width, height: w.height };
        }
      }
      return { how, cg_id: null };
    }, CG_SRC, application, url ?? null);

    if (!res || res.cg_id === null) {
      return sc({
        success: false,
        message: `no new window appeared for ${application}${res?.how === 'cmd-n' ? ' — it may not support ⌘N' : ''}`,
        window: null, title: null, x: null, y: null, width: null, height: null,
      });
    }
    // The CG title is null unless this process holds Screen Recording; read it back
    // through Accessibility, which the pack already relies on.
    let title = res.title ?? null;
    if (title === null) {
      try {
        const t = await resolveHandle(formatHandle(res.cg_id));
        title = await run((app, i) => {
          try { return Application('System Events').processes.whose({ name: app })[0].windows[i].name(); } catch (e) { return null; }
        }, t.application, t.window_index - 1);
      } catch { /* handle already stale — geometry is still worth returning */ }
    }
    return sc({
      success: true,
      message: `Opened a new ${application} window${url ? ` at ${url}` : ''}`,
      window: formatHandle(res.cg_id),
      title: title ?? null,
      x: res.x, y: res.y, width: res.width, height: res.height,
    });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('close_window',
  {
    title: 'Close Window',
    icons: [{ src: 'https://api.iconify.design/mdi/window-close.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Close a specific window of an application. A native-fullscreen window has no close button while fullscreen, so it is brought forward (switching to its Mission Control space), taken out of fullscreen and closed — then whichever app was frontmost before is reactivated.',
    inputSchema: WINDOW_INPUT,
    outputSchema: SUCCESS_OUTPUT,
  },
  async (input) => {
    const { application, window_index } = await resolveTarget(input);
    const idx = window_index - 1;
    const { left_fullscreen, restored_app } = await run((app, i) => {
      ObjC.import('Foundation');
      const se = Application('System Events');
      const proc = se.processes.whose({ name: app })[0];
      const sleep = (seconds) => $.NSThread.sleepForTimeInterval(seconds);

      const closeButtonOf = (win) => {
        try {
          const buttons = win.buttons.whose({ subrole: 'AXCloseButton' })();
          return buttons.length ? buttons[0] : null;
        } catch { return null; }
      };
      const titleOf = (win) => { try { return win.name(); } catch { return null; } };
      const activate = (name) => {
        // Going through the PROCESS avoids Application(name) failing on a process
        // whose name isn't the scriptable app name.
        try { se.processes.byName(name).frontmost = true; return true; }
        catch { try { Application(name).activate(); return true; } catch { return false; } }
      };

      let win = proc.windows[i];
      const title = titleOf(win);
      // Leaving fullscreen reorders the window list, and an index can go stale
      // entirely, so re-find the window by title whenever it stops matching.
      const reresolve = () => {
        if (title === null || titleOf(win) === title) return;
        for (let j = 0; j < proc.windows.length; j++) {
          if (titleOf(proc.windows[j]) === title) { win = proc.windows[j]; return; }
        }
      };

      const wasFullscreen = (() => {
        try { return !!win.attributes.byName('AXFullScreen').value(); } catch { return false; }
      })();
      let previousApp = null;

      // A fullscreen window has NO traffic-light buttons at all — its title bar is
      // auto-hidden — so clicking AXCloseButton failed with "Invalid index. (-1719)".
      // Leaving fullscreen fixes that, but only for a window whose space is ACTIVE:
      // on any other space the title bar never comes back and the button never
      // appears. So bring the app forward (macOS switches to the window's space),
      // close it there, and hand focus back to where it was.
      if (wasFullscreen) {
        const frontmost = (() => { try { return se.processes.whose({ frontmost: true })[0].name(); } catch { return null; } })();
        if (frontmost && frontmost !== app) previousApp = frontmost;
        activate(app);
        sleep(0.6);   // the space switch is animated
        reresolve();
        try { win.attributes.byName('AXFullScreen').value = false; } catch { /* checked below */ }
        for (let tries = 0; tries < 40 && !closeButtonOf(win); tries++) {
          sleep(0.1);
          reresolve();
        }
      }

      const button = closeButtonOf(win);
      if (!button) {
        // Don't leave the window silently un-fullscreened, or the focus moved, by a
        // close that failed.
        if (wasFullscreen) {
          try { win.attributes.byName('AXFullScreen').value = true; } catch { /* best effort */ }
          if (previousApp) activate(previousApp);
        }
        throw new Error(`window ${i + 1} of ${app} has no close button`);
      }
      button.click();

      let restored = null;
      if (previousApp) {
        // Closing a fullscreen window collapses its space, so macOS decides where
        // focus lands. Put it back where it was.
        sleep(0.5);
        if (activate(previousApp)) restored = previousApp;
      }
      return { left_fullscreen: wasFullscreen, restored_app: restored };
    }, application, idx);
    const what = left_fullscreen
      ? `Left fullscreen and closed window ${window_index} of ${application}`
      : `Closed window ${window_index} of ${application}`;
    return sc({
      success: true,
      message: restored_app ? `${what}; reactivated ${restored_app}` : what,
    });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('move_window',
  {
    title: 'Move Window',
    icons: [{ src: 'https://api.iconify.design/mdi/arrow-all.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Move a window to a specific position on screen.',
    inputSchema: {
      ...WINDOW_INPUT,
      x: z.number().describe('X coordinate in pixels'),
      y: z.number().describe('Y coordinate in pixels'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async (input) => {
    const { x, y } = input;
    const { application, window_index } = await resolveTarget(input);
    await run((app, i, x, y) => {
      Application('System Events').processes.whose({ name: app })[0].windows[i].position = [x, y];
    }, application, window_index - 1, x, y);
    return sc({ success: true, message: `Moved window to (${x}, ${y})` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('resize_window',
  {
    title: 'Resize Window',
    icons: [{ src: 'https://api.iconify.design/mdi/resize.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Resize a window to specific dimensions.',
    inputSchema: {
      ...WINDOW_INPUT,
      width: z.number(),
      height: z.number(),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async (input) => {
    const { width, height } = input;
    const { application, window_index } = await resolveTarget(input);
    await run((app, i, w, h) => {
      Application('System Events').processes.whose({ name: app })[0].windows[i].size = [w, h];
    }, application, window_index - 1, width, height);
    return sc({ success: true, message: `Resized window to ${width}x${height}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('minimize_window',
  {
    title: 'Minimise Window',
    icons: [{ src: 'https://api.iconify.design/mdi/window-minimize.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Minimize a window to the Dock.',
    inputSchema: WINDOW_INPUT,
    outputSchema: SUCCESS_OUTPUT,
  },
  async (input) => {
    const { application, window_index } = await resolveTarget(input);
    await run((app, i) => {
      Application('System Events').processes.whose({ name: app })[0].windows[i].miniaturized = true;
    }, application, window_index - 1);
    return sc({ success: true, message: `Minimized window ${window_index} of ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('fullscreen_window',
  {
    title: 'Fullscreen Window',
    icons: [{ src: 'https://api.iconify.design/mdi/fullscreen.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Toggle native fullscreen for a window (enters a separate Mission Control space). Use zoom_window to maximize without leaving the current space.',
    inputSchema: WINDOW_INPUT,
    outputSchema: SUCCESS_OUTPUT,
  },
  async (input) => {
    const { application, window_index } = await resolveTarget(input);
    await run((app, i) => {
      const win = Application('System Events').processes.whose({ name: app })[0].windows[i];
      const current = win.attributes.byName('AXFullScreen').value();
      win.attributes.byName('AXFullScreen').value = !current;
    }, application, window_index - 1);
    return sc({ success: true, message: `Toggled fullscreen for ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('zoom_window',
  {
    title: 'Zoom Window',
    icons: [{ src: 'https://api.iconify.design/mdi/magnify-plus.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Maximize (zoom) a window to fill a screen without entering fullscreen mode.',
    inputSchema: {
      ...WINDOW_INPUT,
      screen_index: z.number().optional().describe('0-based screen index from get_screens (default: main screen)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async (input) => {
    const screen_index = input.screen_index ?? null;
    const { application, window_index } = await resolveTarget(input);
    await run((app, i, si) => {
      ObjC.import('AppKit');
      const mainH = $.NSScreen.mainScreen.frame.size.height;
      const screen = si !== null ? $.NSScreen.screens.objectAtIndex(si) : $.NSScreen.mainScreen;
      const f = screen.visibleFrame;
      // Convert NSScreen coords (origin bottom-left, y up) to Accessibility coords (origin top-left, y down)
      const axX = f.origin.x;
      const axY = mainH - (f.origin.y + f.size.height);
      const win = Application('System Events').processes.whose({ name: app })[0].windows[i];
      win.position = [axX, axY];
      win.size = [f.size.width, f.size.height];
    }, application, window_index - 1, screen_index);
    return sc({ success: true, message: `Zoomed window ${window_index} of ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_screen_size',
  {
    title: 'Main Screen Size',
    icons: [{ src: 'https://api.iconify.design/mdi/monitor.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the screen dimensions of the main display.',
    inputSchema: {},
    outputSchema: { width: z.number(), height: z.number() },
  },
  async () => {
    const result = await run(() => {
      ObjC.import('AppKit');
      const frame = $.NSScreen.mainScreen.frame;
      return { width: frame.size.width, height: frame.size.height };
    });
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_screens',
  {
    title: 'List Screens',
    icons: [{ src: 'https://api.iconify.design/mdi/monitor-multiple.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get dimensions and positions of all connected displays.',
    inputSchema: {},
    outputSchema: {
      screens: z.array(z.object({
        index: z.number(),
        x: z.number(), y: z.number(),
        width: z.number(), height: z.number(),
        visible_x: z.number(), visible_y: z.number(),
        visible_width: z.number(), visible_height: z.number(),
        is_main: z.boolean(),
      })),
    },
  },
  async () => {
    const result = await run(() => {
      ObjC.import('AppKit');
      const main = $.NSScreen.mainScreen;
      const all = $.NSScreen.screens;
      const screens = [];
      for (let i = 0; i < all.count; i++) {
        const s = all.objectAtIndex(i);
        const f = s.frame;
        const v = s.visibleFrame;
        screens.push({
          index: i,
          x: f.origin.x, y: f.origin.y,
          width: f.size.width, height: f.size.height,
          visible_x: v.origin.x, visible_y: v.origin.y,
          visible_width: v.size.width, visible_height: v.size.height,
          is_main: s.isEqual(main),
        });
      }
      return { screens };
    });
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_window_screen',
  {
    title: 'Window\'s Screen',
    icons: [{ src: 'https://api.iconify.design/mdi/monitor.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get which screen a window is currently on, by comparing the window position against all screen frames.',
    inputSchema: WINDOW_INPUT,
    outputSchema: {
      screen_index: z.number().describe('0-based index into get_screens results'),
      is_main: z.boolean(),
      x: z.number(), y: z.number(),
      width: z.number(), height: z.number(),
    },
  },
  async (input) => {
    const { application, window_index } = await resolveTarget(input);
    const result = await run((app, i) => {
      ObjC.import('AppKit');
      const win = Application('System Events').processes.whose({ name: app })[0].windows[i];
      const pos = win.position();
      const sz = win.size();
      const cx = pos[0] + sz[0] / 2;
      const cy = pos[1] + sz[1] / 2;
      const mainH = $.NSScreen.mainScreen.frame.size.height;
      const screens = $.NSScreen.screens;
      // Convert centre to NSScreen coords for containment test
      const nscy = mainH - cy;
      for (let s = 0; s < screens.count; s++) {
        const f = screens.objectAtIndex(s).frame;
        if (cx >= f.origin.x && cx <= f.origin.x + f.size.width &&
            nscy >= f.origin.y && nscy <= f.origin.y + f.size.height) {
          return {
            screen_index: s,
            is_main: screens.objectAtIndex(s).isEqual($.NSScreen.mainScreen),
            x: f.origin.x, y: f.origin.y,
            width: f.size.width, height: f.size.height,
          };
        }
      }
      const mf = $.NSScreen.mainScreen.frame;
      return { screen_index: 0, is_main: true, x: mf.origin.x, y: mf.origin.y, width: mf.size.width, height: mf.size.height };
    }, application, window_index - 1);
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('open_url',
  {
    title: 'Open URL',
    icons: [{ src: 'https://api.iconify.design/mdi/open-in-new.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Open a URL in a browser. Opens in a new tab if browser is already running.',
    inputSchema: {
      url: z.string().describe('URL to open (e.g. "https://example.com")'),
      browser: z.string().optional().describe('"Safari", "Google Chrome", "Firefox", or "Arc" (default: Safari)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ url, browser = 'Safari' }) => {
    await run((url, br) => {
      if (br === 'Google Chrome' || br === 'Chrome') {
        const app = Application('Google Chrome');
        app.activate();
        if (app.windows.length === 0) app.Window().make();
        app.windows[0].tabs.push(app.Tab({ url }));
      } else if (br === 'Firefox') {
        const app = Application('Firefox');
        app.activate();
        app.openLocation(url);
      } else if (br === 'Arc') {
        const app = Application('Arc');
        app.activate();
        app.openLocation(url);
      } else {
        const app = Application('Safari');
        app.activate();
        if (app.windows.length === 0) {
          app.Document({ url }).make();
        } else {
          const tab = app.Tab({ url }).make();
          app.windows[0].currentTab = tab;
        }
      }
    }, url, browser);
    return sc({ success: true, message: `Opened ${url} in ${browser}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_browser_tabs',
  {
    title: 'List Browser Tabs',
    icons: [{ src: 'https://api.iconify.design/mdi/tab.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get all open tabs across all windows in the specified browser.',
    inputSchema: {
      browser: z.string().optional().describe('"Safari", "Google Chrome", or "Arc" (default: Safari)'),
    },
    outputSchema: {
      tabs: z.array(z.object({
        window_index: z.number(),
        tab_index: z.number(),
        title: z.string(),
        url: z.string(),
      })),
    },
  },
  async ({ browser = 'Safari' }) => {
    const tabs = await run((br) => {
      const result = [];
      if (br === 'Google Chrome' || br === 'Chrome') {
        const app = Application('Google Chrome');
        for (let i = 0; i < app.windows.length; i++)
          for (let j = 0; j < app.windows[i].tabs.length; j++) {
            const t = app.windows[i].tabs[j];
            result.push({ window_index: i + 1, tab_index: j + 1, title: t.title(), url: t.url() });
          }
      } else if (br === 'Arc') {
        const app = Application('Arc');
        for (let i = 0; i < app.windows.length; i++)
          for (let j = 0; j < app.windows[i].tabs.length; j++) {
            const t = app.windows[i].tabs[j];
            result.push({ window_index: i + 1, tab_index: j + 1, title: t.title(), url: t.url() });
          }
      } else {
        const app = Application('Safari');
        for (let i = 0; i < app.windows.length; i++)
          for (let j = 0; j < app.windows[i].tabs.length; j++) {
            const t = app.windows[i].tabs[j];
            result.push({ window_index: i + 1, tab_index: j + 1, title: t.name(), url: t.url() });
          }
      }
      return result;
    }, browser);
    return sc({ tabs });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('close_browser_tab',
  {
    title: 'Close Browser Tab',
    icons: [{ src: 'https://api.iconify.design/mdi/tab-minus.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Close a specific browser tab.',
    inputSchema: {
      browser: z.string().optional().describe('"Safari", "Google Chrome", or "Arc" (default: Safari)'),
      window_index: z.number().optional().describe('1-based window index (default: 1)'),
      tab_index: z.number().optional().describe('1-based tab index (default: 1)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ browser = 'Safari', window_index = 1, tab_index = 1 }) => {
    const wi = window_index - 1;
    const ti = tab_index - 1;
    await run((br, wi, ti) => {
      if (br === 'Google Chrome' || br === 'Chrome') {
        Application('Google Chrome').windows[wi].tabs[ti].close();
      } else if (br === 'Arc') {
        Application('Arc').windows[wi].tabs[ti].close();
      } else {
        Application('Safari').windows[wi].tabs[ti].close();
      }
    }, browser, wi, ti);
    return sc({ success: true, message: `Closed tab ${tab_index} of window ${window_index}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_active_tab_info',
  {
    title: 'Active Browser Tab',
    icons: [{ src: 'https://api.iconify.design/mdi/tab.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the title and URL of the active (frontmost) browser tab.',
    inputSchema: {
      browser: z.string().optional().describe('"Safari", "Google Chrome", or "Arc" (default: Safari)'),
    },
    outputSchema: { title: z.string(), url: z.string() },
  },
  async ({ browser = 'Safari' }) => {
    const result = await run((br) => {
      if (br === 'Google Chrome' || br === 'Chrome') {
        const t = Application('Google Chrome').windows[0].activeTab();
        return { title: t.title(), url: t.url() };
      } else if (br === 'Arc') {
        const t = Application('Arc').windows[0].activeTab();
        return { title: t.title(), url: t.url() };
      } else {
        const t = Application('Safari').windows[0].currentTab();
        return { title: t.name(), url: t.url() };
      }
    }, browser);
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_spaces',
  {
    title: 'List Spaces',
    icons: [{ src: 'https://api.iconify.design/mdi/view-grid.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get information about all Mission Control desktops/spaces.',
    inputSchema: {},
    outputSchema: {
      displays: z.array(z.object({
        display: z.string(),
        current_space_index: z.number().nullable(),
        current_space_id: z.number(),
        total_spaces: z.number(),
        spaces: z.array(z.object({
          index: z.number(),
          id: z.number(),
          uuid: z.string(),
          type: z.number(),
          is_current: z.boolean(),
        })),
      })),
    },
  },
  async () => sc(readSpacesConfig())
);

// ---------------------------------------------------------------------------

server.registerTool('get_current_space',
  {
    title: 'Current Space',
    icons: [{ src: 'https://api.iconify.design/mdi/view-grid-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the current desktop/space number and details.',
    inputSchema: {},
    outputSchema: {
      current_space: z.number().nullable(),
      total_spaces: z.number(),
      space_id: z.number(),
    },
  },
  async () => {
    const config = readSpacesConfig();
    if (!config.displays.length) throw new Error('No display information found');
    const d = config.displays[0];
    return sc({ current_space: d.current_space_index, total_spaces: d.total_spaces, space_id: d.current_space_id });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('launch_application',
  {
    title: 'Launch App',
    icons: [{ src: 'https://api.iconify.design/mdi/rocket-launch.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Launch an application by name. If already running, brings it to the front.',
    inputSchema: { application: z.string() },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application }) => {
    await run((app) => { Application(app).activate(); }, application);
    return sc({ success: true, message: `Launched ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('open_file',
  {
    title: 'Open File',
    icons: [{ src: 'https://api.iconify.design/mdi/file-document-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Open a file, optionally with a specific application.',
    inputSchema: {
      file_path: z.string().describe('Absolute path to the file'),
      application: z.string().optional().describe('Optional app to open with (uses default if omitted)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ file_path, application }) => {
    await run((filePath, app) => {
      if (app) {
        Application(app).activate();
        Application(app).open(Path(filePath));
      } else {
        Application('Finder').open(Path(filePath));
      }
    }, file_path, application || null);
    return sc({ success: true, message: `Opened ${file_path}${application ? ` with ${application}` : ''}` });
  }
);

// =============================================================================
// SURFACES: register the live app-list resource + the three ui:// view resources
// =============================================================================

// Advertise resource subscription so the Studio host opens a live subscription for
// a bound face (it only calls resources/subscribe when this capability is present).
server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

// io.streamdeck/resourceSchema — see the Studio host's convention (audio's
// server.mjs has the fuller writeup). Matches appsState's shape (also the
// get_running_applications tool's outputSchema).
const APPS_SCHEMA = {
  type: 'object',
  properties: {
    applications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bundle_id: { type: 'string' },
          frontmost: { type: 'boolean' },
        },
        required: ['name', 'frontmost'],
      },
    },
    active_index: { type: 'number' },
  },
  required: ['applications', 'active_index'],
};

// The live app-list snapshot the surfaces bind to.
server.registerResource(
  'open-applications',
  URI_APPS,
  { title: 'Open Applications', description: 'Ordered switchable GUI apps + the frontmost index — the live data the app-switcher surfaces bind to.', icons: [{ src: 'https://api.iconify.design/mdi/apps.svg', mimeType: 'image/svg+xml', sizes: ['any'] }], mimeType: 'application/json', _meta: { 'io.streamdeck/resourceSchema': APPS_SCHEMA } },
  async () => {
    await ensurePrimed();
    return { contents: [{ uri: URI_APPS, mimeType: 'application/json', text: JSON.stringify(appsState) }] };
  }
);

const WINDOWS_SCHEMA = {
  type: 'object',
  properties: {
    windows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          window: { type: 'string' },
          cg_id: { type: 'number' },
          app: { type: 'string' },
          pid: { type: 'number' },
          title: { type: 'string' },
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
          onscreen: { type: 'boolean' },
          z: { type: 'number', description: '0 = frontmost on the current space; null for an offscreen window' },
        },
        required: ['window', 'cg_id', 'pid', 'x', 'y', 'width', 'height', 'onscreen'],
      },
    },
    count: { type: 'number' },
  },
  required: ['windows', 'count'],
};

// The live window list. Includes windows on other Mission Control spaces (offscreen);
// `title` is null for a window whose title neither CoreGraphics nor Accessibility would
// give up — a face should fall back to `app` rather than render a blank row.
//
// Two limits are inherent to reading this from CoreGraphics, and are cheap-on-purpose
// rather than bugs to be heuristically patched over:
//   • A just-closed window's record can linger offscreen for a while, so the list can
//     briefly show a window that is gone (observed with Finder). It is byte-identical in
//     every CG field to a live window on another space, so there is nothing to filter on;
//     acting on its handle fails safely instead.
//   • Without Screen Recording, CoreGraphics redacts titles, and an offscreen window with
//     no title can't be told apart from the ~24 service placeholders ("AutoFill",
//     "loginwindow", 500x500 panels) — so the list then covers the current space only.
// get_windows is the exhaustive-but-slow (~1s, Accessibility) answer when that matters.
server.registerResource(
  'open-windows',
  URI_WINDOWS,
  { title: 'Open Windows', description: 'Every real open window with a stable handle, its owning app/pid, geometry, z-order and whether it is on the current space. Handles can be passed straight to the move/resize/close tools.', icons: [{ src: 'https://api.iconify.design/mdi/window-restore.svg', mimeType: 'image/svg+xml', sizes: ['any'] }], mimeType: 'application/json', _meta: { 'io.streamdeck/resourceSchema': WINDOWS_SCHEMA } },
  async () => {
    await ensurePrimedWindows();
    return { contents: [{ uri: URI_WINDOWS, mimeType: 'application/json', text: JSON.stringify(windowsState) }] };
  }
);

// The three surface views. metadata carries the io.streamdeck/surfaces _meta on BOTH
// the list descriptor (so the host classifies the surface from resources/list) and
// the read envelope (jsx + _meta), matching what the host's resolveUiResource reads.
// A surface's icon follows what it IS — a key, a dial or a popup — which is the
// distinction a user browsing a server's resources actually needs. `v.name` was
// authored above and never reached the wire: registerResource takes the slug as
// its `name` (a stable identifier), so the human label goes in `title`.
const SURFACE_ICONS = {
  key: 'gesture-tap-button',
  encoder: 'tune-vertical',
  popup: 'dock-window',
};
function surfaceIcons(meta) {
  const slug = SURFACE_ICONS[Object.keys(meta ?? {})[0]] ?? 'view-dashboard-outline';
  return [{ src: `https://api.iconify.design/mdi/${slug}.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }];
}

for (const [uri, v] of Object.entries(UI_VIEWS)) {
  server.registerResource(
    uri.replace('ui://', '').replace(/\//g, '-'),
    uri,
    { title: v.name, description: v.description, icons: surfaceIcons(v.meta), mimeType: 'application/vnd.mcp-ui+json', _meta: { [SURFACE_NS]: v.meta } },
    async () => ({
      contents: [{
        uri,
        mimeType: 'application/vnd.mcp-ui+json',
        text: JSON.stringify({ jsx: readViewFile(v.file), _meta: { [SURFACE_NS]: v.meta } }),
      }],
    })
  );
}

// Track subscriptions so pollApps only pushes resources/updated while a face is bound;
// start/stop the watcher with the first/last subscriber to the app list.
server.server.setRequestHandler('resources/subscribe', async (req) => {
  const uri = req.params?.uri;
  if (uri) {
    subscribed.add(uri);
    if (uri === URI_APPS) startWatching();
    if (uri === URI_WINDOWS) startWatchingWindows();
  }
  return {};
});
server.server.setRequestHandler('resources/unsubscribe', async (req) => {
  const uri = req.params?.uri;
  if (uri) {
    subscribed.delete(uri);
    if (!subscribed.has(URI_APPS)) stopWatching();
    if (!subscribed.has(URI_WINDOWS)) stopWatchingWindows();
  }
  return {};
});

// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
