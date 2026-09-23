/**
 * api.ts — the MCP Generic Registry API, as pure functions over a list of entries.
 *
 * Three endpoints are required of a conforming registry:
 *
 *   GET /v0.1/servers
 *   GET /v0.1/servers/{serverName}/versions
 *   GET /v0.1/servers/{serverName}/versions/{version}        ({version} may be `latest`)
 *
 * Implemented here rather than in the route handlers so the awkward parts — cursor
 * round-tripping, the `latest` alias, a name that contains a `/` — are testable without
 * standing up a server.
 *
 * Why serve an API at all when the catalog is already a static file anyone can fetch:
 * `{serverName}` is percent-encoded in the path (`io.github.maxf98%2Fmiro`), so a
 * conforming client's URLs are not paths a static host can answer. Serving them is what
 * lets someone build a wrapper against this catalog using a stock registry client
 * instead of learning our file format.
 */
import { REGISTRY_META, type CatalogEntry } from "./catalog.js";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 100;

export interface ListQuery {
    cursor?: string;
    limit?: string;
    search?: string;
    version?: string;
}

export interface Page {
    servers: CatalogEntry[];
    metadata: { count: number; nextCursor?: string };
}

/** Thrown for anything that should become a 400 rather than a 500. */
export class BadRequest extends Error {}

function registryMeta(entry: CatalogEntry): Record<string, unknown> {
    return (entry._meta?.[REGISTRY_META] as Record<string, unknown>) ?? {};
}

function isLatest(entry: CatalogEntry): boolean {
    return registryMeta(entry).isLatest !== false;
}

// ---------------------------------------------------------------------------
// Cursors
//
// The spec requires cursors be OPAQUE — a client must not parse one or construct one.
// So this is deliberately an encoding, not an interface: it can become a keyset cursor
// the day the catalog is big enough to need one, without any client noticing.
// ---------------------------------------------------------------------------

function encodeCursor(index: number): string {
    return Buffer.from(String(index), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
    const index = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(index) || index < 0) throw new BadRequest("invalid cursor");
    return index;
}

function parseLimit(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_LIMIT;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) throw new BadRequest("limit must be a positive integer");
    return Math.min(limit, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// GET /v0.1/servers
// ---------------------------------------------------------------------------

/**
 * One page of servers, latest version of each by default.
 *
 * `count` is the number of servers in THIS page, not the size of the catalog — that is
 * what the spec means by it, and reading it as a total is the easy mistake to make when
 * writing a client against this.
 */
export function listServers(entries: CatalogEntry[], query: ListQuery = {}): Page {
    let matching = query.version === undefined || query.version === "latest"
        ? entries.filter(isLatest)
        : entries.filter((e) => e.server.version === query.version);

    if (query.search) {
        const needle = query.search.toLowerCase();
        matching = matching.filter((e) =>
            e.server.name.toLowerCase().includes(needle)
            || (e.server.title ?? "").toLowerCase().includes(needle)
            || e.server.description.toLowerCase().includes(needle));
    }

    const limit = parseLimit(query.limit);
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    const page = matching.slice(start, start + limit);
    const end = start + page.length;

    return {
        servers: page,
        metadata: {
            count: page.length,
            ...(end < matching.length ? { nextCursor: encodeCursor(end) } : {}),
        },
    };
}

// ---------------------------------------------------------------------------
// GET /v0.1/servers/{serverName}/versions
// ---------------------------------------------------------------------------

/**
 * Every version of one server, or null when the name is unknown — so the caller can
 * tell "no such server" (404) from "a server with no versions", which can't happen here
 * but is a distinction a client is entitled to.
 *
 * Today this always returns exactly one version, because the catalog holds one file per
 * server and a new version replaces the old. The endpoint is still required, and a
 * client must not assume the count.
 */
export function listVersions(entries: CatalogEntry[], name: string): Page | null {
    const versions = entries.filter((e) => e.server.name === name);
    if (versions.length === 0) return null;
    return { servers: versions, metadata: { count: versions.length } };
}

// ---------------------------------------------------------------------------
// GET /v0.1/servers/{serverName}/versions/{version}
// ---------------------------------------------------------------------------

/** One version of one server. `latest` is required by the spec and resolved here. */
export function getServer(entries: CatalogEntry[], name: string, version: string): CatalogEntry | null {
    const versions = entries.filter((e) => e.server.name === name);
    if (versions.length === 0) return null;
    if (version === "latest") {
        return versions.find(isLatest) ?? versions[versions.length - 1];
    }
    return versions.find((e) => e.server.version === version) ?? null;
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

export interface ServerPath {
    name: string;
    /** undefined for `…/versions`, a version or `latest` for `…/versions/{version}` */
    version?: string;
}

/**
 * Split `{serverName}/versions[/{version}]` out of the path after `/v0.1/servers/`.
 *
 * Done by hand instead of with route parameters because a server name contains a `/`.
 * The spec says to percent-encode it, and a router would then match `:name` — but only
 * as long as nothing between the client and here decides to normalise `%2F` back into a
 * separator, which proxies do. Parsing the remainder ourselves accepts both the encoded
 * and the decoded form, so a wrapper works whatever its HTTP stack does on the way in.
 *
 * `lastIndexOf` rather than `indexOf`: a server name may legally contain the word
 * "versions", a version string cannot contain "/versions".
 */
export function parseServerPath(rest: string): ServerPath {
    const trimmed = rest.replace(/\/+$/, "");
    const marker = trimmed.lastIndexOf("/versions");
    if (marker <= 0) throw new BadRequest("expected {serverName}/versions[/{version}]");

    const name = decodeURIComponent(trimmed.slice(0, marker));
    const tail = trimmed.slice(marker + "/versions".length);
    if (tail === "") return { name };
    if (!tail.startsWith("/")) throw new BadRequest("expected {serverName}/versions[/{version}]");

    const version = decodeURIComponent(tail.slice(1));
    if (version.includes("/")) throw new BadRequest("version must be a single path segment");
    return { name, version };
}
