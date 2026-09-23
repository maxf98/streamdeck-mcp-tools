# api/ — the catalog, served as an MCP registry

A small [Hono](https://hono.dev) service that publishes this repo's `catalog.json` through
the **MCP Generic Registry API**, so anything can consume it with a stock registry client.

It lives in this repo, next to the data it serves. That's the Homebrew arrangement — a
formula repo plus an API that publishes it — with one difference: Homebrew's API can be
static JSON, and ours can't. A conforming client asks for

```
/v0.1/servers/io.github.maxf98%2Fmiro/versions/latest
```

and a percent-encoded name is not a path a static host answers. That is the entire reason
this process exists alongside a public `catalog.json` anyone can already `curl`.

**No secrets are here, by construction.** The OAuth code→token exchange for providers that
refuse dynamic client registration needs a client secret, so it stays in the private
`streamdeck-mcp-registry` service. That split is the whole boundary between the two.

## Routes

| Route | Purpose |
|---|---|
| `GET /v0.1/servers` | The catalog, latest version of each. `?cursor=&limit=&search=&version=` |
| `GET /v0.1/servers/{name}/versions` | Every version of one server |
| `GET /v0.1/servers/{name}/versions/{version}` | One version; `latest` is accepted |
| `GET /registry` | **Legacy** `{ mcpServers: … }` for already-shipped Studio builds. Projected from the same catalog, so it can't drift |
| `GET /health` | `{ ok, servers }`; 503 when the catalog can't be loaded at all |

```bash
curl "$BASE/v0.1/servers/io.github.maxf98%2Fmiro/versions/latest"
```

There is no auth and no publish endpoint: the catalog is public and read-only, and
publishing is a pull request (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

## Where the data comes from

The deployed service **fetches** `catalog.json` from `main` over HTTP rather than reading
the copy in its own build — the catalog is regenerated and committed on merge, so a baked-in
copy would go stale until the next deploy. 5-minute cache; a failed refresh keeps serving
the stale copy, because a catalog a few minutes old is harmless and an outage isn't.

Two things the file can't decide are resolved at request time from the environment:

| Env var | Effect |
|---|---|
| `GOOGLE_CLIENT_ID` | Un-hides the `publishGated` Google Workspace entries. **Don't set it yet** — they need OAuth verification |
| `SLACK_CLIENT_ID`, `SLACK_SCOPES` | Override what's in the file, to re-register the app without a release |
| `CATALOG_URL` | Where to read the catalog. A local path works as well as a URL |
| `PORT` | Railway sets this |

A client **secret** is never one of these, and `npm test` asserts that no entry reads a
secret-looking var into a client-visible field.

## Develop / test / deploy

```bash
cd api
npm install
npm run dev     # tsx watch, reading ../catalog.json
npm test        # node:test via tsx — 26 tests, no test framework
npm run build   # tsc -> dist/
```

`npm test` reads the real `../catalog.json`, so a catalog edit that would break a consumer
fails here. CI runs it on every pull request that touches `servers/`, `tools/` or `api/`,
after regenerating the catalog — so a contributor's new entry is covered before merge.

Deployed on Railway with the service's **root directory set to `api/`**; the rest of this
repo is Python and data. `railway up` from this directory.
