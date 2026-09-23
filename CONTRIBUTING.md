# Contributing a server

This repo is a **conforming MCP registry**. Every entry is a
[`server.json`](https://modelcontextprotocol.io/specification) document
(`ServerDetail`, schema version `2025-12-11`), and the catalog is served through the
Generic Registry API, so anything you add here is consumable by clients other than
Stream Deck Studio.

There are two kinds of server, and they are contributed differently:

| | Where it runs | You add | Reviewed for |
|---|---|---|---|
| **Remote** | the vendor's servers | one file in `servers/` | that the URL and auth details are right |
| **Pack** | the user's own machine, as a subprocess | a folder in `tools/` | the code, because we ship it |

A remote server is by far the easier contribution: nothing is installed, nothing is
executed, and the entry is a dozen lines. Start there if you have the choice.

**Never edit `catalog.json`, `index.json` or `registry.json`.** All three are generated
by `scripts/build_catalog.py` and rewritten by CI on every push to `main`, so an edit to
them is reverted. Edit a source file instead.

---

## Adding a remote server

Create `servers/<id>.json`:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.maxf98/acme",
  "title": "Acme",
  "description": "Hosted Acme MCP server: projects, tasks and comments.",
  "version": "1.0.0",
  "remotes": [
    { "type": "streamable-http", "url": "https://mcp.acme.com/mcp" }
  ],
  "_meta": {
    "io.github.maxf98.streamdeck-mcp/studio": {
      "sourceId": "acme",
      "authKind": "oauth-dcr"
    }
  }
}
```

Then run the generator and commit what it writes:

```bash
pip install jsonschema
python3 scripts/build_catalog.py
```

(If you'd rather not, that's fine — CI validates your sources on the PR and rebuilds the
outputs after merge.)

### The fields, and the two that trip people up

- **`name`** must be `io.github.maxf98/<id>` for now. The spec namespaces by domain to
  prove who published an entry; since this catalog is curated rather than self-serve,
  everything lives under this repo's namespace. Exactly one `/`, and no underscores
  before it.
- **`description` is capped at 100 characters** by the schema. This is the single most
  common validation failure. Write the one-line version here; if you need more room,
  put the long text in `_meta` (packs do this as `longDescription`).
- **`sourceId`** is the bare id, and it is **load-bearing at runtime, not cosmetic**: the
  Studio prefixes every tool with it (`acme__create_task`), names the pack directory
  after it, and bakes it into exported buttons as a stable reference. It must be unique
  across the whole catalog, lowercase, and **underscores, never hyphens** — a `-` breaks
  the `mcp.acme.tool_name()` dot access that button code uses. Once published, renaming
  it breaks every button that calls the server, so pick it carefully.

### `authKind`, and why auth isn't in the spec fields

A `remotes[]` entry carries only `{type, url, headers?}`. That's deliberate: in MCP,
auth is discovered at **connect** time, not from the catalog — the server answers 401
with `WWW-Authenticate`, the client reads the protected-resource metadata, finds the
authorization server, and registers itself dynamically with PKCE. A well-behaved server
needs nothing in the catalog at all.

So the auth fields under `_meta` are not the normal path. Each one is a workaround for a
provider that breaks some step of that chain, and you should only add one if you have
tried connecting and watched it fail:

| `authKind` | When | Extra `_meta` fields |
|---|---|---|
| `oauth-dcr` | the default — the chain above just works | none |
| `api-key` | the provider allows no third-party OAuth at all | `apiKeyUrl` (where a user gets a token) |
| `oauth-preregistered` | the provider requires a pre-registered app | `clientId`, and `exchangeProxy` if the exchange needs a client secret |

Add `scopes` when the provider's authorization server advertises no default scopes, so
a client that asks for none gets a token that can't do anything.

A `clientId` in this repo is **not** a leak — it travels in every authorize URL and is
public by construction. A client **secret** must never appear here. There is exactly one
provider that needs one (Slack), and its code→token exchange is proxied by the
`streamdeck-mcp-registry` service, which holds the secret as an environment variable. If
your server needs a secret, it needs a handler in that service too; a field here can't
do it.

### `notes`

If a provider did something surprising — an undocumented scope name, a beta gate, a URL
that differs for self-hosted installs — write it down in `_meta … notes[]`. Every note
already in `servers/` records something that cost somebody an afternoon. They are the
most valuable part of these files; please add to them.

---

## Adding a pack

A pack is a local MCP server whose code lives in this repo and runs on the user's
machine. See [README.md](README.md) for the structure (`manifest.json`, `server.mjs`,
`package.json`), the design constraints, and how to develop against a local checkout
without pushing.

Two things the README's manifest example now requires:

- **`summary`** — a ≤100-character line, used as the spec `description`. Keep the full
  prose in `description`; the Studio shows that, and the generator carries it as
  `longDescription`.
- The catalog entry itself is **generated**. Don't add anything to `index.json`; creating
  the folder is the whole step.

Because we ship pack code to users' machines, a pack PR is a code review, and the bar is
higher: read the "What makes a good tool pack?" section before starting.

### Known limitation: packs aren't installable by other clients

A pack entry validates and is discoverable, but it carries no `packages[]`. The spec
requires a `registryType` + `identifier`, and there is no registry type for "a
subdirectory of this repo, fetched file by file" — which is how the Studio installs a
pack today, recorded under `_meta` as `distribution`. So a third-party client can *see*
our packs but not install them. Fixing that means publishing each pack to npm; until
then, the remote half of this catalog is the portable half.

---

## What CI does

On your PR, `scripts/build_catalog.py --validate` checks every entry against the vendored
`server.json` schema (`scripts/schemas/`) and rejects duplicate names or `sourceId`s. It
does **not** require you to have rebuilt the outputs.

After merge, the same script regenerates `catalog.json` (the spec-shaped catalog),
`index.json` and `registry.json` (both legacy, kept byte-identical so already-shipped
Studio builds keep working) and commits them.
