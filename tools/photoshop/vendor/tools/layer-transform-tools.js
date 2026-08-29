import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createLayerTransformTools(connection) {
    return [
        {
            tool: {
                name: 'fit_layer_to_document',
                description: 'Scale the active layer to fit the document canvas while maintaining aspect ratio',
                inputSchema: {
                    type: 'object',
                    properties: {
                        fillDocument: {
                            type: 'boolean',
                            description: 'If true, fills entire canvas (may crop). If false, fits within canvas (may have margins). Default: false',
                            default: false,
                        },
                    },
                },
            },
            handler: async (args) => fitLayerToDocument(connection, args),
        },
        {
            tool: {
                name: 'scale_layer',
                description: 'Scale the active layer by a percentage',
                inputSchema: {
                    type: 'object',
                    properties: {
                        scalePercent: {
                            type: 'number',
                            description: 'Scale percentage (e.g., 50 for 50%, 200 for 200%)',
                            minimum: 1,
                        },
                        centerAnchor: {
                            type: 'boolean',
                            description: 'Scale from center (true) or top-left (false). Default: true',
                            default: true,
                        },
                    },
                    required: ['scalePercent'],
                },
            },
            handler: async (args) => scaleLayer(connection, args),
        },
        {
            tool: {
                name: 'move_layer',
                description: 'Move the active layer by specified offset',
                inputSchema: {
                    type: 'object',
                    properties: {
                        deltaX: {
                            type: 'number',
                            description: 'Horizontal offset in pixels (can be negative)',
                        },
                        deltaY: {
                            type: 'number',
                            description: 'Vertical offset in pixels (can be negative)',
                        },
                    },
                    required: ['deltaX', 'deltaY'],
                },
            },
            handler: async (args) => moveLayer(connection, args),
        },
        {
            tool: {
                name: 'rotate_layer',
                description: 'Rotate the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        degrees: {
                            type: 'number',
                            description: 'Rotation angle in degrees (positive = clockwise, negative = counter-clockwise)',
                        },
                    },
                    required: ['degrees'],
                },
            },
            handler: async (args) => rotateLayer(connection, args),
        },
    ];
}
async function fitLayerToDocument(connection, args) {
    const fillDocument = args.fillDocument || false;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.fitLayerToDocument(fillDocument);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer ${fillDocument ? 'filled' : 'fitted'} to document\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error fitting layer to document: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function scaleLayer(connection, args) {
    const scalePercent = args.scalePercent;
    const centerAnchor = args.centerAnchor !== undefined ? args.centerAnchor : true;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.scaleLayer(scalePercent, centerAnchor);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer scaled to ${scalePercent}%\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error scaling layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function moveLayer(connection, args) {
    const deltaX = args.deltaX;
    const deltaY = args.deltaY;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.moveLayer(deltaX, deltaY);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer moved by (${deltaX}, ${deltaY})px\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error moving layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function rotateLayer(connection, args) {
    const degrees = args.degrees;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.rotateLayer(degrees);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer rotated ${degrees} degrees\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error rotating layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
