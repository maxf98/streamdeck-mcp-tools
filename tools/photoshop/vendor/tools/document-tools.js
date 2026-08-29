import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createDocumentTools(connection) {
    return [
        {
            tool: {
                name: 'create_document',
                description: 'Create a new empty Photoshop document with specified dimensions and color mode.\n\n' +
                    'Use when: starting a design from scratch or no document is open.\n' +
                    'Do NOT use when: opening an existing file — use open_image.\n\n' +
                    'Returns: created document id and name.\n' +
                    'Preconditions: none. Side effects: creates a new document and makes it active.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        width: {
                            type: 'number',
                            description: 'Document width in pixels',
                            minimum: 1,
                        },
                        height: {
                            type: 'number',
                            description: 'Document height in pixels',
                            minimum: 1,
                        },
                        resolution: {
                            type: 'number',
                            description: 'Document resolution in DPI (default: 72)',
                            default: 72,
                        },
                        colorMode: {
                            type: 'string',
                            description: 'Color mode (RGB, CMYK, Grayscale)',
                            enum: ['RGB', 'CMYK', 'Grayscale'],
                            default: 'RGB',
                        },
                    },
                    required: ['width', 'height'],
                },
            },
            handler: async (args) => createDocument(connection, args),
        },
        {
            tool: {
                name: 'get_document_info',
                description: 'Get information about the active Photoshop document',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => getDocumentInfo(connection),
        },
        {
            tool: {
                name: 'save_document',
                description: 'Save the active document to disk in PSD, JPEG, or PNG format.\n\n' +
                    'Use when: user requests export/save with a specific path and format.\n' +
                    'Do NOT use when: web-optimized resize+sharpen pipeline is needed — use recipe_prepare_for_web.\n\n' +
                    'Returns: confirmation with saved path and format.\n' +
                    'Preconditions: active document; path required. Side effects: writes file to disk.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Full path where to save the document',
                        },
                        format: {
                            type: 'string',
                            description: 'File format (PSD, JPEG, PNG)',
                            enum: ['PSD', 'JPEG', 'PNG'],
                            default: 'PSD',
                        },
                        quality: {
                            type: 'number',
                            description: 'Quality for JPEG (1-12, default: 8)',
                            minimum: 1,
                            maximum: 12,
                            default: 8,
                        },
                    },
                    required: ['path'],
                },
            },
            handler: async (args) => saveDocument(connection, args),
        },
        {
            tool: {
                name: 'close_document',
                description: 'Close the active Photoshop document',
                inputSchema: {
                    type: 'object',
                    properties: {
                        save: {
                            type: 'boolean',
                            description: 'Whether to save changes before closing',
                            default: false,
                        },
                    },
                },
            },
            handler: async (args) => closeDocument(connection, args),
        },
    ];
}
async function createDocument(connection, args) {
    const width = args.width;
    const height = args.height;
    const resolution = args.resolution || 72;
    const colorMode = args.colorMode || 'RGB';
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const colorModeMap = {
            RGB: 'NewDocumentMode.RGB',
            CMYK: 'NewDocumentMode.CMYK',
            Grayscale: 'NewDocumentMode.GRAYSCALE',
        };
        const script = ExtendScriptSnippets.newDocument(width, height, resolution, colorModeMap[colorMode] || 'NewDocumentMode.RGB');
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Document created: ${width}x${height}px at ${resolution}dpi (${colorMode})`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error creating document: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function getDocumentInfo(connection) {
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.getDocumentInfo();
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Document info:\n${JSON.stringify(result, null, 2)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function saveDocument(connection, args) {
    const path = args.path;
    const format = args.format || 'PSD';
    const quality = args.quality || 8;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        let script;
        switch (format.toUpperCase()) {
            case 'JPEG':
                script = ExtendScriptSnippets.saveAsJPEG(path, quality);
                break;
            case 'PNG':
                script = ExtendScriptSnippets.saveAsPNG(path);
                break;
            default:
                script = ExtendScriptSnippets.saveAsPSD(path);
        }
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Document saved as ${format} to: ${path}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error saving document: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function closeDocument(connection, args) {
    const save = args.save || false;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.closeDocument(save);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: save ? 'Document closed and saved' : 'Document closed without saving',
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error closing document: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
