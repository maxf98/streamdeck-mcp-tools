/**
 * ADAPTER (not vendored) — the version-gating half of upstream's detector.
 *
 * Upstream's detector also *found* Photoshop across platforms (~380 lines of
 * candidate paths); lib/photoshop.mjs does that with Spotlight instead. What the
 * tool modules still need from it is the feature-by-version predicates, kept
 * here with upstream's thresholds intact.
 */

function parse(version) {
    const numeric = String(version ?? '').match(/(\d+)\.?(\d*)/);
    if (numeric) {
        return {
            major: parseInt(numeric[1], 10),
            minor: numeric[2] ? parseInt(numeric[2], 10) : 0,
        };
    }
    // Some builds report a year ("2024") rather than a major version.
    const year = String(version ?? '').match(/20(\d{2})/);
    if (year) return { year: parseInt(`20${year[1]}`, 10), major: 0, minor: 0 };
    return { major: 0, minor: 0 };
}

export class PhotoshopDetector {
    /** UXP scripting API: Photoshop 23.5+ (2022+). */
    supportsUXP(version) {
        const { major, minor, year } = parse(version);
        if (year !== undefined) return year >= 2022;
        return major > 23 || (major === 23 && minor >= 5);
    }

    /** Select Subject v2 (cloud-assisted): Photoshop 23.0+. */
    supportsSelectSubjectV2(version) {
        const { major, year } = parse(version);
        if (year !== undefined) return year >= 2022;
        return major >= 23;
    }
}
