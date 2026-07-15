#!/usr/bin/env node
/**
 * audio — a stdio MCP server for macOS audio.
 *
 * Built on the official `@modelcontextprotocol/sdk` (McpServer + the stdio
 * transport), so it's unified with the other tool packs in this repo (bash,
 * safari, clipboard, …) — same framing, same `npm install`, same registration
 * API — rather than hand-rolling JSON-RPC over stdio. It exposes the macOS audio
 * system as live MCP resources that push updates the instant anything changes,
 * plus get/set tools:
 *
 *   Resources (each pushes notifications/resources/updated on change):
 *     resource://audio/output   output volume/mute  → { level, muted }
 *     resource://audio/input    input  volume/mute  → { level, muted }
 *     resource://audio/devices  device inventory    → { output, input,
 *                               devices:[{id,uid,name,canInput,canOutput,…}] }
 *
 *   Tools (get + set for output, input, and the default device of each):
 *     get_volume / set_volume / set_muted               (output)
 *     get_input_volume / set_input_volume / set_input_muted   (input)
 *     list_devices / set_default_output_device / set_default_input_device
 *
 * Change detection + control are EVENT-DRIVEN via a tiny Swift Core Audio helper
 * (volume-listener.swift), compiled once on first use and spawned as a long-lived
 * child. It emits a tagged JSON line on every change (volume, mute, default-device
 * switch, or device (un)plug) — zero polling, zero idle cost, sub-frame latency —
 * and accepts stdin commands to set values via Core Audio directly (no osascript
 * spawn, so a slider drag tracks at full input rate). If Swift is unavailable (no
 * Xcode CLT) or the helper can't start, it falls back to polling osascript for the
 * output/input volume + mute (device switching requires the Swift helper).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Resource URIs.
const URI_OUTPUT = "resource://audio/output";
const URI_INPUT = "resource://audio/input";
const URI_DEVICES = "resource://audio/devices";

// Stream Deck surface resources (io.streamdeck/surfaces extension). These are
// ui:// MCP App resources a surface-aware host renders on hardware; a plain chat
// client ignores them. The dial + popup both bind resource://audio/output and
// drive it through the tools below.
const URI_DIAL = "ui://audio/dial";
const URI_POPUP = "ui://audio/popup";
const SURFACE_NS = "io.streamdeck/surfaces";
const APP_MIME = "text/html;profile=mcp-app";

// How many volume points one dial tick moves.
const TICK_STEP = 4;

// The SDK owns the JSON-RPC framing now; `server` is wired up at the bottom of
// the file and `notifyUpdated` pushes resource updates through it.

// ── osascript fallback (when the Swift helper is unavailable) ─────────────────

function osa(script) {
    return new Promise((resolve, reject) => {
        execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

// One `get volume settings` spawn returns every field:
//   "output volume:54, input volume:50, alert volume:100, output muted:false"
// so a poll tick (output + input) costs a single subprocess, not several.
async function readSettings() {
    const out = await osa("get volume settings");
    const oVol = /output volume:(\d+)/.exec(out);
    const oMute = /output muted:(true|false)/.exec(out);
    const iVol = /input volume:(\d+)/.exec(out);
    return {
        output: { level: oVol ? parseInt(oVol[1], 10) : 0, muted: oMute ? oMute[1] === "true" : false },
        // `get volume settings` reports no input-muted field; treat 0 as muted.
        input: { level: iVol ? parseInt(iVol[1], 10) : 0, muted: iVol ? parseInt(iVol[1], 10) === 0 : false },
    };
}

// ── Resource state ────────────────────────────────────────────────────────────

const subscribed = new Set(); // which URIs the gateway is subscribed to

// Latest values pushed by the helper (or polled). null until first read.
let outState = null;   // { level, muted }
let inState = null;    // { level, muted }
let deviceState = null; // { output, input, devices: [...] }

function makeVolSnapshot(level, muted) {
    return { level, muted, label: muted ? "Muted" : `${level}%`, at: Date.now() };
}

function resourceContents(uri, data) {
    return [{ uri, mimeType: "application/json", text: JSON.stringify(data) }];
}

/** Emit notifications/resources/updated for a URI if it's subscribed. */
function notifyUpdated(uri) {
    // The SDK only pushes to clients that subscribed at the protocol level, but
    // we also gate on our own `subscribed` set so the watcher's debounce logic
    // (and the start/stop-watching lifecycle) stays the single source of truth.
    if (subscribed.has(uri)) void server.server.sendResourceUpdated({ uri });
}

