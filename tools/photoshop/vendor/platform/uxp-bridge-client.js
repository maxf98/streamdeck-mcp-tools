/**
 * ADAPTER (not vendored) — the UXP bridge is NOT part of this pack.
 *
 * Neural Filters are the one Photoshop feature ExtendScript can't reach: they're
 * only scriptable from a UXP plugin, so upstream ships a companion plugin the
 * user sideloads into Photoshop plus a localhost HTTP server for the MCP process
 * to call it through. That's a second installable artifact and an extra
 * listening port for exactly one tool — outside what a tool pack should drag in,
 * and untestable from here.
 *
 * So the bridge reports itself permanently unreachable. Everything degrades the
 * way upstream already handles a missing plugin: `get_capabilities` reports
 * neural_filters/uxp_bridge_reachable false, and `neural_filter` returns a
 * `uxp_bridge_unavailable` error naming the reason instead of hanging on a
 * connection that will never open. All other 100+ tools are unaffected.
 */

/** Always false: this pack ships no UXP plugin. */
export async function isUxpBridgeReachable() {
    return false;
}

export async function invokeNeuralFilter(filter) {
    return {
        ok: false,
        error:
            `neural_filter (${filter}) needs Photoshop's UXP scripting API, which this ` +
            `pack does not bridge to — Neural Filters are unavailable through ExtendScript. ` +
            `Apply the filter by hand, or use execute_script for ExtendScript-reachable work.`,
    };
}
