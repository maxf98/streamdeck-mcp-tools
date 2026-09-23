/**
 * api.test.ts — the Generic Registry API's awkward corners.
 *
 * Not the happy paths, which are a slice and a find: the parts a wrapper author would
 * hit first and blame us for. A name containing a `/`, arriving either encoded or
 * already normalised by a proxy; `latest`; a cursor that round-trips; a cursor that
 * doesn't and must be a 400 rather than an outage-shaped 500.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequest, getServer, listServers, listVersions, parseServerPath } from "./api.js";
import { REGISTRY_META, STUDIO_META, type CatalogEntry } from "./catalog.js";

function entry(name: string, version = "1.0.0", isLatest = true): CatalogEntry {
    return {
        server: {
            name: `io.github.maxf98/${name}`,
            title: name,
            description: `the ${name} server`,
            version,
            _meta: { [STUDIO_META]: { sourceId: name } as never },
        },
        _meta: { [REGISTRY_META]: { status: "active", isLatest } },
    };
}

const ENTRIES = [entry("miro"), entry("figma"), entry("slack"), entry("git")];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test("accepts a percent-encoded name, which is what the spec says to send", () => {
    assert.deepEqual(parseServerPath("io.github.maxf98%2Fmiro/versions/latest"),
        { name: "io.github.maxf98/miro", version: "latest" });
});

test("accepts a name a proxy has already decoded into path separators", () => {
    // Nothing in the spec promises %2F survives the trip; some proxies normalise it.
    // Both forms have to resolve to the same server or a wrapper breaks depending on
    // whose load balancer it sits behind.
    assert.deepEqual(parseServerPath("io.github.maxf98/miro/versions/latest"),
        { name: "io.github.maxf98/miro", version: "latest" });
});

test("distinguishes the versions list from a single version", () => {
    assert.deepEqual(parseServerPath("io.github.maxf98%2Fmiro/versions"),
        { name: "io.github.maxf98/miro" });
    assert.deepEqual(parseServerPath("io.github.maxf98%2Fmiro/versions/"),
        { name: "io.github.maxf98/miro" });
});

test("splits on the LAST /versions, so a server may be called 'versions'", () => {
    assert.deepEqual(parseServerPath("io.github.maxf98/versions/versions/1.0.0"),
        { name: "io.github.maxf98/versions", version: "1.0.0" });
});

test("rejects a path with no /versions segment", () => {
    assert.throws(() => parseServerPath("io.github.maxf98%2Fmiro"), BadRequest);
    assert.throws(() => parseServerPath("/versions"), BadRequest);
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test("lists the latest version of each server", () => {
    const page = listServers([...ENTRIES, entry("miro", "0.9.0", false)]);
    assert.equal(page.metadata.count, 4);
    assert.equal(page.metadata.nextCursor, undefined);
});

test("a cursor round-trips and pages the whole catalog exactly once", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
        const page = listServers(ENTRIES, { limit: "2", cursor });
        assert.ok(page.metadata.count <= 2);
        seen.push(...page.servers.map((e) => e.server.name));
        cursor = page.metadata.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ENTRIES.map((e) => e.server.name));
});

test("count is the size of the page, not of the catalog", () => {
    // The easy misreading when writing a client, so it's pinned.
    assert.equal(listServers(ENTRIES, { limit: "2" }).metadata.count, 2);
});

test("a garbage cursor is a 400, not a 500", () => {
    assert.throws(() => listServers(ENTRIES, { cursor: "not-a-cursor" }), BadRequest);
    assert.throws(() => listServers(ENTRIES, { limit: "0" }), BadRequest);
    assert.throws(() => listServers(ENTRIES, { limit: "many" }), BadRequest);
});

test("limit is capped rather than refused", () => {
    // Refusing an over-large limit would make a client that asks for everything fail;
    // capping it just makes it paginate.
    assert.equal(listServers(ENTRIES, { limit: "10000" }).metadata.count, 4);
});

test("search matches name, title and description", () => {
    assert.equal(listServers(ENTRIES, { search: "MIRO" }).metadata.count, 1);
    assert.equal(listServers(ENTRIES, { search: "the slack server" }).metadata.count, 1);
    assert.equal(listServers(ENTRIES, { search: "nothing here" }).metadata.count, 0);
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

test("an unknown server is null, so the handler can 404 it", () => {
    assert.equal(listVersions(ENTRIES, "io.github.maxf98/nope"), null);
    assert.equal(getServer(ENTRIES, "io.github.maxf98/nope", "latest"), null);
});

test("latest resolves to the entry flagged latest, not the last one listed", () => {
    const entries = [entry("miro", "2.0.0", true), entry("miro", "1.0.0", false)];
    assert.equal(getServer(entries, "io.github.maxf98/miro", "latest")!.server.version, "2.0.0");
});

test("an exact version is served, and an unknown one is null", () => {
    const entries = [entry("miro", "2.0.0", true), entry("miro", "1.0.0", false)];
    assert.equal(getServer(entries, "io.github.maxf98/miro", "1.0.0")!.server.version, "1.0.0");
    assert.equal(getServer(entries, "io.github.maxf98/miro", "3.0.0"), null);
});

test("listing all versions returns every one, latest or not", () => {
    const entries = [entry("miro", "2.0.0", true), entry("miro", "1.0.0", false), entry("figma")];
    assert.equal(listVersions(entries, "io.github.maxf98/miro")!.metadata.count, 2);
});
