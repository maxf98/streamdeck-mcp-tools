#!/usr/bin/env node
/**
 * voice — a zero-dependency stdio MCP server for microphone recording.
 *
 * Speaks newline-delimited JSON-RPC over stdio (the framing the MCP stdio
 * transport uses), so it needs no `npm install` and no SDK — it runs on the
 * bundled Node. A node subprocess can't reach a microphone, so the *capture*
 * lives where it belongs: in the host's on-screen surface. This pack ships two
 * MCP App UI resources the Stream Deck host reconciles automatically:
 *
 *   ui://voice/key    surface "key"   → a placeable Stream Deck key face. It
 *                                       *binds* to resource://voice/state, so the
 *                                       key live-updates idle ↔ recording with no
 *                                       press (the design's persistent/ambient
 *                                       mode). Pressing it opens the recorder popup.
 *   ui://voice/popup  surface "popup" → an on-screen recorder pill. It runs
 *                                       getUserMedia + MediaRecorder in the host's
 *                                       popup window (which is why it declares
 *                                       `_meta.ui.permissions: ["microphone"]` —
 *                                       the host grants the iframe mic access from
 *                                       that, the spec-standard MCP Apps way), and
 *                                       on stop base64-encodes the WebM and calls
 *                                       voice__save_recording over the App bridge.
 *
 *   Resource (subscribable — pushes notifications/resources/updated on change):
 *     resource://voice/state  → { recording: boolean }. The popup flips it as it
 *                               starts/stops; the key face subscribes and repaints.
 *
 *   Tools:
 *     set_recording { recording }     → set the shared recording flag (the popup
 *                                        calls this so the key reflects live state).
 *     save_recording { base64, path? } → writes the WebM to disk, clears the flag,
 *                                        and returns { path }. Hand that path to a
 *                                        transcription tool (e.g. openai__transcribe_file).
 *
 * The UI resources are MCP App envelopes: `{ jsx, _meta }`. The host reads `jsx`
 * as the View source (a `Face`/`Popup` React component compiled in-window) and
 * the surface/permissions out of `_meta`. To plain chat clients these are just
 * resources with an HTML-app mimeType — everything device-specific is additive
 * metadata other hosts ignore.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROTOCOL_VERSION = "2025-06-18";

// Vendor namespace the Stream Deck host reads surface/binding metadata from.
const SURFACE_NS = "streamdeck.studio/v1";
const APP_MIME = "text/html;profile=mcp-app";

const URI_KEY = "ui://voice/key";
const URI_POPUP = "ui://voice/popup";
const URI_STATE = "resource://voice/state";

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

// ── Shared recording state ────────────────────────────────────────────────────
// resource://voice/state is the reactive atom the key face binds to. The popup
// flips `recording` as it starts/stops; subscribers get notifications/resources/
// updated and re-read. Only push a notification to subscribers who asked for it.
let recording = false;
const subscribers = new Set();

function setRecording(value) {
    const next = value === true;
    if (next === recording) return;
    recording = next;
    if (subscribers.has(URI_STATE)) notify("notifications/resources/updated", { uri: URI_STATE });
}

// ── UI resource Views (compiled in-window by the host's component harness) ────
// The key face: a stateful `Face({ data })` component bound to resource://voice/
// state. `data.recording` drives idle (grey mic) vs recording (pulsing red dot).
// Pure CSS/SVG — no <Icon> (that relies on host-baked glyph data a server-shipped
// face doesn't get). A square 144×144 stage; the host crops to the key.
const KEY_JSX = `
function Face({ data }) {
  var rec = !!(data && data.recording);
  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 10, background: rec ? '#1a0e0e' : '#161616', color: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      <style>{'@keyframes vpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}'}</style>
      <div style={{
        width: 34, height: 34, borderRadius: '50%',
        background: rec ? '#ff3b3b' : '#5a5a5e',
        boxShadow: rec ? '0 0 16px rgba(255,59,59,.6)' : 'none',
        animation: rec ? 'vpulse 1.4s infinite' : 'none',
      }} />
      <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '.1em', color: rec ? '#fff' : '#8a8a8e' }}>
        {rec ? 'REC' : 'VOICE'}
      </div>
    </div>
  );
}
`.trim();

// The recorder popup: a `Popup({ data, submitPopup, cancelPopup })` component.
// Starts capturing on mount, shows an animated pill + timer, and on stop encodes
// the WebM and calls voice__save_recording via the host bridge (window.mcp).
const POPUP_JSX = `
function Popup({ submitPopup, cancelPopup }) {
  const [phase, setPhase] = React.useState('idle'); // idle | recording | saving | error
  const [seconds, setSeconds] = React.useState(0);
  const [error, setError] = React.useState('');
  const rec = React.useRef(null);
  const chunks = React.useRef([]);
  const stream = React.useRef(null);
  const timer = React.useRef(null);

  const start = React.useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.current = s;
      chunks.current = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                 : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : {});
      r.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.current.push(e.data); };
      r.start(100);
      rec.current = r;
      setSeconds(0);
      setPhase('recording');
      window.mcp.callTool('voice', 'set_recording', { recording: true }).catch(() => {});
      const t0 = Date.now();
      timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250);
    } catch (e) {
      // No mic (e.g. permission denied, or the offscreen thumbnail render) → fall
      // back to a calm idle state with a Start affordance, never a scary error.
      setPhase('idle');
    }
  }, []);

  // Auto-start on open; if the mic isn't available we land back on idle (above).
  React.useEffect(() => {
    start();
    return () => {
      if (timer.current) clearInterval(timer.current);
      if (stream.current) stream.current.getTracks().forEach((t) => t.stop());
      // Closing the window mid-recording (cancel) must release the key's state,
      // since no save_recording will run to clear it.
      if (rec.current && rec.current.state === 'recording') {
        window.mcp.callTool('voice', 'set_recording', { recording: false }).catch(() => {});
      }
    };
  }, [start]);

  const stop = React.useCallback(() => {
    const r = rec.current;
    if (!r || r.state === 'inactive') { cancelPopup(); return; }
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setPhase('saving');
    r.onstop = async () => {
      try {
        if (stream.current) stream.current.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        const cs = 8192;
        for (let i = 0; i < buf.length; i += cs) bin += String.fromCharCode.apply(null, buf.subarray(i, i + cs));
        const base64 = btoa(bin);
        const res = await window.mcp.callTool('voice', 'save_recording', { base64 });
        submitPopup({ path: res && res.path });
      } catch (e) {
        setError(String((e && e.message) || e));
        setPhase('error');
      }
    };
    r.stop();
  }, [submitPopup, cancelPopup]);

  const mmss = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const active = phase === 'recording';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', color: '#fff',
    }}>
      <style>{'@keyframes vp{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}@keyframes vspin{to{transform:rotate(360deg)}}'}</style>
      {phase === 'error' ? (
        <React.Fragment>
          <span style={{ color: '#ff6b6b', fontSize: 16 }}>⚠</span>
          <span style={{ flex: 1, fontSize: 13, color: '#ff9a9a' }}>{error || 'Recording failed'}</span>
          <button onClick={cancelPopup} style={btn('#3a3a3c')}>Close</button>
        </React.Fragment>
      ) : (
        <React.Fragment>
          <span style={{
            width: 12, height: 12, borderRadius: '50%',
            background: active ? '#ff3b3b' : '#8a8a8e',
            boxShadow: active ? '0 0 12px rgba(255,59,59,.6)' : 'none',
            animation: active ? 'vp 1.2s infinite' : 'none', flex: '0 0 auto',
          }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
            {phase === 'idle' ? 'Voice memo' : phase === 'saving' ? 'Saving…' : 'Recording'}
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 14, opacity: .85, minWidth: 38, textAlign: 'right' }}>{mmss}</span>
          {phase === 'idle'
            ? <button onClick={start} style={btn('#ff3b3b')}>Record</button>
            : <button onClick={stop} disabled={phase !== 'recording'} style={btn('#ff3b3b', phase !== 'recording')}>Stop</button>}
        </React.Fragment>
      )}
    </div>
  );

  function btn(bg, disabled) {
    return {
      padding: '7px 16px', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
      cursor: disabled ? 'default' : 'pointer', background: bg, color: '#fff', opacity: disabled ? .5 : 1,
    };
  }
}
`.trim();

// Envelope a View as an MCP App UI resource: jsx + surface metadata. `opts.bind`
// names a resource the View subscribes to (persistent/ambient mode); `opts.permissions`
// declares browser capabilities the host grants the iframe (standard `_meta.ui`).
function envelope(jsx, surface, opts = {}) {
    const sd = { surface };
    if (opts.bind) sd.display = { bind: opts.bind };
    const _meta = { [SURFACE_NS]: sd };
    if (opts.permissions) _meta.ui = { permissions: opts.permissions };
    return JSON.stringify({ jsx, _meta });
}

// resources/list descriptors. The surface lives in `_meta` here too, so the host
// can classify each resource (key vs popup) from the list alone, before reading.
const RESOURCE_DESCRIPTORS = [
    {
        uri: URI_KEY,
        name: "Voice — REC key",
        description: "A Stream Deck key face that live-updates with recording state. Place it on hardware to open the recorder.",
        mimeType: APP_MIME,
        _meta: { [SURFACE_NS]: { surface: "key", display: { bind: URI_STATE } } },
    },
    {
        uri: URI_POPUP,
        name: "Voice — Recorder",
        description: "On-screen microphone recorder pill. Captures audio and saves a WebM file.",
        mimeType: APP_MIME,
        _meta: { [SURFACE_NS]: { surface: "popup" }, ui: { permissions: ["microphone"] } },
    },
    {
        uri: URI_STATE,
        name: "Voice — Recording state",
        description: "Whether a recording is currently in progress: { recording: boolean }.",
        mimeType: "application/json",
    },
];

const TOOL_DESCRIPTORS = [
    {
        name: "set_recording",
        description:
            "Set the shared voice recording flag (resource://voice/state). The recorder popup calls this on " +
            "start/stop so a bound Stream Deck key reflects live recording state. Returns { recording }.",
        inputSchema: {
            type: "object",
            properties: { recording: { type: "boolean", description: "True while recording is in progress." } },
            required: ["recording"],
        },
        outputSchema: {
            type: "object",
            properties: { recording: { type: "boolean" } },
            required: ["recording"],
        },
    },
    {
        name: "save_recording",
        description:
            "Save a base64-encoded WebM audio recording (produced by the voice recorder popup) to disk. " +
            "Returns { path } — hand that path to a transcription tool such as openai__transcribe_file.",
        inputSchema: {
            type: "object",
            properties: {
                base64: { type: "string", description: "Base64-encoded WebM audio bytes." },
                path: { type: "string", description: "Where to save the file. Defaults to a temp .webm file." },
            },
            required: ["base64"],
        },
        outputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "Absolute path to the saved WebM file." } },
            required: ["path"],
        },
    },
];

// ── Request handling ─────────────────────────────────────────────────────────

async function handle(msg) {
    const { id, method, params } = msg;

    // Notifications (no id) — nothing to ack (e.g. notifications/initialized).
    if (id === undefined || id === null) return;

    switch (method) {
        case "initialize":
            reply(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {
                    resources: { subscribe: true, listChanged: false },
                    tools: { listChanged: false },
                },
                serverInfo: { name: "voice", version: "1.0.0" },
            });
            return;

        case "ping":
            reply(id, {});
            return;

        case "resources/list":
            reply(id, { resources: RESOURCE_DESCRIPTORS });
            return;

        case "resources/templates/list":
            reply(id, { resourceTemplates: [] });
            return;

        case "resources/read": {
            const uri = params?.uri;
            if (uri === URI_KEY) {
                reply(id, { contents: [{ uri, mimeType: APP_MIME, text: envelope(KEY_JSX, "key", { bind: URI_STATE }) }] });
            } else if (uri === URI_POPUP) {
                reply(id, { contents: [{ uri, mimeType: APP_MIME, text: envelope(POPUP_JSX, "popup", { permissions: ["microphone"] }) }] });
            } else if (uri === URI_STATE) {
                reply(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ recording }) }] });
            } else {
                replyError(id, -32602, `Unknown resource: ${uri}`);
            }
            return;
        }

        case "resources/subscribe":
            if (params?.uri === URI_STATE) subscribers.add(URI_STATE);
            reply(id, {});
            return;

        case "resources/unsubscribe":
            if (params?.uri) subscribers.delete(params.uri);
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

    if (name === "set_recording") {
        setRecording(args.recording === true);
        reply(id, {
            structuredContent: { recording },
            content: [{ type: "text", text: recording ? "Recording." : "Not recording." }],
        });
        return;
    }

    if (name === "save_recording") {
        const base64 = typeof args.base64 === "string" ? args.base64 : "";
        if (!base64) {
            replyError(id, -32602, "save_recording requires a base64-encoded WebM string.");
            return;
        }
        const outPath = args.path ? String(args.path) : join(tmpdir(), `recording_${Date.now()}.webm`);
        try {
            await writeFile(outPath, Buffer.from(base64, "base64"));
            setRecording(false); // recording finished → release the key's state
            reply(id, {
                structuredContent: { path: outPath },
                content: [{ type: "text", text: `Saved recording to ${outPath}` }],
            });
        } catch (err) {
            replyError(id, -32603, `Failed to save recording: ${String(err?.message ?? err)}`);
        }
        return;
    }

    replyError(id, -32602, `Unknown tool: ${name}`);
}

// ── stdio read loop ───────────────────────────────────────────────────────────

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue; // ignore malformed lines
        }
        Promise.resolve(handle(msg)).catch((err) => {
            if (msg && msg.id != null) replyError(msg.id, -32603, String(err?.message ?? err));
        });
    }
});
process.stdin.on("end", () => process.exit(0));
