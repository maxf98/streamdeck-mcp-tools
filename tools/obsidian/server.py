"""
Obsidian vault MCP server.

Reads/writes Markdown files in an Obsidian vault directory.
Configure the vault path via the OBSIDIAN_VAULT_PATH environment variable.
"""

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastmcp import FastMCP

mcp = FastMCP("obsidian")

# ---------------------------------------------------------------------------
# Vault root
# ---------------------------------------------------------------------------

def vault() -> Path:
    vp = os.environ.get("OBSIDIAN_VAULT_PATH", "").strip()
    if not vp:
        raise RuntimeError(
            "OBSIDIAN_VAULT_PATH is not set. "
            "Configure it via install_tool_pack or configure_tool_pack."
        )
    p = Path(vp).expanduser().resolve()
    if not p.is_dir():
        raise RuntimeError(f"Vault path does not exist or is not a directory: {p}")
    return p


def _safe_path(vault_root: Path, rel: str) -> Path:
    """Resolve a relative note path inside the vault, rejecting path traversal."""
    if not rel.endswith(".md"):
        rel = rel + ".md"
    candidate = (vault_root / rel).resolve()
    if not str(candidate).startswith(str(vault_root)):
        raise ValueError(f"Path traversal rejected: {rel}")
    return candidate


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def list_notes(folder: str = "") -> list[dict]:
    """
    List all Markdown notes in the vault (or a sub-folder).

    Args:
        folder: Relative path to a sub-folder (empty = entire vault).

    Returns:
        List of {path, name, modified} dicts sorted by modification time descending.
    """
    root = vault()
    base = (root / folder).resolve() if folder else root
    if not base.is_dir():
        return []

    results = []
    for f in base.rglob("*.md"):
        # Skip .obsidian internals
        if ".obsidian" in f.parts:
            continue
        rel = str(f.relative_to(root))
        stat = f.stat()
        results.append({
            "path": rel,
            "name": f.stem,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })

    results.sort(key=lambda x: x["modified"], reverse=True)
    return results


@mcp.tool()
def read_note(path: str) -> dict:
    """
    Read a note from the vault.

    Args:
        path: Relative path to the note (e.g. "folder/My Note.md" or "My Note").

    Returns:
        {path, name, content, modified}
    """
    root = vault()
    full = _safe_path(root, path)
    if not full.exists():
        raise FileNotFoundError(f"Note not found: {path}")
    content = full.read_text(encoding="utf-8")
    stat = full.stat()
    return {
        "path": str(full.relative_to(root)),
        "name": full.stem,
        "content": content,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


@mcp.tool()
def write_note(path: str, content: str, overwrite: bool = True) -> dict:
    """
    Create or overwrite a note in the vault.

    Args:
        path: Relative path (e.g. "folder/My Note.md" or "My Note").
        content: Full Markdown content.
        overwrite: If False, raises an error when the note already exists.

    Returns:
        {path, created}
    """
    root = vault()
    full = _safe_path(root, path)
    if full.exists() and not overwrite:
        raise FileExistsError(f"Note already exists: {path}")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    return {
        "path": str(full.relative_to(root)),
        "created": not full.exists(),
    }


@mcp.tool()
def append_to_note(path: str, text: str) -> dict:
    """
    Append text to an existing note (creates the note if it doesn't exist).

    Args:
        path: Relative path to the note.
        text: Text to append (a newline is added before it if needed).

    Returns:
        {path, length}
    """
    root = vault()
    full = _safe_path(root, path)
    full.parent.mkdir(parents=True, exist_ok=True)
    existing = full.read_text(encoding="utf-8") if full.exists() else ""
    separator = "\n" if existing and not existing.endswith("\n") else ""
    new_content = existing + separator + text
    full.write_text(new_content, encoding="utf-8")
    return {"path": str(full.relative_to(root)), "length": len(new_content)}


@mcp.tool()
def delete_note(path: str) -> dict:
    """
    Delete a note from the vault.

    Args:
        path: Relative path to the note.

    Returns:
        {path, deleted}
    """
    root = vault()
    full = _safe_path(root, path)
    if not full.exists():
        return {"path": path, "deleted": False, "reason": "not found"}
    full.unlink()
    return {"path": str(full.relative_to(root)), "deleted": True}


@mcp.tool()
def search_notes(query: str, folder: str = "", max_results: int = 20) -> list[dict]:
    """
    Full-text search across all notes in the vault.

    Args:
        query: Search string (case-insensitive).
        folder: Limit search to this sub-folder (empty = entire vault).
        max_results: Maximum number of results to return.

    Returns:
        List of {path, name, snippet, matches} sorted by match count descending.
    """
    root = vault()
    base = (root / folder).resolve() if folder else root
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    results = []

    for f in base.rglob("*.md"):
        if ".obsidian" in f.parts:
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        matches_list = pattern.findall(text)
        if not matches_list:
            continue
        # Find a snippet around the first match
        m = pattern.search(text)
        start = max(0, m.start() - 80)
        end = min(len(text), m.end() + 80)
        snippet = "..." + text[start:end].replace("\n", " ").strip() + "..."
        results.append({
            "path": str(f.relative_to(root)),
            "name": f.stem,
            "snippet": snippet,
            "matches": len(matches_list),
        })

    results.sort(key=lambda x: x["matches"], reverse=True)
    return results[:max_results]


@mcp.tool()
def list_folders() -> list[str]:
    """
    List all sub-folders in the vault (excluding .obsidian internals).

    Returns:
        Sorted list of relative folder paths.
    """
    root = vault()
    folders = []
    for d in root.rglob("*"):
        if not d.is_dir():
            continue
        if ".obsidian" in d.parts:
            continue
        rel = str(d.relative_to(root))
        if rel != ".":
            folders.append(rel)
    return sorted(folders)


@mcp.tool()
def move_note(path: str, new_path: str) -> dict:
    """
    Move (rename) a note within the vault.

    Args:
        path: Current relative path.
        new_path: New relative path.

    Returns:
        {old_path, new_path}
    """
    root = vault()
    src = _safe_path(root, path)
    dst = _safe_path(root, new_path)
    if not src.exists():
        raise FileNotFoundError(f"Note not found: {path}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {
        "old_path": str(src.relative_to(root)),
        "new_path": str(dst.relative_to(root)),
    }


@mcp.tool()
def get_vault_stats() -> dict:
    """
    Return statistics about the vault.

    Returns:
        {note_count, folder_count, vault_path, total_size_bytes}
    """
    root = vault()
    notes = [f for f in root.rglob("*.md") if ".obsidian" not in f.parts]
    folders = [d for d in root.rglob("*") if d.is_dir() and ".obsidian" not in d.parts]
    total_size = sum(f.stat().st_size for f in notes)
    return {
        "note_count": len(notes),
        "folder_count": len(folders),
        "vault_path": str(root),
        "total_size_bytes": total_size,
    }


if __name__ == "__main__":
    mcp.run()