function setOutState(level, muted) {
    const sig = `${level}|${muted}`;
    if (outState && `${outState.level}|${outState.muted}` === sig) return;
    outState = makeVolSnapshot(level, muted);
    notifyUpdated(URI_OUTPUT);
}

function setInState(level, muted) {
    const sig = `${level}|${muted}`;
    if (inState && `${inState.level}|${inState.muted}` === sig) return;
    inState = makeVolSnapshot(level, muted);
    notifyUpdated(URI_INPUT);
}

function setDeviceState(next) {
    const sig = JSON.stringify(next);
    if (deviceState && JSON.stringify(deviceState) === sig) return;
    deviceState = { ...next, at: Date.now() };
    notifyUpdated(URI_DEVICES);
}

// ── Watcher: event-driven (Swift Core Audio) with a polling fallback ──────────

let watcher = null; // { write(line), stop() } once started

/** Compile the Swift listener once (cached binary next to the source) and return
 *  its path, or null if Swift is unavailable / compilation fails. */
function ensureListenerBinary() {
    return new Promise((resolve) => {
        const src = join(HERE, "volume-listener.swift");
        const bin = join(HERE, ".volume-listener");
        if (!existsSync(src)) return resolve(null);
        // Reuse a cached binary if it's newer than the source.
        try {
            if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) {
                return resolve(bin);
            }
        } catch { /* fall through to compile */ }
        execFile("swiftc", ["-O", src, "-o", bin], { timeout: 60000 }, (err) => {
            resolve(err ? null : bin);
        });
    });
}

/** Parse one tagged JSON line from the helper into our resource state. */
function ingestHelperLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    switch (msg.t) {
        case "o": setOutState(msg.level | 0, msg.muted === true); break;
        case "i": setInState(msg.level | 0, msg.muted === true); break;
        case "d": setDeviceState({ output: msg.output, input: msg.input, devices: msg.devices ?? [] }); break;
    }
}

/** Start the event-driven Swift listener. Returns a watcher, or null to fall back. */
async function startEventWatcher() {
    const bin = await ensureListenerBinary();
    if (!bin) return null;

    let child;
    try {
        child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
        return null;
    }
    if (!child.pid) return null;

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) ingestHelperLine(line);
        }
    });
    // If the helper dies for any reason, degrade so updates continue.
    child.on("exit", () => {
        if (watcher && watcher._child === child) {
            watcher = null;
            // Restart while anything is still subscribed.
            if (subscribed.size > 0) startWatching();
        }
    });
    child.unref?.();

    return {
        _child: child,
        write(line) {
            try { return child.stdin.write(line + "\n"); }
            catch { return false; }
        },
        stop() { try { child.kill(); } catch { /* already gone */ } },
    };
}

/** Polling fallback: read osascript ~3x/sec, emit only on change. Covers
 *  output/input volume + mute; device switching is unavailable without Swift. */
function startPollWatcher() {
    const timer = setInterval(async () => {
        try {
            const s = await readSettings();
            setOutState(s.output.level, s.output.muted);
            setInState(s.input.level, s.input.muted);
        } catch { /* transient osascript failure — try again next tick */ }
    }, 300);
    timer.unref?.();
    return { write: () => false, stop() { clearInterval(timer); } };
}

let helperActive = false; // true when the event-driven Swift helper is running

async function startWatching() {
    if (watcher) return;
    const event = await startEventWatcher();
    helperActive = event !== null;
    watcher = event ?? startPollWatcher();
}

/** Resolve once `deviceState` is populated, or after `timeoutMs`. The device
 *  inventory only comes from the helper, so first reads/validations may race the
 *  helper's startup line; this gives it a brief window to arrive. */
function waitForDevices(timeoutMs = 1500) {
    if (deviceState || !helperActive) return Promise.resolve();
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
            if (deviceState || Date.now() - started >= timeoutMs) {
                clearInterval(tick);
                resolve();
            }
        }, 25);
        tick.unref?.();
    });
}

function stopWatching() {
    if (watcher) { watcher.stop(); watcher = null; }
}

