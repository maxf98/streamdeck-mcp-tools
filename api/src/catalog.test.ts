/**
 * catalog.test.ts — what this service may and may not serve.
 *
 * Node's built-in test runner via tsx, so this adds no dependency. Run: `npm test`.
 *
 * These assertions guard real incidents-in-waiting, not shapes: a client secret reaching
 * clients, and a half-configured server appearing in the picker (the user finds out at
 * the consent screen, which looks like our bug either way).
 *
 * The fixture is the generated `catalog.json` two directories up — the real one, not a
 * copy — so this is also the check that a catalog edit hasn't broken a consumer. That is
 * why the service lives in this repo: when it was elsewhere, these tests had to reach
 * into a sibling checkout and skip when it was missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    STUDIO_META,
    resolve,
    resolveAll,
    studioMeta,
    toLegacyRegistry,
    type Catalog,
    type CatalogEntry,
} from "./catalog.js";

/** Resolved against this file, not the cwd, so `node --test` works from anywhere. */
function repoFile(name: string): string {
    return readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
}

const catalog = JSON.parse(repoFile("catalog.json")) as Catalog;

function entry(name: string, meta: Record<string, unknown>, url = "https://example.com/mcp"): CatalogEntry {
    return {
        server: {
            name: `io.github.maxf98/${name}`,
            description: "x",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url }],
            _meta: { [STUDIO_META]: { sourceId: name, ...meta } as never },
        },
    };
}

// ---------------------------------------------------------------------------
// Env gating — the logic that used to live in registry.ts
// ---------------------------------------------------------------------------

test("a publishGated entry is withheld until its client id env var is set", () => {
    const gated = entry("gmail", { publishGated: true, clientIdEnv: "GOOGLE_CLIENT_ID" });
    assert.equal(resolve(gated, {}), null);
    const resolved = resolve(gated, { GOOGLE_CLIENT_ID: "g-123" });
    assert.equal(studioMeta(resolved!)!.clientId, "g-123");
});

test("an env var overrides a static client id but a missing one doesn't hide the entry", () => {
    const slack = entry("slack", { clientId: "392247373648.1066", clientIdEnv: "SLACK_CLIENT_ID" });
    assert.equal(studioMeta(resolve(slack, {})!)!.clientId, "392247373648.1066");
    assert.equal(studioMeta(resolve(slack, { SLACK_CLIENT_ID: "cid-123" })!)!.clientId, "cid-123");
});

test("resolving never mutates the entry it was given", () => {
    const slack = entry("slack", { clientId: "static", clientIdEnv: "SLACK_CLIENT_ID" });
    resolve(slack, { SLACK_CLIENT_ID: "override" });
    assert.equal(studioMeta(slack)!.clientId, "static");
});

// ---------------------------------------------------------------------------
// The real catalog
// ---------------------------------------------------------------------------

test("serves the DCR servers with no env at all", () => {
    // These need no pre-registered credentials, so they must never depend on config.
    const { mcpServers } = toLegacyRegistry(resolveAll(catalog, {}));
    for (const id of ["miro", "figma", "atlassian", "coda", "notion", "paypal", "canva", "gitlab"]) {
        assert.ok(mcpServers[id], `${id} missing`);
        assert.equal(mcpServers[id].transport, "streamable-http");
    }
});

test("hides Google until GOOGLE_CLIENT_ID is set", () => {
    // Deliberate: the Google servers need OAuth verification (restricted scopes + CASA),
    // so shipping them is gated on the env var being set in production.
    const google = ["gmail", "gcalendar", "gdrive", "gsheets", "gchat", "gdocs", "gslides"];
    const without = toLegacyRegistry(resolveAll(catalog, {})).mcpServers;
    for (const id of google) assert.equal(without[id], undefined, `${id} must stay hidden`);

    const withGoogle = toLegacyRegistry(resolveAll(catalog, { GOOGLE_CLIENT_ID: "g-123" })).mcpServers;
    for (const id of google) assert.ok(withGoogle[id], `${id} must appear once configured`);
    assert.equal(withGoogle.gmail.clientId, "g-123");
});

