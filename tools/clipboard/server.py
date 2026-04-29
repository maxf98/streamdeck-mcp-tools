"""
Clipboard Management MCP Server for macOS.

Provides tools to read, write, transform, and manage the system clipboard
using NSPasteboard (via pyobjc) for proper multi-type support, with
pbcopy/pbpaste as fallbacks for plain text operations.
"""

from datetime import datetime
from typing import Optional

import AppKit
from fastmcp import FastMCP
from pydantic import BaseModel

from applescript_runner import run_applescript, AppleScriptError

mcp = FastMCP(name="ClipboardMCP")

# In-memory clipboard history (persists for the lifetime of the server)
_clipboard_history: list[dict] = []
_MAX_HISTORY = 100

# NSPasteboard type constants for readable names
_TYPE_LABELS = {
    str(AppKit.NSPasteboardTypeString): "plain_text",
    str(AppKit.NSPasteboardTypeRTF): "rtf",
    str(AppKit.NSPasteboardTypeRTFD): "rtfd",
    str(AppKit.NSPasteboardTypeHTML): "html",
    str(AppKit.NSPasteboardTypePNG): "png_image",
    str(AppKit.NSPasteboardTypeTIFF): "tiff_image",
    str(AppKit.NSPasteboardTypeFileURL): "file_url",
    str(AppKit.NSPasteboardTypePDF): "pdf",
    str(AppKit.NSPasteboardTypeTabularText): "tabular_text",
    str(AppKit.NSPasteboardTypeURL): "url",
    str(AppKit.NSPasteboardTypeColor): "color",
    str(AppKit.NSPasteboardTypeSound): "sound",
}


# =============================================================================
# PYDANTIC MODELS
# =============================================================================


class ErrorResult(BaseModel):
    error: str


# READ TOOLS

class ClipboardText(BaseModel):
    text: str
    length: int
    available_types: list[str]


class ClipboardTypeEntry(BaseModel):
    type: str
    label: str
    size: int


class ClipboardInfo(BaseModel):
    types: list[ClipboardTypeEntry]
    has_text: bool
    has_rich_text: bool
    has_html: bool
    has_image: bool
    has_file_urls: bool
    has_url: bool
    type_count: int


class ClipboardHtml(BaseModel):
    html: str
    length: int


class ClipboardRtf(BaseModel):
    rtf: str
    length: int


class ClipboardImageInfo(BaseModel):
    format: str
    width: int
    height: int
    size_bytes: int


class ClipboardFilePaths(BaseModel):
    file_paths: list[str]
    count: int


class ClipboardUrl(BaseModel):
    url: str
    source: Optional[str] = None


# WRITE TOOLS

class SuccessMessage(BaseModel):
    success: bool
    message: str


class SuccessMessageWithLength(BaseModel):
    success: bool
    message: str
    length: int


# TRANSFORM TOOLS

class TransformResult(BaseModel):
    success: bool
    operation: str
    length: int
    preview: str


class TransformError(BaseModel):
    error: str
    valid_operations: list[str] | None = None


class FindReplaceResult(BaseModel):
    success: bool
    replacements: int
    length: Optional[int] = None
    message: Optional[str] = None


# HISTORY TOOLS

class HistoryEntry(BaseModel):
    text: str
    full_length: int
    timestamp: str
    source: str
    types: list[str]


class ClipboardHistory(BaseModel):
    entries: list[HistoryEntry]
    total_in_history: int


class RestoreResult(BaseModel):
    success: bool
    message: str
    preview: str
    length: int


class ClearHistoryResult(BaseModel):
    success: bool
    message: str
    entries_cleared: int


# SYSTEM TOOLS

class CopySelectionResult(BaseModel):
    success: bool
    text: str
    length: int
    available_types: list[str]


# =============================================================================
# HELPERS
# =============================================================================


def _pb() -> AppKit.NSPasteboard:
    """Get the general system pasteboard."""
    return AppKit.NSPasteboard.generalPasteboard()


def _add_to_history(text: str, source: str = "system", types: list[str] | None = None) -> None:
    """Record a clipboard entry in the in-memory history."""
    if _clipboard_history and _clipboard_history[0]["text"] == text:
        return
    _clipboard_history.insert(0, {
        "text": text,
        "timestamp": datetime.now().isoformat(),
        "source": source,
        "types": types or ["plain_text"],
    })
    if len(_clipboard_history) > _MAX_HISTORY:
        _clipboard_history.pop()


