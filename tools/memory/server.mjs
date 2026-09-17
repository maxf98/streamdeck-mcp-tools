import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Persistence for buttons, which cannot persist anything themselves.
//
// A face runs in a sandboxed, non-secure, opaque origin (a `data:` URL), so it has no
// localStorage and no indexedDB — measured, not assumed. Its useViewState is scoped to
// state private to that one control, and the host dismisses an idle face's window after
// 30s and rebuilds it on the next interaction. Between those two facts, a button today
// cannot remember a count, a latch, or "the last thing I picked" across presses.
//
// Capability belongs in a server, so here it is: one JSON file, a few tools, and the
// store exposed as a live resource so a face can bind it instead of re-reading it.

const STATE_DIR = join(process.env.STREAMDECK_MCP_DIR ?? join(homedir(), '.streamdeck-mcp'), 'memory');
const STORE_PATH = join(STATE_DIR, 'store.json');
const URI_STORE = 'resource://memory/store';

// ── Store ─────────────────────────────────────────────────────────────────────

/** In-memory truth: key → { value, updated_at }. The file is a mirror of this, not
 *  the other way round — every tool reads from here so a press never waits on disk. */
let entries = new Map();

function load() {
    try {
        if (!existsSync(STORE_PATH)) return;
        const raw = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
        for (const [k, v] of Object.entries(raw?.entries ?? {})) {
            // Tolerate a hand-edited file that stored bare values instead of records.
            if (v && typeof v === 'object' && 'value' in v) {
                entries.set(k, { value: v.value, updated_at: Number(v.updated_at) || Date.now() });
            } else {
                entries.set(k, { value: v, updated_at: Date.now() });
            }
        }
    } catch (err) {
        // A corrupt store must not take the pack down — every tool would then fail and
        // every button using it would look broken. Start empty and say so on stderr;
        // the next write replaces the bad file.
        process.stderr.write(`[memory] ignoring unreadable ${STORE_PATH}: ${err.message}\n`);
    }
}

/** Flushes are serialized through this chain so two presses in the same tick can't
 *  interleave a read-modify-write, and rename() makes the swap atomic — a reader
 *  never sees a half-written file. */
let flushing = Promise.resolve();

function persist() {
    flushing = flushing.then(() => {
        try {
            mkdirSync(STATE_DIR, { recursive: true });
            const body = JSON.stringify({
                version: 1,
                entries: Object.fromEntries(entries),
            }, null, 2);
            const tmp = `${STORE_PATH}.${process.pid}.tmp`;
            writeFileSync(tmp, body, 'utf-8');
            renameSync(tmp, STORE_PATH);
        } catch (err) {
            process.stderr.write(`[memory] write failed: ${err.message}\n`);
        }
    });
    return flushing;
}

const subscribed = new Set();

/** Save, then tell anyone bound to the store that it moved. Called by every mutating
 *  tool — a face that bound the store repaints from this, which is the whole reason
 *  the resource exists. Gated on an actual subscription, per the profile. */
async function commit() {
    await persist();
    if (subscribed.has(URI_STORE)) {
        void server.server.sendResourceUpdated({ uri: URI_STORE });
    }
}

const snapshot = () => ({
    values: Object.fromEntries([...entries].map(([k, v]) => [k, v.value])),
    count: entries.size,
    updated_at: entries.size
        ? Math.max(...[...entries.values()].map((v) => v.updated_at))
        : 0,
});

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

load();

// ── Server ────────────────────────────────────────────────────────────────────

// `subscribe` has to be declared here: registerResource only sets listChanged, and
// without the capability the host primes the face once and never hears about a change.
const server = new McpServer(
    { name: 'memory', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } },
);

const ok = (structured, text) => ({ structuredContent: structured, content: [{ type: 'text', text }] });
const VERSION = { 'io.streamdeck/tool': { version: '1.0.0' } };

