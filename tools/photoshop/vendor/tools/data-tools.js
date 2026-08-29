import { ExtendScriptSnippets } from '../api/extendscript.js';
import { atomicFailureFromError, atomicSuccess, parseSnippetResult, runSnippet, } from './atomic-shared.js';
const EXPORT_FORMATS = ['JPEG', 'PNG', 'PSD'];
export function createDataTools(connection) {
    return [
        {
            tool: {
                name: 'list_datasets',
                description: 'List the data sets defined on the active document (Image > Variables > Data Sets).\n\n' +
                    'Use when: before applying data sets or debugging a data-driven template.\n\n' +
                    'Returns: JSON { ok, summary, details: { datasets, active, count } }.\n' +
                    'Preconditions: active document with variables/data sets defined.',
                inputSchema: { type: 'object', properties: {} },
            },
            handler: async () => listDataSets(connection),
        },
        {
            tool: {
                name: 'import_datasets',
                description: 'Import a Photoshop variables/data-sets XML file into the active document (the same file Image > Variables > Data Sets > Import accepts).\n\n' +
                    'Users often say: load data sets, import variables XML, data-driven graphics.\n\n' +
                    'Use when: the template PSD already has variable-bound layers and you want to load rows from an XML file.\n' +
                    'Do NOT use when: generating a batch from a CSV directly — use recipe_csv_to_cards.\n\n' +
                    'Returns: JSON { ok, summary, details: { count, datasets } }.\n' +
                    'Preconditions: active document with variables defined (Image > Variables > Define).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        xml_path: { type: 'string', description: 'Absolute path to the variables/data-sets XML file' },
                    },
                    required: ['xml_path'],
                },
            },
            handler: async (args) => importDataSets(connection, args),
        },
        {
            tool: {
                name: 'generate_from_datasets',
                description: 'Batch-export the active document once per data set: applies each data set, saves a copy, moves on. "Mail merge for images".\n\n' +
                    'Users often say: generate all variants, batch personalize, render every row.\n\n' +
                    'Use when: data sets are already imported (import_datasets) and you want one file per row.\n\n' +
                    'Returns: JSON { ok, summary, details: { exported, skipped, output_paths } }.\n' +
                    'Preconditions: active document with data sets. Side effects: writes files to output_dir.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        output_dir: { type: 'string', description: 'Directory for generated files (created if missing)' },
                        format: { type: 'string', enum: EXPORT_FORMATS, description: 'Output format', default: 'JPEG' },
                        dataset_names: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Subset of data set names to export (default: all)',
                        },
                    },
                    required: ['output_dir'],
                },
            },
            handler: async (args) => generateFromDataSets(connection, args),
        },
    ];
}
async function listDataSets(connection) {
    try {
        const raw = await runSnippet(connection, ExtendScriptSnippets.listDataSets());
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Unparseable datasets result: ${String(raw)}`));
        }
        const count = typeof parsed.count === 'number' ? parsed.count : 0;
        return atomicSuccess(`${count} data set(s) on active document`, parsed, 'generate_from_datasets');
    }
    catch (error) {
        return atomicFailureFromError(error);
    }
}
async function importDataSets(connection, args) {
    const xmlPath = typeof args.xml_path === 'string' ? args.xml_path.trim() : '';
    if (!xmlPath) {
        return atomicFailureFromError(new Error('xml_path parameter is required'));
    }
    try {
        const raw = await runSnippet(connection, ExtendScriptSnippets.importDataSets(xmlPath));
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Unparseable import result: ${String(raw)}`));
        }
        const count = typeof parsed.count === 'number' ? parsed.count : 0;
        return atomicSuccess(`Imported ${count} data set(s)`, parsed, 'generate_from_datasets');
    }
    catch (error) {
        return atomicFailureFromError(error);
    }
}
async function generateFromDataSets(connection, args) {
    const outputDir = typeof args.output_dir === 'string' ? args.output_dir.trim() : '';
    if (!outputDir) {
        return atomicFailureFromError(new Error('output_dir parameter is required'));
    }
    const format = EXPORT_FORMATS.includes(args.format)
        ? args.format
        : 'JPEG';
    let names = [];
    if (Array.isArray(args.dataset_names)) {
        names = args.dataset_names.filter((n) => typeof n === 'string');
    }
    else {
        const listed = await runSnippet(connection, ExtendScriptSnippets.listDataSets());
        const parsed = parseSnippetResult(listed);
        if (parsed && Array.isArray(parsed.datasets)) {
            names = parsed.datasets.filter((n) => typeof n === 'string');
        }
    }
    if (names.length === 0) {
        return atomicFailureFromError(new Error('No data sets to export — import a variables XML first'));
    }
    try {
        const raw = await runSnippet(connection, ExtendScriptSnippets.applyDataSetsExport(outputDir, format, names));
        const parsed = parseSnippetResult(raw);
        if (!parsed) {
            return atomicFailureFromError(new Error(`Unparseable dataset export result: ${String(raw)}`));
        }
        if (parsed.ok === false) {
            return atomicFailureFromError(new Error(String(parsed.message || 'Data set export failed')));
        }
        const exported = typeof parsed.exported === 'number' ? parsed.exported : 0;
        return atomicSuccess(`Exported ${exported} file(s) from data sets`, parsed);
    }
    catch (error) {
        return atomicFailureFromError(error);
    }
}
