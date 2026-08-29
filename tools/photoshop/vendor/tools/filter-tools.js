import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
export function createFilterTools(connection) {
    return [
        {
            tool: {
                name: 'apply_gaussian_blur',
                description: 'Apply Gaussian Blur filter to the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        radius: {
                            type: 'number',
                            description: 'Blur radius in pixels (0.1-250)',
                            minimum: 0.1,
                            maximum: 250,
                        },
                    },
                    required: ['radius'],
                },
            },
            handler: async (args) => applyGaussianBlur(connection, args),
        },
        {
            tool: {
                name: 'apply_sharpen',
                description: 'Apply Unsharp Mask (sharpen) filter to the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        amount: {
                            type: 'number',
                            description: 'Sharpening amount in percent (1-500)',
                            minimum: 1,
                            maximum: 500,
                        },
                        radius: {
                            type: 'number',
                            description: 'Radius in pixels (0.1-250)',
                            minimum: 0.1,
                            maximum: 250,
                        },
                        threshold: {
                            type: 'number',
                            description: 'Threshold levels (0-255)',
                            minimum: 0,
                            maximum: 255,
                            default: 0,
                        },
                    },
                    required: ['amount', 'radius'],
                },
            },
            handler: async (args) => applySharpen(connection, args),
        },
        {
            tool: {
                name: 'apply_noise',
                description: 'Apply Add Noise filter to the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        amount: {
                            type: 'number',
                            description: 'Noise amount in percent (0.1-400)',
                            minimum: 0.1,
                            maximum: 400,
                        },
                        distribution: {
                            type: 'string',
                            description: 'Noise distribution type',
                            enum: ['UNIFORM', 'GAUSSIAN'],
                            default: 'UNIFORM',
                        },
                        monochromatic: {
                            type: 'boolean',
                            description: 'Apply monochromatic noise',
                            default: false,
                        },
                    },
                    required: ['amount'],
                },
            },
            handler: async (args) => applyNoise(connection, args),
        },
        {
            tool: {
                name: 'apply_motion_blur',
                description: 'Apply Motion Blur filter to the active layer',
                inputSchema: {
                    type: 'object',
                    properties: {
                        angle: {
                            type: 'number',
                            description: 'Blur angle in degrees (-360 to 360)',
                            minimum: -360,
                            maximum: 360,
                        },
                        radius: {
                            type: 'number',
                            description: 'Blur distance in pixels (1-999)',
                            minimum: 1,
                            maximum: 999,
                        },
                    },
                    required: ['angle', 'radius'],
                },
            },
            handler: async (args) => applyMotionBlur(connection, args),
        },
    ];
}
async function applyGaussianBlur(connection, args) {
    const radius = args.radius;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.applyGaussianBlur(radius);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Gaussian Blur applied with radius ${radius}px`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error applying Gaussian Blur: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function applySharpen(connection, args) {
    const amount = args.amount;
    const radius = args.radius;
    const threshold = args.threshold || 0;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.applyUnsharpMask(amount, radius, threshold);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Unsharp Mask applied: amount ${amount}%, radius ${radius}px, threshold ${threshold}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error applying sharpen: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function applyNoise(connection, args) {
    const amount = args.amount;
    const distribution = args.distribution || 'UNIFORM';
    const monochromatic = args.monochromatic || false;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.applyAddNoise(amount, distribution, monochromatic);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Add Noise applied: ${amount}% (${distribution}${monochromatic ? ', monochromatic' : ''})`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error applying noise: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
async function applyMotionBlur(connection, args) {
    const angle = args.angle;
    const radius = args.radius;
    try {
        const apiFactory = new PhotoshopAPIFactory(connection);
        const api = await apiFactory.createAPI();
        const script = ExtendScriptSnippets.applyMotionBlur(angle, radius);
        await api.executeScript(script);
        return {
            content: [
                {
                    type: 'text',
                    text: `Motion Blur applied: angle ${angle}°, radius ${radius}px`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error applying motion blur: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}