/** Ensure we have at least one snapshot of each kind before serving a read. With
 *  the Swift helper running, state is populated almost immediately; with the poll
 *  fallback we read osascript once so the first read isn't empty. */
async function ensurePrimed() {
    await startWatching();
    // The device inventory comes only from the helper; give its startup line a
    // brief window so device lookups/validation don't race it.
    await waitForDevices();
    if (outState && inState) return;
    // Helper hasn't emitted yet (or poll fallback): seed volumes from osascript.
    try {
        const s = await readSettings();
        if (!outState) setOutState(s.output.level, s.output.muted);
        if (!inState) setInState(s.input.level, s.input.muted);
    } catch { /* leave null; read handlers default sensibly */ }
}

// ── Volume / mute setters (coalesced for slider drags) ────────────────────────
//
// A slider drag fires many set_* calls per second. The Swift helper sets via Core
// Audio directly (sub-ms), so the per-call cost is just a stdin write. We still
// coalesce per channel so the osascript fallback (~150–200ms/spawn) tracks the
// finger instead of queuing a backlog: at most one apply per channel runs at a
// time; while it's in flight we remember only the LATEST requested value.

// Drag-coalescing state, keyed per (channel + device) so independent sliders on
// different devices don't stomp on each other's in-flight applies.
const drag = new Map(); // key → { inFlight, pending }
function dragFor(channel, device) {
    const key = `${channel}:${device ?? ""}`;
    let d = drag.get(key);
    if (!d) { d = { inFlight: false, pending: null }; drag.set(key, d); }
    return d;
}

const clampLevel = (n) => Math.max(0, Math.min(100, Math.round(n)));
const scopeTok = (channel) => (channel === "input" ? "i" : "o");

/** The latest reported state for a specific device UID on a channel, or null. */
function deviceChannelState(channel, device) {
    const dev = deviceState?.devices?.find((d) => d.uid === device);
    return dev?.[channel] ?? null; // { level, muted, settable }
}

/** A friendly label for messages: a specific device's name, or the channel. */
function deviceLabel(channel, device) {
    if (!device) return channel === "input" ? "Input" : "Output";
    const dev = deviceState?.devices?.find((d) => d.uid === device);
    return dev?.name ?? device;
}

/** Validate a device UID against the live inventory for a channel. Returns an
 *  error string to send back, or null if the device is usable. `needsSettable`
 *  requires the device to expose a settable volume on that scope (for volume
 *  sets; mute doesn't require it). */
async function validateDevice(channel, device, needsSettable) {
    await ensurePrimed();
    const dev = deviceState?.devices?.find((d) => d.uid === device);
    if (!dev) return `Unknown device UID '${device}'. Call list_devices for valid UIDs.`;
    const cap = channel === "input" ? dev.canInput : dev.canOutput;
    if (!cap) return `Device '${dev.name}' has no ${channel} capability.`;
    if (needsSettable && dev[channel]?.settable === false) {
        return `Device '${dev.name}' does not expose a settable ${channel} volume (the OS controls it elsewhere).`;
    }
    return null;
}

/** Apply one volume value to a channel/device; helper fast-path, else osascript
 *  (osascript only knows the DEFAULT device, so a specific `device` needs the
 *  helper). Returns the clamped level, or throws if a specific device can't be
 *  driven without the helper. */
async function applyVolume(channel, device, level) {
    const clamped = clampLevel(level);
    if (device) {
        // Specific device — only the Core Audio helper can target it.
        if (!watcher?.write?.(`sv ${scopeTok(channel)} ${clamped} ${device}`)) {
            throw new Error("Setting a specific device's volume requires the Core Audio helper (Xcode Command Line Tools).");
        }
        return clamped; // the helper's per-device listener pushes the new state
    }
    const cmd = channel === "input" ? `iv ${clamped}` : `ov ${clamped}`;
    if (watcher?.write?.(cmd)) {
        // Reflect optimistically; the helper's own listener confirms via state.
        if (channel === "input") setInState(clamped, inState?.muted ?? false);
        else setOutState(clamped, outState?.muted ?? false);
        return clamped;
    }
    const scope = channel === "input" ? "input volume" : "output volume";
    await osa(`set volume ${scope} ${clamped}`);
    if (channel === "input") setInState(clamped, inState?.muted ?? false);
    else setOutState(clamped, outState?.muted ?? false);
    return clamped;
}