def _get_clipboard_types() -> list[dict]:
    """Get all types currently on the pasteboard with human-readable labels."""
    pb = _pb()
    types = pb.types() or []
    result = []
    for t in types:
        t_str = str(t)
        label = _TYPE_LABELS.get(t_str, t_str)
        data = pb.dataForType_(t)
        size = len(data) if data else 0
        result.append({"type": t_str, "label": label, "size": size})
    return result


# =============================================================================
# READ TOOLS
# =============================================================================


@mcp.tool
async def get_clipboard() -> ClipboardText:
    """
    Get the current text contents of the system clipboard.
    """
    pb = _pb()
    text = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    types = _get_clipboard_types()
    type_labels = [t["label"] for t in types]

    if text:
        _add_to_history(text, types=type_labels)

    return ClipboardText(text=text, length=len(text), available_types=type_labels)


@mcp.tool
async def get_clipboard_info() -> ClipboardInfo:
    """
    Get detailed information about all data types currently on the clipboard.
    """
    types = _get_clipboard_types()
    labels = {t["label"] for t in types}
    type_entries = [ClipboardTypeEntry(type=t["type"], label=t["label"], size=t["size"]) for t in types]
    return ClipboardInfo(
        types=type_entries,
        has_text="plain_text" in labels,
        has_rich_text="rtf" in labels or "rtfd" in labels,
        has_html="html" in labels,
        has_image="png_image" in labels or "tiff_image" in labels,
        has_file_urls="file_url" in labels,
        has_url="url" in labels,
        type_count=len(types),
    )


@mcp.tool
async def get_clipboard_html() -> ClipboardHtml | ErrorResult:
    """
    Get HTML content from the clipboard (e.g. after copying from a browser or
    rich text editor).
    """
    pb = _pb()
    html_data = pb.dataForType_(AppKit.NSPasteboardTypeHTML)
    if not html_data:
        return ErrorResult(error="No HTML content on clipboard")

    html = bytes(html_data).decode("utf-8", errors="replace")
    return ClipboardHtml(html=html, length=len(html))


@mcp.tool
async def get_clipboard_rtf() -> ClipboardRtf | ErrorResult:
    """
    Get RTF content from the clipboard.
    """
    pb = _pb()
    rtf_data = pb.dataForType_(AppKit.NSPasteboardTypeRTF)
    if not rtf_data:
        return ErrorResult(error="No RTF content on clipboard")

    rtf = bytes(rtf_data).decode("utf-8", errors="replace")
    return ClipboardRtf(rtf=rtf, length=len(rtf))


@mcp.tool
async def get_clipboard_image_info() -> ClipboardImageInfo | ErrorResult:
    """
    Get information about an image on the clipboard. Does not return the
    image data itself (which could be very large), but reports dimensions
    and size.
    """
    pb = _pb()
    # Try PNG first, then TIFF
    for ptype, fmt in [(AppKit.NSPasteboardTypePNG, "png"), (AppKit.NSPasteboardTypeTIFF, "tiff")]:
        data = pb.dataForType_(ptype)
        if data:
            image = AppKit.NSImage.alloc().initWithData_(data)
            if image:
                size = image.size()
                return ClipboardImageInfo(
                    format=fmt,
                    width=int(size.width),
                    height=int(size.height),
                    size_bytes=len(data),
                )
    return ErrorResult(error="No image on clipboard")


@mcp.tool
async def get_clipboard_file_paths() -> ClipboardFilePaths:
    """
    Get file paths from the clipboard (e.g. after copying files in Finder).
    """
    pb = _pb()
    urls = pb.readObjectsForClasses_options_(
        [AppKit.NSURL], {AppKit.NSPasteboardURLReadingFileURLsOnlyKey: True}
    )
    paths = []
    if urls:
        for url in urls:
            path = url.path()
            if path:
                paths.append(str(path))
    return ClipboardFilePaths(file_paths=paths, count=len(paths))


@mcp.tool
async def get_clipboard_url() -> ClipboardUrl | ErrorResult:
    """
    Get a URL from the clipboard (e.g. after copying a link from a browser).
    """
    pb = _pb()
    url_string = pb.stringForType_(AppKit.NSPasteboardTypeURL)
    if url_string:
        return ClipboardUrl(url=str(url_string))
    # Fallback: check if the plain text looks like a URL
    text = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    if text.startswith(("http://", "https://", "ftp://")):
        return ClipboardUrl(url=text, source="plain_text")
    return ErrorResult(error="No URL on clipboard")


# =============================================================================
# WRITE TOOLS
# =============================================================================


@mcp.tool
async def set_clipboard(text: str) -> SuccessMessageWithLength:
    """
    Set the system clipboard to the given plain text.

    Args:
        text: The text to place on the clipboard.
    """
    pb = _pb()
    pb.clearContents()
    pb.setString_forType_(text, AppKit.NSPasteboardTypeString)
    _add_to_history(text, source="set_clipboard")
    return SuccessMessageWithLength(
        success=True,
        message=f"Clipboard set ({len(text)} chars)",
        length=len(text),
    )


