#!/usr/bin/env python3
"""
Build the catalog from the two kinds of source in this repo, and validate it.

    python3 scripts/build_catalog.py             # validate, then write the outputs
    python3 scripts/build_catalog.py --validate  # validate the sources, write nothing
    python3 scripts/build_catalog.py --check      # ...and also fail if an output is stale

Use `--validate` on a pull request and `--check` on a branch that is supposed to be
already built. A contributor is not expected to run the generator, so drift on a PR is
normal and must not fail the build.

THE TWO SOURCES, and why they differ:

  servers/*.json      A conforming MCP `server.json` (ServerDetail), hand-authored.
                      This is where a REMOTE server lives, and where anyone adding a
                      server by pull request puts it. One file, one server.

  tools/*/manifest.json
                      A local pack, whose source code lives next to it in the same
                      folder. Its catalog entry is GENERATED, because `version`,
                      `command` and `args` have to stay in step with the code — an
                      entry hand-written alongside the pack would drift.

Both are projected into one list, because the spec's unit is a server with `packages[]`
and `remotes[]` as SIBLING arrays: how you obtain a server is not the top-level axis.
That is the whole reason the two catalogs below can collapse into one.

WHAT IT WRITES

  catalog.json    The spec-shaped catalog, in the same envelope the registry API serves
                  ({server, _meta} per row), so the service can hand it out with almost
                  no reshaping. This is the file new clients should read.

  index.json      LEGACY. The pack catalog in its original shape. Still written byte-for
  registry.json   byte as before so shipped Studio builds keep working. Delete both once
                  nothing fetches them.

WHAT DOESN'T CONFORM YET, deliberately:

  A pack has no `packages[]`. The spec requires `registryType` + `identifier`, and there
  is no registry type for "a subdirectory of this repo, fetched file by file". So a pack
  entry is valid and discoverable but not installable by a foreign client until the packs
  are published as real npm packages. How the STUDIO installs one today is recorded under
  `_meta` as `distribution`, which foreign clients correctly ignore.

  `platform` has no spec field at all, so it is `_meta` too. Same for the OAuth hints
  (`scopes`, `clientId`, `exchangeProxy`) — auth is the protocol's job, discovered at
  connect time, and these are per-provider workarounds for providers that break it.
"""

import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
SERVERS_DIR = ROOT / "servers"
TOOLS_DIR = ROOT / "tools"

CATALOG_PATH = ROOT / "catalog.json"
INDEX_PATH = ROOT / "index.json"
REGISTRY_PATH = ROOT / "registry.json"

SCHEMA_VERSION = "2025-12-11"
SCHEMA_URL = f"https://static.modelcontextprotocol.io/schemas/{SCHEMA_VERSION}/server.schema.json"
#: Vendored, and committed on purpose — see load_schema().
SCHEMA_CACHE = Path(__file__).parent / "schemas" / f"server.schema.{SCHEMA_VERSION}.json"

NAMESPACE = "io.github.maxf98"
#: Our own `_meta` key, for everything the spec has no field for. Reverse-DNS, per the
#: spec's extension rules, so a foreign consumer knows to skip it.
META_STUDIO = "io.github.maxf98.streamdeck-mcp/studio"
#: Registry-level metadata on the envelope row, mirroring where the official registry
#: puts `status`/`isLatest`.
META_REGISTRY = "io.github.maxf98.streamdeck-mcp/registry"

#: Fields index.json has always carried, in that order. Do not reorder: it is compared
#: byte-for-byte against the committed file.
CATALOG_FIELDS = ["id", "name", "description", "version", "platform", "tags"]
#: Ditto for registry.json entries.
REGISTRY_FIELDS = ["url", "transport", "auth", "apiKeyUrl", "scopes", "clientId", "exchangeProxy"]


# ── sources ───────────────────────────────────────────────────────────────────

def load_remote_entries() -> list[dict]:
    """Read servers/*.json as-is — they are already ServerDetail documents."""
    entries = []
    for path in sorted(SERVERS_DIR.glob("*.json")):
        try:
            entries.append(json.loads(path.read_text()))
        except json.JSONDecodeError as err:
            sys.exit(f"✗ {path}: invalid JSON — {err}")
    # Declared order first (so registry.json keeps the order it has always had), then
    # anything without one, alphabetically. A contributor need not think about this.
    def key(entry):
        meta = entry.get("_meta", {}).get(META_STUDIO, {})
        return (meta.get("order", 10_000), entry["name"])
    return sorted(entries, key=key)


