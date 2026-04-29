#!/usr/bin/env python3
"""
Regenerate index.json from all tools/*/manifest.json files.
Run locally or via CI on every push to main.
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
TOOLS_DIR = ROOT / "tools"
INDEX_PATH = ROOT / "index.json"

CATALOG_FIELDS = ["id", "name", "description", "version", "platform", "tags"]


def build_index():
    tools = []
    for manifest_path in sorted(TOOLS_DIR.glob("*/manifest.json")):
        tool_dir = manifest_path.parent
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError as e:
            print(f"  ⚠ Skipping {tool_dir.name}: invalid JSON — {e}")
            continue

        if "id" not in manifest or "name" not in manifest:
            print(f"  ⚠ Skipping {tool_dir.name}: missing 'id' or 'name'")
            continue

        entry = {k: manifest[k] for k in CATALOG_FIELDS if k in manifest}
        entry["path"] = f"tools/{tool_dir.name}"
        tools.append(entry)
        print(f"  ✓ {manifest['id']} v{manifest.get('version', '?')}")

    index = {"version": "1", "tools": tools}
    INDEX_PATH.write_text(json.dumps(index, indent=4) + "\n")
    print(f"\nWrote {INDEX_PATH} — {len(tools)} tool(s)")


if __name__ == "__main__":
    build_index()
