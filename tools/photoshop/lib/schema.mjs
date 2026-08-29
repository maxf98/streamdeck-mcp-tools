/**
 * JSON Schema → zod, for the subset this pack's tool definitions use.
 *
 * The tool table is declared as plain JSON Schema because that's the form it was
 * ported from and it stays readable next to 100 tools. But MCP SDK v2 rejects a
 * raw schema object outright ("inputSchema must be a Standard Schema"), so it's
 * converted once at registration time.
 *
 * Deliberately NOT a general JSON Schema compiler. The supported vocabulary is
 * exactly what the tool table uses — type (string/number/integer/boolean/array),
 * description, enum, default, minimum, maximum, items, required. Anything else
 * throws at startup rather than silently producing a schema that accepts the
 * wrong thing.
 */

import { z } from 'zod';

const KNOWN = new Set([
    'type', 'description', 'enum', 'default', 'minimum', 'maximum',
    'items', 'properties', 'required', 'minItems', 'maxItems',
]);

function leaf(spec, path) {
    for (const key of Object.keys(spec)) {
        if (!KNOWN.has(key)) {
            throw new Error(`${path}: unsupported JSON Schema keyword '${key}'`);
        }
    }

    let node;
    if (spec.enum) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
            throw new Error(`${path}: enum must be a non-empty array`);
        }
        // z.enum only takes strings; a mixed/numeric enum becomes a union of
        // literals so numeric enums keep validating as numbers.
        node = spec.enum.every((v) => typeof v === 'string')
            ? z.enum(spec.enum)
            : z.union(spec.enum.map((v) => z.literal(v)));
    } else {
        switch (spec.type) {
            case 'string':
                node = z.string();
                break;
            case 'integer':
                node = z.number().int();
                break;
            case 'number':
                node = z.number();
                break;
            case 'boolean':
                node = z.boolean();
                break;
            case 'array': {
                if (!spec.items) throw new Error(`${path}: array needs 'items'`);
                node = z.array(leaf(spec.items, `${path}[]`));
                if (spec.minItems !== undefined) node = node.min(spec.minItems);
                if (spec.maxItems !== undefined) node = node.max(spec.maxItems);
                break;
            }
            case 'object':
                node = z.object(shape(spec, path));
                break;
            default:
                throw new Error(`${path}: unsupported type '${spec.type}'`);
        }
    }

    if (spec.type === 'number' || spec.type === 'integer') {
        if (spec.minimum !== undefined) node = node.min(spec.minimum);
        if (spec.maximum !== undefined) node = node.max(spec.maximum);
    }
    if (spec.description) node = node.describe(spec.description);
    return node;
}

function shape(spec, path = '') {
    const required = new Set(spec.required ?? []);
    const out = {};
    for (const [name, sub] of Object.entries(spec.properties ?? {})) {
        let node = leaf(sub, `${path}.${name}`);
        // A JSON Schema `default` documents the value the TOOL applies when the
        // arg is absent — it must NOT become a zod default, or the handler can no
        // longer tell "caller omitted it" from "caller passed the default", and
        // the tool's own fallback logic (which is where the real default lives)
        // gets bypassed. The cost is that `default` doesn't survive into the
        // emitted schema, so every default is also stated in the description
        // where an agent reading tools/list will still see it.
        if (!required.has(name)) node = node.optional();
        out[name] = node;
    }
    return out;
}

/**
 * The zod *shape* for a tool's inputSchema — v2's registerTool accepts a raw
 * shape ({ field: z.string() }) as well as a z.object, and the shape form keeps
 * the emitted schema flat.
 */
export function toZodShape(inputSchema, toolName) {
    if (!inputSchema || inputSchema.type !== 'object') {
        throw new Error(`${toolName}: inputSchema must be an object schema`);
    }
    return shape(inputSchema, toolName);
}

/** Human-readable one-line summary of a schema, for docs/debugging. */
export function summarize(inputSchema) {
    const required = new Set(inputSchema.required ?? []);
    return Object.entries(inputSchema.properties ?? {})
        .map(([n, s]) => `${n}${required.has(n) ? '' : '?'}:${s.type ?? 'enum'}`)
        .join(', ');
}
