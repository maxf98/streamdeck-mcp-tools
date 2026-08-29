import { ExtendScriptSnippets } from '../api/extendscript.js';
import { atomicFailureFromError, atomicSuccess, parseSnippetResult, runSnippet, } from './atomic-shared.js';
const EXPORT_FORMATS = ['PNG', 'JPEG', 'WEBP', 'AVIF'];
export function createExportTools(connection) {
    return [
        {
            tool: {
                name: 'export_as',
                description: 'Export a copy of the active document as PNG, JPEG, WebP or AVIF without changing the open document. WebP/AVIF require Photoshop 23.2+/recent builds and return a clear error when unsupported.\n\n' +
                    'Users often say: export for web, save as webp, quick export png.\n\n' +
                    'Use when: web-ready delivery formats are needed (WebP/AVIF/modern pipelines).\n' +
                    'Do NOT use when: saving the working document itself — use save_document.\n\n' +
                    'Returns: JSON { ok, summary, details: { path, format, method } }.\n' +
                    'Preconditions: active document. Side effects: writes one file to path.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Absolute output file path (extension should match format)' },
                        format: { type: 'string', enum: EXPORT_FORMATS, description: 'Export format', default: 'PNG' },
                        quality: { type: 'number', description: 'Quality 0-100 (JPEG/WebP/AVIF)', minimum: 0, maximum: 100, default: 80 },
                    },
                    required: ['path'],
                },
            },
            handler: async (args) => exportAs(connection, args),
        },
    ];
}
async function exportAs(connection, args) {
    const filePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!filePath) {
        return atomicFailureFromError(new Error('path parameter is required'));
    }
    const format = EXPORT_FORMATS.includes(args.format)
        ? args.format
        : 'PNG';
    const quality = typeof args.quality === 'number' && Number.isFinite(args.quality)
        ? Math.max(0, Math.min(100, Math.round(args.quality)))
        : 80;
    try {
        const raw = await runSnippet(connection, ExtendScriptSnippets.exportAs(filePath, format, quality));
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Unparseable export result: ${String(raw)}`));
        }
        if (parsed.ok === false) {
            return atomicFailureFromError(new Error(String(parsed.message || 'Export failed')), {
                code: 'version_unsupported',
                suggested_next_tool: 'save_document',
            });
        }
        return atomicSuccess(`Exported ${format} to ${filePath}`, {
            path: filePath,
            format,
            method: parsed.method,
        });
    }
    catch (error) {
        return atomicFailureFromError(error);
    }
}
