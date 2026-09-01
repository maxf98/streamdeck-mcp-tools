/**
 * photoshop — drive Adobe Photoshop from a Stream Deck button.
 *
 * 102 tools: document/layer/selection/mask/text/filter/adjustment atomics, the
 * generative-AI family (fill, remove, expand, upscale, sky replacement), and 16
 * multi-step "recipe" tools that run a whole retouching workflow inside one
 * suspended history state (so one Undo reverts the lot).
 *
 * ── HOW IT TALKS TO PHOTOSHOP ────────────────────────────────────────────────
 *
 * Photoshop's AppleScript dictionary is thin; the real API is ExtendScript
 * running inside the app, reached from outside via AppleScript's one useful verb,
 * `do javascript`. All of that plumbing — and the seven quirks that shape it —
 * lives in lib/photoshop.mjs. Read that header before changing anything here.
 *
 * ── LAYOUT (this pack is not a single file) ──────────────────────────────────
 *
 *   server.mjs                 this file: registration, resources, surfaces
 *   lib/photoshop.mjs          the AppleScript↔ExtendScript executor
 *   lib/schema.mjs             JSON Schema → zod (v2 rejects raw JSON Schema)
 *   vendor/                    the ExtendScript tool library (see vendor/README.md)
 *
 * The tool bodies are VENDORED from alisaitteke/photoshop-mcp (MIT) rather than
 * rewritten: they encode a lot of hard-won Action Manager knowledge (the
 * four-digit charIDs, the per-version fallbacks) that can only be validated
 * against a real Photoshop. vendor/README.md records exactly what was changed.
 *
 * ── A NOTE ON SPEED ──────────────────────────────────────────────────────────
 *
 * Some tools are slow — a generative fill is a round trip to Adobe's servers,
 * and a batch recipe over 50 files takes minutes. That's fine for a button: the
 * press handler awaits it and can paint progress on the key meanwhile. But
 * Photoshop is single-threaded, so calls are serialized pack-wide (quirk 4) —
 * a button firing a long recipe blocks other Photoshop buttons until it's done.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toZodShape } from './lib/schema.mjs';
import { appPath, isRunning, runScript, version } from './lib/photoshop.mjs';
import { PhotoshopConnection } from './vendor/platform/connection.js';
import { collectTools } from './vendor/tools/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const server = new McpServer(
    { name: 'photoshop', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true }, tools: {} } },
);

const connection = new PhotoshopConnection();

// ── Resource + surface URIs ──────────────────────────────────────────────────

const URI_DOCUMENT = 'resource://photoshop/document';

const URI_UI_KEY = 'ui://photoshop/key';
const URI_UI_DIAL = 'ui://photoshop/dial';
const URI_UI_POPUP = 'ui://photoshop/popup';

const SURFACE_NS = 'io.streamdeck/surfaces';
const APP_MIME = 'text/html;profile=mcp-app';

// ── Icons ────────────────────────────────────────────────────────────────────

// Under SDK v2 icons reach the client (v1 silently dropped them), so the Studio
// can show one per tool in the picker. Keyed by prefix — 102 hand-picked icons
// would be noise, but a caller can still tell a layer tool from an export tool.
const ICON_RULES = [
    [/^recipe_/, 'auto-fix'],
    [/^(generative|generate)_/, 'creation'],
    [/^neural_/, 'brain'],
    [/mask/, 'gradient-horizontal'],
    [/^select|deselect/, 'select-drag'],
    [/text|font/, 'format-text'],
    [/layer/, 'layers'],
    [/^(export|save)_/, 'tray-arrow-down'],
    [/^(open|place)_/, 'folder-open'],
    [/^(undo|redo|get_history)/, 'undo-variant'],
    [/blur|sharpen|noise|filter/, 'blur'],
    [/brightness|contrast|hue|saturation|curves|levels|exposure|vibrance|invert|desaturate|lut|gradient_map/, 'tune-variant'],
    [/document|crop|resize|image/, 'image-outline'],
    [/^(ping|get_version|get_state|get_capabilities|get_preview)$/, 'information-outline'],
];

function iconFor(name) {
    const rule = ICON_RULES.find(([re]) => re.test(name));
    const slug = rule ? rule[1] : 'palette';
    return [{
        src: `https://api.iconify.design/mdi/${slug}.svg`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
    }];
}

// ── Tool registration ────────────────────────────────────────────────────────

// Slow families get a bigger budget than the 60s default: a generative call is a
// server round trip, and a batch recipe walks a whole folder. Photoshop's own
// progress is invisible to us, so the only lever is patience.
function timeoutFor(name) {
    if (/^recipe_(batch_|csv_|split_|export_social)/.test(name)) return 600000;
    if (/^recipe_/.test(name)) return 180000;
    if (/^(generative_|generate_image|sky_replacement|neural_filter|select_subject|content_aware_fill)/.test(name)) return 180000;
    return 60000;
}

const registered = [];

for (const def of collectTools(connection)) {
    const name = def.tool.name;
    const inputSchema = toZodShape(def.tool.inputSchema ?? { type: 'object', properties: {} }, name);

    server.registerTool(name, {
        description: def.tool.description,
        icons: iconFor(name),
        inputSchema,
        // No outputSchema: these handlers return human-readable text or a JSON
        // envelope, and a declared outputSchema would require structuredContent
        // on every success path (the SDK rewrites a content-only success into an
        // isError result). The envelope's shape is documented per tool instead.
    }, async (args) => {
        const budget = timeoutFor(name);
        // The vendored handlers own their error formatting (see
        // vendor/errors/envelope.js): failures come back as an isError result
        // carrying a { ok:false, code, message, suggested_next_tool } envelope,
        // so a button can branch on `code` instead of matching English.
        return withTimeout(def.handler(args ?? {}), budget, name);
    });
    registered.push(name);
}

/**
 * Guard against a handler that never settles.
 *
 * The executor already kills osascript, but a vendored handler can make several
 * calls in sequence (the batch recipes make dozens), so its total runtime isn't
 * bounded by any single call. A button press that hangs forever is worse than
 * one that fails, so the whole handler gets an outer bound.
 */
