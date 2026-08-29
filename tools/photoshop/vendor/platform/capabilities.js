import { PhotoshopDetector } from './detector.js';
import { isUxpBridgeReachable } from './uxp-bridge-client.js';
export function parsePhotoshopVersion(version) {
    const numeric = version.match(/(\d+)\.?(\d*)/);
    if (numeric) {
        return {
            major: parseInt(numeric[1], 10),
            minor: numeric[2] ? parseInt(numeric[2], 10) : 0,
            raw: version,
        };
    }
    const yearMatch = version.match(/20(\d{2})/);
    if (yearMatch) {
        const year = parseInt(`20${yearMatch[1]}`, 10);
        return {
            major: year - 1990,
            minor: 0,
            year,
            raw: version,
        };
    }
    return { major: 0, minor: 0, raw: version };
}
export function getPhotoshopCapabilities(version) {
    const parsed = parsePhotoshopVersion(version);
    const detector = new PhotoshopDetector();
    const major = parsed.major;
    const year = parsed.year ?? (major >= 13 ? 1990 + major : undefined);
    const selectSubjectV2 = major >= 23 || (year !== undefined && year >= 2020);
    const generativeFill = major >= 25 || (year !== undefined && year >= 2024);
    const generativeRemove = generativeFill;
    const generativeExpand = generativeFill;
    const generativeUpscale = major >= 27 || (year !== undefined && year >= 2025);
    const skyReplacementNative = generativeFill;
    const executeAsModal = generativeFill;
    return {
        version,
        features: {
            select_subject_v2: selectSubjectV2,
            generative_fill: generativeFill,
            generative_remove: generativeRemove,
            generative_expand: generativeExpand,
            generative_upscale: generativeUpscale,
            sky_replacement_native: skyReplacementNative,
            neural_filters: false,
            uxp_bridge_reachable: false,
            execute_as_modal_timeout: executeAsModal,
            uxp_plugin_api: detector.supportsUXP(version),
        },
    };
}
/** Merge runtime UXP bridge reachability into version-derived capabilities. */
export async function resolvePhotoshopCapabilities(version) {
    const base = getPhotoshopCapabilities(version);
    const bridgeUp = await isUxpBridgeReachable();
    return {
        ...base,
        features: {
            ...base.features,
            uxp_bridge_reachable: bridgeUp,
            neural_filters: bridgeUp && base.features.uxp_plugin_api,
        },
    };
}