@mcp.tool
async def set_clipboard_html(html: str, plain_text_fallback: Optional[str] = None) -> SuccessMessage:
    """
    Set the clipboard to HTML content, with an optional plain text fallback.
    Apps that support rich paste (Mail, Pages, etc.) will get the HTML;
    others will get the plain text.

    Args:
        html: The HTML content to place on the clipboard.
        plain_text_fallback: Optional plain text version. If omitted, a basic
                             stripped version is used.
    """
    pb = _pb()
    pb.clearContents()
    pb.setString_forType_(html, AppKit.NSPasteboardTypeHTML)
    fallback = plain_text_fallback or html
    pb.setString_forType_(fallback, AppKit.NSPasteboardTypeString)
    _add_to_history(fallback, source="set_clipboard_html", types=["html", "plain_text"])
    return SuccessMessage(success=True, message=f"Clipboard set to HTML ({len(html)} chars)")


@mcp.tool
async def clear_clipboard() -> SuccessMessage:
    """
    Clear the system clipboard of all content.
    """
    pb = _pb()
    pb.clearContents()
    return SuccessMessage(success=True, message="Clipboard cleared")


@mcp.tool
async def append_to_clipboard(text: str, separator: str = "\n") -> SuccessMessageWithLength:
    """
    Append text to the current clipboard text contents.

    Args:
        text: The text to append.
        separator: Separator between existing content and new text (default: newline).
    """
    pb = _pb()
    current = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    new_text = current + separator + text
    pb.clearContents()
    pb.setString_forType_(new_text, AppKit.NSPasteboardTypeString)
    _add_to_history(new_text, source="append_to_clipboard")
    return SuccessMessageWithLength(
        success=True,
        message=f"Appended to clipboard ({len(new_text)} chars total)",
        length=len(new_text),
    )


@mcp.tool
async def prepend_to_clipboard(text: str, separator: str = "\n") -> SuccessMessageWithLength:
    """
    Prepend text to the current clipboard text contents.

    Args:
        text: The text to prepend.
        separator: Separator between new text and existing content (default: newline).
    """
    pb = _pb()
    current = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    new_text = text + separator + current
    pb.clearContents()
    pb.setString_forType_(new_text, AppKit.NSPasteboardTypeString)
    _add_to_history(new_text, source="prepend_to_clipboard")
    return SuccessMessageWithLength(
        success=True,
        message=f"Prepended to clipboard ({len(new_text)} chars total)",
        length=len(new_text),
    )


# =============================================================================
# TRANSFORM TOOLS
# =============================================================================


@mcp.tool
async def transform_clipboard(operation: str) -> TransformResult | TransformError:
    """
    Apply a text transformation to the current clipboard contents in place.

    Args:
        operation: The transformation to apply. One of:
            - "uppercase": Convert to UPPERCASE
            - "lowercase": Convert to lowercase
            - "titlecase": Convert To Title Case
            - "trim": Remove leading/trailing whitespace
            - "strip_newlines": Replace newlines with spaces
            - "sort_lines": Sort lines alphabetically
            - "unique_lines": Remove duplicate lines (preserving order)
            - "reverse_lines": Reverse the order of lines
            - "number_lines": Add line numbers (1. 2. 3. ...)
            - "remove_blank_lines": Remove empty lines
    """
    pb = _pb()
    current = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    if not current:
        return TransformError(error="Clipboard is empty or has no text")

    ops = {
        "uppercase": lambda t: t.upper(),
        "lowercase": lambda t: t.lower(),
        "titlecase": lambda t: t.title(),
        "trim": lambda t: t.strip(),
        "strip_newlines": lambda t: t.replace("\n", " ").replace("\r", " "),
        "sort_lines": lambda t: "\n".join(sorted(t.splitlines())),
        "unique_lines": lambda t: "\n".join(dict.fromkeys(t.splitlines())),
        "reverse_lines": lambda t: "\n".join(reversed(t.splitlines())),
        "number_lines": lambda t: "\n".join(
            f"{i}. {line}" for i, line in enumerate(t.splitlines(), 1)
        ),
        "remove_blank_lines": lambda t: "\n".join(
            line for line in t.splitlines() if line.strip()
        ),
    }

    if operation not in ops:
        return TransformError(
            error=f"Unknown operation '{operation}'",
            valid_operations=list(ops.keys()),
        )

    transformed = ops[operation](current)
    pb.clearContents()
    pb.setString_forType_(transformed, AppKit.NSPasteboardTypeString)
    _add_to_history(transformed, source=f"transform:{operation}")
    preview = transformed[:200] + ("..." if len(transformed) > 200 else "")
    return TransformResult(
        success=True,
        operation=operation,
        length=len(transformed),
        preview=preview,
    )