/** Set volume on a channel. `device` (a UID) targets a specific device; omitted
 *  → the current default device (back-compat). */
async function setVolume(channel, level, device) {
    await startWatching();
    const clamped = clampLevel(level);
    const d = dragFor(channel, device);
    if (d.inFlight) { d.pending = clamped; return clamped; }
    d.inFlight = true;
    try {
        let target = clamped;
        do {
            d.pending = null;
            await applyVolume(channel, device, target);
            target = d.pending; // jump to the newest value, skipping intermediates
        } while (target !== null);
    } finally {
        d.inFlight = false;
    }
    return clamped;
}

/** Mute/unmute a channel. `device` (a UID) targets a specific device; omitted →
 *  the current default device. */
async function setMuted(channel, muted, device) {
    await startWatching();
    if (device) {
        if (!watcher?.write?.(`sm ${scopeTok(channel)} ${muted ? 1 : 0} ${device}`)) {
            throw new Error("Muting a specific device requires the Core Audio helper (Xcode Command Line Tools).");
        }
        return muted; // helper pushes the updated inventory
    }
    const cmd = channel === "input" ? `im ${muted ? 1 : 0}` : `om ${muted ? 1 : 0}`;
    if (!watcher?.write?.(cmd)) {
        // osascript fallback. Note: macOS only exposes an *output* mute toggle;
        // for input we emulate mute by setting the input volume to 0.
        if (channel === "input") {
            await osa(`set volume input volume ${muted ? 0 : 50}`);
        } else {
            await osa(`set volume ${muted ? "with" : "without"} output muted`);
        }
    }
    if (channel === "input") setInState(inState?.level ?? 0, muted);
    else setOutState(outState?.level ?? 0, muted);
    return muted;
}

/** Set the default input/output device by UID. Requires the Swift helper. */
async function setDefaultDevice(kind, uid) {
    await startWatching();
    const cmd = kind === "input" ? `id ${uid}` : `od ${uid}`;
    if (!watcher?.write?.(cmd)) {
        throw new Error("Switching the default device requires the Core Audio helper (Xcode Command Line Tools).");
    }
    // The helper re-emits the device list with the new default; nothing to do.
    return uid;
}

// ── SDK server: resources, tools, subscribe gating, transport ─────────────────

// Advertise `resources.subscribe` up front: the high-level `registerResource`
// only sets `resources.listChanged`, so the subscribe capability (and thus our
// low-level subscribe/unsubscribe handlers below) must be declared here.
const server = new McpServer(
    { name: "audio", version: "3.0.0" },
    { capabilities: { resources: { subscribe: true } } },
);

// Tool return shape helper — mirrors the SDK's expected
// { structuredContent, content:[{type:'text',text}] }.
const ok = (structured, text) => ({ structuredContent: structured, content: [{ type: "text", text }] });

// ── Resources ─────────────────────────────────────────────────────────────────
// list/read via the high-level API; subscribe/unsubscribe via low-level handlers
// (the high-level API doesn't expose them). The watcher's debounce + start/stop
// lifecycle is preserved verbatim — only the doorbell + dispatch are re-wired.

server.registerResource(
    "System Output Volume", URI_OUTPUT,
    { description: "Default output device volume (0–100) and mute state.", mimeType: "application/json" },
    async (uri) => {
        await ensurePrimed();
        return { contents: resourceContents(uri.href, outState ?? makeVolSnapshot(0, false)) };
    },
);

server.registerResource(
    "System Input Volume", URI_INPUT,
    { description: "Default input (microphone) volume (0–100) and mute state.", mimeType: "application/json" },
    async (uri) => {
        await ensurePrimed();
        return { contents: resourceContents(uri.href, inState ?? makeVolSnapshot(0, false)) };
    },
);

server.registerResource(
    "Audio Devices", URI_DEVICES,
    { description: "All audio devices and the current default input/output device.", mimeType: "application/json" },
    async (uri) => {
        await ensurePrimed();
        return { contents: resourceContents(uri.href, deviceState ?? { output: "", input: "", devices: [] }) };
    },
);

// ── Stream Deck surfaces (io.streamdeck/surfaces) ───────────────────────────
// A dial (encoder) and a popup, both bound to resource://audio/output. A
// surface-aware host renders these on hardware; a plain MCP client ignores the
// `_meta`. The face JSX is a pure function of the bound resource's data
// ({ level, muted, label }); the popup drives the tools over window.mcp.

