/**
 * index.ts — the MCP Generic Registry API over this repo's catalog.
 *
 * Read-only and public, like the data it serves. It lives next to that data on purpose:
 * this is the Homebrew arrangement (a formula repo plus an API that publishes it), except
 * that Homebrew's API can be static JSON and ours can't — a conforming client asks for
 * `/v0.1/servers/io.github.maxf98%2Fmiro/versions/latest`, and a percent-encoded name is
 * not a path a static host answers.
 *
 * The OAuth code→token exchange is NOT here. It needs a client secret, so it stays in the
 * private `streamdeck-mcp-registry` service. That is the whole line between the two: this
 * process holds nothing that would be a problem to read.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { BadRequest, getServer, listServers, listVersions, parseServerPath } from "./api.js";
import { loadCatalog, resolveAll, toLegacyRegistry } from "./catalog.js";

const app = new Hono();

/** The catalog as this deployment sees it: fetched, cached, and env-resolved. */
async function entries() {
    return resolveAll(await loadCatalog(), process.env);
}

/** The catalog changes at commit speed, so let proxies hold it for five minutes. */
const CATALOG_CACHE = "public, max-age=300";

app.get("/health", async (c) => {
    try {
        return c.json({ ok: true, servers: (await entries()).length });
    } catch (err) {
        // A cold start that can't reach the catalog is the one unservable state, and
        // Railway should see it as unhealthy rather than as an empty catalog.
        return c.json({ ok: false, error: String(err) }, 503);
    }
});

// ---------------------------------------------------------------------------
// Generic Registry API (spec)
//
// The three endpoints a conforming MCP registry must serve. Everything they return comes
// from `catalog.json` in this repo, so adding a server is a pull request rather than a
// deploy. There is deliberately no auth and no publish endpoint: the catalog is public
// and read-only, and publishing is that pull request.
// ---------------------------------------------------------------------------

app.get("/v0.1/servers", async (c) => {
    c.header("Cache-Control", CATALOG_CACHE);
    return c.json(listServers(await entries(), c.req.query()));
});

// One wildcard handler for both `…/versions` and `…/versions/{version}`, because the
// name in between contains a `/`. See parseServerPath for why that isn't a route param.
app.get("/v0.1/servers/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const { name, version } = parseServerPath(path.slice("/v0.1/servers/".length));
    c.header("Cache-Control", CATALOG_CACHE);

    if (version === undefined) {
        const page = listVersions(await entries(), name);
        return page ? c.json(page) : c.json({ error: `unknown server: ${name}` }, 404);
    }

    const entry = getServer(await entries(), name, version);
    return entry
        ? c.json(entry)
        : c.json({ error: `unknown server or version: ${name}@${version}` }, 404);
});

// ---------------------------------------------------------------------------
// Legacy registry
//
// The pre-spec `{ mcpServers }` payload. Kept for already-shipped Studio builds, which
// ask the OLD service for `/registry` — that service now proxies the request here, so
// this is the only implementation of the projection and the two views cannot drift.
// Delete it once no shipped build asks for it.
// ---------------------------------------------------------------------------

app.get("/registry", async (c) => {
    c.header("Cache-Control", CATALOG_CACHE);
    return c.json(toLegacyRegistry(await entries()));
});

// A malformed path or cursor is the client's mistake, not a server fault. Without this
// a bad cursor would be a 500 and look like an outage.
app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
});

const port = parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: app.fetch, port }, () => {
    console.log(`Catalog API listening on port ${port}`);
});