function withTimeout(promise, ms, name) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${name} exceeded its ${Math.round(ms / 1000)}s budget`)),
            ms,
        );
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// ── Connection tools (upstream defined these in its server core) ─────────────

server.registerTool('ping', {
    description:
        'Check whether Photoshop is installed, running and reachable. Cheap and safe to ' +
        'call first — returns { installed, running, version, path } rather than failing ' +
        'when Photoshop is closed, so a button can decide what to do about it.',
    icons: iconFor('ping'),
    inputSchema: {},
}, async () => {
    const path = await appPath();
    const running = path ? await isRunning() : false;
    let ver = null;
    if (running) {
        try {
            ver = await version();
        } catch {
            // Reachability is the answer being reported; a version read that
            // fails (busy modal, script disabled) shouldn't turn this into an error.
        }
    }
    const state = { installed: !!path, running, version: ver, path };
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
});

server.registerTool('get_version', {
    description: "Photoshop's version string (e.g. \"26.3.0\"), or an error if it isn't running.",
    icons: iconFor('get_version'),
    inputSchema: {},
}, async () => {
    const ver = await version();
    return { content: [{ type: 'text', text: JSON.stringify({ version: ver }, null, 2) }] };
});

// (`get_capabilities` is NOT defined here — the vendored one is better: it also
// reports uxp_bridge_reachable, which is what gates the neural-filter family.)

// ── The live document resource ────────────────────────────────────────────────

const DOCUMENT_SCHEMA = {
    type: 'object',
    properties: {
        running: { type: 'boolean' },
        hasDocument: { type: 'boolean' },
        name: { type: ['string', 'null'] },
        width: { type: ['number', 'null'] },
        height: { type: ['number', 'null'] },
        resolution: { type: ['number', 'null'] },
        colorMode: { type: ['string', 'null'] },
        layerCount: { type: ['number', 'null'] },
        hasSelection: { type: 'boolean' },
        activeLayer: { type: ['string', 'null'] },
        activeLayerKind: { type: ['string', 'null'] },
        at: { type: 'number' },
    },
    required: ['running', 'hasDocument', 'hasSelection', 'at'],
};

const EMPTY_DOCUMENT = {
    running: false, hasDocument: false, name: null, width: null, height: null,
    resolution: null, colorMode: null, layerCount: null, hasSelection: false,
    activeLayer: null, activeLayerKind: null, at: 0,
};

const DOC_SNAPSHOT_SCRIPT = `
    var out = { hasDocument: app.documents.length > 0 };
    if (out.hasDocument) {
      var doc = null;
      try { doc = app.activeDocument; } catch (e) { doc = null; }
      if (doc) {
        try { out.name = doc.name; } catch (e) {}
        try { out.width = doc.width.as('px'); } catch (e) {}
        try { out.height = doc.height.as('px'); } catch (e) {}
        try { out.resolution = doc.resolution; } catch (e) {}
        try { out.colorMode = String(doc.mode); } catch (e) {}
        try { out.layerCount = doc.layers.length; } catch (e) {}
        try {
          out.hasSelection = !!(doc.selection && doc.selection.bounds);
        } catch (e) {
          // ExtendScript throws "No such element" when nothing is selected —
          // that's a normal state, not a failure.
          out.hasSelection = false;
        }
        try { out.activeLayer = doc.activeLayer.name; } catch (e) {}
        try { out.activeLayerKind = String(doc.activeLayer.kind); } catch (e) {}
      }
    }
    return out;
