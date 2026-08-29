import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createLayerPropertiesTools(connection) {
    return [
        {
            tool: {
                name: 'rasterize_layer',
                description: 'Rasterize the active layer (convert text/smart object to normal layer)',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => rasterizeLayer(connection),
        },
        {
            tool: {
                name: 'set_layer_opacity',
                description: 'Set the opacity of the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        opacity: {
                            type: 'number',
                            description: 'Opacity value (0-100)',
                            minimum: 0,
                            maximum: 100,
                        },
                    },
                    required: ['opacity'],
                },
            },
            handler: async (args) => setLayerOpacity(connection, args),
        },
        {
            tool: {
                name: 'set_layer_blend_mode',
                description: 'Set the blend mode of the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        blendMode: {
                            type: 'string',
                            description: 'Blend mode name',
                            enum: [
                                'NORMAL',
                                'DISSOLVE',
                                'DARKEN',
                                'MULTIPLY',
                                'COLORBURN',
                                'LINEARBURN',
                                'DARKERCOLOR',
                                'LIGHTEN',
                                'SCREEN',
                                'COLORDODGE',
                                'LINEARDODGE',
                                'LIGHTERCOLOR',
                                'OVERLAY',
                                'SOFTLIGHT',
                                'HARDLIGHT',
                                'VIVIDLIGHT',
                                'LINEARLIGHT',
                                'PINLIGHT',
                                'HARDMIX',
                                'DIFFERENCE',
                                'EXCLUSION',
                                'SUBTRACT',
                                'DIVIDE',
                                'HUE',
                                'SATURATION',
                                'COLOR',
                                'LUMINOSITY',
                            ],
                        },
                    },
                    required: ['blendMode'],
                },
            },
            handler: async (args) => setLayerBlendMode(connection, args),
        },
        {
            tool: {
                name: 'set_layer_visibility',
                description: 'Show or hide the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        visible: {
                            type: 'boolean',
                            description: 'Whether the layer should be visible',
                        },
                    },
                    required: ['visible'],
                },
            },
            handler: async (args) => setLayerVisibility(connection, args),
        },
        {
            tool: {
                name: 'set_layer_locked',
                description: 'Lock or unlock the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        locked: {
                            type: 'boolean',
                            description: 'Whether the layer should be locked',
                        },
                    },
                    required: ['locked'],
                },
            },
            handler: async (args) => setLayerLocked(connection, args),
        },
        {
            tool: {
                name: 'rename_layer',
                description: 'Rename the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'New name for the layer',
                        },
                    },
                    required: ['name'],
                },
            },
            handler: async (args) => renameLayer(connection, args),
        },
        {
            tool: {
                name: 'duplicate_layer',
                description: 'Duplicate the active layer. The duplicate becomes the active layer; ' +
                    'returns its name and, when available, its layer id.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        newName: {
                            type: 'string',
                            description: 'Name for the duplicated layer (optional)',
                        },
                    },
                },
            },
            handler: async (args) => duplicateLayer(connection, args),
        },
        {
            tool: {
                name: 'merge_visible_layers',
                description: 'Merge all visible layers into one',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => mergeVisibleLayers(connection),
        },
        {
            tool: {
                name: 'flatten_image',
                description: 'Flatten all layers into a single background layer',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => flattenImage(connection),
        },
    ];
}
async function setLayerOpacity(connection, args) {
    const opacity = args.opacity;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setLayerOpacity(opacity);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer opacity set to ${opacity}%`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error setting layer opacity: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function setLayerBlendMode(connection, args) {
    const blendMode = args.blendMode;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setLayerBlendMode(blendMode);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer blend mode set to ${blendMode}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error setting blend mode: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function setLayerVisibility(connection, args) {
    const visible = args.visible;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setLayerVisibility(visible);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer ${visible ? 'shown' : 'hidden'}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error setting layer visibility: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function setLayerLocked(connection, args) {
    const locked = args.locked;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setLayerLocked(locked);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer ${locked ? 'locked' : 'unlocked'}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error locking/unlocking layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function renameLayer(connection, args) {
    const name = args.name;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.renameLayer(name);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer renamed to: ${name}\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error renaming layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function duplicateLayer(connection, args) {
    const newName = args.newName;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.duplicateLayer(newName);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer duplicated\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error duplicating layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function mergeVisibleLayers(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.mergeVisibleLayers();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'All visible layers merged',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error merging visible layers: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function flattenImage(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.flattenImage();
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Image flattened (all layers merged to background)',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error flattening image: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function rasterizeLayer(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.rasterizeLayer();
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Layer rasterized\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error rasterizing layer: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
