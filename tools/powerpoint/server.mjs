/**
 * PowerPoint — drive the OPEN presentation via AppleScript.
 *
 * PowerPoint for Mac ships a real scripting dictionary
 * (`sdef "/Applications/Microsoft PowerPoint.app"`), so this pack talks to the
 * document the user is actually looking at: the live *selection*, the active
 * slide, the editor view, the running slide show. A file-level library
 * (python-pptx, OOXML surgery) cannot see any of that — it edits a copy on disk
 * and can't safely touch a presentation PowerPoint has open.
 *
 * Shape of the dictionary (the bits that matter here):
 *   application
 *     └─ active presentation ─────┐
 *        presentation            │  name / path / full name / saved
 *          ├─ slides            │    slide: slide index, slide ID, shapes
 *          ├─ slide show settings   (starting slide, advance mode, …)
 *          └─ slide show window ──▶ slideshow view: slide, elapsed time, state
 *        document window 1
 *          ├─ view ─────────────▶  slide  (this is what "navigate" writes)
 *          └─ selection ────────▶  selection type, shape range, text range
 *        shape
 *          ├─ left position / top / width / height / rotation / visible / name
 *          ├─ fill format ──▶ fore color, visible, transparency
 *          ├─ line format ──▶ fore color, line weight, dash style, visible
 *          └─ text frame ──▶ text range ──▶ content, font
 *
 * ── VERIFIED QUIRKS (probed against PowerPoint 16.103.1) ─────────────────────
 * Every item below was confirmed by running it, not read off the sdef — the
 * dictionary describes several things that do not behave as documented, and three
 * of these (1, 11, 15) fail SILENTLY rather than erroring.
 *
 *  1. `count of <shape range>` RETURNS 0 EVEN WHEN THE RANGE HAS SHAPES. Every
 *     iteration over a selection must therefore walk `shape i of range` upward
 *     and stop on the first error — never `repeat with s in range`, never
 *     `count`. This is the single most important quirk in the file.
 *
 *  2. Colors are `{r, g, b}` in the **0–255** range, not the 0–65535 that most
 *     other AppleScript-able apps use. See `rgb()`.
 *
 *  3. Setting a line color or weight has NO VISIBLE EFFECT unless the dash style
 *     is made solid first (`set dash style of line format of shp to line dash
 *     style solid`). A fresh shape's line is styled but effectively absent.
 *
 *  4. `visible of line format` / `visible of fill format` are settable but are
 *     absent from some sdef property listings; they can also throw on certain
 *     shape types (pictures, placeholders). Always wrapped in `try`.
 *
 *  5. Text is written through `content of text range of text frame of shp` — but
 *     only if `has text frame of shp` is true. Reading it on a shape without one
 *     throws and would abort a whole listing, so reads go through `orNull`.
 *
 *  6. Two ways to navigate the EDITOR, both verified: the property write
 *     `set slide of (view of document window 1) to slide N of pres`, and the
 *     command `go to slide (view of document window 1) number N`. Despite its
 *     name the latter is editor navigation — its direct parameter is a `view`,
 *     NOT a slide show view. This file uses the property write.
 *
 *  7. `go to next slide` / `go to previous slide` / `go to first slide` take a
 *     SLIDE SHOW VIEW (`slideshow view of slide show window of pres`) and only
 *     exist while a show is running; they error otherwise, so the presenter tools
 *     check for a live show first and say so plainly.
 *
 *  8. A `tell application "Microsoft PowerPoint"` LAUNCHES PowerPoint if it isn't
 *     running — a slow, startling side effect for a button press or a poll.
 *     Every script is gated on PowerPoint already running via System Events;
 *     nothing in this pack opens the app.
 *
 *  9. `slide index of <slide>` is the reliable way to learn where a slide sits;
 *     the ordinal used to reach it is not enough once slides move.
 *
 * 10. A slide has no title property. The conventional "title" is the text of the
 *     first shape that has one, which is what list_slides reports.
 *
 * 11. `real as text` USES THE SYSTEM DECIMAL SEPARATOR. On a comma locale a
 *     shape's `left position` reads back as "222,5", which `Number()` turns into
 *     NaN — silently nulling every geometry value, font size and elapsed time.
 *     All numeric parsing goes through `asNum`. Writing a period is always fine.
 *
 * 12. `current show position` counts from the start of the show RANGE, not the
 *     deck: a show started at slide 3 reports 1. Use `slide index of (slide of
 *     <slide show view>)` for the true deck index.
 *
 * 13. Slide insertion location is the PRESENTATION, not its slides element:
 *     `make new slide at end of pres` works, `… at end of slides of pres` fails
 *     with "Can't make class slide". Shapes are the opposite — they can only be
 *     made from inside `tell slide N`, never `make new shape at end of shapes of
 *     slide N of pres` (Parameter error).
 *
 * 14. The standard `duplicate` command does not work on a slide at all. Use
 *     PowerPoint's `copy object` / `paste object`, which appends to the deck end.
 *
 * 15. THE SELECTION CANNOT BE EXTENDED. `select shp with extend` compiles, runs,
 *     reports no error — and leaves only the last shape selected. `select {shape
 *     1, shape 3}` is worse: it selects EVERY shape on the slide. Only two things
 *     work: `select <one shape>` and `select shapes of <slide>` (all of them).
 *     Arbitrary multi-select must be done by the user, by hand; reading it back
 *     works perfectly, which is the direction that matters.
 *
 * 16. There is no direct jump inside a running show — `slide` on a slide show view
 *     is read-only and the view doesn't conform to `view`, so goto_slide_in_show
 *     steps with go to next/previous slide.
 *
 * The gateway may tear this server down between presses, so nothing important
 * lives only in memory — every tool re-reads state from PowerPoint.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 'Microsoft PowerPoint';

const server = new McpServer(
  { name: 'powerpoint', version: '1.0.0' },
  { capabilities: { resources: { subscribe: true }, tools: {} } },
);

// ── Resource + surface URIs ──────────────────────────────────────────────────

const URI_PRESENTATION = 'resource://powerpoint/presentation';
const URI_SELECTION = 'resource://powerpoint/selection';

const URI_UI_KEY = 'ui://powerpoint/key';
const URI_UI_DIAL = 'ui://powerpoint/dial';
const URI_UI_POPUP = 'ui://powerpoint/popup';

const SURFACE_NS = 'io.streamdeck/surfaces';
const APP_MIME = 'text/html;profile=mcp-app';

// ── AppleScript plumbing ─────────────────────────────────────────────────────

// AppleScript has no JSON writer, so results come back as delimited records and
// are parsed here. RS/US are the ASCII record/unit separators — they can't occur
// in a font name, shape name or slide text.
const RS = '\x1e';
const US = '\x1f';

/**
 * AppleScript helpers injected into every script.
 *
 * `orNull` collapses `missing value` — and any property whose getter throws
 * (quirk 5) — to the empty string, so a record's arity stays stable and one
 * awkward shape can't take down a whole listing.
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
 * Run an AppleScript.
 *
 * Quirk 8: gated on PowerPoint already running unless the caller opts out, so a
 * poll or a stray press can never boot the app.
 */
async function osa(script, timeoutMs = 20000, { allowLaunch = false, helpers = '' } = {}) {
  if (!allowLaunch && script.includes(`application "${APP}"`)) await requirePowerPoint();
  // Handler definitions are only legal at the TOP LEVEL of a script, so HELPERS —
  // and any caller-supplied handler, passed via `helpers` — is hoisted above the
  // `with timeout` block. Put one inside and compilation fails outright with
  // "Expected end but found on".
  const secs = Math.ceil(timeoutMs / 1000) + 5;
  const wrapped = `${HELPERS}\n${helpers}\nwith timeout of ${secs} seconds\n${script}\nend timeout`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', wrapped], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(translateError(stderr || err.message || String(err))));
      else resolve(stdout.replace(/\n$/, ''));
    });
  });
}

/** Turn raw AppleScript/TCC failures into something a button author can act on. */
function translateError(raw) {
  // osascript prefixes every failure with a character range and trails an error
  // number — "249:281: execution error: … (-2700)". Match the RAW text (it
  // carries the OSStatus code) but return the cleaned one.
  const full = String(raw);
  const msg = full
    .replace(/^\s*\d+:\d+:\s*(execution|syntax) error:\s*/i, '')
    .replace(/\s*\(-?\d+\)\s*$/, '')
    .trim();
  if (/Application isn.t running|-600/.test(full)) {
    return 'PowerPoint is not running. Open it and a presentation first.';
  }
  if (/not allowed to send Apple events|-1743/.test(full)) {
    return 'Not permitted to control PowerPoint. Grant automation access in System Settings › '
      + 'Privacy & Security › Automation (allow Stream Deck to control Microsoft PowerPoint), then retry.';
  }
  if (/-1712/.test(full) || /timed out/i.test(msg)) {
    return 'PowerPoint did not answer in time. Retry, or raise the timeout.';
  }
  if (/Can.t get active presentation|-1728/.test(full)) {
    return 'No presentation is open in PowerPoint.';
  }
  return msg;
}

