import { ExtendScriptSnippets } from '../../api/extendscript.js';
import { getPhotoshopCapabilities } from '../../platform/capabilities.js';
import { PhotoshopAPIFactory } from '../../api/photoshop-api.js';
import { atomicFailure, atomicFailureFromError, atomicSuccess, parseSnippetResult, } from '../atomic-shared.js';
/** Generative cloud jobs may exceed the default 30s script timeout. */
export const GENERATIVE_SCRIPT_TIMEOUT_MS = 120_000;
export async function runGenerativeSnippet(connection, script) {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();
    return api.executeScript(script, GENERATIVE_SCRIPT_TIMEOUT_MS);
}
export async function requireGenerativeCapability(connection, feature) {
    const version = await connection.getVersion();
    const caps = getPhotoshopCapabilities(version);
    if (!caps.features[feature]) {
        return atomicFailure({
            ok: false,
            code: 'version_unsupported',
            message: `Photoshop ${version} does not expose ${feature}`,
            suggested_next_tool: 'get_capabilities',
        });
    }
    return null;
}
export function parseGenerativeResult(raw) {
    const parsed = parseSnippetResult(raw);
    if (!parsed) {
        return atomicFailureFromError(new Error(`Unparseable generative result: ${String(raw)}`));
    }
    if (parsed.ok === false) {
        const rawCode = typeof parsed.code === 'string' ? parsed.code : 'generative_unavailable';
        const allowed = [
            'generative_credits_exhausted',
            'generative_no_selection',
            'generative_timeout',
            'generative_unavailable',
            'version_unsupported',
        ];
        const code = allowed.includes(rawCode)
            ? rawCode
            : 'generative_unavailable';
        const message = typeof parsed.message === 'string' ? parsed.message : 'Generative action failed';
        return atomicFailure({
            ok: false,
            code,
            message,
            suggested_next_tool: code === 'generative_no_selection'
                ? 'select_rectangle'
                : 'get_capabilities',
        });
    }
    const summary = typeof parsed.summary === 'string' ? parsed.summary : 'Generative action completed';
    const nextTool = typeof parsed.next_suggested_tool === 'string'
        ? parsed.next_suggested_tool
        : 'get_preview';
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
        ? parsed.details
        : undefined;
    return atomicSuccess(summary, details, nextTool);
}
export function clampGenerativeScale(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return n >= 4 ? 4 : 2;
}
export const GENERATIVE_EXPAND_DIRECTIONS = [
    'left',
    'right',
    'top',
    'bottom',
    'all',
];
export function normalizeExpandDirection(value) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : 'all';
    return GENERATIVE_EXPAND_DIRECTIONS.includes(raw)
        ? raw
        : 'all';
}
export { ExtendScriptSnippets };