// A stored value is arbitrary JSON, so its schema is genuinely open. Everything
// around it is typed.
const VALUE = z.any();

const STORE_SCHEMA = {
    type: 'object',
    properties: {
        values: { type: 'object', additionalProperties: true },
        count: { type: 'number' },
        updated_at: { type: 'number' },
    },
    required: ['values', 'count', 'updated_at'],
};

server.registerResource(
    'Memory Store', URI_STORE,
    {
        title: 'Memory Store',
        description:
            'Every stored key and its value, as { values, count, updated_at }. Bind a face to this ' +
            'and read data.values.<key> — the face repaints whenever any value changes.',
        icons: [{ src: 'https://api.iconify.design/mdi/database-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
        mimeType: 'application/json',
        _meta: { 'io.streamdeck/resourceSchema': STORE_SCHEMA },
    },
    async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot()) }],
    }),
);

server.server.setRequestHandler('resources/subscribe', async (req) => {
    if (req.params.uri === URI_STORE) subscribed.add(URI_STORE);
    return {};
});

server.server.setRequestHandler('resources/unsubscribe', async (req) => {
    if (req.params.uri) subscribed.delete(req.params.uri);
    return {};
});

// ── Tools ─────────────────────────────────────────────────────────────────────

const KEY = z.string().min(1).max(200)
    .describe('The key to store under. Namespace with a prefix ("pomodoro.count") — list_keys and clear_values filter on it.');

