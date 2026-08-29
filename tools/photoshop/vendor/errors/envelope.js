// Upstream reported every tool call to PostHog here. A local tool pack must not
// phone home, so the analytics import and its two call sites are removed rather
// than stubbed — nothing else in this file depended on them.
const ERROR_PATTERNS = [
    // ADAPTED: two failure modes this pack raises that upstream's executor never
    // did (lib/photoshop.mjs checks both before spending an Apple event). Without
    // these they fell through to code:'unknown' + "try get_state" — advice that
    // can only fail the same way. First, because nothing below should shadow them.
    { pattern: /photoshop is not installed/i, code: 'photoshop_not_installed' },
    { pattern: /photoshop is not running/i, code: 'photoshop_not_running', suggested_next_tool: 'ping' },
    { pattern: /no active document/i, code: 'no_active_document', suggested_next_tool: 'get_state' },
    { pattern: /no documents/i, code: 'no_active_document', suggested_next_tool: 'get_state' },
    { pattern: /no active layer/i, code: 'no_active_layer', suggested_next_tool: 'get_layers' },
    { pattern: /layer not found/i, code: 'layer_not_found', suggested_next_tool: 'get_layers' },
    { pattern: /selection/i, code: 'selection_required', suggested_next_tool: 'get_state' },
    { pattern: /version_unsupported|not supported.*version/i, code: 'version_unsupported', suggested_next_tool: 'get_capabilities' },
    { pattern: /generative.*credit|quota|sign in/i, code: 'generative_credits_exhausted', suggested_next_tool: 'get_capabilities' },
    { pattern: /generative.*timeout|timed out/i, code: 'generative_timeout', suggested_next_tool: 'get_preview' },
    { pattern: /generative_no_selection|selection required for generative/i, code: 'generative_no_selection', suggested_next_tool: 'select_rectangle' },
    { pattern: /uxp.?bridge|neural filter.*bridge/i, code: 'uxp_bridge_unavailable', suggested_next_tool: 'get_capabilities' },
    { pattern: /generative/i, code: 'generative_unavailable', suggested_next_tool: 'get_capabilities' },
    { pattern: /font_not_found/i, code: 'font_not_found', suggested_next_tool: 'list_fonts' },
    { pattern: /file not found|does not exist/i, code: 'file_not_found' },
    { pattern: /color mode/i, code: 'unsupported_color_mode', suggested_next_tool: 'get_document_info' },
];
export function classifyError(message) {
    for (const { pattern, code, suggested_next_tool } of ERROR_PATTERNS) {
        if (pattern.test(message)) {
            return {
                ok: false,
                code,
                message,
                ...(suggested_next_tool ? { suggested_next_tool } : {}),
            };
        }
    }
    return {
        ok: false,
        code: message.includes('ERROR:') ? 'extendscript_runtime_error' : 'unknown',
        message,
        suggested_next_tool: 'get_state',
    };
}
export function envelopeToToolResult(envelope) {
    return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        isError: true,
    };
}
export function enrichErrorResult(result) {
    const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    if (!text)
        return result;
    try {
        const parsed = JSON.parse(text);
        if (parsed.ok === false && parsed.code)
            return result;
    }
    catch {
        // not JSON — classify plain error text
    }
    if (text.startsWith('Error:') || text.toLowerCase().includes('error')) {
        const message = text.replace(/^Error:\s*/i, '').trim();
        return envelopeToToolResult(classifyError(message));
    }
    return result;
}
export function buildEnvelopeFromError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return envelopeToToolResult(classifyError(message));
}
function extractErrorCodeFromResult(result) {
    const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    if (!text)
        return 'unknown';
    try {
        const parsed = JSON.parse(text);
        if (parsed.ok === false && parsed.code)
            return parsed.code;
    }
    catch {
        // not JSON — fall through
    }
    return 'unknown';
}
export function wrapToolHandler(toolName, handler) {
    return async (args) => {
        try {
            let result = await handler(args);
            if (result.isError) {
                result = enrichErrorResult(result);
            }
            return result;
        }
        catch (error) {
            return buildEnvelopeFromError(error);
        }
    };
}
