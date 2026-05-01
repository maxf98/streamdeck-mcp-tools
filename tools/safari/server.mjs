/**
 * Safari — control Apple Safari via AppleScript
 *
 * Layer 1 – Tab management (always available):
 *   open_url, get_active_tab, list_tabs, focus_tab, close_tab,
 *   reload, go_back, go_forward, new_window
 *
 * Layer 2 – JavaScript execution (requires one-time setup):
 *   Call enable_javascript once to enable "Allow JavaScript from Apple Events"
 *   in Safari's Develop menu. After that, execute_javascript, get_page_source,
 *   and get_page_text work against the user's real Safari session — no separate
 *   window or port needed (unlike Chrome CDP).
 *
 * No Safari extension required.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const server = new McpServer({ name: 'safari', version: '1.0.0' });

// ── AppleScript helpers ───────────────────────────────────────────────────────

async function as(script, timeoutMs = 15000) {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: timeoutMs,
    });
    return stdout.trim();
  } catch (err) {
    const msg = err?.stderr?.trim() ?? err?.message ?? String(err);
    if (msg.includes('not running') || msg.includes("Can't get")) {
      throw new Error('Safari is not running. Please open Safari first.');
    }
    if (msg.includes('Apple Events') || msg.includes('turned off') || msg.includes('not allowed')) {
      throw new Error(
        'JavaScript from Apple Events is not enabled in Safari. ' +
        'Call enable_javascript to turn it on, or go to Safari > Develop > Allow JavaScript from Apple Events.'
      );
    }
    throw new Error(msg);
  }
}

// ── Layer 1: Tab management ───────────────────────────────────────────────────

server.registerTool('open_url', {
  description: 'Open a URL in Safari. Opens in a new tab in the front window by default, or in a new window.',
  inputSchema: {
    url:        z.string().describe('URL to open (e.g. "https://example.com")'),
    new_window: z.boolean().default(false).describe('Open in a new window instead of a new tab'),
  },
}, async ({ url, new_window }) => {
  const escaped = url.replace(/"/g, '\\"');
  if (new_window) {
    await as(`
      tell application "Safari"
        make new document with properties {URL:"${escaped}"}
        activate
      end tell
    `);
  } else {
    await as(`
      tell application "Safari"
        if (count of windows) is 0 then
          make new document with properties {URL:"${escaped}"}
        else
          tell front window
            set newTab to make new tab with properties {URL:"${escaped}"}
            set current tab to newTab
          end tell
        end if
        activate
      end tell
    `);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, url }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_active_tab', {
  description: 'Get the URL and title of the currently active tab in the front Safari window.',
  inputSchema: {},
}, async () => {
  const raw = await as(`
    tell application "Safari"
      if (count of windows) is 0 then return "NO_WINDOW"
      set t to current tab of front window
      return (URL of t) & "|||" & (name of t)
    end tell
  `);
  if (raw === 'NO_WINDOW') throw new Error('No Safari windows open.');
  const [url, ...rest] = raw.split('|||');
  return { content: [{ type: 'text', text: JSON.stringify({ url, title: rest.join('|||') }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('list_tabs', {
  description: 'List all open tabs across all Safari windows. Returns [{window_index, tab_index, url, title, active}].',
  inputSchema: {},
}, async () => {
  const raw = await as(`
    tell application "Safari"
      set output to ""
      repeat with w in every window
        set wi to index of w
        set ai to index of current tab of w
        repeat with t in every tab of w
          set ti to index of t
          set isActive to (ti = ai)
          set output to output & wi & ":::" & ti & ":::" & (URL of t) & ":::" & (name of t) & ":::" & isActive & "|||"
        end repeat
      end repeat
      return output
    end tell
  `);
  const tabs = raw.split('|||').filter(Boolean).map(entry => {
    const [wi, ti, url, ...rest] = entry.split(':::');
    const active = rest[rest.length - 1] === 'true';
    const title = rest.slice(0, -1).join(':::');
    return {
      window_index: parseInt(wi) - 1,
      tab_index:    parseInt(ti) - 1,
      url, title, active,
    };
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: tabs.length, tabs }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('focus_tab', {
  description: 'Switch to the first Safari tab whose URL or title contains the query string (case-insensitive). Brings Safari to the foreground.',
  inputSchema: {
    query: z.string().describe('Substring to match against tab URL or title'),
  },
}, async ({ query }) => {
  const escaped = query.replace(/"/g, '\\"').toLowerCase();
  const raw = await as(`
    tell application "Safari"
      set q to "${escaped}"
      repeat with w in every window
        set wi to index of w
        repeat with t in every tab of w
          set ti to index of t
          set u to URL of t
          set n to name of t
          if (u contains q) or (n contains q) then
            set current tab of w to t
            activate
            return (wi as text) & ":::" & (ti as text) & ":::" & u & ":::" & n
          end if
        end repeat
      end repeat
      return "NOT_FOUND"
    end tell
  `);
  if (raw === 'NOT_FOUND') throw new Error(`No tab found matching "${query}"`);
  const [wi, ti, url, ...rest] = raw.split(':::');
  return { content: [{ type: 'text', text: JSON.stringify({
    success: true,
    tab: { window_index: parseInt(wi) - 1, tab_index: parseInt(ti) - 1, url, title: rest.join(':::') },
  }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('close_tab', {
  description: 'Close a Safari tab. Closes the first tab matching the query, or the active tab if no query given.',
  inputSchema: {
    query: z.string().default('').describe('Substring to match URL or title (empty = close active tab)'),
  },
}, async ({ query }) => {
  let raw;
  if (!query) {
    raw = await as(`
      tell application "Safari"
        if (count of windows) is 0 then return "NO_WINDOW"
        set t to current tab of front window
        set info to (URL of t) & ":::" & (name of t)
        close t
        return info
      end tell
    `);
    if (raw === 'NO_WINDOW') throw new Error('No Safari windows open.');
  } else {
    const escaped = query.replace(/"/g, '\\"').toLowerCase();
    raw = await as(`
      tell application "Safari"
        set q to "${escaped}"
        repeat with w in every window
          repeat with t in every tab of w
            set u to URL of t
            set n to name of t
            if (u contains q) or (n contains q) then
              set info to u & ":::" & n
              close t
              return info
            end if
          end repeat
        end repeat
        return "NOT_FOUND"
      end tell
    `);
    if (raw === 'NOT_FOUND') throw new Error(`No tab found matching "${query}"`);
  }
  const [url, ...rest] = raw.split(':::');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, closed: { url, title: rest.join(':::') } }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('reload', {
  description: 'Reload the active tab in the front Safari window.',
  inputSchema: {},
}, async () => {
  await as(`
    tell application "Safari"
      if (count of windows) is 0 then error "No Safari windows open."
      do JavaScript "location.reload()" in current tab of front window
    end tell
  `);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('go_back', {
  description: 'Navigate back in history in the active tab of the front Safari window.',
  inputSchema: {},
}, async () => {
  await as(`
    tell application "Safari"
      if (count of windows) is 0 then error "No Safari windows open."
      do JavaScript "history.back()" in current tab of front window
    end tell
  `);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('go_forward', {
  description: 'Navigate forward in history in the active tab of the front Safari window.',
  inputSchema: {},
}, async () => {
  await as(`
    tell application "Safari"
      if (count of windows) is 0 then error "No Safari windows open."
      do JavaScript "history.forward()" in current tab of front window
    end tell
  `);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('new_window', {
  description: 'Open a new Safari window, optionally navigating to a URL.',
  inputSchema: {
    url: z.string().default('').describe('URL to open in the new window (empty = start page)'),
  },
}, async ({ url }) => {
  const escaped = url.replace(/"/g, '\\"');
  if (url) {
    await as(`tell application "Safari" to make new document with properties {URL:"${escaped}"}`);
  } else {
    await as(`tell application "Safari" to make new document`);
  }
  await as(`tell application "Safari" to activate`);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ── Layer 2: JavaScript execution ────────────────────────────────────────────

server.registerTool('enable_javascript', {
  description: `Enable "Allow JavaScript from Apple Events" in Safari — required for execute_javascript, get_page_source, and get_page_text.
Enables the Develop menu and the JavaScript from Apple Events setting via System Events menu clicks.
Only needs to be called once; the setting persists across Safari restarts.
Requires Accessibility access for the plugin (System Preferences > Privacy & Security > Accessibility).`,
  inputSchema: {},
}, async () => {
  // Check if already enabled by trying a simple do JavaScript
  try {
    await as(`tell application "Safari" to do JavaScript "1" in current tab of front window`, 3000);
    return { content: [{ type: 'text', text: JSON.stringify({ already_enabled: true }) }] };
  } catch (e) {
    if (!e.message.includes('Apple Events') && !e.message.includes('turned off') && !e.message.includes('not allowed')) {
      // Different error (e.g. no windows) — still try to enable
    }
  }

  // Step 1: Make sure the Develop menu is visible by enabling it via Settings > Advanced
  try {
    await as(`
      tell application "Safari" to activate
      delay 0.3
      tell application "System Events"
        tell process "Safari"
          -- Check if Develop menu already exists
          set menuNames to name of every menu bar item of menu bar 1
          if menuNames does not contain "Develop" then
            -- Open Settings, go to Advanced tab, enable developer features
            keystroke "," using {command down}
            delay 1
            tell window 1
              -- Click Advanced tab (last tab in Settings)
              click button "Advanced" of toolbar 1
              delay 0.5
              -- Check "Show features for web developers"
              set devCheck to checkbox "Show features for web developers" of window 1
              if value of devCheck is 0 then click devCheck
            end tell
            delay 0.5
            keystroke "w" using {command down}
            delay 0.3
          end if
        end tell
      end tell
    `, 12000);
  } catch { /* Settings approach failed — Develop menu may already be there */ }

  // Step 2: Click Develop > Allow JavaScript from Apple Events
  try {
    await as(`
      tell application "Safari" to activate
      delay 0.3
      tell application "System Events"
        tell process "Safari"
          tell menu bar 1
            tell menu bar item "Develop"
              tell menu "Develop"
                set allowItem to menu item "Allow JavaScript from Apple Events"
                if value of allowItem is 0 then click allowItem
              end tell
            end tell
          end tell
        end tell
      end tell
    `, 8000);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, method: 'menu_click' }) }] };
  } catch (menuErr) {
    return { content: [{ type: 'text', text: JSON.stringify({
      success: false,
      hint: 'Please enable manually: Safari > Settings > Advanced > Show features for web developers, then Safari > Develop > Allow JavaScript from Apple Events.',
    }) }] };
  }
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('execute_javascript', {
  description: `Run JavaScript in the active Safari tab and return the result.
Works on the user's real Safari session — no separate window or port needed.
Requires "Allow JavaScript from Apple Events" — call enable_javascript once to set it up.
Example: expression="document.title" → "My Page Title"`,
  inputSchema: {
    expression: z.string().describe('JavaScript expression to evaluate in the active tab'),
  },
}, async ({ expression }) => {
  // Escape for AppleScript string: backslash and double-quote
  const escaped = expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = await as(`
    tell application "Safari"
      if (count of windows) is 0 then error "No Safari windows open."
      return do JavaScript "${escaped}" in current tab of front window
    end tell
  `, 15000);
  return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_page_source', {
  description: `Get the full HTML source of the active Safari tab.
Works on the user's real Safari session. Requires "Allow JavaScript from Apple Events" — call enable_javascript once.`,
  inputSchema: {},
}, async () => {
  const [url, title, html] = await Promise.all([
    as(`tell application "Safari" to return URL of current tab of front window`),
    as(`tell application "Safari" to return name of current tab of front window`),
    as(`tell application "Safari" to do JavaScript "document.documentElement.outerHTML" in current tab of front window`, 30000),
  ]);
  return { content: [{ type: 'text', text: JSON.stringify({ url, title, length: html.length, html }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_page_text', {
  description: `Get the readable text content of the active Safari tab (strips HTML tags).
Works on the user's real Safari session. Requires "Allow JavaScript from Apple Events" — call enable_javascript once.`,
  inputSchema: {},
}, async () => {
  const [url, title, text] = await Promise.all([
    as(`tell application "Safari" to return URL of current tab of front window`),
    as(`tell application "Safari" to return name of current tab of front window`),
    as(`tell application "Safari" to do JavaScript "document.body ? document.body.innerText : ''" in current tab of front window`, 15000),
  ]);
  return { content: [{ type: 'text', text: JSON.stringify({ url, title, length: text.length, text }) }] };
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
