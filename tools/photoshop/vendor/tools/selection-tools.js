import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
import { PhotoshopDetector } from '../platform/detector.js';
import { atomicFailure, atomicFailureFromError, atomicSuccess, parseSnippetResult, runSnippet, } from './atomic-shared.js';
export function createSelectionTools(connection) {
    return [
        {
            tool: {
                name: 'select_rectangle',
                description: 'Create a rectangular pixel selection from corner coordinates.\n\n' +
                    'Use when: masking, cropping a region, or preparing for layer mask.\n' +
                    'Do NOT use when: subject isolation is needed — use recipe_remove_background.\n\n' +
                    'Returns: selection bounds [left, top, right, bottom].\n' +
                    'Preconditions: active document. Side effects: replaces current selection.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        left: {
                            type: 'number',
                            description: 'Left edge in pixels',
                        },
                        top: {
                            type: 'number',
                            description: 'Top edge in pixels',
                        },
                        right: {
                            type: 'number',
                            description: 'Right edge in pixels',
                        },
                        bottom: {
                            type: 'number',
                            description: 'Bottom edge in pixels',
                        },
                    },
                    required: ['left', 'top', 'right', 'bottom'],
                },
            },
            handler: async (args) => selectRectangle(connection, args),
        },
        {
            tool: {
                name: 'select_all',
                description: 'Select the entire document',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => selectAll(connection),
        },
        {
            tool: {
                name: 'deselect',
                description: 'Deselect all selections',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => deselect(connection),
        },
        {
            tool: {
                name: 'invert_selection',
                description: 'Invert the current selection',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => invertSelection(connection),
        },
        {
            tool: {
                name: 'create_layer_mask',
                description: 'Create a layer mask on the active layer from the current selection (reveal selection).\n\n' +
                    'Users often say: mask this, hide the background, non-destructive cutout (after selection).\n\n' +
                    'Use when: non-destructive hide/show after a selection exists.\n' +
                    'Do NOT use when: no selection exists — create selection first or use remove_background recipe.\n\n' +
                    'Returns: maskCreated confirmation.\n' +
                    'Preconditions: active document and active selection. Side effects: adds mask to active layer.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => createLayerMask(connection),
        },
        {
            tool: {
                name: 'delete_layer_mask',
                description: 'Delete the layer mask from active layer',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => deleteLayerMask(connection),
        },
        {
            tool: {
                name: 'apply_layer_mask',
                description: 'Apply (merge) the layer mask to the layer',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => applyLayerMask(connection),
        },
        {
            tool: {
                name: 'select_subject',
                description: 'Run Select Subject on the active layer (creates a pixel selection only, no mask).\n\n' +
                    'Users often say: cut out, isolate subject, select person, select object.\n\n' +
                    'Use when: you need a subject selection for masking, fill, or further edits.\n' +
                    'Do NOT use when: full background removal with mask — use recipe_remove_background.\n\n' +
                    'Returns: JSON { ok, summary, details: { selected, method } }.\n' +
                    'Preconditions: PS ≥ 23, active document, non-Background active layer with a recognizable subject.\n' +
                    'Side effects: replaces current selection.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sample_all_layers: {
                            type: 'boolean',
                            description: 'Sample all layers for autoCutout fallback (default false)',
                            default: false,
                        },
                    },
                },
            },
            handler: async (args) => selectSubject(connection, args),
        },
        {
            tool: {
                name: 'content_aware_fill',
                description: 'Fill the current pixel selection using Content-Aware Fill.\n\n' +
                    'Users often say: remove distraction, erase object, content aware fill, inpaint selection.\n\n' +
                    'Use when: a rectangular or other selection covers the area to remove/replace.\n' +
                    'Do NOT use when: no selection exists — use select_rectangle first.\n' +
                    'Do NOT use when: generative remove is requested — not scriptable; use this fill or manual touch-up.\n\n' +
                    'Returns: JSON { ok, summary, details: { filled } }.\n' +
                    'Preconditions: active document and active pixel selection.\n' +
                    'Side effects: modifies pixels inside selection; deselects afterward.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => contentAwareFill(connection),
        },
    ];
}
async function selectRectangle(connection, args) {
    const left = args.left;
    const top = args.top;
    const right = args.right;
    const bottom = args.bottom;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.selectRectangle(left, top, right, bottom);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Rectangular selection created: (${left}, ${top}) to (${right}, ${bottom})`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error creating selection: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function selectAll(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.selectAll();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'All selected',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error selecting all: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function deselect(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.deselect();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Selection cleared',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error deselecting: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function invertSelection(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.invertSelection();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Selection inverted',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error inverting selection: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function createLayerMask(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.createLayerMask();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Layer mask created from selection',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error creating layer mask: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function deleteLayerMask(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.deleteLayerMask();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Layer mask deleted',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error deleting layer mask: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function applyLayerMask(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.applyLayerMask();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Layer mask applied (merged to layer)',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error applying layer mask: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function selectSubject(connection, args) {
    const sampleAllLayers = args.sample_all_layers === true;
    await connection.ping().catch(() => undefined);
    const info = connection.getPhotoshopInfo();
    if (info) {
        const detector = new PhotoshopDetector();
        if (!detector.supportsSelectSubjectV2(info.version)) {
            return atomicFailure({
                ok: false,
                code: 'version_unsupported',
                message: `Select Subject v2 requires Photoshop 23.0+; detected version ${info.version}. Upgrade Photoshop or select manually.`,
                suggested_next_tool: 'get_capabilities',
            });
        }
    }
    try {
        const raw = await runSnippet(connection, ExtendScriptSnippets.selectSubject(sampleAllLayers));
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Snippet returned unparseable payload: ${String(raw)}`));
        }
        const method = typeof parsed.method === 'string' ? parsed.method : 'selectSubject';
        return atomicSuccess(`Subject selected via ${method}`, parsed);
    }
    catch (error) {
        return atomicFailureFromError(error);
    }
}
async function contentAwareFill(connection) {
    try {
        const raw = await runSnippet(connection, ExtendScriptSnippets.contentAwareFill());
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Snippet returned unparseable payload: ${String(raw)}`));
        }
        return atomicSuccess('Content-aware fill applied', parsed);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/selection_required/i.test(message)) {
            return atomicFailure({
                ok: false,
                code: 'selection_required',
                message: 'Active pixel selection required before content-aware fill',
                suggested_next_tool: 'select_rectangle',
            });
        }
        return atomicFailureFromError(error);
    }
}