const asRecords = (out) => (out ? out.split(RS).filter(Boolean).map((r) => r.split(US)) : []);
const nullable = (s) => (s === '' || s == null ? null : s);

/**
 * Quirk 11 — the one that silently corrupts everything: `real as text` in
 * AppleScript uses the SYSTEM's decimal separator. On a machine set to a
 * comma locale, `left position` of a shape comes back as "222,5", and
 * `Number("222,5")` is NaN — so every geometry read, font size and elapsed time
 * turns to null on a European Mac while working perfectly on a US one.
 *
 * AppleScript accepts a period on the way IN regardless of locale, so only
 * parsing needs normalizing. Reals never carry a thousands separator, which is
 * what makes the swap safe.
 */
const asNum = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const asBool = (s) => s === 'true';
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * Escape a JS string for an AppleScript double-quoted literal.
 *
 * One implementation, used for EVERY interpolated string in this file. The
 * earlier Python version hand-rolled this per tool and missed two call sites
 * (font names), where a quote in the value produced a syntax error or worse.
 */
const q = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Quirk 2: PowerPoint wants {r, g, b} in 0–255. Accepts "#RGB", "#RRGGBB", "red". */
const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00a651', blue: '#0070c0',
  yellow: '#ffc000', orange: '#ed7d31', purple: '#7030a0', pink: '#ff69b4', gray: '#808080',
  grey: '#808080', teal: '#008080', cyan: '#00b0f0', magenta: '#ff00ff', brown: '#8b4513',
};
function rgb(color) {
  let hex = String(color ?? '').trim().toLowerCase();
  if (NAMED[hex]) hex = NAMED[hex];
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    throw new Error(`Invalid color ${JSON.stringify(color)}. Use hex ("#FF0000", "#f00") or a name (${Object.keys(NAMED).slice(0, 6).join(', ')}, …).`);
  }
  const n = parseInt(hex, 16);
  return `{${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}}`;
}

/** Wrap a body in the PowerPoint tell block, binding `pres` to the open deck. */
function ppt(body, { needPresentation = true } = {}) {
  const bind = needPresentation
    ? 'set pres to active presentation\nif pres is missing value then error "No presentation is open in PowerPoint."\n'
    : '';
  return `tell application "${APP}"\n${bind}${body}\nend tell`;
}

/**
 * Quirk 1: iterate a shape range by index and stop on the first error, because
 * `count` lies (returns 0). `bodyFor(varName)` supplies the per-shape work.
 */
function forEachSelectedShape(body, { counter = 'n' } = {}) {
  return `
set sel to selection of document window 1
set ${counter} to 0
set shapeIdx to 1
try
  set selRange to shape range of sel
  repeat
    try
      set shp to shape shapeIdx of selRange
    on error
      exit repeat
    end try
${body}
    set ${counter} to ${counter} + 1
    set shapeIdx to shapeIdx + 1
  end repeat
end try`;
}

// ── Guards ───────────────────────────────────────────────────────────────────

/** Asked via System Events so we never auto-launch PowerPoint (quirk 8). */
async function isRunning() {
  try {
    const out = await osa(
      `tell application "System Events" to return (name of processes) contains "${APP}"`,
      8000, { allowLaunch: true },
    );
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function requirePowerPoint() {
  if (!(await isRunning())) {
    throw new Error('PowerPoint is not running. Open PowerPoint and a presentation first.');
  }
}

// ── Result helper ────────────────────────────────────────────────────────────

function ok(data, summary) {
  return {
    content: [{ type: 'text', text: summary ?? JSON.stringify(data) }],
    structuredContent: data,
  };
}

// =============================================================================
// READING STATE  (shared by tools, resources and faces)
// =============================================================================

/**
 * Quirk 10: no title property — the first shape bearing text is the title.
 *
 * A handler must live at the top level (see `osa`), but PowerPoint's vocabulary
 * (`shapes`, `has text frame`) is only in scope inside a `tell`, so the body
 * carries its own tell block. Without it the whole script fails to compile with
 * "Expected end of line but found identifier".
 */
const SLIDE_TITLE = `
on titleOf(sld)
  tell application "${APP}"
    try
      repeat with i from 1 to (count of shapes of sld)
        set shp to shape i of sld
        try
          if has text frame of shp then
            set t to content of text range of text frame of shp
            if t is not "" then return t
          end if
        end try
      end repeat
    end try
  end tell
  return ""
end titleOf
`.trim();

const PRESENTATION_SNAPSHOT = `
set slideTotal to count of slides of pres
set curIdx to 0
try
  set curIdx to slide index of (slide of view of document window 1)
end try
set showRunning to false
set showPos to 0
set showElapsed to 0
try
  set ssw to slide show window of pres
  if ssw is not missing value then
    set showRunning to true
    set ssv to slideshow view of ssw
    -- Quirk 12: NOT \`current show position\` — that counts from the start of the
    -- show RANGE, so a show started at slide 3 reports position 1. The view's
    -- read-only \`slide\` gives the true deck index.
    try
      set showPos to slide index of (slide of ssv)
    end try
    try
      set showElapsed to presentation elapsed time of ssv
    end try
  end if
end try
set slideTitle to ""
if curIdx > 0 then set slideTitle to my titleOf(slide curIdx of pres)
set buf to my orNull(name of pres) & "${US}" & my orNull(path of pres) & "${US}" & (slideTotal as text) & "${US}" & (curIdx as text) & "${US}" & my orNull(saved of pres) & "${US}" & (showRunning as text) & "${US}" & (showPos as text) & "${US}" & (showElapsed as text) & "${US}" & slideTitle
return buf
`.trim();

async function readPresentation(timeoutMs = 15000) {
  const out = await osa(ppt(PRESENTATION_SNAPSHOT), timeoutMs, { helpers: SLIDE_TITLE });
  const [name, path, total, cur, saved, running, pos, elapsed, title] = out.split(US);
  return {
    name: nullable(name),
    path: nullable(path),
    slide_count: Number(total || 0),
    current_slide: Number(cur || 0),
    saved: saved === 'true',
    slideshow_running: running === 'true',
    slideshow_position: Number(pos || 0),
    slideshow_elapsed: Math.round(asNum(elapsed) ?? 0),
    current_slide_title: nullable(title),
  };
}

const EMPTY_PRESENTATION = {
  name: null, path: null, slide_count: 0, current_slide: 0, saved: true,
  slideshow_running: false, slideshow_position: 0, slideshow_elapsed: 0,
  current_slide_title: null,
};

/**
 * The live selection. `selection type` tells us what kind it is; the shape range
 * is walked by index (quirk 1).
 */
const SELECTION_SNAPSHOT = `
set sel to selection of document window 1
set selKind to my orNull(selection type of sel)
set selText to ""
try
  set selText to content of text range of sel
end try
set curIdx to 0
try
  set curIdx to slide index of (slide of view of document window 1)
end try
set buf to selKind & "${US}" & (curIdx as text) & "${US}" & selText & "${RS}"
set shapeIdx to 1
try
  set selRange to shape range of sel
  repeat
    try
      set shp to shape shapeIdx of selRange
    on error
      exit repeat
    end try
    set shpText to ""
    try
      if has text frame of shp then set shpText to content of text range of text frame of shp
    end try
    set buf to buf & my orNull(name of shp) & "${US}" & my orNull(auto shape type of shp) & "${US}" & my orNull(left position of shp) & "${US}" & my orNull(top of shp) & "${US}" & my orNull(width of shp) & "${US}" & my orNull(height of shp) & "${US}" & my orNull(rotation of shp) & "${US}" & shpText & "${US}" & my orNull(font name of font of text range of text frame of shp) & "${US}" & my orNull(font size of font of text range of text frame of shp) & "${RS}"
    set shapeIdx to shapeIdx + 1
  end repeat
end try
return buf
`.trim();

async function readSelection(timeoutMs = 15000) {
  const out = await osa(ppt(SELECTION_SNAPSHOT, { needPresentation: false }), timeoutMs);
  const rows = asRecords(out);
  const [kind, curIdx, text] = rows[0] ?? ['', '0', ''];
  const shapes = rows.slice(1).map((r, i) => ({
    index: i + 1,
    name: nullable(r[0]),
    shape_type: nullable(r[1]),
    left: round1(asNum(r[2])),
    top: round1(asNum(r[3])),
    width: round1(asNum(r[4])),
    height: round1(asNum(r[5])),
    rotation: round1(asNum(r[6])),
    text: nullable(r[7]),
    font_name: nullable(r[8]),
    font_size: asNum(r[9]),
  }));
  return {
    kind: nullable(kind),
    slide_index: Number(curIdx || 0),
    shape_count: shapes.length,
    text: nullable(text),
    shapes,
  };
}

const EMPTY_SELECTION = { kind: null, slide_index: 0, shape_count: 0, text: null, shapes: [] };

// =============================================================================
// LIVE RESOURCES
// =============================================================================
// PowerPoint pushes no events, so we poll — but ONLY while something is
// subscribed, and never in a way that launches the app.

const subscribed = new Set();
let presentationState = null;
let selectionState = null;
let pollTimer = null;
let pollBusy = false;

const POLL_MS = 1200;
const POLL_SHOW_MS = 600; // a running show moves fast; the face should keep up

function notifyUpdated(uri) {
  if (subscribed.has(uri)) void server.server.sendResourceUpdated({ uri });
}

const presSig = (s) => (s ? [s.name, s.slide_count, s.current_slide, s.saved, s.slideshow_running, s.slideshow_position, s.current_slide_title].join('|') : '');
const selSig = (s) => (s ? [s.kind, s.slide_index, s.shape_count, s.text, s.shapes.map((x) => `${x.name}@${x.left},${x.top},${x.width},${x.height}`).join(';')].join('|') : '');

function setPresentationState(next) {
  if (presSig(presentationState) === presSig(next)) { presentationState = next; return; }
  presentationState = next;
  notifyUpdated(URI_PRESENTATION);
}

function setSelectionState(next) {
  if (selSig(selectionState) === selSig(next)) { selectionState = next; return; }
  selectionState = next;
  notifyUpdated(URI_SELECTION);
}

async function pollOnce() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    // Don't launch PowerPoint just to poll — an Apple event would boot the app.
    if (!(await isRunning())) {
      setPresentationState({ ...EMPTY_PRESENTATION });
      setSelectionState({ ...EMPTY_SELECTION });
      return;
    }
    if (subscribed.has(URI_PRESENTATION)) {
      try { setPresentationState(await readPresentation(12000)); }
      catch { setPresentationState({ ...EMPTY_PRESENTATION }); }
    }
    // A running slide show has no document window, so the selection read throws.
    // That's a normal state, not a failure.
    if (subscribed.has(URI_SELECTION)) {
      try { setSelectionState(await readSelection(12000)); }
      catch { setSelectionState({ ...EMPTY_SELECTION }); }
    }
  } catch {
    // keep the last good snapshot
  } finally {
    pollBusy = false;
    schedulePoll();
  }
}

function schedulePoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (subscribed.size === 0) return;
  pollTimer = setTimeout(() => void pollOnce(), presentationState?.slideshow_running ? POLL_SHOW_MS : POLL_MS);
}

function startPolling() {
  if (pollTimer || subscribed.size === 0) return;
  void pollOnce();
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// io.streamdeck/resourceSchema — the Studio reads this from `_meta` to generate a
// typed accessor; a plain MCP client ignores it.
const PRESENTATION_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    path: { type: 'string' },
    slide_count: { type: 'number' },
    current_slide: { type: 'number' },
    saved: { type: 'boolean' },
    slideshow_running: { type: 'boolean' },
    slideshow_position: { type: 'number' },
    slideshow_elapsed: { type: 'number' },
    current_slide_title: { type: 'string' },
  },
  required: ['slide_count', 'current_slide', 'slideshow_running'],
};

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    slide_index: { type: 'number' },
    shape_count: { type: 'number' },
    text: { type: 'string' },
    shapes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          name: { type: 'string' },
          shape_type: { type: 'string' },
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          rotation: { type: 'number' },
          text: { type: 'string' },
          font_name: { type: 'string' },
          font_size: { type: 'number' },
        },
      },
    },
  },
  required: ['shape_count', 'shapes'],
};

server.registerResource(
  'Open presentation', URI_PRESENTATION,
  {
    description: 'The open PowerPoint presentation: name, path, slide count, current slide + its title, unsaved-changes flag, and live slide-show state (running, position, elapsed seconds). Bind a key or dial to this to show deck position on the hardware.',
    mimeType: 'application/json',
    _meta: { 'io.streamdeck/resourceSchema': PRESENTATION_SCHEMA },
  },
  async (uri) => {
    // A resource read must always yield a snapshot: a face can do nothing with an
    // exception, and "PowerPoint closed" / "no deck open" are normal states.
    let s = presentationState;
    if (!s) {
      try { s = (await isRunning()) ? await readPresentation() : { ...EMPTY_PRESENTATION }; }
      catch { s = { ...EMPTY_PRESENTATION }; }
      presentationState = s;
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s) }] };
  },
);

server.registerResource(
  'Live selection', URI_SELECTION,
  {
    description: 'What is selected right now in PowerPoint: selection kind, slide index, and for each selected shape its name, type, position, size, rotation, text and font. This is the thing a file-based tool cannot see. Bind a face to it to react to the user\'s selection.',
    mimeType: 'application/json',
    _meta: { 'io.streamdeck/resourceSchema': SELECTION_SCHEMA },
  },
  async (uri) => {
    let s = selectionState;
    if (!s) {
      try { s = (await isRunning()) ? await readSelection() : { ...EMPTY_SELECTION }; }
      catch { s = { ...EMPTY_SELECTION }; }
      selectionState = s;
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s) }] };
  },
);

// ── Surfaces (io.streamdeck/surfaces) ────────────────────────────────────────
// Key: deck position + press advances (or starts the show). Dial: scrub slides.
// Popup: selection inspector + one-click restyle. Each view's JSX lives in a
// sibling .view.jsx, read at request time.

function readViewFile(name) {
  try { return readFileSync(join(HERE, name), 'utf8'); }
  catch { return `function Face(){ return null; } /* missing view: ${name} */`; }
}

