/**
 * ADAPTER (not vendored) — the `connection` object the vendored tool modules
 * expect, backed by this pack's own executor in ../../lib/photoshop.mjs.
 *
 * Upstream has a PhotoshopConnection class that owns detection, a platform
 * executor, and a script queue. This pack already does all of that in
 * lib/photoshop.mjs, so the class collapses to the three methods the tools
 * actually call: ping(), getPhotoshopInfo(), getVersion().
 */

import { appPath, isRunning, version } from '../../lib/photoshop.mjs';

let info = null;

export class PhotoshopConnection {
    /**
     * Populate the cached info (path/version/running) and report reachability.
     * The tools call this before reading getPhotoshopInfo(), which is why
     * getPhotoshopInfo is allowed to be synchronous.
     */
    async ping() {
        const path = await appPath();
        if (!path) {
            info = null;
            return false;
        }
        const running = await isRunning();
        // Asking Photoshop its version requires it to be running; when it isn't,
        // still report the install so version-gated tools can explain themselves
        // rather than failing with a null dereference.
        let ver = null;
        if (running) {
            try {
                ver = await version();
            } catch {
                ver = null;
            }
        }
        info = { version: ver ?? '0', path, isRunning: running };
        return running;
    }

    getPhotoshopInfo() {
        return info;
    }

    async getVersion() {
        if (!info?.version || info.version === '0') await this.ping();
        return info?.version ?? null;
    }
}