`;

async function readDocument() {
    // A resource read must always yield a snapshot: a face bound to this can't do
    // anything with an exception, and "Photoshop closed" / "no document open" are
    // normal states, not failures. Tools still report those as errors.
    if (!(await isRunning())) return { ...EMPTY_DOCUMENT, at: Date.now() };
    try {
        const snap = await runScript(DOC_SNAPSHOT_SCRIPT, 15000);
        return {
            ...EMPTY_DOCUMENT,
            ...(snap && typeof snap === 'object' ? snap : {}),
            running: true,
            at: Date.now(),
        };
    } catch {
        return { ...EMPTY_DOCUMENT, running: true, at: Date.now() };
    }
}

server.registerResource(
    'Active Document', URI_DOCUMENT,
    {
        description: "The active document's live state — size, colour mode, layer count, selection and active layer.",
        mimeType: 'application/json',
        _meta: { 'io.streamdeck/resourceSchema': DOCUMENT_SCHEMA },
    },
    async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await readDocument()) }],
    }),
);

// ── Subscriptions ────────────────────────────────────────────────────────────

// Photoshop has no change notification we can observe from outside, so a bound
// face is served by polling. Gated on an actual subscription: an idle pack must
// not wake Photoshop, and each poll is a real Apple event.
const POLL_MS = 2000;

const subscribed = new Set();
let pollTimer = null;
let lastJson = null;

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
        if (!subscribed.has(URI_DOCUMENT)) return;
        try {
            const snap = await readDocument();
            // `at` changes every tick, so compare on everything else — otherwise
            // every poll would look like a change and repaint the face.
            const { at, ...rest } = snap;
            const json = JSON.stringify(rest);
            if (json !== lastJson) {
                lastJson = json;
                server.server.sendResourceUpdated({ uri: URI_DOCUMENT }).catch(() => {});
            }
        } catch {
            // Photoshop quitting mid-poll is expected; the next tick reports it.
        }
    }, POLL_MS);
    pollTimer.unref?.();
}

function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    lastJson = null;
}

// v2 takes a method STRING here, not a request schema object.
server.server.setRequestHandler('resources/subscribe', async (req) => {
    const uri = req.params?.uri;
    if (uri) {
        subscribed.add(uri);
        if (uri === URI_DOCUMENT) startPolling();
    }
    return {};
});

server.server.setRequestHandler('resources/unsubscribe', async (req) => {
    const uri = req.params?.uri;
    if (uri) {
        subscribed.delete(uri);
        if (!subscribed.has(URI_DOCUMENT)) stopPolling();
    }
    return {};
});

// ── Surfaces ─────────────────────────────────────────────────────────────────

// The io.streamdeck/surfaces block is KEYED BY SURFACE ("key"/"encoder"/"popup"),
// not a list of {type} objects — the host iterates the known surface keys, so an
// array yields no surface at all (no button generated, no handles read, no event
// injected). `handles` names the slots the view registers via in-component hooks
// (useKeyDown/useDialRotate/…); it must match the view, or the host has no reason
// to inject the hardware event.
const SURFACES = {
    [URI_UI_KEY]: {
        name: 'Photoshop Key',
        file: 'key.view.jsx',
        description: 'Stream Deck key face: document name, size and layer count, live.',
        surfaces: { key: { resourceUri: URI_UI_KEY, mode: 'persistent', bind: URI_DOCUMENT, handles: ['press'] } },
    },
    [URI_UI_DIAL]: {
        name: 'Photoshop Dial',
        file: 'dial.view.jsx',
        description: 'Stream Deck dial face: scrub the active layer\'s opacity.',
        surfaces: { encoder: { resourceUri: URI_UI_DIAL, mode: 'persistent', bind: URI_DOCUMENT, handles: ['rotate', 'dialPress'] } },
    },
    [URI_UI_POPUP]: {
        name: 'Photoshop Panel',
        file: 'popup.view.jsx',
        description: 'On-screen panel: document state, layer list and one-press actions.',
        surfaces: { popup: { resourceUri: URI_UI_POPUP, mode: 'on-demand', bind: URI_DOCUMENT } },
    },
};

for (const [uri, surface] of Object.entries(SURFACES)) {
    server.registerResource(
        surface.name, uri,
        {
            description: surface.description,
            mimeType: APP_MIME,
            _meta: { [SURFACE_NS]: surface.surfaces },
        },
        async () => ({
            contents: [{
                uri,
                mimeType: APP_MIME,
                // The Studio expects { jsx, _meta } — the JSX source, not HTML.
                text: JSON.stringify({
                    jsx: readFileSync(join(HERE, surface.file), 'utf8'),
                    _meta: { [SURFACE_NS]: surface.surfaces },
                }),
            }],
        }),
    );
}

// ── Go ───────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