const UI_VIEWS = {
  [URI_UI_KEY]: {
    name: 'PowerPoint presenter key',
    description: 'Key: shows slide position and show state; press advances the show (or starts it), long-press exits.',
    file: 'key.view.jsx',
    meta: { key: { resourceUri: URI_UI_KEY, mode: 'persistent', bind: URI_PRESENTATION, handles: ['press'] } },
  },
  [URI_UI_DIAL]: {
    name: 'PowerPoint slide dial',
    description: 'Dial: rotate to scrub through slides, press to start or advance the show.',
    file: 'dial.view.jsx',
    meta: { encoder: { resourceUri: URI_UI_DIAL, mode: 'persistent', bind: URI_PRESENTATION, handles: ['rotate', 'dialPress', 'touchTap'] } },
  },
  [URI_UI_POPUP]: {
    name: 'PowerPoint selection inspector',
    description: 'Popup: inspect the live selection (shapes, geometry, fonts) and restyle it — font, size, colors, alignment — in one click.',
    file: 'popup.view.jsx',
    meta: { popup: { resourceUri: URI_UI_POPUP, mode: 'on-demand', bind: URI_SELECTION } },
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
const LIVE_URIS = new Set([URI_PRESENTATION, URI_SELECTION]);

server.server.setRequestHandler('resources/subscribe', async (req) => {
  const uri = req.params?.uri;
  if (uri && LIVE_URIS.has(uri)) {
    subscribed.add(uri);
    startPolling();
  }
  return {};
});

server.server.setRequestHandler('resources/unsubscribe', async (req) => {
  const uri = req.params?.uri;
  if (uri) {
    subscribed.delete(uri);
    if (subscribed.size === 0) stopPolling();
  }
  return {};
});

const icon = (name) => [{ src: `https://api.iconify.design/mdi/${name}.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }];

// =============================================================================
// READ-ONLY TOOLS
// =============================================================================

server.registerTool('get_presentation_info', {
  icons: icon('information-outline'),
  description: 'Get the open presentation: name, file path, slide count, which slide the editor is on (and its title), whether there are unsaved changes, and live slide-show state. Cheap — safe to call on a face refresh.',
  inputSchema: {},
  outputSchema: {
    name: z.string().nullable(),
    path: z.string().nullable(),
    slide_count: z.number(),
    current_slide: z.number(),
    saved: z.boolean(),
    slideshow_running: z.boolean(),
    slideshow_position: z.number(),
    slideshow_elapsed: z.number(),
    current_slide_title: z.string().nullable(),
  },
}, async () => {
  const p = await readPresentation();
  setPresentationState(p);
  return ok(p, `${p.name ?? 'Untitled'} — slide ${p.current_slide}/${p.slide_count}${p.saved ? '' : ' (unsaved changes)'}${p.slideshow_running ? ' — show running' : ''}.`);
});

server.registerTool('list_slides', {
  icons: icon('view-list-outline'),
  description: 'List every slide with its index, title (the text of its first text-bearing shape), shape count and layout. Use this to find the slide you want before navigating or editing.',
  inputSchema: {
    limit: z.number().int().default(200).describe('Max slides to return (default 200).'),
  },
  outputSchema: {
    count: z.number(),
    slides: z.array(z.object({
      index: z.number(),
      title: z.string().nullable(),
      shape_count: z.number(),
      layout: z.string().nullable(),
    })),
  },
}, async ({ limit }) => {
  const cap = Math.max(1, Math.min(500, limit));
  const out = await osa(ppt(`
set buf to ""
set total to count of slides of pres
if total > ${cap} then set total to ${cap}
repeat with i from 1 to total
  set sld to slide i of pres
  set buf to buf & (i as text) & "${US}" & my titleOf(sld) & "${US}" & ((count of shapes of sld) as text) & "${US}" & my orNull(layout of sld) & "${RS}"
end repeat
return buf
`), 45000, { helpers: SLIDE_TITLE });
  const slides = asRecords(out).map(([index, title, shapes, layout]) => ({
    index: Number(index), title: nullable(title), shape_count: Number(shapes || 0), layout: nullable(layout),
  }));
  return ok({ count: slides.length, slides }, `${slides.length} slide(s).`);
});

server.registerTool('get_slide', {
  icons: icon('card-text-outline'),
  description: 'Get one slide in detail — every shape with its name, type, position, size, rotation, visibility and text. Omit slide_index to inspect the slide the editor is currently on.',
  inputSchema: {
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
  },
  outputSchema: {
    slide_index: z.number(),
    title: z.string().nullable(),
    layout: z.string().nullable(),
    shape_count: z.number(),
    shapes: z.array(z.object({
      index: z.number(),
      name: z.string().nullable(),
      shape_type: z.string().nullable(),
      left: z.number().nullable(),
      top: z.number().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      rotation: z.number().nullable(),
      visible: z.boolean(),
      text: z.string().nullable(),
    })),
  },
}, async ({ slide_index }) => {
  const target = slide_index != null
    ? `set idx to ${Math.max(1, slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';
  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
set sld to slide idx of pres
set buf to (idx as text) & "${US}" & my titleOf(sld) & "${US}" & my orNull(layout of sld) & "${RS}"
repeat with i from 1 to (count of shapes of sld)
  set shp to shape i of sld
  set shpText to ""
  try
    if has text frame of shp then set shpText to content of text range of text frame of shp
  end try
  set buf to buf & (i as text) & "${US}" & my orNull(name of shp) & "${US}" & my orNull(auto shape type of shp) & "${US}" & my orNull(left position of shp) & "${US}" & my orNull(top of shp) & "${US}" & my orNull(width of shp) & "${US}" & my orNull(height of shp) & "${US}" & my orNull(rotation of shp) & "${US}" & my orNull(visible of shp) & "${US}" & shpText & "${RS}"
end repeat
return buf
`), 30000, { helpers: SLIDE_TITLE });
  const rows = asRecords(out);
  const [idx, title, layout] = rows[0] ?? ['0', '', ''];
  const shapes = rows.slice(1).map((r) => ({
    index: Number(r[0]), name: nullable(r[1]), shape_type: nullable(r[2]),
    left: round1(asNum(r[3])), top: round1(asNum(r[4])), width: round1(asNum(r[5])), height: round1(asNum(r[6])),
    rotation: round1(asNum(r[7])), visible: asBool(r[8]), text: nullable(r[9]),
  }));
  return ok(
    { slide_index: Number(idx), title: nullable(title), layout: nullable(layout), shape_count: shapes.length, shapes },
    `Slide ${idx}${title ? ` — ${title}` : ''}: ${shapes.length} shape(s).`,
  );
});

server.registerTool('get_selection', {
  icons: icon('select-drag'),
  description: 'Get what the user has selected RIGHT NOW in PowerPoint — selection kind, slide, and each selected shape\'s name, type, geometry, text and font. This is the live-app capability a file-based library cannot offer; use it to make a button act on whatever the user is pointing at.',
  inputSchema: {},
  outputSchema: {
    kind: z.string().nullable(),
    slide_index: z.number(),
    shape_count: z.number(),
    text: z.string().nullable(),
    shapes: z.array(z.object({
      index: z.number(),
      name: z.string().nullable(),
      shape_type: z.string().nullable(),
      left: z.number().nullable(),
      top: z.number().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      rotation: z.number().nullable(),
      text: z.string().nullable(),
      font_name: z.string().nullable(),
      font_size: z.number().nullable(),
    })),
  },
}, async () => {
  const s = await readSelection();
  setSelectionState(s);
  return ok(s, s.shape_count
    ? `${s.shape_count} shape(s) selected on slide ${s.slide_index}.`
    : s.text ? `Text selected on slide ${s.slide_index}.` : 'Nothing selected.');
});

// =============================================================================
// STYLING THE SELECTION
// =============================================================================

server.registerTool('set_selection_font', {
  icons: icon('format-font'),
  description: 'Set font properties on the current selection — family, size, bold, italic, underline, color. Works on selected shapes (all their text) or on a selected text range. Omitted properties are left alone.',
  inputSchema: {
    font_name: z.string().optional().describe('Font family, e.g. "Avenir Next", "Helvetica Neue".'),
    font_size: z.number().optional().describe('Size in points.'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    color: z.string().optional().describe('Text color as hex ("#FF0000", "#f00") or a name ("red").'),
  },
  outputSchema: { shapes_changed: z.number(), applied: z.array(z.string()) },
}, async (args) => {
  const cmds = [];
  const applied = [];
  if (args.font_name != null) { cmds.push(`set font name of theFont to ${q(args.font_name)}`); applied.push(`font ${args.font_name}`); }
  if (args.font_size != null) { cmds.push(`set font size of theFont to ${Number(args.font_size)}`); applied.push(`${args.font_size}pt`); }
  if (args.bold != null) { cmds.push(`set bold of theFont to ${args.bold}`); applied.push(args.bold ? 'bold' : 'not bold'); }
  if (args.italic != null) { cmds.push(`set italic of theFont to ${args.italic}`); applied.push(args.italic ? 'italic' : 'not italic'); }
  if (args.underline != null) { cmds.push(`set underline of theFont to ${args.underline}`); applied.push(args.underline ? 'underline' : 'no underline'); }
  if (args.color != null) { cmds.push(`set font color of theFont to ${rgb(args.color)}`); applied.push(args.color); }
  if (!cmds.length) throw new Error('Specify at least one font property to change.');
  const body = cmds.join('\n      ');

  // Two paths: a selected TEXT RANGE (style just that run) or selected SHAPES
  // (style all their text). Text range wins when present, matching what the user
  // sees highlighted.
  const out = await osa(ppt(`
set sel to selection of document window 1
set n to 0
set didText to false
try
  set tr to text range of sel
  if (text length of tr) > 0 then
    set theFont to font of tr
      ${body}
    set didText to true
    set n to 1
  end if
end try
if didText is false then
${forEachSelectedShape(`      set theFont to font of text range of text frame of shp
      ${body}`)}
end if
return (n as text) & "${US}" & (didText as text)
`, { needPresentation: false }), 25000);
  const [n, didText] = out.split(US);
  const count = Number(n || 0);
  if (!count) throw new Error('Nothing selected. Select one or more shapes, or some text, in PowerPoint first.');
  return ok({ shapes_changed: count, applied },
    `Applied ${applied.join(', ')} to ${didText === 'true' ? 'the selected text' : `${count} shape(s)`}.`);
});

server.registerTool('style_selection', {
  icons: icon('format-paint'),
  description: 'Style the selected shapes — fill color, border color, border weight, and fill/border visibility. Note: setting a border color or weight also forces the dash style solid, because PowerPoint otherwise leaves the border invisible.',
  inputSchema: {
    fill_color: z.string().optional().describe('Fill color as hex or name. Also makes the fill visible.'),
    line_color: z.string().optional().describe('Border color as hex or name.'),
    line_weight: z.number().optional().describe('Border thickness in points.'),
    fill_visible: z.boolean().optional().describe('Show or hide the fill.'),
    line_visible: z.boolean().optional().describe('Show or hide the border.'),
    transparency: z.number().min(0).max(1).optional().describe('Fill transparency, 0 (opaque) to 1 (invisible).'),
  },
  outputSchema: { shapes_changed: z.number(), applied: z.array(z.string()) },
}, async (args) => {
  const cmds = [];
  const applied = [];
  if (args.fill_color != null) {
    // Make the fill visible too — setting a color on a hidden fill looks broken.
    cmds.push(`try
        set visible of fill format of shp to true
      end try`);
    cmds.push(`set fore color of fill format of shp to ${rgb(args.fill_color)}`);
    applied.push(`fill ${args.fill_color}`);
  }
  // Quirk 3: a line color/weight is inert until the dash style is solid.
  if (args.line_color != null || args.line_weight != null) {
    cmds.push('set dash style of line format of shp to line dash style solid');
  }
  if (args.line_color != null) {
    cmds.push(`set fore color of line format of shp to ${rgb(args.line_color)}`);
    applied.push(`border ${args.line_color}`);
    if (args.line_weight == null) cmds.push('set line weight of line format of shp to 1.5');
  }
  if (args.line_weight != null) { cmds.push(`set line weight of line format of shp to ${Number(args.line_weight)}`); applied.push(`border ${args.line_weight}pt`); }
  if (args.transparency != null) { cmds.push(`set transparency of fill format of shp to ${Number(args.transparency)}`); applied.push(`${Math.round(args.transparency * 100)}% transparent`); }
  // Quirk 4: `visible` can throw on pictures/placeholders — guard each.
  if (args.fill_visible != null) {
    cmds.push(`try
        set visible of fill format of shp to ${args.fill_visible}
      end try`);
    applied.push(args.fill_visible ? 'fill on' : 'fill off');
  }
  if (args.line_visible != null) {
    cmds.push(`try
        set visible of line format of shp to ${args.line_visible}
      end try`);
    applied.push(args.line_visible ? 'border on' : 'border off');
  }
  if (!cmds.length) throw new Error('Specify at least one style property to change.');

  const out = await osa(ppt(forEachSelectedShape(`      ${cmds.join('\n      ')}`) + '\nreturn n as text', { needPresentation: false }), 25000);
  const count = Number(out || 0);
  if (!count) throw new Error('No shapes selected. Select one or more shapes in PowerPoint first.');
  return ok({ shapes_changed: count, applied }, `Applied ${applied.join(', ')} to ${count} shape(s).`);
});

server.registerTool('set_selection_text', {
  icons: icon('format-text'),
  description: 'Replace the text of the selected shape(s). Every selected shape that can hold text gets the same string — handy for a button that stamps a standard label.',
  inputSchema: {
    text: z.string().describe('The replacement text. Use \\n for line breaks.'),
  },
  outputSchema: { shapes_changed: z.number() },
}, async ({ text }) => {
  const out = await osa(ppt(forEachSelectedShape(`      try
        if has text frame of shp then set content of text range of text frame of shp to ${q(text)}
      end try`) + '\nreturn n as text', { needPresentation: false }), 25000);
  const count = Number(out || 0);
  if (!count) throw new Error('No shapes selected. Select one or more shapes in PowerPoint first.');
  return ok({ shapes_changed: count }, `Set text on ${count} shape(s).`);
});

server.registerTool('rearrange_selection', {
  icons: icon('align-horizontal-left'),
  description: 'Align, distribute or stack the selected shapes: align their left/right/top/bottom edges or centers, space them evenly, or lay them out in a row or column. Needs at least two shapes selected (three for distribute).',
  inputSchema: {
    mode: z.enum([
      'align_left', 'align_right', 'align_top', 'align_bottom',
      'align_center_h', 'align_center_v',
      'distribute_h', 'distribute_v',
      'row', 'column',
    ]).describe('align_*: line edges/centers up. distribute_*: equalize gaps. row/column: lay out sequentially.'),
    gap: z.number().default(12).describe('Gap in points, used by row and column (default 12).'),
  },
  outputSchema: { shapes_changed: z.number(), mode: z.string() },
}, async ({ mode, gap }) => {
  // Read geometry first, compute in JS, then write back. Doing the arithmetic in
  // AppleScript would be unreadable, and the read is cheap.
  const sel = await readSelection();
  const shapes = sel.shapes;
  const need = mode.startsWith('distribute') ? 3 : 2;
  if (shapes.length < need) {
    throw new Error(`Select at least ${need} shapes to ${mode.replace('_', ' ')} (currently ${shapes.length}).`);
  }

  const byLeft = [...shapes].sort((a, b) => a.left - b.left);
  const byTop = [...shapes].sort((a, b) => a.top - b.top);
  const targets = new Map(); // index -> {left?, top?}
  const set = (s, patch) => targets.set(s.index, { ...(targets.get(s.index) ?? {}), ...patch });

  const minLeft = Math.min(...shapes.map((s) => s.left));
  const maxRight = Math.max(...shapes.map((s) => s.left + s.width));
  const minTop = Math.min(...shapes.map((s) => s.top));
  const maxBottom = Math.max(...shapes.map((s) => s.top + s.height));

  if (mode === 'align_left') shapes.forEach((s) => set(s, { left: minLeft }));
  else if (mode === 'align_right') shapes.forEach((s) => set(s, { left: maxRight - s.width }));
  else if (mode === 'align_top') shapes.forEach((s) => set(s, { top: minTop }));
  else if (mode === 'align_bottom') shapes.forEach((s) => set(s, { top: maxBottom - s.height }));
  else if (mode === 'align_center_h') {
    const cx = (minLeft + maxRight) / 2;
    shapes.forEach((s) => set(s, { left: cx - s.width / 2 }));
  } else if (mode === 'align_center_v') {
    const cy = (minTop + maxBottom) / 2;
    shapes.forEach((s) => set(s, { top: cy - s.height / 2 }));
  } else if (mode === 'distribute_h') {
    // Hold the outermost two still and spread the rest so the gaps match.
    const total = maxRight - minLeft;
    const used = byLeft.reduce((a, s) => a + s.width, 0);
    const g = (total - used) / (byLeft.length - 1);
    let x = minLeft;
    byLeft.forEach((s) => { set(s, { left: x }); x += s.width + g; });
  } else if (mode === 'distribute_v') {
    const total = maxBottom - minTop;
    const used = byTop.reduce((a, s) => a + s.height, 0);
    const g = (total - used) / (byTop.length - 1);
    let y = minTop;
    byTop.forEach((s) => { set(s, { top: y }); y += s.height + g; });
  } else if (mode === 'row') {
    let x = minLeft;
    byLeft.forEach((s) => { set(s, { left: x, top: minTop }); x += s.width + gap; });
  } else if (mode === 'column') {
    let y = minTop;
    byTop.forEach((s) => { set(s, { left: minLeft, top: y }); y += s.height + gap; });
  }

  const writes = [...targets.entries()].map(([idx, t]) => {
    const parts = [];
    if (t.left != null) parts.push(`set left position of shape ${idx} of selRange to ${Math.round(t.left * 100) / 100}`);
    if (t.top != null) parts.push(`set top of shape ${idx} of selRange to ${Math.round(t.top * 100) / 100}`);
    return parts.join('\n  ');
  }).join('\n  ');

  await osa(ppt(`
set sel to selection of document window 1
set selRange to shape range of sel
  ${writes}
return "ok"
`, { needPresentation: false }), 25000);

  try { setSelectionState(await readSelection()); } catch { /* best effort */ }
  return ok({ shapes_changed: targets.size, mode }, `${mode.replace(/_/g, ' ')} applied to ${targets.size} shape(s).`);
});

// =============================================================================
// SLIDES
// =============================================================================

server.registerTool('create_slide', {
  icons: icon('plus-box-outline'),
  description: 'Create a new slide. By default it goes after the current slide; pass position to place it elsewhere. Returns the new slide index.',
  inputSchema: {
    position: z.number().int().optional().describe('1-based index for the new slide. Defaults to just after the current slide.'),
    layout: z.enum(['title', 'title_body', 'blank', 'title_only', 'two_column'])
      .default('blank').describe('Slide layout (default blank).'),
  },
  outputSchema: { slide_index: z.number(), slide_count: z.number() },
}, async ({ position, layout }) => {
  // Enumerator names come from the sdef's EPPSlideLayout; "slide layout text" does
  // not exist (it's "text slide"), and a wrong enumerator is a COMPILE error, so
  // these are copied verbatim rather than guessed.
  const LAYOUTS = {
    title: 'slide layout title slide',
    title_body: 'slide layout text slide',
    blank: 'slide layout blank',
    title_only: 'slide layout title only',
    two_column: 'slide layout two column text',
  };
  // An empty deck (a freshly made presentation has NO slides) has no current
  // slide, so fall back to position 1 rather than reading the view.
  const pos = position != null
    ? `set pos to ${Math.max(1, position)}`
    : `set pos to 1
try
  set pos to (slide index of (slide of view of document window 1)) + 1
end try`;
  const out = await osa(ppt(`
${pos}
set total to count of slides of pres
if pos > total + 1 then set pos to total + 1
if pos < 1 then set pos to 1
-- Quirk 13: the insertion location must be the PRESENTATION, not its slides
-- element — \`make new slide at end of slides of pres\` fails with
-- "Can't make class slide", while \`at end of pres\` works.
set newSlide to make new slide at end of pres with properties {layout:${LAYOUTS[layout]}}
if pos <= total then
  if pos = 1 then
    move newSlide to beginning of pres
  else
    move newSlide to after slide (pos - 1) of pres
  end if
end if
set finalIdx to slide index of newSlide
try
  set slide of view of document window 1 to newSlide
end try
return (finalIdx as text) & "${US}" & ((count of slides of pres) as text)
`), 25000);
  const [idx, total] = out.split(US);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ slide_index: Number(idx), slide_count: Number(total) }, `Created slide ${idx} of ${total}.`);
});

