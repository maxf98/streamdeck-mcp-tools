import { ExtendScriptSnippets } from '../api/extendscript.js';
import { clampInt } from './recipes/_shared.js';
import { atomicFailureFromError, atomicSuccess, parseSnippetResult, runSnippet, } from './atomic-shared.js';
const GRADIENT_DIRECTIONS = [
    'top_to_bottom',
    'bottom_to_top',
    'left_to_right',
    'right_to_left',
];
function parseGradientDirection(value) {
    if (typeof value === 'string' && GRADIENT_DIRECTIONS.includes(value)) {
        return value;
    }
    return 'bottom_to_top';
}
export function createMaskTools(connection) {
    return [
        {
            tool: {
                name: 'apply_gradient_mask',
                description: 'Apply a linear black-to-white gradient on the active layer mask channel (fade/blend).\n\n' +
                    'Users often say: fade into background, gradient mask, blend subject, soft edge fade.\n\n' +
                    'This paints on an existing layer mask — not a Gradient Fill layer.\n' +
                    'Use when: softening edges or fading a layer into the background through its mask.\n' +
                    'Do NOT use when: subject is not isolated — use recipe_remove_background or create_layer_mask first.\n\n' +
                    'Returns: JSON { ok, summary, details: { applied, direction, angle, mask_auto_created? } }.\n' +
                    'Preconditions: active document and active layer. Creates a reveal-all mask if none exists.\n' +
                    'Side effects: modifies layer mask pixels; two history steps when mask is auto-created.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        direction: {
                            type: 'string',
                            enum: GRADIENT_DIRECTIONS,
                            description: 'Gradient fade direction on the mask (default bottom_to_top)',
                            default: 'bottom_to_top',
                        },
                        start_pct: {
                            type: 'number',
                            description: 'Gradient start along fade axis (0-100)',
                            minimum: 0,
                            maximum: 100,
                            default: 0,
                        },
                        end_pct: {
                            type: 'number',
                            description: 'Gradient end along fade axis (0-100)',
                            minimum: 0,
                            maximum: 100,
                            default: 100,
                        },
                        angle_deg: {
                            type: 'number',
                            description: 'Override gradient angle in degrees (optional)',
                        },
                    },
                },
            },
            handler: async (args) => applyGradientMask(connection, args),
        },
    ];
}
async function applyGradientMask(connection, args) {
    const direction = parseGradientDirection(args.direction);
    const startPct = clampInt(args.start_pct, 0, 100, 0);
    const endPct = clampInt(args.end_pct, 0, 100, 100);
    const angleDeg = typeof args.angle_deg === 'number' ? args.angle_deg : undefined;
    const gradientScript = ExtendScriptSnippets.applyGradientMask(direction, startPct, endPct, angleDeg);
    let maskAutoCreated = false;
    try {
        const raw = await runSnippet(connection, gradientScript);
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Snippet returned unparseable payload: ${String(raw)}`));
        }
        return atomicSuccess('Gradient applied on layer mask', {
            ...parsed,
            mask_auto_created: false,
        });
    }
    catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/no layer mask/i.test(firstMessage)) {
            return atomicFailureFromError(firstError);
        }
    }
    try {
        const maskRaw = await runSnippet(connection, ExtendScriptSnippets.createLayerMask());
        const maskParsed = parseSnippetResult(maskRaw);
        if (maskParsed?.maskCreated === true) {
            maskAutoCreated = true;
        }
        const raw = await runSnippet(connection, gradientScript);
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Snippet returned unparseable payload: ${String(raw)}`));
        }
        return atomicSuccess('Gradient applied on layer mask', {
            ...parsed,
            mask_auto_created: maskAutoCreated,
        });
    }
    catch (error) {
        return atomicFailureFromError(error);
    }
}