test("Slack ships with a static client id, and the env var only overrides it", () => {
    // The catalog is published as a static file, so Slack's (public) client id has to be
    // IN it. The matching secret never is: it lives on the private OAuth-proxy service,
    // which reports whether it's configured from its own /health.
    const fromFile = toLegacyRegistry(resolveAll(catalog, {})).mcpServers.slack;
    assert.ok(fromFile, "slack must be present with no env at all");
    assert.match(fromFile.clientId!, /^\d+\.\d+$/);
    assert.equal(fromFile.exchangeProxy, true);
    // Slack's MCP server needs a USER token, so the default scopes are user scopes.
    assert.ok(fromFile.scopes?.includes("search:read"));

    const env = { SLACK_CLIENT_ID: "cid-123", SLACK_SCOPES: "chat:write" };
    const overridden = toLegacyRegistry(resolveAll(catalog, env)).mcpServers.slack;
    assert.equal(overridden.clientId, "cid-123");
    assert.equal(overridden.scopes, "chat:write");
});

test("never serves a client secret", () => {
    // This repo is public, and a secret must never reach it in the first place — but the
    // env is also read at runtime, so a mapping mistake could still copy one into a
    // response. Checked rather than reasoned about.
    const env = { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "shhh", GOOGLE_CLIENT_ID: "g-123" };
    const payload = JSON.stringify(resolveAll(catalog, env));
    assert.equal(payload.includes("shhh"), false);
    assert.equal(payload.includes("clientSecret"), false);
    // And no entry reads a secret-looking env var into a client-visible field. The
    // failure mode is silent, so it's checked rather than reasoned about.
    for (const e of catalog.servers) {
        const meta = studioMeta(e);
        for (const ref of [meta?.clientIdEnv, meta?.scopesEnv]) {
            assert.equal(/SECRET|PASSWORD|TOKEN|_KEY$/i.test(ref ?? ""), false,
                `${e.server.name} exposes ${ref}`);
        }
    }
});

test("github is api-key, not OAuth, and says where to get one", () => {
    const github = toLegacyRegistry(resolveAll(catalog, {})).mcpServers.github;
    assert.equal(github.auth, "api-key");
    assert.ok(github.apiKeyUrl?.startsWith("https://github.com/"));
    assert.equal(github.clientId, undefined);
});

test("every entry has a unique name and sourceId, and https remotes", () => {
    const names = catalog.servers.map((e) => e.server.name);
    const ids = catalog.servers.map((e) => studioMeta(e)?.sourceId);
    assert.equal(new Set(names).size, names.length, "duplicate name");
    assert.equal(new Set(ids).size, ids.length, "duplicate sourceId");
    for (const e of catalog.servers) {
        for (const remote of e.server.remotes ?? []) {
            assert.ok(remote.url.startsWith("https://"), `${e.server.name} is not https`);
        }
    }
});

test("the legacy payload keeps the field order and membership it always had", () => {
    // Shipped Studio builds read this shape from the static registry.json. The order of
    // the keys is not load-bearing for a JSON parser, but a diff against that committed
    // file is how we know this projection still matches what the generator emits.
    const { mcpServers } = toLegacyRegistry(resolveAll(catalog, {}));
    const committed = JSON.parse(repoFile("registry.json")) as {
        mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(mcpServers), Object.keys(committed.mcpServers));
    assert.deepEqual(mcpServers, committed.mcpServers);
});

test("packs are discoverable but never reach the legacy remote list", () => {
    const packs = catalog.servers.filter((e) => studioMeta(e)?.kind === "pack");
    assert.ok(packs.length > 0, "expected packs in the catalog");
    const { mcpServers } = toLegacyRegistry(resolveAll(catalog, {}));
    for (const pack of packs) {
        assert.equal(mcpServers[studioMeta(pack)!.sourceId], undefined);
    }
});