server.registerTool('delete_slide', {
  icons: icon('delete-outline'),
  description: 'Delete a slide by index. Omit slide_index to delete the slide the editor is currently on. This is not undoable through this pack — PowerPoint\'s own Undo still works.',
  inputSchema: {
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
  },
  outputSchema: { deleted: z.number(), slide_count: z.number() },
}, async ({ slide_index }) => {
  const target = slide_index != null
    ? `set idx to ${Math.max(1, slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';
  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if total <= 1 then error "Cannot delete the only slide in the presentation."
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
delete slide idx of pres
return (idx as text) & "${US}" & ((count of slides of pres) as text)
`), 25000);
  const [idx, total] = out.split(US);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ deleted: Number(idx), slide_count: Number(total) }, `Deleted slide ${idx}; ${total} remain.`);
});

server.registerTool('duplicate_slide', {
  icons: icon('content-duplicate'),
  description: 'Duplicate a slide, placing the copy right after the original. Omit slide_index to duplicate the current slide. Useful as a one-press "give me another one like this".',
  inputSchema: {
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
  },
  outputSchema: { source: z.number(), slide_index: z.number(), slide_count: z.number() },
}, async ({ slide_index }) => {
  const target = slide_index != null
    ? `set idx to ${Math.max(1, slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';
  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
-- Quirk 14: the standard \`duplicate\` command does NOT work on a slide (both
-- \`duplicate slide N of pres\` and \`… to end of pres\` raise a Parameter error).
-- PowerPoint's own \`copy object\` / \`paste object\` pair does, and pastes at the
-- END of the deck — so the copy is then moved in next to its original.
copy object slide idx of pres
paste object pres
set newIdx to count of slides of pres
if idx < newIdx - 1 then
  move slide newIdx of pres to after slide idx of pres
  set newIdx to idx + 1
end if
try
  set slide of view of document window 1 to slide newIdx of pres
end try
return (idx as text) & "${US}" & (newIdx as text) & "${US}" & ((count of slides of pres) as text)
`), 25000);
  const [src, idx, total] = out.split(US);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ source: Number(src), slide_index: Number(idx), slide_count: Number(total) },
    `Duplicated slide ${src} → ${idx} (${total} total).`);
});