def pack_entry(manifest: dict, folder: str) -> dict:
    """Project a pack manifest into a ServerDetail. See the module docstring for why
    there is no `packages[]`."""
    studio = {
        "sourceId": manifest["id"],
        "kind": "pack",
        "platform": manifest.get("platform", []),
        "tags": manifest.get("tags", []),
        # The full prose. `description` is capped at 100 chars by the spec, and the
        # Studio's catalog UI shows the long form, so it has to survive somewhere.
        "longDescription": manifest["description"],
        "distribution": {
            "kind": "repo-subdir",
            "path": f"tools/{folder}",
            "command": manifest["command"],
            "args": manifest.get("args", []),
            **({"install": manifest["install"]} if manifest.get("install") else {}),
        },
    }
    if manifest.get("config_schema"):
        studio["configSchema"] = manifest["config_schema"]

    return {
        "$schema": SCHEMA_URL,
        "name": f"{NAMESPACE}/{manifest['id']}",
        "title": manifest["name"],
        "description": manifest["summary"],
        "version": manifest["version"],
        "repository": {
            "url": "https://github.com/maxf98/streamdeck-mcp-tools",
            "source": "github",
            "subfolder": f"tools/{folder}",
        },
        "_meta": {META_STUDIO: studio},
    }


def load_pack_entries() -> tuple[list[dict], list[dict]]:
    """Returns (ServerDetail entries, legacy index.json rows)."""
    entries, legacy = [], []
    for path in sorted(TOOLS_DIR.glob("*/manifest.json")):
        folder = path.parent.name
        try:
            manifest = json.loads(path.read_text())
        except json.JSONDecodeError as err:
            sys.exit(f"✗ {path}: invalid JSON — {err}")

        for required in ("id", "name", "description", "version", "command"):
            if required not in manifest:
                sys.exit(f"✗ tools/{folder}/manifest.json: missing '{required}'")
        if "summary" not in manifest:
            sys.exit(
                f"✗ tools/{folder}/manifest.json: missing 'summary'. A spec description is "
                f"capped at 100 characters; add a short one and keep the long text in "
                f"'description'."
            )
        if len(manifest["summary"]) > 100:
            sys.exit(
                f"✗ tools/{folder}/manifest.json: 'summary' is {len(manifest['summary'])} "
                f"characters, limit is 100."
            )

        entries.append(pack_entry(manifest, folder))
        row = {k: manifest[k] for k in CATALOG_FIELDS if k in manifest}
        row["path"] = f"tools/{folder}"
        legacy.append(row)
    return entries, legacy


# ── outputs ───────────────────────────────────────────────────────────────────

def catalog_document(entries: list[dict]) -> dict:
    """Wrap entries in the registry API's envelope, so serving it is a projection.

    `status` is carried explicitly because a catalog needs to be able to RETIRE a server.
    Without it a removed entry merely vanishes, and a client can't tell "this was
    withdrawn" from "the fetch failed".
    """
    rows = []
    for entry in entries:
        studio = entry.get("_meta", {}).get(META_STUDIO, {})
        rows.append({
            "server": entry,
            "_meta": {META_REGISTRY: {
                "status": "active",
                "isLatest": True,
                **({"publishGated": True} if studio.get("publishGated") else {}),
            }},
        })
    return {"schemaVersion": SCHEMA_VERSION, "servers": rows,
            "metadata": {"count": len(rows)}}


def registry_document(remote_entries: list[dict]) -> dict:
    """The legacy `{mcpServers: {...}}` payload, rebuilt from the same source.

    Entries marked `publishGated` are left out — that is how the Google Workspace servers
    stay hidden. It used to fall out of running `npm run emit` with no env set; it is now
    a property of the entry, which is both visible in review and testable.
    """
    servers = {}
    for entry in remote_entries:
        studio = entry["_meta"][META_STUDIO]
        if studio.get("publishGated"):
            continue
        remote = entry["remotes"][0]
        flat = {"url": remote["url"], "transport": remote["type"]}
        for field in REGISTRY_FIELDS:
            if field in ("url", "transport"):
                continue
            if field == "auth" and studio.get("authKind") == "api-key":
                flat["auth"] = "api-key"
            elif field in studio:
                flat[field] = studio[field]
        servers[studio["sourceId"]] = {k: flat[k] for k in REGISTRY_FIELDS if k in flat}
    return {"mcpServers": servers}


