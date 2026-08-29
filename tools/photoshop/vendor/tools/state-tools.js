import { readFile, unlink } from 'node:fs/promises';
import { ExtendScriptSnippets } from '../api/extendscript.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { resolvePhotoshopCapabilities } from '../platform/capabilities.js';
import { envelopeToToolResult, classifyError } from '../errors/envelope.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
async function runScript(connection, script) {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();
    return api.executeScript(script);
}
export function createStateTools(connection) {
    return [
        {
            tool: {
                name: 'get_state',
                description: 'Return a cheap read-only snapshot of Photoshop session state (active document, layer, selection).\n\n' +
                    'Use when: before any tool that needs an active document/layer, or after an error to recover context.\n' +
                    'Do NOT use when: you only need a visual preview — use get_preview instead.\n\n' +
                    'Returns: JSON with hasDocument, document dimensions/colorMode, activeLayer kind/name, hasSelection.\n' +
                    'Preconditions: none (safe on empty session). Side effects: none.',
                inputSchema: { type: 'object', properties: {} },
            },
            handler: async () => getState(connection),
        },
        {
            tool: {
                name: 'get_preview',
                description: 'Export the active document as a base64 JPEG preview for visual verification.\n\n' +
                    'Use when: after visual edits to confirm result before reporting success to the user.\n' +
                    'Do NOT use when: you only need numeric state — use get_state (much cheaper).\n\n' +
                    'Returns: MCP image content block (JPEG) plus metadata text.\n' +
                    'Preconditions: active document required. Side effects: creates and deletes a temp file; does not modify the document.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        max_dimension_px: {
                            type: 'number',
                            description: 'Maximum long edge in pixels (default 1024)',
                            default: 1024,
                        },
                        quality: {
                            type: 'number',
                            description: 'JPEG quality 1–12 (default 8)',
                            minimum: 1,
                            maximum: 12,
                            default: 8,
                        },
                    },
                },
            },
            handler: async (args) => getPreview(connection, args),
        },
        {
            tool: {
                name: 'get_capabilities',
                description: 'Return version-aware feature flags for the installed Photoshop (Select Subject v2, Generative Fill, etc.).\n\n' +
                    'Use when: once per session before suggesting AI-powered features or gated recipes.\n' +
                    'Do NOT use when: Photoshop version is already known from get_version.\n\n' +
                    'Returns: JSON { version, features: { select_subject_v2, generative_fill, ... } }.\n' +
                    'Preconditions: none. Side effects: none.',
                inputSchema: { type: 'object', properties: {} },
            },
            handler: async () => getCapabilities(connection),
        },
    ];
}
async function getState(connection) {
    try {
        const raw = await runScript(connection, ExtendScriptSnippets.getState());
        const result = parseExtendScriptPayload(raw);
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (error) {
        return envelopeToToolResult(classifyError(error instanceof Error ? error.message : String(error)));
    }
}
async function getPreview(connection, args) {
    const maxDimension = args.max_dimension_px || 1024;
    const quality = args.quality || 8;
    let tempPath;
    try {
        const result = (await runScript(connection, ExtendScriptSnippets.exportPreview(maxDimension, quality)));
        tempPath = result.path;
        const buffer = await readFile(tempPath);
        if (buffer.byteLength > PREVIEW_MAX_BYTES) {
            return envelopeToToolResult(classifyError(`Preview exceeds ${PREVIEW_MAX_BYTES} byte limit (${buffer.byteLength} bytes). Lower max_dimension_px or quality.`));
        }
        const base64 = buffer.toString('base64');
        return {
            content: [
                {
                    type: 'image',
                    data: base64,
                    mimeType: result.mimeType || 'image/jpeg',
                },
                {
                    type: 'text',
                    text: JSON.stringify({
                        ok: true,
                        width: result.width,
                        height: result.height,
                        bytes: buffer.byteLength,
                    }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return envelopeToToolResult(classifyError(error instanceof Error ? error.message : String(error)));
    }
    finally {
        if (tempPath) {
            await unlink(tempPath).catch(() => undefined);
        }
    }
}
async function getCapabilities(connection) {
    try {
        const version = await connection.getVersion();
        const capabilities = await resolvePhotoshopCapabilities(version);
        return {
            content: [{ type: 'text', text: JSON.stringify(capabilities, null, 2) }],
        };
    }
    catch (error) {
        return envelopeToToolResult(classifyError(error instanceof Error ? error.message : String(error)));
    }
}