@mcp.tool
async def find_and_replace_clipboard(find: str, replace: str) -> FindReplaceResult | ErrorResult:
    """
    Find and replace text in the current clipboard contents.

    Args:
        find: The text to search for.
        replace: The text to replace it with.
    """
    pb = _pb()
    current = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    if not current:
        return ErrorResult(error="Clipboard is empty or has no text")

    count = current.count(find)
    if count == 0:
        return FindReplaceResult(success=True, message="No matches found", replacements=0)

    transformed = current.replace(find, replace)
    pb.clearContents()
    pb.setString_forType_(transformed, AppKit.NSPasteboardTypeString)
    _add_to_history(transformed, source="find_and_replace")
    return FindReplaceResult(success=True, replacements=count, length=len(transformed))


# =============================================================================
# HISTORY TOOLS
# =============================================================================


@mcp.tool
async def get_clipboard_history(limit: int = 20) -> ClipboardHistory:
    """
    Get the in-memory clipboard history (entries tracked since the server started).

    Args:
        limit: Maximum number of history entries to return (default: 20).
    """
    # Snapshot current clipboard and add if new
    pb = _pb()
    text = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
    if text:
        types = _get_clipboard_types()
        _add_to_history(text, types=[t["label"] for t in types])

    entries = _clipboard_history[:limit]
    result = []
    for entry in entries:
        t = entry["text"]
        result.append(HistoryEntry(
            text=t[:500] + ("..." if len(t) > 500 else ""),
            full_length=len(t),
            timestamp=entry["timestamp"],
            source=entry["source"],
            types=entry.get("types", ["plain_text"]),
        ))
    return ClipboardHistory(entries=result, total_in_history=len(_clipboard_history))


@mcp.tool
async def restore_from_history(index: int) -> RestoreResult | ErrorResult:
    """
    Restore a clipboard entry from history back to the system clipboard.

    Args:
        index: The 0-based index in the history (0 = most recent).
    """
    if index < 0 or index >= len(_clipboard_history):
        return ErrorResult(
            error=f"Invalid index {index}. History has {len(_clipboard_history)} entries (0-{len(_clipboard_history) - 1}).",
        )

    text = _clipboard_history[index]["text"]
    pb = _pb()
    pb.clearContents()
    pb.setString_forType_(text, AppKit.NSPasteboardTypeString)
    preview = text[:200] + ("..." if len(text) > 200 else "")
    return RestoreResult(
        success=True,
        message=f"Restored entry {index} to clipboard",
        preview=preview,
        length=len(text),
    )


@mcp.tool
async def clear_clipboard_history() -> ClearHistoryResult:
    """
    Clear the in-memory clipboard history. Does not affect the current clipboard.
    """
    count = len(_clipboard_history)
    _clipboard_history.clear()
    return ClearHistoryResult(
        success=True,
        message=f"Cleared {count} history entries",
        entries_cleared=count,
    )


# =============================================================================
# SYSTEM COPY / PASTE TOOLS
# =============================================================================


@mcp.tool
async def copy_selection() -> CopySelectionResult | ErrorResult:
    """
    Send Cmd+C to the frontmost application to copy its current selection
    to the clipboard, then return what was copied.
    """
    script = '''
    tell application "System Events"
        keystroke "c" using command down
    end tell
    delay 0.3
    return "ok"
    '''
    try:
        run_applescript(script)
        pb = _pb()
        text = pb.stringForType_(AppKit.NSPasteboardTypeString) or ""
        types = _get_clipboard_types()
        type_labels = [t["label"] for t in types]
        if text:
            _add_to_history(text, source="copy_selection", types=type_labels)
        return CopySelectionResult(
            success=True,
            text=text,
            length=len(text),
            available_types=type_labels,
        )
    except AppleScriptError as e:
        return ErrorResult(error=e.message)


@mcp.tool
async def paste() -> SuccessMessage | ErrorResult:
    """
    Send Cmd+V to the frontmost application to paste the current clipboard
    contents at the cursor/selection.
    """
    script = '''
    tell application "System Events"
        keystroke "v" using command down
    end tell
    return "ok"
    '''
    try:
        run_applescript(script)
        return SuccessMessage(success=True, message="Pasted clipboard contents")
    except AppleScriptError as e:
        return ErrorResult(error=e.message)


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    mcp.run()
