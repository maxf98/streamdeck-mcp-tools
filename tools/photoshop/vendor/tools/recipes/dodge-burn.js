import { executeRecipe } from './_shared.js';
const TOOL_NAME = 'recipe_dodge_burn';
const BLEND_MODE_OPTIONS = ['overlay', 'soft_light'];
const BLEND_MODE_BY_ARG = {
    overlay: 'OVERLAY',
    soft_light: 'SOFTLIGHT',
};
export function bindDodgeBurn(connection) {
    return {
        tool: {
            name: TOOL_NAME,
            description: 'One-shot dodge & burn setup: creates a 50% gray layer in Overlay or Soft Light mode for non-destructive light sculpting. Wrapped in a single undoable history step.\n' +
                '\n' +
                'Users often say: dodge and burn, sculpt light, lighten face, darken shadows.\n' +
                '\n' +
                'Use when: the user wants a ready-to-paint dodge & burn layer above the subject.\n' +
                'Do NOT use when: the user wants automated retouch — this only sets up the paint layer; paint white (dodge) and black (burn) manually at low opacity.\n' +
                'Do NOT use when: automated portrait smoothing is enough — use recipe_enhance_portrait instead.\n' +
                '\n' +
                'Returns: { ok, summary, undo_history_states_consumed, details: { layer_name, blend_mode } }.\n' +
                '\n' +
                'Preconditions: active document with a raster-compatible active layer.\n' +
                'Side effects: adds one "Dodge & Burn" layer above the active layer; one undo reverts.',
            inputSchema: {
                type: 'object',
                properties: {
                    blend_mode: {
                        type: 'string',
                        description: 'Retouch blend mode: overlay (default, stronger) or soft_light (gentler)',
                        enum: [...BLEND_MODE_OPTIONS],
                        default: 'overlay',
                    },
                },
            },
        },
        handler: async (args) => runDodgeBurn(connection, args),
    };
}
async function runDodgeBurn(connection, args) {
    const blendArg = parseBlendMode(args.blend_mode);
    const blendMode = BLEND_MODE_BY_ARG[blendArg];
    const body = `
    var doc = app.activeDocument;
    try {
      __mcp_ensureRasterActiveLayer();
    } catch (eRaster) {
      return { ok: false, code: 'no_active_layer', message: eRaster.message || String(eRaster), suggested_next_tool: 'rasterize_layer' };
    }

    var db = doc.artLayers.add();
    db.name = 'Dodge & Burn';

    var color = new SolidColor();
    color.rgb.red = 128;
    color.rgb.green = 128;
    color.rgb.blue = 128;

    doc.activeLayer = db;
    doc.selection.selectAll();
    doc.selection.fill(color);
    doc.selection.deselect();

    db.blendMode = BlendMode.${blendMode};

    return {
      ok: true,
      summary: 'Dodge & Burn layer ready in ${blendArg.replace(/_/g, ' ')} mode — paint white to lighten, black to darken',
      undo_history_states_consumed: 1,
      next_suggested_tool: 'get_preview',
      details: {
        layer_name: db.name,
        blend_mode: '${blendArg}'
      }
    };
  `;
    return executeRecipe(connection, 'Dodge & Burn', body);
}
function parseBlendMode(raw) {
    if (typeof raw !== 'string')
        return 'overlay';
    const v = raw.trim().toLowerCase();
    return BLEND_MODE_OPTIONS.find((o) => o === v) ?? 'overlay';
}
