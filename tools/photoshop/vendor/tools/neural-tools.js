import { resolvePhotoshopCapabilities } from '../platform/capabilities.js';
import { invokeNeuralFilter, } from '../platform/uxp-bridge-client.js';
import { atomicFailure, atomicSuccess } from './atomic-shared.js';
const FILTER_KINDS = [
    'skin_smoothing',
    'harmonize',
    'depth_blur',
    'super_zoom',
    'colorize',
];
function clampPct(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
}
export function createNeuralTools(connection) {
    return [
        {
            tool: {
                name: 'neural_filter',
                description: 'Apply a Photoshop Neural Filter via the companion UXP bridge plugin.\n\n' +
                    'Use when: skin smoothing, harmonize composite layers, depth blur, super zoom, or colorizing B&W photos.\n' +
                    'Do NOT use when: uxp_bridge_reachable is false — install uxp-plugin per docs/development.md.\n\n' +
                    'Returns: { ok, summary, details }.\n' +
                    'Preconditions: UXP bridge plugin running in Photoshop; PS 22+.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filter: {
                            type: 'string',
                            enum: FILTER_KINDS,
                            description: 'Neural filter to apply',
                        },
                        smoothness: {
                            type: 'number',
                            description: 'Skin smoothing smoothness 0-100 (skin_smoothing only)',
                            minimum: 0,
                            maximum: 100,
                            default: 50,
                        },
                        blur: {
                            type: 'number',
                            description: 'Skin smoothing blur 0-100 (skin_smoothing only)',
                            minimum: 0,
                            maximum: 100,
                            default: 50,
                        },
                        reference_layer_id: {
                            type: 'number',
                            description: 'Layer id for harmonize reference (harmonize only)',
                        },
                    },
                    required: ['filter'],
                },
            },
            handler: async (args) => runNeuralFilter(connection, args),
        },
    ];
}
async function runNeuralFilter(connection, args) {
    const version = await connection.getVersion();
    const caps = await resolvePhotoshopCapabilities(version);
    if (!caps.features.neural_filters) {
        return atomicFailure({
            ok: false,
            code: 'uxp_bridge_unavailable',
            message: 'Neural Filters require the photoshop-mcp UXP bridge plugin. Load uxp-plugin/ via UXP Developer Tools.',
            suggested_next_tool: 'get_capabilities',
        });
    }
    const filterRaw = typeof args.filter === 'string' ? args.filter.trim() : '';
    if (!FILTER_KINDS.includes(filterRaw)) {
        return atomicFailure({
            ok: false,
            code: 'generative_unavailable',
            message: `filter must be one of: ${FILTER_KINDS.join(', ')}`,
        });
    }
    const filter = filterRaw;
    const params = {
        smoothness: clampPct(args.smoothness, 50),
        blur: clampPct(args.blur, 50),
        ...(typeof args.reference_layer_id === 'number'
            ? { reference_layer_id: args.reference_layer_id }
            : {}),
    };
    const result = await invokeNeuralFilter(filter, params);
    if (!result.ok) {
        return atomicFailure({
            ok: false,
            code: 'uxp_bridge_unavailable',
            message: result.error ?? 'Neural filter invocation failed',
            suggested_next_tool: 'get_capabilities',
        });
    }
    return atomicSuccess(`Neural filter "${filter}" applied via UXP bridge`, { filter, params, bridge: result.data }, 'get_preview');
}
