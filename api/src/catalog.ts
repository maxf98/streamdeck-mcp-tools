/**
 * catalog.ts — the catalog this service serves, and where it comes from.
 *
 * The source of truth is one `server.json` per server in `../servers/`, plus the tool
 * packs in `../tools/`, from which `scripts/build_catalog.py` generates `../catalog.json`.
 * Adding a server is a pull request against this repo, not a deploy of this service.
 *
 * This module still FETCHES that file over HTTP rather than reading the copy in its own
 * build: the catalog is regenerated and committed on merge, and a deployed container's
 * copy would be whatever was in the tree when it was built. Fetching from `main` means a
 * merged entry appears without a redeploy.
 *
 * It also resolves the two things a static file can't decide: which entries are gated
 * behind an env var, and env overrides of a client id or scope set.
 *
 * PURE where it can be: everything except `loadCatalog` is a function of its arguments,
 * so the parts that can actually hurt a user — an entry appearing half-configured, a
 * secret escaping into a payload — are testable without a network.
 */
import { readFile } from "node:fs/promises";

/**
 * Where the catalog comes from. A local FILE PATH is accepted as well as a URL, which is
 * what `npm run dev` uses (`CATALOG_URL=../catalog.json`) so you can develop against an
 * uncommitted catalog rebuild.
 */
const CATALOG_URL = process.env.CATALOG_URL
    ?? "https://raw.githubusercontent.com/maxf98/streamdeck-mcp-tools/main/catalog.json";

const TTL_MS = 5 * 60 * 1000;

export const STUDIO_META = "io.github.maxf98.streamdeck-mcp/studio";
export const REGISTRY_META = "io.github.maxf98.streamdeck-mcp/registry";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A `remotes[]` entry. Note what auth fields are NOT here — see StudioMeta. */
export interface Remote {
    type: "streamable-http" | "sse";
    url: string;
    headers?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
}

/**
 * Our own `_meta` block. Every auth field here is a workaround for a provider that
 * breaks MCP's own auth discovery (401 → protected-resource metadata → AS metadata →
 * dynamic registration + PKCE). A well-behaved server needs none of them, which is why
 * the spec has no fields for them and these live under a reverse-DNS key.
 */
export interface StudioMeta {
    sourceId: string;
    kind?: "pack";
    order?: number;
    authKind?: "oauth-dcr" | "oauth-preregistered" | "api-key";
    scopes?: string;
    scopesEnv?: string;
    clientId?: string;
    clientIdEnv?: string;
    exchangeProxy?: boolean;
    apiKeyUrl?: string;
    /** Withheld until its gating env var is set. See resolve(). */
    publishGated?: boolean;
    notes?: string[];
    platform?: string[];
    tags?: string[];
    longDescription?: string;
    distribution?: Record<string, unknown>;
    configSchema?: Record<string, unknown>;
}

/** A spec `ServerDetail`. Only the fields we read are named. */
export interface ServerDetail {
    $schema?: string;
    name: string;
    title?: string;
    description: string;
    version: string;
    repository?: { url: string; source: string; subfolder?: string };
    packages?: unknown[];
    remotes?: Remote[];
    _meta?: Record<string, unknown> & { [STUDIO_META]?: StudioMeta };
}

/** One row of the catalog: the server, plus registry-level metadata about it. */
export interface CatalogEntry {
    server: ServerDetail;
    _meta?: Record<string, unknown>;
}

export interface Catalog {
    schemaVersion?: string;
    servers: CatalogEntry[];
    metadata?: { count?: number };
}

export type Env = Record<string, string | undefined>;

export function studioMeta(entry: CatalogEntry): StudioMeta | undefined {
    return entry.server._meta?.[STUDIO_META];
}

// ---------------------------------------------------------------------------
// Env resolution — the one thing the catalog file can't decide for itself
// ---------------------------------------------------------------------------

/**
 * Resolve one entry against `env`, or return null to withhold it.
 *
 * An env var can OVERRIDE a static client id (re-registering an app without a release),
 * but for a `publishGated` entry the var is REQUIRED and its absence hides the entry.
 * That is what keeps the Google Workspace servers out: they need OAuth verification, and
 * withholding them beats advertising servers that fail at the consent screen — to a user
 * that looks like our bug either way. It is a filter rather than a `status` because the
 * spec's statuses describe a server's lifecycle, not our readiness to ship it.
 */