const DIAL_JSX = `
function Face({ data }) {
  var level = (data && typeof data.level === 'number') ? data.level : 0;
  var muted = !!(data && data.muted);
  var pct = Math.max(0, Math.min(100, level));
  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 8,
      background: '#161616', color: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      <div style={{ fontSize: 20 }}>{muted ? '🔇' : pct > 50 ? '🔊' : pct > 0 ? '🔉' : '🔈'}</div>
      <div style={{ width: '78%', height: 6, borderRadius: 3, background: '#333', overflow: 'hidden' }}>
        <div style={{ width: pct + '%', height: '100%', background: muted ? '#5a5a5e' : '#3b9bff' }} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: muted ? '#8a8a8e' : '#fff' }}>
        {muted ? 'Muted' : pct + '%'}
      </div>
    </div>
  );
}
`.trim();

const POPUP_JSX = `
function Popup({ data, submitPopup }) {
  const [level, setLevel] = React.useState((data && data.level) || 0);
  const [muted, setMuted] = React.useState(!!(data && data.muted));

  // Keep in sync with live state pushed via the bound resource.
  React.useEffect(() => {
    let off = function () {};
    try {
      off = window.sd.resource.subscribe('resource://audio/output', function (s) {
        if (s && typeof s.level === 'number') setLevel(s.level);
        if (s) setMuted(!!s.muted);
      });
    } catch (e) {}
    return off;
  }, []);

  const apply = React.useCallback((next) => {
    setLevel(next);
    window.mcp.callTool('audio', 'set_volume', { level: next }).catch(function () {});
  }, []);

  const toggle = React.useCallback(() => {
    const next = !muted;
    setMuted(next);
    window.mcp.callTool('audio', 'set_muted', { muted: next }).catch(function () {});
  }, [muted]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', color: '#fff', minWidth: 260,
    }}>
      <button onClick={toggle} style={{
        border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer',
      }}>{muted ? '🔇' : '🔊'}</button>
      <input type="range" min="0" max="100" value={level} onChange={function (e) { apply(Number(e.target.value)); }}
        style={{ flex: 1 }} />
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 14, minWidth: 40, textAlign: 'right' }}>
        {muted ? 'Muted' : level + '%'}
      </span>
    </div>
  );
}
`.trim();

// One resource registration = jsx + surface _meta on BOTH the read envelope and
// the list descriptor (so a host can classify the surface from resources/list
// alone, then read the JSX on demand). Mirrors the in-app voice built-in.
function surfaceEnvelope(jsx, meta) {
    return JSON.stringify({ jsx, _meta: meta });
}

const DIAL_META = {
    [SURFACE_NS]: {
        encoder: {
            resourceUri: URI_DIAL,
            mode: "persistent",
            bind: URI_OUTPUT,
            triggers: {
                rotate:    { tool: "audio__nudge_volume" },
                dialPress: { tool: "audio__toggle_mute" },
                touchTap:  { tool: "audio__toggle_mute" },
            },
        },
    },
};
const POPUP_META = { [SURFACE_NS]: { popup: { resourceUri: URI_POPUP, mode: "on-demand" } } };

server.registerResource(
    "Volume Dial", URI_DIAL,
    { description: "A Stream Deck dial for output volume: rotate to adjust, press to mute.", mimeType: APP_MIME, _meta: DIAL_META },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: APP_MIME, text: surfaceEnvelope(DIAL_JSX, DIAL_META) }] }),
);

server.registerResource(
    "Volume Popup", URI_POPUP,
    { description: "A volume slider popup for the default output device.", mimeType: APP_MIME, _meta: POPUP_META },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: APP_MIME, text: surfaceEnvelope(POPUP_JSX, POPUP_META) }] }),
);

const RESOURCE_URIS = new Set([URI_OUTPUT, URI_INPUT, URI_DEVICES]);

// Subscribe gating: start the watcher when a resource is first subscribed, stop
// it when the last subscriber leaves. `subscribed` stays the single source of
// truth for both the start/stop lifecycle and `notifyUpdated`'s push gating.
server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (RESOURCE_URIS.has(uri)) {
        subscribed.add(uri);
        void startWatching();
    }
    return {};
});

