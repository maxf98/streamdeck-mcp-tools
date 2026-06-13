#!/usr/bin/env node
/**
 * audio — a zero-dependency stdio MCP server for macOS audio.
 *
 * Speaks newline-delimited JSON-RPC directly over stdio (the same framing the
 * MCP stdio transport uses), so it needs no `npm install` and no SDK — it just
 * runs on the bundled Node. It exposes the macOS audio system as live MCP
 * resources that push updates the instant anything changes, plus get/set tools:
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

import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = "2025-06-18"; // any SUPPORTED_PROTOCOL_VERSIONS entry
const HERE = dirname(fileURLToPath(import.meta.url));

// Resource URIs.
const URI_OUTPUT = "resource://audio/output";
const URI_INPUT = "resource://audio/input";
const URI_DEVICES = "resource://audio/devices";

// ── Transport: newline-delimited JSON-RPC over stdio ─────────────────────────

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
}
function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
}

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
    if (subscribed.has(uri)) notify("notifications/resources/updated", { uri });
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

// ── JSON-RPC request handling ────────────────────────────────────────────────

const RESOURCE_DESCRIPTORS = [
    { uri: URI_OUTPUT, name: "System Output Volume", description: "Default output device volume (0–100) and mute state." },
    { uri: URI_INPUT, name: "System Input Volume", description: "Default input (microphone) volume (0–100) and mute state." },
    { uri: URI_DEVICES, name: "Audio Devices", description: "All audio devices and the current default input/output device." },
];

const TOOL_DESCRIPTORS = [
    {
        name: "get_volume",
        description: "Get the macOS system output volume (0–100) and mute state.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
            type: "object",
            properties: { level: { type: "number" }, muted: { type: "boolean" } },
            required: ["level", "muted"],
        },
    },
    {
        name: "set_volume",
        description: "Set output volume (0–100). Targets the default output device, or a specific device when 'device' (a UID from list_devices) is given. Setting a specific device requires the Core Audio helper, and the device must expose a settable volume (see 'settable' in list_devices).",
        inputSchema: {
            type: "object",
            properties: {
                level: { type: "number", description: "Volume 0–100." },
                device: { type: "string", description: "Optional device UID from list_devices; omit for the default output device." },
            },
            required: ["level"],
        },
        outputSchema: { type: "object", properties: { level: { type: "number" } }, required: ["level"] },
    },
    {
        name: "set_muted",
        description: "Mute or unmute output. Targets the default output device, or a specific device when 'device' (a UID) is given (requires the Core Audio helper).",
        inputSchema: {
            type: "object",
            properties: {
                muted: { type: "boolean", description: "True to mute, false to unmute." },
                device: { type: "string", description: "Optional device UID from list_devices; omit for the default output device." },
            },
            required: ["muted"],
        },
        outputSchema: { type: "object", properties: { muted: { type: "boolean" } }, required: ["muted"] },
    },
    {
        name: "get_input_volume",
        description: "Get the macOS system input (microphone) volume (0–100) and mute state.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
            type: "object",
            properties: { level: { type: "number" }, muted: { type: "boolean" } },
            required: ["level", "muted"],
        },
    },
    {
        name: "set_input_volume",
        description: "Set input (microphone) volume (0–100). Targets the default input device, or a specific device when 'device' (a UID) is given (requires the Core Audio helper; device must expose a settable volume).",
        inputSchema: {
            type: "object",
            properties: {
                level: { type: "number", description: "Volume 0–100." },
                device: { type: "string", description: "Optional device UID from list_devices; omit for the default input device." },
            },
            required: ["level"],
        },
        outputSchema: { type: "object", properties: { level: { type: "number" } }, required: ["level"] },
    },
    {
        name: "set_input_muted",
        description: "Mute or unmute input (microphone). Targets the default input device, or a specific device when 'device' (a UID) is given (requires the Core Audio helper).",
        inputSchema: {
            type: "object",
            properties: {
                muted: { type: "boolean", description: "True to mute, false to unmute." },
                device: { type: "string", description: "Optional device UID from list_devices; omit for the default input device." },
            },
            required: ["muted"],
        },
        outputSchema: { type: "object", properties: { muted: { type: "boolean" } }, required: ["muted"] },
    },
    {
        name: "list_devices",
        description: "List all audio devices with each device's current volume/mute (and whether volume is settable), plus the current default input/output device (by UID).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
            type: "object",
            properties: {
                output: { type: "string", description: "UID of the current default output device." },
                input: { type: "string", description: "UID of the current default input device." },
                devices: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "number" },
                            uid: { type: "string" },
                            name: { type: "string" },
                            canInput: { type: "boolean" },
                            canOutput: { type: "boolean" },
                            output: {
                                type: "object",
                                description: "Output-scope volume/mute (present when canOutput).",
                                properties: {
                                    level: { type: "number" },
                                    muted: { type: "boolean" },
                                    settable: { type: "boolean", description: "Whether this device's output volume can be set." },
                                },
                            },
                            input: {
                                type: "object",
                                description: "Input-scope volume/mute (present when canInput).",
                                properties: {
                                    level: { type: "number" },
                                    muted: { type: "boolean" },
                                    settable: { type: "boolean", description: "Whether this device's input volume can be set." },
                                },
                            },
                        },
                        required: ["uid", "name", "canInput", "canOutput"],
                    },
                },
            },
            required: ["output", "input", "devices"],
        },
    },
    {
        name: "set_default_output_device",
        description: "Set the default output device by UID (from list_devices). Requires the Core Audio helper.",
        inputSchema: {
            type: "object",
            properties: { uid: { type: "string", description: "Device UID from list_devices." } },
            required: ["uid"],
        },
        outputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"] },
    },
    {
        name: "set_default_input_device",
        description: "Set the default input device by UID (from list_devices). Requires the Core Audio helper.",
        inputSchema: {
            type: "object",
            properties: { uid: { type: "string", description: "Device UID from list_devices." } },
            required: ["uid"],
        },
        outputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"] },
    },
];

async function handle(msg) {
    const { id, method, params } = msg;

    // Notifications (no id) — nothing to ack.
    if (id === undefined || id === null) return; // e.g. notifications/initialized

    switch (method) {
        case "initialize":
            reply(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {
                    resources: { subscribe: true, listChanged: false },
                    tools: { listChanged: false },
                },
                serverInfo: { name: "audio", version: "3.0.0" },
            });
            return;

        case "ping":
            reply(id, {});
            return;

        case "resources/list":
            reply(id, {
                resources: RESOURCE_DESCRIPTORS.map((r) => ({ ...r, mimeType: "application/json" })),
            });
            return;

        case "resources/templates/list":
            reply(id, { resourceTemplates: [] });
            return;

        case "resources/read": {
            const uri = params?.uri;
            await ensurePrimed();
            if (uri === URI_OUTPUT) {
                reply(id, { contents: resourceContents(uri, outState ?? makeVolSnapshot(0, false)) });
            } else if (uri === URI_INPUT) {
                reply(id, { contents: resourceContents(uri, inState ?? makeVolSnapshot(0, false)) });
            } else if (uri === URI_DEVICES) {
                reply(id, { contents: resourceContents(uri, deviceState ?? { output: "", input: "", devices: [] }) });
            } else {
                replyError(id, -32602, `Unknown resource: ${uri}`);
            }
            return;
        }

        case "resources/subscribe":
            if (params?.uri && RESOURCE_DESCRIPTORS.some((r) => r.uri === params.uri)) {
                subscribed.add(params.uri);
                void startWatching();
            }
            reply(id, {});
            return;

        case "resources/unsubscribe":
            if (params?.uri) {
                subscribed.delete(params.uri);
                if (subscribed.size === 0) stopWatching();
            }
            reply(id, {});
            return;

        case "tools/list":
            reply(id, { tools: TOOL_DESCRIPTORS });
            return;

        case "tools/call":
            await handleToolCall(id, params);
            return;

        default:
            replyError(id, -32601, `Method not found: ${method}`);
            return;
    }
}

async function handleToolCall(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const ok = (structured, text) =>
        reply(id, { structuredContent: structured, content: [{ type: "text", text }] });

    switch (name) {
        case "get_volume": {
            await ensurePrimed();
            const s = outState ?? makeVolSnapshot(0, false);
            return ok({ level: s.level, muted: s.muted }, s.muted ? "Output muted." : `Output volume ${s.level}%.`);
        }
        case "get_input_volume": {
            await ensurePrimed();
            const s = inState ?? makeVolSnapshot(0, false);
            return ok({ level: s.level, muted: s.muted }, s.muted ? "Input muted." : `Input volume ${s.level}%.`);
        }
        case "set_volume":
        case "set_input_volume": {
            const channel = name === "set_input_volume" ? "input" : "output";
            const level = Number(args.level);
            if (!Number.isFinite(level)) return replyError(id, -32602, `${name} requires a numeric 'level'.`);
            const device = args.device ? String(args.device) : undefined;
            const bad = device && await validateDevice(channel, device, /* needsSettable */ true);
            if (bad) return replyError(id, -32602, bad);
            try {
                const applied = await setVolume(channel, level, device);
                return ok({ level: applied }, `${deviceLabel(channel, device)} volume set to ${applied}%.`);
            } catch (err) {
                return replyError(id, -32603, String(err?.message ?? err));
            }
        }
        case "set_muted":
        case "set_input_muted": {
            const channel = name === "set_input_muted" ? "input" : "output";
            const muted = args.muted === true || args.muted === "true";
            const device = args.device ? String(args.device) : undefined;
            const bad = device && await validateDevice(channel, device, /* needsSettable */ false);
            if (bad) return replyError(id, -32602, bad);
            try {
                await setMuted(channel, muted, device);
                const lbl = deviceLabel(channel, device);
                return ok({ muted }, muted ? `${lbl} muted.` : `${lbl} unmuted.`);
            } catch (err) {
                return replyError(id, -32603, String(err?.message ?? err));
            }
        }
        case "list_devices": {
            await ensurePrimed();
            const d = deviceState ?? { output: "", input: "", devices: [] };
            return ok(
                { output: d.output, input: d.input, devices: d.devices },
                `${d.devices.length} audio device(s).`,
            );
        }
        case "set_default_output_device": {
            const uid = String(args.uid ?? "");
            if (!uid) return replyError(id, -32602, "set_default_output_device requires a 'uid'.");
            try {
                await setDefaultDevice("output", uid);
                return ok({ uid }, `Default output set to ${uid}.`);
            } catch (err) {
                return replyError(id, -32603, String(err?.message ?? err));
            }
        }
        case "set_default_input_device": {
            const uid = String(args.uid ?? "");
            if (!uid) return replyError(id, -32602, "set_default_input_device requires a 'uid'.");
            try {
                await setDefaultDevice("input", uid);
                return ok({ uid }, `Default input set to ${uid}.`);
            } catch (err) {
                return replyError(id, -32603, String(err?.message ?? err));
            }
        }
        default:
            return replyError(id, -32602, `Unknown tool: ${name}`);
    }
}

// ── Stdin loop ───────────────────────────────────────────────────────────────

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        Promise.resolve(handle(msg)).catch((err) => {
            if (msg && msg.id !== undefined && msg.id !== null) {
                replyError(msg.id, -32603, `Internal error: ${err?.message ?? err}`);
            }
        });
    }
});
process.stdin.on("end", () => { stopWatching(); process.exit(0); });
