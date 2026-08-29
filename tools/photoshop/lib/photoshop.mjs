/**
 * photoshop/lib/photoshop.mjs — the bridge to a running Photoshop.
 *
 * Photoshop has an AppleScript dictionary, but it's a thin shadow of what
 * scripting can actually do. The real API is ExtendScript (Adobe's ES3 dialect)
 * running *inside* Photoshop, and AppleScript's `do javascript` is the documented
 * way in from outside. So every tool here is ExtendScript; AppleScript carries
 * exactly one verb.
 *
 *   node → osascript → tell app "…" → do javascript "$.evalFile('/tmp/x.jsx')"
 *                                       └─ ExtendScript runs in-process in PS
 *
 * ── VERIFIED QUIRKS ──────────────────────────────────────────────────────────
 *
 *  1. `tell application id "com.adobe.Photoshop"` FAILS TO COMPILE when
 *     Photoshop isn't installed (-1728) — AppleScript resolves app references at
 *     compile time. So the app is addressed by an absolute path discovered at
 *     runtime (see appPath), never by a hardcoded name like
 *     "Adobe Photoshop 2025" which breaks on every yearly release.
 *
 *  2. Without an explicit `with timeout of N seconds` block, AppleScript's
 *     default ~120s Apple-event reply timeout silently caps every synchronous
 *     `do javascript`. A generative fill can exceed that, so the wrapper's
 *     timeout must always exceed the caller's budget (same trap as the xcode
 *     pack's -1712).
 *
 *  3. ExtendScript has NO `JSON` object (it's ES3). A returned object comes back
 *     via `toSource()` as `({a:1})` — valid JS, invalid JSON. Errors can't
 *     propagate as AppleScript errors either, so they're returned with an
 *     `ERROR:` stdout prefix. Both are handled in parseResult.
 *
 *  4. Concurrent `do javascript` calls into one Photoshop DO NOT compose — the
 *     app is single-threaded and a second Apple event arriving mid-script errors
 *     or interleaves state. Every call goes through a serial queue.
 *
 *  5. `activate` steals focus on every call, which makes the machine unusable
 *     while a button drives Photoshop. Apple events reach background apps fine,
 *     so we never activate (open_document is the one deliberate exception).
 *
 *  6. Ruler/type units follow the USER'S preferences, so a script passing plain
 *     numbers means px for one user and cm for another. Every script is wrapped
 *     to force px/pt and restore the originals in a `finally`.
 *
 *  7. A modal dialog blocks the Apple event until someone clicks it — fatal for
 *     an unattended button press. The wrapper forces `DialogModes.NO` and stubs
 *     alert/confirm/prompt.
 *
 * This is macOS-only as shipped. The ExtendScript half is fully
 * platform-independent — a Windows port replaces just `runScript` below with a
 * `cscript` + `CreateObject("Photoshop.Application").DoJavaScript(...)` COM
 * shim. It's deliberately not written here because it can't be tested from this
 * machine; claiming win32 in the manifest untested would be worse than omitting
 * it.
 */

import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const BUNDLE_ID = 'com.adobe.Photoshop';

// Beyond the caller's budget, so the JSX gets its full advertised time plus
// Apple-event overhead before AppleScript gives up (quirk 2).
const APPLESCRIPT_MARGIN_MS = 5000;
// Beyond the AppleScript timeout, so the clean AppleEvent timeout error fires
// first and we don't SIGKILL osascript into a dead pipe.
const KILL_GRACE_MS = 5000;

// ── Locating Photoshop ───────────────────────────────────────────────────────

let cachedAppPath;

/**
 * Absolute path of the newest installed Photoshop, or null.
 *
 * Spotlight is asked for the bundle id, which finds any release (2024, 2026,
 * Beta, non-standard install location) without a hardcoded list of names or a
 * yearly code change. Sorted descending so "2026" beats "2025"; a Beta sorts
 * after the same year's release and is only used if it's all there is.
 */
