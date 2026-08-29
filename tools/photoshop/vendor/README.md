# `vendor/` — the ExtendScript tool library

Everything under this directory except the four files marked `ADAPTER (not
vendored)` comes from **[alisaitteke/photoshop-mcp](https://github.com/alisaitteke/photoshop-mcp)**,
MIT licensed, © 2026 Ali Sait Teke. Full licence text: [`LICENSE-upstream`](LICENSE-upstream).

- upstream package: `@alisaitteke/photoshop-mcp` **1.7.3**
- upstream commit: `53c25b532d6d7e095e6215ccdb570a6bd2689c87` (2026-08-25)

## Why vendored rather than rewritten

These modules are mostly ExtendScript source held in JS template strings, and
that ExtendScript encodes a lot of hard-won Action Manager knowledge — the
four-digit `charIDToTypeID` codes, the per-Photoshop-version fallbacks, the
argument descriptors for generative fill. None of it can be validated by reading
it; it's only provable against a running Photoshop. Retyping it by hand would
produce something plausible and unverifiable. So it's taken as-is, and the port
is confined to the four small adapters below.

## What was changed

1. **TypeScript → JavaScript.** Mechanically transpiled with `tsc --target es2022
   --module esnext --moduleResolution bundler --skipLibCheck`. Type annotations
   are gone; no logic was touched. A tool pack is plain `node server.mjs`, so
   there's no build step to keep.

2. **Four adapter files replace upstream's platform/API layer.** Every one of the
   100 tools bottoms out on a single call — `PhotoshopAPIFactory(connection)
   .createAPI().executeScript(script)` — so the whole port fits behind that seam:

   | File | What it does now |
   |---|---|
   | `api/photoshop-api.js` | The seam. `executeScript` → `runScript()` from `../../lib/photoshop.mjs`. Upstream's vestigial UXP/ExtendScript engine choice is dropped. |
   | `platform/connection.js` | Collapsed to the only three methods tools actually call: `ping`, `getPhotoshopInfo`, `getVersion`. |
   | `platform/detector.js` | Kept only the two version predicates the tools consult (`supportsUXP`, `supportsSelectSubjectV2`), with upstream's thresholds. |
   | `platform/uxp-bridge-client.js` | Permanent stub — see below. |
   | `tools/index.js` | New: flattens the 23 tool-factory modules into one list (upstream did this inside its server core). Throws on a duplicate name. |

   Upstream's macOS/Windows executors, its server core, its stdio wiring and its
   UXP plugin are **not** vendored — `../lib/photoshop.mjs` replaces the
   executor, `../server.mjs` replaces the server.

3. **Telemetry removed.** Upstream posted every tool call to PostHog from
   `errors/envelope.ts`. Both call sites and the import are gone. A local tool
   pack must not phone home.

4. **The UXP bridge is not ported.** Neural Filters are the one Photoshop feature
   ExtendScript can't reach — they need the UXP scripting API, so upstream ships
   a companion plugin the user sideloads plus a localhost HTTP server to reach
   it. That's a second installable artifact and an extra listening port for
   exactly one tool. `isUxpBridgeReachable()` therefore returns `false` forever;
   `get_capabilities` reports `neural_filters: false` and `neural_filter`
   returns an error naming the reason. The other 99 tools are unaffected.

5. **The `photoshop_` tool-name prefix was stripped** (102 identifiers, 235
   occurrences — including the `suggested_next_tool` hints inside error
   envelopes). The gateway namespaces tools itself as `{packId}__{toolName}`, so
   a prefix here would surface as `photoshop__photoshop_create_document`. Button
   code calls `sd.photoshop.create_document(...)`.

## Updating

Re-transpile from a fresh upstream checkout, then re-apply 3–5 (the analytics
strip and the prefix rename are mechanical; the adapters are the files listed
above and should be kept, not overwritten). Bump `manifest.json`'s `version`
afterwards — the Studio's update check compares the catalog version against the
installed manifest, so content changes without a bump never reach an installed
copy.
