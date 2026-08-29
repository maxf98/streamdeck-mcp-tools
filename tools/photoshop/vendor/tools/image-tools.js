import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createImageTools(connection) {
    return [
        {
            tool: {
                name: 'resize_image',
                description: 'Resize the active image to specified dimensions',
                inputSchema: {
                    type: 'object',
                    properties: {
                        width: {
                            type: 'number',
                            description: 'New width in pixels',
                            minimum: 1,
                        },
                        height: {
                            type: 'number',
                            description: 'New height in pixels',
                            minimum: 1,
                        },
                    },
                    required: ['width', 'height'],
                },
            },
            handler: async (args) => resizeImage(connection, args),
        },
        {
            tool: {
                name: 'crop_document',
                description: 'Crop the document to specified bounds',
                inputSchema: {
                    type: 'object',
                    properties: {
                        left: {
                            type: 'number',
                            description: 'Left edge position in pixels',
                            minimum: 0,
                        },
                        top: {
                            type: 'number',
                            description: 'Top edge position in pixels',
                            minimum: 0,
                        },
                        right: {
                            type: 'number',
                            description: 'Right edge position in pixels',
                            minimum: 1,
                        },
                        bottom: {
                            type: 'number',
                            description: 'Bottom edge position in pixels',
                            minimum: 1,
                        },
                    },
                    required: ['left', 'top', 'right', 'bottom'],
                },
            },
            handler: async (args) => cropDocument(connection, args),
        },
    ];
}
async function resizeImage(connection, args) {
    const width = args.width;
    const height = args.height;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.resizeImage(width, height);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Image resized to ${width}x${height}px`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error resizing image: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function cropDocument(connection, args) {
    const left = args.left;
    const top = args.top;
    const right = args.right;
    const bottom = args.bottom;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.cropDocument(left, top, right, bottom);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Document cropped\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error cropping document: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
