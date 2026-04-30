"""
Bash / Shell MCP Server for macOS.

Two modes of execution:
  - run_command / run_script: run non-interactively, capture stdout/stderr/exit code.
    Good for scripting, data processing, build steps.
  - open_in_terminal: open Terminal.app (or iTerm2) with an optional command.
    Good for interactive sessions — e.g. `claude`, `python`, ssh.
"""

import os
import subprocess
import shlex
from typing import Optional

from fastmcp import FastMCP

mcp = FastMCP(name="BashMCP")


def _resolve_cwd(cwd: Optional[str]) -> Optional[str]:
    """Expand ~ and env vars in a path, return None if empty."""
    if not cwd:
        return None
    expanded = os.path.expandvars(os.path.expanduser(cwd))
    return expanded if os.path.isdir(expanded) else None


# ---------------------------------------------------------------------------
# Non-interactive execution
# ---------------------------------------------------------------------------

@mcp.tool
def run_command(
    command: str,
    cwd: str = "",
    env: Optional[dict] = None,
    timeout: int = 30,
) -> dict:
    """
    Run a shell command and return its output.

    Runs via bash -c so pipes, redirects, and shell builtins all work.
    stdout and stderr are captured separately. Non-zero exit codes do NOT
    raise — check the `success` field instead.

    Args:
        command: Shell command to run. Examples:
                   "ls -la ~/Desktop"
                   "git status"
                   "echo $HOME"
                   "find . -name '*.py' | wc -l"
        cwd:     Working directory. Supports ~ and $ENV_VAR. Defaults to $HOME.
        env:     Extra environment variables to merge into the process env.
        timeout: Max seconds to wait (default 30). Raises on timeout.

    Returns:
        {
          "stdout": str,       # captured standard output
          "stderr": str,       # captured standard error
          "exit_code": int,    # process exit code
          "success": bool,     # true if exit_code == 0
          "command": str       # the command that was run (for logging)
        }
    """
    resolved_cwd = _resolve_cwd(cwd) or os.path.expanduser("~")

    proc_env = os.environ.copy()
    if env:
        proc_env.update({str(k): str(v) for k, v in env.items()})

    try:
        result = subprocess.run(
            ["bash", "-c", command],
            capture_output=True,
            text=True,
            cwd=resolved_cwd,
            env=proc_env,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode,
            "success": result.returncode == 0,
            "command": command,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Command timed out after {timeout}s",
            "exit_code": -1,
            "success": False,
            "command": command,
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "success": False,
            "command": command,
        }


@mcp.tool
def run_script(
    script: str,
    cwd: str = "",
    env: Optional[dict] = None,
    timeout: int = 60,
) -> dict:
    """
    Run a multi-line bash script and return its output.

    Identical to run_command but intended for multi-line scripts.
    The script is written to a temp file and executed with bash.

    Args:
        script:  Multi-line bash script. Example:
                   #!/bin/bash
                   cd ~/my-project
                   git pull
                   npm install
                   npm run build
        cwd:     Working directory for the script. Supports ~ and $ENV_VAR.
        env:     Extra environment variables.
        timeout: Max seconds (default 60 — scripts often take longer).

    Returns:
        Same shape as run_command: {stdout, stderr, exit_code, success, command}
    """
    import tempfile
    resolved_cwd = _resolve_cwd(cwd) or os.path.expanduser("~")
    proc_env = os.environ.copy()
    if env:
        proc_env.update({str(k): str(v) for k, v in env.items()})

    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".sh", delete=False, prefix="streamdeck_"
        ) as f:
            f.write(script)
            script_path = f.name

        os.chmod(script_path, 0o755)

        result = subprocess.run(
            ["bash", script_path],
            capture_output=True,
            text=True,
            cwd=resolved_cwd,
            env=proc_env,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode,
            "success": result.returncode == 0,
            "command": f"<script ({len(script.splitlines())} lines)>",
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Script timed out after {timeout}s",
            "exit_code": -1,
            "success": False,
            "command": "<script>",
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "success": False,
            "command": "<script>",
        }
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Interactive terminal
# ---------------------------------------------------------------------------

