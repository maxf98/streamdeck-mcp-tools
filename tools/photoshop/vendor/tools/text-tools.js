import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createTextTools(connection) {
    return [
        {
            tool: {
                name: 'list_fonts',
                description: 'List installed fonts available to Photoshop.\n\n' +
                    'Use when: choosing a font for create_text_layer or set_text_font.\n' +
                    'TextItem.font requires the PostScript name — use postScriptName from results, or pass display name to set/create tools (they resolve automatically).\n\n' +
                    'Returns: fonts array ({ name, postScriptName, family, style }), total count, truncated flag.\n' +
                    'First call may be slow (app.fonts.length can exceed 1000). Side effects: none.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Optional substring filter (matches name, postScriptName, or family)',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum fonts to return (default: 200)',
                            default: 200,
                            minimum: 1,
                            maximum: 1000,
                        },
                    },
                },
            },
            handler: async (args) => listFonts(connection, args),
        },
        {
            tool: {
                name: 'set_text_font',
                description: 'Set font family and size for active text layer.\n\n' +
                    'Accepts display name (e.g. "Arial") or PostScript name (e.g. "ArialMT") — resolved via app.fonts.\n' +
                    'Use list_fonts to discover available fonts.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        fontName: {
                            type: 'string',
                            description: 'Font display or PostScript name (see list_fonts)',
                        },
                        fontSize: {
                            type: 'number',
                            description: 'Font size in points (optional)',
                            minimum: 1,
                        },
                    },
                    required: ['fontName'],
                },
            },
            handler: async (args) => setTextFont(connection, args),
        },
        {
            tool: {
                name: 'set_text_color',
                description: 'Set color for active text layer',
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
            handler: async (args) => setTextColor(connection, args),
        },
        {
            tool: {
                name: 'set_text_alignment',
                description: 'Set text alignment for active text layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        alignment: {
                            type: 'string',
                            description: 'Text alignment',
                            enum: ['LEFT', 'CENTER', 'RIGHT', 'LEFTJUSTIFIED', 'CENTERJUSTIFIED', 'RIGHTJUSTIFIED', 'FULLYJUSTIFIED'],
                        },
                    },
                    required: ['alignment'],
                },
            },
            handler: async (args) => setTextAlignment(connection, args),
        },
        {
            tool: {
                name: 'update_text_content',
                description: 'Update the text content of active text layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'New text content',
                        },
                    },
                    required: ['text'],
                },
            },
            handler: async (args) => updateTextContent(connection, args),
        },
    ];
}
async function listFonts(connection, args) {
    const query = args.query;
    const limit = args.limit ?? 200;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.listFonts(query, limit);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Fonts listed${query ? ` (query: "${query}")` : ''}\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error listing fonts: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function setTextFont(connection, args) {
    const fontName = args.fontName;
    const fontSize = args.fontSize;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setTextFont(fontName, fontSize);
        const result = await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Text font set to ${fontName}${fontSize ? `, size ${fontSize}pt` : ''}\nResult: ${JSON.stringify(result)}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error setting text font: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function setTextColor(connection, args) {
    const red = args.red;
    const green = args.green;
    const blue = args.blue;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setTextColor(red, green, blue);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Text color set to RGB(${red}, ${green}, ${blue})`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error setting text color: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function setTextAlignment(connection, args) {
    const alignment = args.alignment;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.setTextAlignment(alignment);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Text alignment set to ${alignment}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error setting text alignment: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function updateTextContent(connection, args) {
    const text = args.text;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.updateTextContent(text);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Text content updated to: "${text}"`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error updating text content: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