server.registerTool('move_slide', {
  icons: icon('swap-vertical'),
  description: 'Move a slide to a different position in the deck.',
  inputSchema: {
    from: z.number().int().describe('1-based index of the slide to move.'),
    to: z.number().int().describe('1-based index it should end up at.'),
  },
  outputSchema: { from: z.number(), to: z.number() },
}, async ({ from, to }) => {
  await osa(ppt(`
set total to count of slides of pres
if ${from} > total or ${from} < 1 then error "Source index out of range (1-" & total & ")."
if ${to} > total or ${to} < 1 then error "Target index out of range (1-" & total & ")."
set sld to slide ${from} of pres
if ${to} = 1 then
  move sld to beginning of (get slides of pres)
else
  move sld to after slide ${to} of pres
end if
return "ok"
`), 25000);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ from, to }, `Moved slide ${from} to position ${to}.`);
});

// =============================================================================
// SHAPES
// =============================================================================

server.registerTool('add_text_box', {
  icons: icon('format-text-variant-outline'),
  description: 'Add a text box to a slide. Borderless and unfilled by default so it reads as plain text. Omit slide_index to add it to the current slide.',
  inputSchema: {
    text: z.string().describe('The text content. Use \\n for line breaks.'),
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
    left: z.number().default(100).describe('X position in points from the left edge.'),
    top: z.number().default(100).describe('Y position in points from the top edge.'),
    width: z.number().default(300),
    height: z.number().default(60),
    font_size: z.number().optional(),
    font_name: z.string().optional(),
    color: z.string().optional().describe('Text color as hex or name.'),
    bold: z.boolean().optional(),
  },
  outputSchema: { slide_index: z.number(), shape_index: z.number(), shape_name: z.string().nullable() },
}, async (a) => {
  const extra = [];
  if (a.font_size != null) extra.push(`set font size of theFont to ${Number(a.font_size)}`);
  if (a.font_name != null) extra.push(`set font name of theFont to ${q(a.font_name)}`);
  if (a.color != null) extra.push(`set font color of theFont to ${rgb(a.color)}`);
  if (a.bold != null) extra.push(`set bold of theFont to ${a.bold}`);

  const target = a.slide_index != null
    ? `set idx to ${Math.max(1, a.slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';

  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
tell slide idx of pres
  set newBox to make new shape at end with properties {auto shape type:autoshape rectangle, left position:${Number(a.left)}, top:${Number(a.top)}, width:${Number(a.width)}, height:${Number(a.height)}}
  set content of text range of text frame of newBox to ${q(a.text)}
  -- A text box should read as text, not as a filled rectangle.
  try
    set visible of line format of newBox to false
  end try
  try
    set visible of fill format of newBox to false
  end try
  set theFont to font of text range of text frame of newBox
  ${extra.join('\n  ')}
  return (idx as text) & "${US}" & ((count of shapes) as text) & "${US}" & my orNull(name of newBox)
end tell
`), 25000);
  const [idx, shapeIdx, name] = out.split(US);
  return ok({ slide_index: Number(idx), shape_index: Number(shapeIdx), shape_name: nullable(name) },
    `Added a text box to slide ${idx}.`);
});

server.registerTool('add_shape', {
  icons: icon('shape-outline'),
  description: 'Add a shape to a slide — rectangle, rounded rectangle, oval, triangle, diamond, arrow, star, or a callout — with optional fill, border and text. Omit slide_index to add it to the current slide.',
  inputSchema: {
    shape: z.enum([
      'rectangle', 'rounded_rectangle', 'oval', 'triangle', 'right_triangle', 'diamond',
      'pentagon', 'hexagon', 'star', 'arrow_right', 'arrow_left', 'arrow_up', 'arrow_down',
      'chevron', 'callout', 'line_callout',
    ]).default('rectangle'),
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
    left: z.number().default(100),
    top: z.number().default(100),
    width: z.number().default(200),
    height: z.number().default(100),
    fill_color: z.string().optional().describe('Fill color as hex or name.'),
    line_color: z.string().optional().describe('Border color as hex or name.'),
    text: z.string().optional().describe('Text to place inside the shape.'),
    font_size: z.number().optional(),
  },
  outputSchema: { slide_index: z.number(), shape_index: z.number(), shape_name: z.string().nullable() },
}, async (a) => {
  const SHAPES = {
    rectangle: 'autoshape rectangle',
    rounded_rectangle: 'autoshape rounded rectangle',
    oval: 'autoshape oval',
    triangle: 'autoshape isosceles triangle',
    right_triangle: 'autoshape right triangle',
    diamond: 'autoshape diamond',
    pentagon: 'autoshape regular pentagon',
    hexagon: 'autoshape hexagon',
    star: 'autoshape five point star',
    arrow_right: 'autoshape right arrow',
    arrow_left: 'autoshape left arrow',
    arrow_up: 'autoshape up arrow',
    arrow_down: 'autoshape down arrow',
    chevron: 'autoshape chevron',
    callout: 'autoshape rectangular callout',
    line_callout: 'autoshape line callout two',
  };
  const cmds = [];
  if (a.fill_color != null) {
    cmds.push(`try
    set visible of fill format of newShape to true
  end try`);
    cmds.push(`set fore color of fill format of newShape to ${rgb(a.fill_color)}`);
  }
  // Quirk 3: solid dash style first, or the border stays invisible.
  if (a.line_color != null) {
    cmds.push('set dash style of line format of newShape to line dash style solid');
    cmds.push('set line weight of line format of newShape to 1.5');
    cmds.push(`set fore color of line format of newShape to ${rgb(a.line_color)}`);
  }
  if (a.text != null) cmds.push(`set content of text range of text frame of newShape to ${q(a.text)}`);
  if (a.font_size != null) cmds.push(`set font size of font of text range of text frame of newShape to ${Number(a.font_size)}`);

  const target = a.slide_index != null
    ? `set idx to ${Math.max(1, a.slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';

  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
tell slide idx of pres
  set newShape to make new shape at end with properties {auto shape type:${SHAPES[a.shape]}, left position:${Number(a.left)}, top:${Number(a.top)}, width:${Number(a.width)}, height:${Number(a.height)}}
  ${cmds.join('\n  ')}
  return (idx as text) & "${US}" & ((count of shapes) as text) & "${US}" & my orNull(name of newShape)
end tell
`), 25000);
  const [idx, shapeIdx, name] = out.split(US);
  return ok({ slide_index: Number(idx), shape_index: Number(shapeIdx), shape_name: nullable(name) },
    `Added a ${a.shape.replace(/_/g, ' ')} to slide ${idx}.`);
});