server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri) {
        subscribed.delete(uri);
        if (subscribed.size === 0) stopWatching();
    }
    return {};
});

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool("get_volume", {
    icons: [{ src: 'https://api.iconify.design/mdi/volume-high.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "Get the macOS system output volume (0–100) and mute state.",
    inputSchema: {},
    outputSchema: { level: z.number(), muted: z.boolean() },
}, async () => {
    await ensurePrimed();
    const s = outState ?? makeVolSnapshot(0, false);
    return ok({ level: s.level, muted: s.muted }, s.muted ? "Output muted." : `Output volume ${s.level}%.`);
});

server.registerTool("get_input_volume", {
    icons: [{ src: 'https://api.iconify.design/mdi/microphone.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "Get the macOS system input (microphone) volume (0–100) and mute state.",
    inputSchema: {},
    outputSchema: { level: z.number(), muted: z.boolean() },
}, async () => {
    await ensurePrimed();
    const s = inState ?? makeVolSnapshot(0, false);
    return ok({ level: s.level, muted: s.muted }, s.muted ? "Input muted." : `Input volume ${s.level}%.`);
});

for (const name of ["set_volume", "set_input_volume"]) {
    const channel = name === "set_input_volume" ? "input" : "output";
    const dflt = channel === "input" ? "input" : "output";
    server.registerTool(name, {
        description: name === "set_input_volume"
            ? "Set input (microphone) volume (0–100). Targets the default input device, or a specific device when 'device' (a UID) is given (requires the Core Audio helper; device must expose a settable volume)."
            : "Set output volume (0–100). Targets the default output device, or a specific device when 'device' (a UID from list_devices) is given. Setting a specific device requires the Core Audio helper, and the device must expose a settable volume (see 'settable' in list_devices).",
        inputSchema: {
            level: z.number().describe("Volume 0–100."),
            device: z.string().optional().describe(`Optional device UID from list_devices; omit for the default ${dflt} device.`),
        },
        outputSchema: { level: z.number() },
    }, async (args) => {
        const level = Number(args.level);
        if (!Number.isFinite(level)) throw new Error(`${name} requires a numeric 'level'.`);
        const device = args.device ? String(args.device) : undefined;
        const bad = device && await validateDevice(channel, device, /* needsSettable */ true);
        if (bad) throw new Error(bad);
        const applied = await setVolume(channel, level, device);
        return ok({ level: applied }, `${deviceLabel(channel, device)} volume set to ${applied}%.`);
    });
}

for (const name of ["set_muted", "set_input_muted"]) {
    const channel = name === "set_input_muted" ? "input" : "output";
    const dflt = channel === "input" ? "input" : "output";
    server.registerTool(name, {
        description: name === "set_input_muted"
            ? "Mute or unmute input (microphone). Targets the default input device, or a specific device when 'device' (a UID) is given (requires the Core Audio helper)."
            : "Mute or unmute output. Targets the default output device, or a specific device when 'device' (a UID) is given (requires the Core Audio helper).",
        inputSchema: {
            muted: z.boolean().describe("True to mute, false to unmute."),
            device: z.string().optional().describe(`Optional device UID from list_devices; omit for the default ${dflt} device.`),
        },
        outputSchema: { muted: z.boolean() },
    }, async (args) => {
        const muted = args.muted === true || args.muted === "true";
        const device = args.device ? String(args.device) : undefined;
        const bad = device && await validateDevice(channel, device, /* needsSettable */ false);
        if (bad) throw new Error(bad);
        await setMuted(channel, muted, device);
        const lbl = deviceLabel(channel, device);
        return ok({ muted }, muted ? `${lbl} muted.` : `${lbl} unmuted.`);
    });
}

// ── Dial-friendly tools ─────────────────────────────────────────────────────
// A Stream Deck dial emits a signed `ticks` delta per detent, not an absolute
// level — so these translate the hardware interaction into an absolute set_volume
// / mute-flip. They are what the io.streamdeck/surfaces dial triggers point at
// (rotate → nudge_volume, dialPress → toggle_mute), and are handy on their own.

server.registerTool("nudge_volume", {
    icons: [{ src: 'https://api.iconify.design/mdi/volume-plus.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "Adjust output volume by a relative amount — for a Stream Deck dial. Applies `ticks` × step "
        + "to the current default output volume (positive = louder). Returns the new level.",
    inputSchema: {
        ticks: z.number().describe("Signed number of dial detents (e.g. +1, -3). Multiplied by a fixed step."),
        pressed: z.boolean().optional().describe("Whether the dial was held while rotating (ignored)."),
    },
    outputSchema: { level: z.number() },
}, async (args) => {
    await ensurePrimed();
    const ticks = Number(args.ticks);
    if (!Number.isFinite(ticks)) throw new Error("nudge_volume requires a numeric 'ticks'.");
    const current = (outState ?? makeVolSnapshot(0, false)).level;
    const applied = await setVolume("output", current + ticks * TICK_STEP);
    return ok({ level: applied }, `Output volume ${applied}%.`);
});

server.registerTool("toggle_mute", {
    icons: [{ src: 'https://api.iconify.design/mdi/volume-mute.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "Toggle output mute on/off — for a Stream Deck dial press or key. Flips the current default "
        + "output mute state. Returns the new mute state.",
    inputSchema: {},
    outputSchema: { muted: z.boolean() },
}, async () => {
    await ensurePrimed();
    const muted = !((outState ?? makeVolSnapshot(0, false)).muted);
    await setMuted("output", muted);
    return ok({ muted }, muted ? "Output muted." : "Output unmuted.");
});

const deviceScope = z.object({
    level: z.number(),
    muted: z.boolean(),
    settable: z.boolean().describe("Whether this device's volume can be set.").optional(),
}).optional();

server.registerTool("list_devices", {
    icons: [{ src: 'https://api.iconify.design/mdi/speaker-multiple.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "List all audio devices with each device's current volume/mute (and whether volume is settable), plus the current default input/output device (by UID).",
    inputSchema: {},
    outputSchema: {
        output: z.string().describe("UID of the current default output device."),
        input: z.string().describe("UID of the current default input device."),
        devices: z.array(z.object({
            id: z.number().optional(),
            uid: z.string(),
            name: z.string(),
            canInput: z.boolean(),
            canOutput: z.boolean(),
            output: deviceScope.describe("Output-scope volume/mute (present when canOutput)."),
            input: deviceScope.describe("Input-scope volume/mute (present when canInput)."),
        })),
    },
}, async () => {
    await ensurePrimed();
    const d = deviceState ?? { output: "", input: "", devices: [] };
    return ok(
        { output: d.output, input: d.input, devices: d.devices },
        `${d.devices.length} audio device(s).`,
    );
});

server.registerTool("set_default_output_device", {
    icons: [{ src: 'https://api.iconify.design/mdi/speaker.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "Set the default output device by UID (from list_devices). Requires the Core Audio helper.",
    inputSchema: { uid: z.string().describe("Device UID from list_devices.") },
    outputSchema: { uid: z.string() },
}, async (args) => {
    const uid = String(args.uid ?? "");
    if (!uid) throw new Error("set_default_output_device requires a 'uid'.");
    await setDefaultDevice("output", uid);
    return ok({ uid }, `Default output set to ${uid}.`);
});

server.registerTool("set_default_input_device", {
    icons: [{ src: 'https://api.iconify.design/mdi/microphone-settings.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: "Set the default input device by UID (from list_devices). Requires the Core Audio helper.",
    inputSchema: { uid: z.string().describe("Device UID from list_devices.") },
    outputSchema: { uid: z.string() },
}, async (args) => {
    const uid = String(args.uid ?? "");
    if (!uid) throw new Error("set_default_input_device requires a 'uid'.");
    await setDefaultDevice("input", uid);
    return ok({ uid }, `Default input set to ${uid}.`);
});

// ── Start + teardown ─────────────────────────────────────────────────────────
// Preserve the old graceful shutdown: when stdin ends (the gateway disconnects)
// stop the watcher so the Swift child + timers don't leak, then exit — exactly
// what the hand-rolled `process.stdin.on("end")` did. We chain off the server's
// `onclose` too (the SDK invokes it when the stdio transport closes) so teardown
// runs no matter which fires first; `stopWatching()` is idempotent.
function shutdown() {
    stopWatching();
    process.exit(0);
}

process.stdin.on("end", shutdown);

await server.connect(new StdioServerTransport());

const sdkOnClose = server.server.onclose;
server.server.onclose = () => { stopWatching(); sdkOnClose?.(); };