# ── validation ────────────────────────────────────────────────────────────────

def load_schema() -> dict:
    """The published schema, vendored on first run and committed thereafter.

    Vendored rather than fetched every time so that CI validates against a schema
    version we chose, and a new upstream revision can't turn a green main red without a
    commit. To move to a newer version, bump SCHEMA_VERSION and delete the old file.
    """
    if SCHEMA_CACHE.exists():
        return json.loads(SCHEMA_CACHE.read_text())
    with urllib.request.urlopen(SCHEMA_URL, timeout=20) as response:
        raw = response.read().decode()
    SCHEMA_CACHE.parent.mkdir(exist_ok=True)
    SCHEMA_CACHE.write_text(raw)
    print(f"  fetched and vendored {SCHEMA_CACHE.relative_to(ROOT)} — commit it")
    return json.loads(raw)


def validate(entries: list[dict]) -> list[str]:
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        return ["jsonschema is not installed — run `pip install jsonschema` to validate."]

    validator = Draft7Validator(load_schema())
    problems = []
    seen_names, seen_ids = set(), set()
    for entry in entries:
        name = entry.get("name", "<unnamed>")
        for error in sorted(validator.iter_errors(entry), key=lambda e: list(e.path)):
            where = "/".join(str(p) for p in error.path) or "(root)"
            problems.append(f"{name}: {where}: {error.message}")

        if name in seen_names:
            problems.append(f"{name}: duplicate server name")
        seen_names.add(name)

        # The bare id is the Studio's runtime handle: it prefixes every tool name as
        # `<sourceId>__<tool>`, names the pack directory, and is the stable id baked into
        # exported .loopbutton bundles. Two entries sharing one is not a cosmetic clash.
        source_id = entry.get("_meta", {}).get(META_STUDIO, {}).get("sourceId")
        if not source_id:
            problems.append(f"{name}: _meta['{META_STUDIO}'].sourceId is required")
        elif source_id in seen_ids:
            problems.append(f"{name}: duplicate sourceId '{source_id}'")
        else:
            seen_ids.add(source_id)
    return problems


# ── entry point ───────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate", action="store_true",
                        help="validate the sources and write nothing")
    parser.add_argument("--check", action="store_true",
                        help="as --validate, and also fail if an output is out of date")
    args = parser.parse_args()

    remote_entries = load_remote_entries()
    pack_entries, legacy_rows = load_pack_entries()
    entries = pack_entries + remote_entries

    problems = validate(entries)
    if problems:
        print(f"✗ {len(problems)} problem(s):", file=sys.stderr)
        for problem in problems:
            print(f"    {problem}", file=sys.stderr)
        return 1

    outputs = {
        CATALOG_PATH: json.dumps(catalog_document(entries), indent=2, ensure_ascii=False) + "\n",
        # `ensure_ascii` differs by file on purpose, so both legacy files stay byte-identical
        # to what produced them: index.json came from Python's default (\uXXXX escapes),
        # registry.json from TypeScript's JSON.stringify (literal UTF-8).
        INDEX_PATH: json.dumps({"version": "1", "tools": legacy_rows}, indent=4) + "\n",
        REGISTRY_PATH: json.dumps(registry_document(remote_entries), indent=2,
                                  ensure_ascii=False) + "\n",
    }

    if args.validate and not args.check:
        print(f"✓ {len(entries)} entries valid")
        return 0

    drifted = [p for p, text in outputs.items()
               if not p.exists() or p.read_text() != text]
    if args.check:
        if drifted:
            print("✗ out of date — run scripts/build_catalog.py:", file=sys.stderr)
            for path in drifted:
                print(f"    {path.name}", file=sys.stderr)
            return 1
        print(f"✓ {len(entries)} entries valid, all outputs up to date")
        return 0

    for path, text in outputs.items():
        path.write_text(text)

    packs = len(pack_entries)
    remotes = len(remote_entries)
    gated = sum(1 for e in remote_entries
                if e["_meta"][META_STUDIO].get("publishGated"))
    print(f"✓ {len(entries)} entries valid — {packs} packs, {remotes} remotes "
          f"({gated} publish-gated)")
    print(f"  catalog.json   {len(entries)} servers")
    print(f"  index.json     {packs} packs (legacy)")
    print(f"  registry.json  {remotes - gated} remotes (legacy)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