server.registerTool('delete_selection', {
  icons: icon('close-box-outline'),
  description: 'Delete the currently selected shape(s). PowerPoint\'s own Undo (Cmd-Z) still reverses this.',
  inputSchema: {},
  outputSchema: { shapes_deleted: z.number() },
}, async () => {
  // Deleting shifts the range under us, so collect references first, then delete
  // from the highest index down.
  const sel = await readSelection();
  if (!sel.shape_count) throw new Error('No shapes selected. Select one or more shapes in PowerPoint first.');
  const out = await osa(ppt(`
set sel to selection of document window 1
set selRange to shape range of sel
set n to 0
repeat with i from ${sel.shape_count} to 1 by -1
  try
    delete shape i of selRange
    set n to n + 1
  end try
end repeat
return n as text
`, { needPresentation: false }), 25000);
  return ok({ shapes_deleted: Number(out || 0) }, `Deleted ${out} shape(s).`);
});

// =============================================================================
// NAVIGATION  (editor, not slide show)
// =============================================================================

server.registerTool('navigate_to_slide', {
  icons: icon('arrow-right-bold-box-outline'),
  description: 'Move the PowerPoint editor to a slide. Accepts an absolute index, or a relative step via delta (+1 / -1) which clamps at the ends of the deck. This drives the editing view, not a running slide show — use next_slide for that.',
  inputSchema: {
    slide_index: z.number().int().optional().describe('1-based slide index to jump to.'),
    delta: z.number().int().optional().describe('Relative move, e.g. 1 for next, -1 for previous. Ignored if slide_index is given.'),
  },
  outputSchema: { slide_index: z.number(), slide_count: z.number(), title: z.string().nullable() },
}, async ({ slide_index, delta }) => {
  if (slide_index == null && delta == null) throw new Error('Provide either slide_index or delta.');
  const compute = slide_index != null
    ? `set idx to ${Math.max(1, slide_index)}`
    : `set idx to (slide index of (slide of view of document window 1)) + (${Number(delta)})`;
  const out = await osa(ppt(`
${compute}
set total to count of slides of pres
-- Clamp rather than error: a "next slide" button at the end of the deck should
-- sit still, not fail.
if idx > total then set idx to total
if idx < 1 then set idx to 1
set slide of view of document window 1 to slide idx of pres
return (idx as text) & "${US}" & (total as text) & "${US}" & my titleOf(slide idx of pres)
`), 25000, { helpers: SLIDE_TITLE });
  const [idx, total, title] = out.split(US);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ slide_index: Number(idx), slide_count: Number(total), title: nullable(title) },
    `On slide ${idx}/${total}${title ? ` — ${title}` : ''}.`);
});

server.registerTool('select_shape', {
  icons: icon('cursor-default-click-outline'),
  description: 'Select one shape so the styling tools act on it. Identify it by index or by name; omit slide_index to look on the current slide. PowerPoint\'s AppleScript cannot extend a selection, so this replaces it — to act on several shapes, use select_all_shapes, or let the user multi-select by hand and read it with get_selection.',
  inputSchema: {
    shape_index: z.number().int().optional().describe('1-based shape index on the slide.'),
    shape_name: z.string().optional().describe('Shape name, e.g. "Title 1". Used when shape_index is absent.'),
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
  },
  outputSchema: {
    slide_index: z.number(),
    shape_name: z.string().nullable(),
    shape_index: z.number().nullable(),
    selected_count: z.number(),
  },
}, async ({ shape_index, shape_name, slide_index }) => {
  if (shape_index == null && shape_name == null) {
    throw new Error('Provide either shape_index or shape_name.');
  }
  const target = slide_index != null
    ? `set idx to ${Math.max(1, slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';
  const ref = shape_index != null
    ? `shape ${Math.max(1, shape_index)} of sld`
    : `shape ${q(shape_name)} of sld`;
  const guard = shape_index != null
    ? `if ${Math.max(1, shape_index)} > (count of shapes of sld) then error "Shape index out of range (1-" & (count of shapes of sld) & ") on slide " & idx & "."`
    : `try
  set probe to ${ref}
on error
  error "No shape named ${String(shape_name).replace(/"/g, '')} on slide " & idx & "."
end try`;

  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
set sld to slide idx of pres
${guard}
set slide of view of document window 1 to sld
set tgt to ${ref}
-- Quirk 15: \`select tgt with extend\` COMPILES AND RUNS but does not extend —
-- the selection ends up holding only the last shape. And \`select {shape 1, shape
-- 3}\` is worse: it silently selects EVERY shape on the slide. There is no way to
-- select an arbitrary subset from AppleScript, so this selects exactly one.
select tgt
return (idx as text) & "${US}" & my orNull(name of tgt)
`), 25000);
  const [idx, name] = out.split(US);
  let count = 1;
  try { const s = await readSelection(); setSelectionState(s); count = s.shape_count; } catch { /* best effort */ }
  return ok(
    { slide_index: Number(idx), shape_name: nullable(name), shape_index: shape_index ?? null, selected_count: count },
    `Selected ${name || 'shape'} on slide ${idx}.`,
  );
});

server.registerTool('select_all_shapes', {
  icons: icon('select-all'),
  description: 'Select every shape on a slide — the usual setup for a one-press restyle or realign. Omit slide_index to use the current slide.',
  inputSchema: {
    slide_index: z.number().int().optional().describe('1-based slide index. Defaults to the current slide.'),
  },
  outputSchema: { slide_index: z.number(), selected_count: z.number() },
}, async ({ slide_index }) => {
  const target = slide_index != null
    ? `set idx to ${Math.max(1, slide_index)}`
    : 'set idx to slide index of (slide of view of document window 1)';
  const out = await osa(ppt(`
${target}
set total to count of slides of pres
if idx > total or idx < 1 then error "Slide index out of range (1-" & total & ")."
set sld to slide idx of pres
set slide of view of document window 1 to sld
set shapeTotal to count of shapes of sld
if shapeTotal is 0 then error "Slide " & idx & " has no shapes to select."
-- Selecting the plural element selects them all at once. Looping with
-- \`with extend\` does NOT work (quirk 15) — it leaves just the last shape.
select shapes of sld
return (idx as text) & "${US}" & (shapeTotal as text)
`), 30000);
  const [idx, n] = out.split(US);
  try { setSelectionState(await readSelection()); } catch { /* best effort */ }
  return ok({ slide_index: Number(idx), selected_count: Number(n) }, `Selected ${n} shape(s) on slide ${idx}.`);
});

// =============================================================================
// SLIDE SHOW  (the presenter remote)
// =============================================================================
// Quirk 7 (corrected after probing): `go to next slide` / `go to previous slide` /
// `go to first slide` take a SLIDE SHOW VIEW and only exist while a show runs.
// `go to slide … number N`, despite the name, takes the EDITOR's `view` — it is
// editor navigation, not an in-show jump.
//
// Quirk 16: there is therefore NO way to jump directly to a slide inside a running
// show. `slide` on a slide show view is read-only, and slide show view does not
// inherit from view. So goto_slide_in_show walks with go to next/previous slide.

const SHOW_VIEW = 'slideshow view of slide show window of pres';