export function resolve(entry: CatalogEntry, env: Env): CatalogEntry | null {
    const meta = studioMeta(entry);
    if (!meta) return entry;

    const clientId = (meta.clientIdEnv ? env[meta.clientIdEnv] : undefined) ?? meta.clientId;
    if (meta.publishGated && !clientId) return null;

    const scopes = (meta.scopesEnv ? env[meta.scopesEnv] : undefined) ?? meta.scopes;
    if (clientId === meta.clientId && scopes === meta.scopes) return entry;

    return {
        ...entry,
        server: {
            ...entry.server,
            _meta: {
                ...entry.server._meta,
                [STUDIO_META]: {
                    ...meta,
                    ...(clientId ? { clientId } : {}),
                    ...(scopes ? { scopes } : {}),
                },
            },
        },
    };
}

export function resolveAll(catalog: Catalog, env: Env): CatalogEntry[] {
    return catalog.servers
        .map((entry) => resolve(entry, env))
        .filter((entry): entry is CatalogEntry => entry !== null);
}

// ---------------------------------------------------------------------------
// Legacy projection
// ---------------------------------------------------------------------------

export interface PublishedServer {
    url: string;
    transport: string;
    auth?: "api-key";
    apiKeyUrl?: string;
    scopes?: string;
    clientId?: string;
    exchangeProxy?: boolean;
}

/**
 * The pre-spec `{ mcpServers }` payload that `GET /registry` has always returned, and
 * that shipped Studio builds still read from `registry.json` in this repo.
 *
 * Derived from the same entries the new API serves, so the old and new views cannot
 * disagree — which was the point of doing it this way rather than keeping a second list.
 * Packs are excluded: this payload only ever described remote servers.
 */
export function toLegacyRegistry(entries: CatalogEntry[]): { mcpServers: Record<string, PublishedServer> } {
    const mcpServers: Record<string, PublishedServer> = {};
    const remotes = entries
        .filter((e) => e.server.remotes?.length && studioMeta(e))
        .sort((a, b) => (studioMeta(a)!.order ?? Infinity) - (studioMeta(b)!.order ?? Infinity));

    for (const entry of remotes) {
        const meta = studioMeta(entry)!;
        const remote = entry.server.remotes![0];
        mcpServers[meta.sourceId] = {
            url: remote.url,
            transport: remote.type,
            ...(meta.authKind === "api-key" ? { auth: "api-key" as const } : {}),
            ...(meta.apiKeyUrl ? { apiKeyUrl: meta.apiKeyUrl } : {}),
            ...(meta.scopes ? { scopes: meta.scopes } : {}),
            ...(meta.clientId ? { clientId: meta.clientId } : {}),
            ...(meta.exchangeProxy ? { exchangeProxy: true } : {}),
        };
    }
    return { mcpServers };
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

let cached: { catalog: Catalog; at: number } | null = null;

async function fetchCatalog(url: string): Promise<Catalog> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json() as Catalog;
}

/**
 * The catalog, from cache when fresh.
 *
 * On a failed refresh we keep serving the stale copy rather than erroring: a catalog
 * minutes out of date is harmless, an outage is not, and the upstream here is a third
 * party (raw.githubusercontent.com). A cold start with the fetch failing is the one case
 * that genuinely can't be served, and it throws.
 */
export async function loadCatalog(now = Date.now()): Promise<Catalog> {
    if (cached && now - cached.at < TTL_MS) return cached.catalog;

    try {
        const catalog = /^https?:/.test(CATALOG_URL)
            ? await fetchCatalog(CATALOG_URL)
            : JSON.parse(await readFile(CATALOG_URL, "utf8")) as Catalog;
        if (!Array.isArray(catalog.servers)) throw new Error("no servers array");
        cached = { catalog, at: now };
        return catalog;
    } catch (err) {
        if (cached) {
            console.warn(`catalog refresh failed, serving stale copy: ${String(err)}`);
            return cached.catalog;
        }
        throw new Error(`could not load ${CATALOG_URL}: ${String(err)}`);
    }
}

/** Test seam: preload or clear the cache without a network round trip. */
export function primeCatalog(catalog: Catalog | null, at = Date.now()): void {
    cached = catalog ? { catalog, at } : null;
}