export async function appPath() {
    if (cachedAppPath !== undefined) return cachedAppPath;
    let paths = [];
    try {
        const out = await exec('mdfind', [`kMDItemCFBundleIdentifier == "${BUNDLE_ID}"`], 5000);
        paths = out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.app'));
    } catch {
        paths = [];
    }
    // Spotlight can be off or stale; fall back to the conventional locations.
    if (paths.length === 0) {
        const year = new Date().getFullYear() + 1;
        const guesses = [];
        for (let y = year; y >= year - 6; y--) {
            guesses.push(`/Applications/Adobe Photoshop ${y}/Adobe Photoshop ${y}.app`);
        }
        guesses.push('/Applications/Adobe Photoshop (Beta)/Adobe Photoshop (Beta).app');
        const { existsSync } = await import('node:fs');
        paths = guesses.filter((p) => existsSync(p));
    }
    paths.sort((a, b) => {
        const beta = (p) => (/beta/i.test(p) ? 1 : 0);
        if (beta(a) !== beta(b)) return beta(a) - beta(b);
        return b.localeCompare(a);
    });
    cachedAppPath = paths[0] ?? null;
    return cachedAppPath;
}

/** True when a Photoshop process is live. Never launches it. */
export async function isRunning() {
    const path = await appPath();
    if (!path) return false;
    try {
        // Match the bundle path we'd actually drive, not any process with
        // "Photoshop" in its name (Creative Cloud helpers, this very pack's
        // node process, an installer) — and not a *different* installed
        // version than the one appPath() resolved.
        const out = await exec('pgrep', ['-f', path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], 4000);
        return out.trim().length > 0;
    } catch {
        return false;
    }
}

/** Throw the message a button author needs, rather than a raw osascript error. */
export async function requirePhotoshop() {
    if (!(await appPath())) throw new Error('Photoshop is not installed on this Mac.');
    if (!(await isRunning())) {
        throw new Error('Photoshop is not running. Launch it first, then retry.');
    }
}

// ── Script execution ─────────────────────────────────────────────────────────

function exec(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' },
            (err, stdout, stderr) => {
                if (err) {
                    err.message = `${err.message}${stderr ? `\n${stderr}` : ''}`;
                    reject(err);
                } else resolve(stdout);
            });
    });
}

// Quirk 4: one Photoshop, one script at a time. Chaining onto a promise keeps
// the order callers issued without a queue array to reason about.
let tail = Promise.resolve();

/**
 * Run raw ExtendScript in Photoshop and return its (parsed) result.
 *
 * The script is written to a temp .jsx and evaluated via $.evalFile rather than
 * inlined into the AppleScript string: a `do javascript "…"` literal would need
 * every quote, backslash and newline of a 200-line script escaped through two
 * languages, and ExtendScript reads the file as UTF-8 when it starts with a BOM
 * (Adobe's documented signal) so non-ASCII text survives.
 */
export async function runScript(script, timeoutMs = 30000, { launch = false } = {}) {
    const run = async () => {
        const path = await appPath();
        if (!path) throw new Error('Photoshop is not installed on this Mac.');
        if (!launch) await requirePhotoshop();

        const tag = randomBytes(6).toString('hex');
        const jsx = join(tmpdir(), `sdmcp-photoshop-${tag}.jsx`);
        try {
            await writeFile(jsx, `\ufeff${wrap(script)}`, 'utf8');
            const seconds = Math.ceil((timeoutMs + APPLESCRIPT_MARGIN_MS) / 1000);
            // encodeURI + decodeURI keeps a path with a quote or a space from
            // breaking out of the nested JS-inside-AppleScript string literal.
            const as = [
                `tell application ${JSON.stringify(path)}`,
                `  with timeout of ${seconds} seconds`,
                `    do javascript "$.evalFile(decodeURI('${encodeURI(jsx)}'))"`,
                `  end timeout`,
                `end tell`,
            ].join('\n');
            const stdout = await exec('osascript', ['-e', as], timeoutMs + APPLESCRIPT_MARGIN_MS + KILL_GRACE_MS);
            return parseResult(stdout);
        } finally {
            await unlink(jsx).catch(() => {});
        }
    };
    // Serialize, but never let one caller's failure reject the next in line.
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
}

