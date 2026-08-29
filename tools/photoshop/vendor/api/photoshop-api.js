/**
 * ADAPTER (not vendored) — routes the vendored tools' single execution call
 * into this pack's executor.
 *
 * Every vendored tool module ultimately does:
 *     new PhotoshopAPIFactory(connection).createAPI().executeScript(script)
 * so this one seam is all that's needed to re-host ~10k lines of ExtendScript
 * on our own AppleScript bridge. Upstream's version of this file also chose
 * between a UXP and an ExtendScript API; that choice was already vestigial (UXP
 * can't be driven externally, so it always resolved to ExtendScript) and is
 * dropped here.
 *
 * The error-handling/units/dialog wrapper that upstream applied at this layer
 * lives in lib/photoshop.mjs's `wrap` instead — it belongs with the executor
 * that depends on it, and applying it in both places would double-wrap.
 */

import { runScript } from '../../lib/photoshop.mjs';

/** Default per-call budget. Individual tools pass their own for slow work. */
const DEFAULT_TIMEOUT_MS = 60000;

class ExtendScriptAPI {
    async executeScript(script, timeoutMs) {
        return runScript(script, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }

    getAPIType() {
        return 'ExtendScript';
    }
}

export class PhotoshopAPIFactory {
    // Kept for call-signature compatibility with the vendored modules; the
    // connection is unused because the executor resolves Photoshop itself.
    constructor(_connection) {
        this.connection = _connection;
    }

    async createAPI() {
        return new ExtendScriptAPI();
    }
}
