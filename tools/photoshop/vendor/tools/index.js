/**
 * ADAPTER (not vendored) — one flat tool list from the vendored modules.
 *
 * Upstream registered these through a ToolRegistry class inside its server core;
 * this pack registers straight onto McpServer, so all that's needed is the
 * assembled list. A module that fails to load is fatal on purpose: a pack that
 * silently exposes 80 of its 102 tools is worse than one that won't start.
 */

import { createDocumentTools } from './document-tools.js';
import { createLayerTools } from './layer-tools.js';
import { createLayerOrderingTools } from './layer-ordering-tools.js';
import { createLayerPropertiesTools } from './layer-properties-tools.js';
import { createLayerTransformTools } from './layer-transform-tools.js';
import { createFilterTools } from './filter-tools.js';
import { createAdjustmentTools } from './adjustment-tools.js';
import { createColorAdjustmentTools } from './color-adjustment-tools.js';
import { createTextTools } from './text-tools.js';
import { createSelectionTools } from './selection-tools.js';
import { createMaskTools } from './mask-tools.js';
import { createHistoryTools } from './history-tools.js';
import { createActionTools } from './action-tools.js';
import { createImageTools } from './image-tools.js';
import { createImagePlacementTools } from './image-placement-tools.js';
import { createGenerativeTools } from './generative-tools.js';
import { createNeuralTools } from './neural-tools.js';
import { createStyleTools } from './style-tools.js';
import { createDataTools } from './data-tools.js';
import { createStackTools } from './stack-tools.js';
import { createStateTools } from './state-tools.js';
import { createExportTools } from './export-tools.js';
import { createRecipeTools } from './recipes/index.js';

const FACTORIES = [
    createDocumentTools,
    createLayerTools,
    createLayerOrderingTools,
    createLayerPropertiesTools,
    createLayerTransformTools,
    createFilterTools,
    createAdjustmentTools,
    createColorAdjustmentTools,
    createTextTools,
    createSelectionTools,
    createMaskTools,
    createHistoryTools,
    createActionTools,
    createImageTools,
    createImagePlacementTools,
    createGenerativeTools,
    createNeuralTools,
    createStyleTools,
    createDataTools,
    createStackTools,
    createStateTools,
    createExportTools,
    createRecipeTools,
];

/** Every vendored tool definition: [{ tool: {name, description, inputSchema}, handler }]. */
export function collectTools(connection) {
    const all = [];
    const seen = new Set();
    for (const factory of FACTORIES) {
        for (const def of factory(connection)) {
            if (seen.has(def.tool.name)) {
                throw new Error(`Duplicate tool name from vendored modules: ${def.tool.name}`);
            }
            seen.add(def.tool.name);
            all.push(def);
        }
    }
    return all;
}