@mcp.tool
def open_in_terminal(
    command: str = "",
    cwd: str = "",
    app: str = "auto",
    new_window: bool = True,
) -> dict:
    """
    Open Terminal.app (or iTerm2) and optionally run a command interactively.

    Unlike run_command, this opens a visible terminal window — great for
    interactive programs like `claude`, `python`, `ssh`, or any REPL.
    The command is typed into the terminal as if you typed it yourself.

    Args:
        command:    Command to run in the terminal. Leave empty to just open
                    a shell at cwd. Examples:
                      "claude"
                      "python3 -m venv .venv && source .venv/bin/activate"
                      "ssh user@host"
        cwd:        Directory to open in. Supports ~ and $ENV_VAR.
                    Defaults to $HOME.
        app:        Which terminal to use: "Terminal", "iTerm", or "auto"
                    (auto picks iTerm if installed, else Terminal).
        new_window: If True (default), open a new window. If False, open a
                    new tab in the frontmost window (Terminal.app only).

    Returns:
        {"success": bool, "app": str, "message": str}
    """
    resolved_cwd = _resolve_cwd(cwd) or os.path.expanduser("~")

    # Auto-detect iTerm2
    if app == "auto":
        iterm_check = subprocess.run(
            ["osascript", "-e", 'tell application "System Events" to return (exists process "iTerm2")'],
            capture_output=True, text=True
        )
        app = "iTerm" if iterm_check.stdout.strip() == "true" else "Terminal"

    try:
        if app == "iTerm":
            _open_iterm(resolved_cwd, command)
        else:
            _open_terminal(resolved_cwd, command, new_window)

        return {
            "success": True,
            "app": app,
            "message": f"Opened {app}" + (f" in {resolved_cwd}" if cwd else "") + (f" running: {command}" if command else ""),
        }
    except Exception as e:
        return {
            "success": False,
            "app": app,
            "message": str(e),
        }


def _open_terminal(cwd: str, command: str, new_window: bool) -> None:
    """Open Terminal.app, cd to cwd, optionally run command."""
    # Build the shell command: cd first, then the user command
    shell_cmd = f"cd {shlex.quote(cwd)}"
    if command:
        shell_cmd += f" && {command}"

    if new_window:
        script = f'''
tell application "Terminal"
    activate
    do script {_as_string(shell_cmd)}
end tell
'''
    else:
        script = f'''
tell application "Terminal"
    activate
    tell front window
        do script {_as_string(shell_cmd)} in selected tab
    end tell
end tell
'''
    subprocess.run(["osascript", "-e", script], check=True, capture_output=True)


def _open_iterm(cwd: str, command: str) -> None:
    """Open iTerm2, cd to cwd, optionally run command."""
    shell_cmd = f"cd {shlex.quote(cwd)}"
    if command:
        shell_cmd += f" && {command}"

    script = f'''
tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text {_as_string(shell_cmd)}
    end tell
end tell
'''
    subprocess.run(["osascript", "-e", script], check=True, capture_output=True)


def _as_string(s: str) -> str:
    """Wrap a Python string as an AppleScript string literal."""
    # AppleScript strings use double quotes; escape any internal double quotes
    escaped = s.replace('"', '\\"')
    return f'"{escaped}"'


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

@mcp.tool
def which(command: str) -> dict:
    """
    Find where a command is installed (like `which` in the shell).

    Useful before constructing a run_command call to verify the tool exists.

    Args:
        command: Command name to look up. Example: "git", "python3", "claude"

    Returns:
        {"found": bool, "path": str, "command": str}
    """
    result = subprocess.run(
        ["which", command],
        capture_output=True, text=True
    )
    path = result.stdout.strip()
    return {
        "found": result.returncode == 0,
        "path": path,
        "command": command,
    }


@mcp.tool
def get_env(keys: Optional[list] = None) -> dict:
    """
    Get environment variables from the shell.

    Args:
        keys: List of variable names to fetch. If None/empty, returns a
              useful subset: PATH, HOME, USER, SHELL, PWD, LANG, TERM.

    Returns:
        Dict of {variable_name: value}. Missing vars are omitted.
    """
    if not keys:
        keys = ["PATH", "HOME", "USER", "SHELL", "PWD", "LANG", "TERM",
                "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "NVM_DIR", "GOPATH"]
    return {k: os.environ[k] for k in keys if k in os.environ}


if __name__ == "__main__":
    mcp.run()
