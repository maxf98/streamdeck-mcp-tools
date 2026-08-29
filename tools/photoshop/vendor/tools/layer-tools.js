import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createLayerTools(connection) {
    return [
        {
            tool: {
                name: 'create_layer',
                description: 'Create a new empty layer above the active layer.\n\n' +
                    'Use when: user needs a blank layer for painting, fills, or stacking content.\n' +
                    'Do NOT use when: adding text — use create_text_layer.\n\n' +
                    'Returns: created layer name and context.\n' +
                    'Preconditions: active document. Side effects: adds layer to history.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Name for the new layer (optional)',
                        },
                    },
                },
            },
            handler: async (args) => createLayer(connection, args),
        },
        {
            tool: {
                name: 'delete_layer',
                description: 'Delete the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => deleteLayer(connection),
        },
        {
            tool: {
                name: 'create_text_layer',
                description: 'Create a text layer with content, position, font size, and optional font.\n\n' +
                    'Use when: adding labels, titles, or typography to the design.\n' +
                    'Do NOT use when: editing existing text — use update_text_content.\n\n' +
                    'Returns: layer name, text, position, fontSize, font (when fontName set), context.\n' +
                    'Use list_fonts to discover font names; set_text_font to change font later.\n' +
                    'Preconditions: active document. Side effects: adds text layer.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'Text content',
                        },
                        x: {
                            type: 'number',
                            description: 'X position in pixels (default: 100)',
                            default: 100,
                        },
                        y: {
                            type: 'number',
                            description: 'Y position in pixels (default: 100)',
                            default: 100,
                        },
                        fontSize: {
                            type: 'number',
                            description: 'Font size in points (default: 24)',
                            default: 24,
                        },
                        fontName: {
                            type: 'string',
                            description: 'Optional font display or PostScript name (resolved via app.fonts; see list_fonts)',
                        },
                    },
                    required: ['text'],
                },
            },
            handler: async (args) => createTextLayer(connection, args),
        },
        {
            tool: {
                name: 'fill_layer',
                description: 'Fill the active layer with a color',
                inputSchema: {
                    type: 'object',
                    properties: {
                        red: {
                            type: 'number',
                            description: 'Red component (0-255)',
                            minimum: 0,
                            maximum: 255,
                        },
                        green: {
                            type: 'number',
                            description: 'Green component (0-255)',
                            minimum: 0,
                            maximum: 255,
                        },
                        blue: {
                            type: 'number',
                            description: 'Blue component (0-255)',
                            minimum: 0,
                            maximum: 255,
                        },
                    },
                    required: ['red', 'green', 'blue'],
                },
            },
            handler: async (args) => fillLayer(connection, args),
        },
        {
            tool: {
                name: 'get_layers',
                description: 'List all layers in the active document with kind, visibility, and opacity.\n\n' +
                    'Use when: choosing a layer to edit, debugging structure, or after organize_layers.\n' +
                    'Do NOT use when: only session summary is needed — use get_state (lighter).\n\n' +
                    'Returns: layerCount, layers array, context.\n' +
                    'Preconditions: active document. Side effects: none.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => getLayers(connection),
        },
        {
            tool: {
                name: 'select_layer_by_name',
                description: 'Select the active layer by exact name, including layers inside groups.\n\n' +
                    'Use when: a transform or property tool must target a named layer (scale_layer, etc.).\n' +
                    'Do NOT use when: the layer is already active — check get_state first.\n\n' +
                    'Returns: selected, layerName, kind, bounds (best-effort), context.\n' +
                    'First depth-first name match wins when duplicate names exist in different groups.\n' +
                    'Preconditions: active document. Side effects: changes active layer.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Exact layer name (case-sensitive)',
                        },
                    },
                    required: ['name'],
                },
            },
            handler: async (args) => selectLayerByName(connection, args),
        },
    ];
}
async function createLayer(connection, args) {
    const name = args.name;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.newLayer(name);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer created${name ? `: ${name}` : ''}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error creating layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function deleteLayer(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.deleteLayer();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Layer deleted successfully',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error deleting layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function createTextLayer(connection, args) {
    const text = args.text;
    const x = args.x || 100;
    const y = args.y || 100;
    const fontSize = args.fontSize || 24;
    const fontName = args.fontName;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.createTextLayer(text, x, y, fontSize, fontName);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Text layer created: "${text}" at (${x}, ${y})${fontName ? ` with font ${fontName}` : ''}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error creating text layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function fillLayer(connection, args) {
    const red = args.red;
    const green = args.green;
    const blue = args.blue;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.fillLayer(red, green, blue);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer filled with RGB(${red}, ${green}, ${blue})`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error filling layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function getLayers(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.getLayerNames();
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layers:\n${JSON.stringify(result, null, 2)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error getting layers: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function selectLayerByName(connection, args) {
    const name = args.name;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.selectLayerByName(name);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer selected:\n${JSON.stringify(result, null, 2)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error selecting layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