server.registerTool('get_value', {
    title: 'Get Value',
    icons: [{ src: 'https://api.iconify.design/mdi/database-search-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Read a stored value. Returns {key, value, exists, updated_at}; `value` is `default_value` ' +
        '(null unless given) when the key was never set, so a handler never has to branch on undefined.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: VERSION,
    inputSchema: {
        key: KEY,
        // .optional() is load-bearing: under zod v4 a bare z.any() is a REQUIRED field
        // that rejects `undefined`, so omitting the default — the ordinary call — failed
        // validation before the handler ever ran.
        default_value: VALUE.optional().describe('Returned as `value` when the key is not set (default: null)'),
    },
    outputSchema: z.object({
        key: z.string(),
        value: VALUE,
        exists: z.boolean(),
        updated_at: z.number(),
    }),
}, async ({ key, default_value }) => {
    const hit = entries.get(key);
    const out = {
        key,
        value: hit ? hit.value : (default_value ?? null),
        exists: !!hit,
        updated_at: hit ? hit.updated_at : 0,
    };
    return ok(out, `${key} = ${JSON.stringify(out.value)}${hit ? '' : ' (unset)'}`);
});

server.registerTool('set_value', {
    title: 'Set Value',
    icons: [{ src: 'https://api.iconify.design/mdi/content-save-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Store any JSON value (string, number, boolean, object, array, null) under a key, replacing whatever was there.',
    // Not flagged destructive: overwriting one of your own keys is the ordinary use,
    // and flagging it would make every counter button look like it needs guarding.
    // delete_value and clear_values, which lose data you can't recompute, are flagged.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: VERSION,
    inputSchema: {
        key: KEY,
        value: VALUE.describe('Any JSON value'),
    },
    outputSchema: z.object({ key: z.string(), value: VALUE, created: z.boolean() }),
}, async ({ key, value }) => {
    const created = !entries.has(key);
    entries.set(key, { value: value ?? null, updated_at: Date.now() });
    await commit();
    const out = { key, value: value ?? null, created };
    return ok(out, `${key} = ${JSON.stringify(out.value)}`);
});

server.registerTool('increment_value', {
    title: 'Increment Value',
    icons: [{ src: 'https://api.iconify.design/mdi/plus-circle-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Add to a numeric value and return the new one, treating an unset key as 0. Use this rather ' +
        'than get+set for a press counter: it is one call, so two fast presses cannot both read the ' +
        'same old number and write the same new one.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: VERSION,
    inputSchema: {
        key: KEY,
        by: z.number().default(1).describe('Amount to add — negative to subtract (default: 1)'),
    },
    outputSchema: z.object({ key: z.string(), value: z.number(), previous: z.number() }),
}, async ({ key, by }) => {
    const hit = entries.get(key);
    const previous = typeof hit?.value === 'number' ? hit.value : 0;
    if (hit && typeof hit.value !== 'number') {
        throw new Error(`"${key}" holds a ${typeOf(hit.value)}, not a number — use set_value to replace it first`);
    }
    const value = previous + by;
    entries.set(key, { value, updated_at: Date.now() });
    await commit();
    const out = { key, value, previous };
    return ok(out, `${key} = ${value}`);
});

server.registerTool('toggle_value', {
    title: 'Toggle Value',
    icons: [{ src: 'https://api.iconify.design/mdi/toggle-switch-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Flip a boolean and return the new value, treating an unset key as false (so the first press ' +
        'turns it on). The one call a latching button needs.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: VERSION,
    inputSchema: { key: KEY },
    outputSchema: z.object({ key: z.string(), value: z.boolean(), previous: z.boolean() }),
}, async ({ key }) => {
    const hit = entries.get(key);
    if (hit && typeof hit.value !== 'boolean') {
        throw new Error(`"${key}" holds a ${typeOf(hit.value)}, not a boolean — use set_value to replace it first`);
    }
    const previous = hit?.value === true;
    const value = !previous;
    entries.set(key, { value, updated_at: Date.now() });
    await commit();
    const out = { key, value, previous };
    return ok(out, `${key} = ${value}`);
});

server.registerTool('list_keys', {
    title: 'List Keys',
    icons: [{ src: 'https://api.iconify.design/mdi/format-list-bulleted.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'List stored keys with each value\'s type and last-write time, optionally filtered by key prefix.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: VERSION,
    inputSchema: {
        prefix: z.string().default('').describe('Only keys starting with this (default: all keys)'),
    },
    outputSchema: z.object({
        count: z.number().int(),
        keys: z.array(z.object({
            key: z.string(),
            type: z.string(),
            updated_at: z.number(),
        })),
    }),
}, async ({ prefix }) => {
    const keys = [...entries]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => ({ key: k, type: typeOf(v.value), updated_at: v.updated_at }));
    const out = { count: keys.length, keys };
    return ok(out, keys.length ? keys.map((k) => `${k.key} (${k.type})`).join('\n') : '(empty)');
});

server.registerTool('delete_value', {
    title: 'Delete Value',
    icons: [{ src: 'https://api.iconify.design/mdi/delete-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Remove a key. Returns {key, deleted} — deleted is false when the key was not there.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    _meta: VERSION,
    inputSchema: { key: KEY },
    outputSchema: z.object({ key: z.string(), deleted: z.boolean() }),
}, async ({ key }) => {
    const deleted = entries.delete(key);
    if (deleted) await commit();
    return ok({ key, deleted }, deleted ? `deleted ${key}` : `${key} was not set`);
});

server.registerTool('clear_values', {
    title: 'Clear Values',
    icons: [{ src: 'https://api.iconify.design/mdi/delete-sweep-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Delete every key, or every key under a prefix. `prefix` is required and must be passed as ' +
        '"" to mean everything — an empty default would make a mis-wired button wipe the whole store.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    _meta: VERSION,
    inputSchema: {
        prefix: z.string().describe('Delete keys starting with this. Pass "" to delete ALL keys.'),
    },
    outputSchema: z.object({ deleted: z.number().int(), keys: z.array(z.string()) }),
}, async ({ prefix }) => {
    const doomed = [...entries.keys()].filter((k) => k.startsWith(prefix));
    for (const k of doomed) entries.delete(k);
    if (doomed.length) await commit();
    const out = { deleted: doomed.length, keys: doomed };
    return ok(out, `deleted ${doomed.length} key(s)`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
