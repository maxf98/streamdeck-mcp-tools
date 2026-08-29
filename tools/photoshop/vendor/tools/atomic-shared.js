import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { classifyError } from '../errors/envelope.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
export async function runSnippet(connection, script) {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();
    return api.executeScript(script);
}
export function parseSnippetResult(raw) {
    const payload = parseExtendScriptPayload(raw);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    return payload;
}
export function atomicSuccess(summary, details, nextSuggestedTool = 'get_preview') {
    const body = {
        ok: true,
        summary,
        ...(details ? { details } : {}),
        next_suggested_tool: nextSuggestedTool,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    };
}
export function atomicFailure(envelope) {
    return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        isError: true,
    };
}
export function atomicFailureFromError(error, overrides) {
    const message = error instanceof Error ? error.message : String(error);
    const base = classifyError(message);
    return atomicFailure({
        ...base,
        ...overrides,
        message: overrides?.message ?? base.message,
    });
}