/** ERROR:-prefixed failure, or a toSource()/JSON payload (quirk 3). */
function parseResult(stdout) {
    const trimmed = String(stdout).trim();
    if (trimmed.startsWith('ERROR:')) throw new Error(trimmed.slice(6).trim());
    if (!trimmed) return trimmed;
    try {
        return JSON.parse(trimmed);
    } catch {
        // Not JSON — try the toSource() object-literal form.
    }
    const literal = /^[([{]/.test(trimmed) && /[)\]}]$/.test(trimmed);
    if (literal) {
        // eslint-disable-next-line no-new-func -- the only producer is Photoshop's
        // own toSource() on a value this pack constructed; there is no third-party
        // input path into this string.
        try {
            return new Function(`return ${trimmed}`)();
        } catch {
            if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
                try {
                    return new Function(`return ${trimmed.slice(1, -1)}`)();
                } catch { /* fall through to the raw string */ }
            }
        }
    }
    return trimmed;
}

/**
 * Wrap a snippet so it runs predictably regardless of the user's Photoshop
 * setup: pixels/points forced (quirk 6), dialogs suppressed (quirk 7), the
 * result serialized (quirk 3), and every preference restored afterwards even on
 * failure. `script` is expected to `return` a value.
 */
function wrap(script) {
    return `(function () {
  var _ru = null, _tu = null, _dlg = null, _alert = null, _confirm = null, _prompt = null;
  try { _ru = app.preferences.rulerUnits; } catch (e) {}
  try { _tu = app.preferences.typeUnits; } catch (e) {}
  try { _dlg = app.displayDialogs; } catch (e) {}
  try { app.displayDialogs = DialogModes.NO; } catch (e) {}
  if (typeof alert !== 'undefined') { _alert = alert; alert = function (m) { $.writeln('[sdmcp] ' + m); }; }
  if (typeof confirm !== 'undefined') { _confirm = confirm; confirm = function () { return true; }; }
  if (typeof prompt !== 'undefined') { _prompt = prompt; prompt = function (m, d) { return d || ''; }; }
  try {
    try { app.preferences.rulerUnits = Units.PIXELS; } catch (e) {}
    try { app.preferences.typeUnits = TypeUnits.POINTS; } catch (e) {}
    var result = (function () {
${script}
    })();
    if (typeof result === 'object' && result !== null) {
      return result.toSource ? result.toSource() : String(result);
    }
    return String(result);
  } catch (error) {
    return 'ERROR: ' + (error.message || String(error));
  } finally {
    try { if (_ru !== null) app.preferences.rulerUnits = _ru; } catch (e) {}
    try { if (_tu !== null) app.preferences.typeUnits = _tu; } catch (e) {}
    try { if (_dlg !== null) app.displayDialogs = _dlg; } catch (e) {}
    if (_alert !== null) { alert = _alert; }
    if (_confirm !== null) { confirm = _confirm; }
    if (_prompt !== null) { prompt = _prompt; }
  }
})();`;
}

// ── Version ──────────────────────────────────────────────────────────────────

let cachedVersion;

/** Photoshop's own version string, e.g. "26.3.0". Cached per process. */
export async function version() {
    if (cachedVersion !== undefined) return cachedVersion;
    const info = await runScript('return { version: app.version, name: app.name };', 15000);
    cachedVersion = info?.version ?? null;
    return cachedVersion;
}

/** Escape a JS string for embedding in an ExtendScript source literal. */
export function jsString(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        // Remaining C0 controls plus U+2028/U+2029, which ES3 treats as line
        // terminators — a raw one ends the string literal mid-script.
        .replace(/[\u0000-\u001f\u2028\u2029]/g, (c) =>
            `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
