"""
AppleScript execution utilities for the Clipboard MCP server.
"""

import subprocess


class AppleScriptError(Exception):
    """Custom exception for AppleScript errors."""

    def __init__(self, message: str, error_type: str = "applescript_error") -> None:
        self.message = message
        self.error_type = error_type
        super().__init__(self.message)


def run_applescript(script: str, timeout: int = 30) -> str:
    """
    Execute an AppleScript and return the output.

    Args:
        script: The AppleScript code to execute.
        timeout: Maximum execution time in seconds.

    Returns:
        The stdout from osascript execution.

    Raises:
        AppleScriptError: If the script fails.
    """
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise AppleScriptError(
            message=f"AppleScript timed out after {timeout} seconds",
            error_type="timeout",
        ) from e

    if result.returncode != 0:
        raise AppleScriptError(
            message=result.stderr.strip() or "Unknown AppleScript error",
            error_type="execution_failed",
        )

    return result.stdout.strip()