// Quirk 12 again: read the position off the view's `slide`, not `current show
// position` (which counts from the start of the show RANGE).
const SHOW_POS = `slide index of (slide of ${SHOW_VIEW})`;

async function showRunning() {
  try {
    const out = await osa(ppt(`
set r to false
try
  if slide show window of pres is not missing value then set r to true
end try
return r as text
`), 10000);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

server.registerTool('start_slideshow', {
  icons: icon('play-box-outline'),
  description: 'Start the slide show. By default it begins at the slide the editor is on, so a button press picks up where you were; pass from_slide to start elsewhere, or from_start=true to begin at slide 1. If a show is already running this reports the current position instead of restarting.',
  inputSchema: {
    from_slide: z.number().int().optional().describe('1-based slide to start from.'),
    from_start: z.boolean().default(false).describe('Start at slide 1, ignoring the current position.'),
  },
  outputSchema: { started: z.boolean(), from_slide: z.number() },
}, async ({ from_slide, from_start }) => {
  if (await showRunning()) {
    const p = await readPresentation();
    return ok({ started: false, from_slide: p.slideshow_position },
      `A slide show is already running (slide ${p.slideshow_position}).`);
  }
  const pick = from_start
    ? 'set startIdx to 1'
    : from_slide != null
      ? `set startIdx to ${Math.max(1, from_slide)}`
      : `set startIdx to 1
try
  set startIdx to slide index of (slide of view of document window 1)
end try`;
  const out = await osa(ppt(`
${pick}
set total to count of slides of pres
if total is 0 then error "The presentation has no slides to show."
if startIdx > total then set startIdx to total
if startIdx < 1 then set startIdx to 1
set sss to slide show settings of pres
-- \`starting slide\` is only honored for a custom range; with
-- \`slide show range show all\` the show always opens on slide 1. Setting the
-- range is what makes "start where I am" work.
set range type of sss to slide show range
set starting slide of sss to startIdx
set ending slide of sss to total
run slide show sss
return startIdx as text
`), 30000);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ started: true, from_slide: Number(out || 1) }, `Slide show started at slide ${out}.`);
});

server.registerTool('exit_slideshow', {
  icons: icon('stop-circle-outline'),
  description: 'Exit the running slide show and return to the editor. Reports exited=false rather than failing if no show is running, so a button can call it unconditionally.',
  inputSchema: {},
  outputSchema: { exited: z.boolean() },
}, async () => {
  if (!(await showRunning())) return ok({ exited: false }, 'No slide show is running.');
  await osa(ppt(`exit slide show ${SHOW_VIEW}\nreturn "ok"`), 20000);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ exited: true }, 'Slide show exited.');
});

server.registerTool('next_slide', {
  icons: icon('skip-next-outline'),
  description: 'Advance the running slide show to the next slide. If no show is running, advances the EDITOR to the next slide instead — so one button works in both modes. Clamps at the end of the deck.',
  inputSchema: {},
  outputSchema: { position: z.number(), mode: z.string() },
}, async () => {
  if (await showRunning()) {
    const out = await osa(ppt(`
go to next slide ${SHOW_VIEW}
return (${SHOW_POS}) as text
`), 20000);
    try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
    return ok({ position: Number(out || 0), mode: 'slideshow' }, `Advanced to slide ${out}.`);
  }
  const out = await osa(ppt(`
set idx to (slide index of (slide of view of document window 1)) + 1
set total to count of slides of pres
if idx > total then set idx to total
set slide of view of document window 1 to slide idx of pres
return idx as text
`), 20000);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ position: Number(out || 0), mode: 'editor' }, `Editor moved to slide ${out}.`);
});

server.registerTool('previous_slide', {
  icons: icon('skip-previous-outline'),
  description: 'Step the running slide show back one slide. If no show is running, moves the EDITOR back instead. Clamps at slide 1.',
  inputSchema: {},
  outputSchema: { position: z.number(), mode: z.string() },
}, async () => {
  if (await showRunning()) {
    const out = await osa(ppt(`
go to previous slide ${SHOW_VIEW}
return (${SHOW_POS}) as text
`), 20000);
    try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
    return ok({ position: Number(out || 0), mode: 'slideshow' }, `Back to slide ${out}.`);
  }
  const out = await osa(ppt(`
set idx to (slide index of (slide of view of document window 1)) - 1
if idx < 1 then set idx to 1
set slide of view of document window 1 to slide idx of pres
return idx as text
`), 20000);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ position: Number(out || 0), mode: 'editor' }, `Editor moved to slide ${out}.`);
});

server.registerTool('goto_slide_in_show', {
  icons: icon('debug-step-over'),
  description: 'Move the running slide show to a specific slide. PowerPoint offers no direct jump inside a show, so this steps slide-by-slide (animations are skipped, but a long jump takes a moment). Errors if no show is running — use navigate_to_slide for the editor.',
  inputSchema: {
    slide_index: z.number().int().describe('1-based slide to move to.'),
  },
  outputSchema: { position: z.number(), steps: z.number() },
}, async ({ slide_index }) => {
  if (!(await showRunning())) {
    throw new Error('No slide show is running. Use start_slideshow, or navigate_to_slide to move the editor.');
  }
  // Quirk 16: stepped, not jumped. The loop is bounded by the deck size and bails
  // the moment the position stops changing, so a show parked at the last slide
  // can't spin forever.
  const out = await osa(ppt(`
set total to count of slides of pres
set idx to ${Math.max(1, slide_index)}
if idx > total then set idx to total
if idx < 1 then set idx to 1
set ssv to ${SHOW_VIEW}
set steps to 0
repeat while steps < total
  set cur to slide index of (slide of ssv)
  if cur = idx then exit repeat
  if cur < idx then
    go to next slide ssv
  else
    go to previous slide ssv
  end if
  set steps to steps + 1
  -- If the show refuses to move (already at an end), stop rather than loop.
  if (slide index of (slide of ssv)) = cur then exit repeat
end repeat
return ((slide index of (slide of ssv)) as text) & "${US}" & (steps as text)
`), 40000);
  const [pos, steps] = out.split(US);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ position: Number(pos || 0), steps: Number(steps || 0) },
    `Now on slide ${pos}${Number(steps) > 1 ? ` (${steps} steps)` : ''}.`);
});

server.registerTool('get_slideshow_state', {
  icons: icon('timer-outline'),
  description: 'Get slide-show state: whether a show is running, which deck slide it is on, and elapsed seconds for the whole show and the current slide. Cheap — this is what a presenter face polls.',
  inputSchema: {},
  outputSchema: {
    running: z.boolean(),
    position: z.number(),
    slide_count: z.number(),
    elapsed: z.number(),
    slide_elapsed: z.number(),
  },
}, async () => {
  if (!(await showRunning())) {
    const p = await readPresentation().catch(() => EMPTY_PRESENTATION);
    return ok({ running: false, position: 0, slide_count: p.slide_count, elapsed: 0, slide_elapsed: 0 },
      'No slide show is running.');
  }
  const out = await osa(ppt(`
set ssv to ${SHOW_VIEW}
return my orNull(slide index of (slide of ssv)) & "${US}" & ((count of slides of pres) as text) & "${US}" & my orNull(presentation elapsed time of ssv) & "${US}" & my orNull(slide elapsed time of ssv)
`), 15000);
  const [pos, total, elapsed, slideElapsed] = out.split(US);
  const data = {
    running: true,
    position: Number(pos || 0),
    slide_count: Number(total || 0),
    // Elapsed times are reals — they must go through asNum for the comma locale.
    elapsed: Math.round(asNum(elapsed) ?? 0),
    slide_elapsed: Math.round(asNum(slideElapsed) ?? 0),
  };
  return ok(data, `Slide ${data.position}/${data.slide_count}, ${data.elapsed}s elapsed.`);
});

// =============================================================================
// FILE
// =============================================================================

server.registerTool('save_presentation', {
  icons: icon('content-save-outline'),
  description: 'Save the open presentation. Fails clearly if it has never been saved (no file path yet) — this pack will not invent a location for it.',
  inputSchema: {},
  outputSchema: { saved: z.boolean(), path: z.string().nullable() },
}, async () => {
  const out = await osa(ppt(`
if (path of pres) is "" then error "This presentation has never been saved. Save it once in PowerPoint to give it a location."
save pres
return my orNull(path of pres) & "${US}" & my orNull(name of pres)
`), 30000);
  const [path, name] = out.split(US);
  try { setPresentationState(await readPresentation()); } catch { /* best effort */ }
  return ok({ saved: true, path: nullable(path) }, `Saved ${name}.`);
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
