/**
 * Chrome — control Google Chrome via JXA/AppleScript + CDP
 *
 * Layer 1 – Tab management (always available, works on user's regular Chrome):
 *   open_url, get_active_tab, list_tabs, focus_tab, close_tab,
 *   reload, go_back, go_forward, new_window
 *
 * Layer 2 – Chrome DevTools Protocol (call enable_cdp once to set up):
 *   enable_cdp       → launches a CDP-enabled Chrome window (separate profile
 *                       at /tmp/chrome-cdp, runs alongside regular Chrome)
 *   get_debug_status → check if CDP is available
 *   navigate         → navigate the CDP window to a URL
 *   execute_javascript, get_page_source, get_page_text, take_screenshot
 *
 * CDP uses a separate Chrome profile so it never touches the user's regular
 * session. Both Chrome instances run side by side. The CDP window is the one
 * to use for content inspection and JS automation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { run } from '@jxa/run';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CDP_PORT = 9222;
const CDP_BASE = `http://localhost:${CDP_PORT}`;
const CDP_USER_DATA_DIR = '/tmp/chrome-cdp';

const server = new McpServer({ name: 'chrome', version: '1.0.0' });

// ── JXA helper ────────────────────────────────────────────────────────────────

async function jxa(fn, ...args) {
  try {
    return await run(fn, ...args);
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg.includes('not running') || msg.includes("Can't get")) {
      throw new Error('Google Chrome is not running. Please open Chrome first.');
    }
    throw err;
  }
}

// ── CDP helpers ───────────────────────────────────────────────────────────────

async function cdpTargets() {
  try {
    const res = await fetch(`${CDP_BASE}/json`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    throw new Error(
      'CDP is not available. Call enable_cdp to launch a CDP-enabled Chrome window.'
    );
  }
}

async function cdpActivePage() {
  const targets = await cdpTargets();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('No Chrome page found via CDP. Call navigate to open a URL.');
  return page;
}

function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed')); };
  });
}

// ── Layer 1: Tab management ───────────────────────────────────────────────────

server.registerTool('open_url', {
  description: 'Open a URL in Google Chrome. Opens in a new tab in the front window by default, or in a new window.',
  inputSchema: {
    url:        z.string().describe('URL to open (e.g. "https://example.com")'),
    new_window: z.boolean().default(false).describe('Open in a new window instead of a new tab'),
  },
}, async ({ url, new_window }) => {
  if (new_window) {
    await jxa((u) => { const c = Application('Google Chrome'); c.open(u); c.activate(); }, url);
  } else {
    await jxa((u) => {
      const c = Application('Google Chrome');
      if (c.windows.length === 0) { c.open(u); }
      else {
        c.windows[0].tabs.push(c.Tab({ url: u }));
        c.windows[0].activeTabIndex = c.windows[0].tabs.length;
      }
      c.activate();
    }, url);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, url }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_active_tab', {
  description: 'Get the URL and title of the currently active tab in the front Chrome window.',
  inputSchema: {},
}, async () => {
  const result = await jxa(() => {
    const c = Application('Google Chrome');
    if (c.windows.length === 0) return null;
    const tab = c.windows[0].activeTab;
    return { url: tab.url(), title: tab.title() };
  });
  if (!result) throw new Error('No Chrome windows open.');
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('list_tabs', {
  description: 'List all open tabs across all Chrome windows. Returns [{window_index, tab_index, url, title, active}].',
  inputSchema: {},
}, async () => {
  const tabs = await jxa(() => {
    const c = Application('Google Chrome');
    const results = [];
    c.windows().forEach((win, wi) => {
      const ai = win.activeTabIndex();
      win.tabs().forEach((tab, ti) => {
        results.push({ window_index: wi, tab_index: ti, url: tab.url(), title: tab.title(), active: (ti + 1) === ai });
      });
    });
    return results;
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: tabs.length, tabs }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('focus_tab', {
  description: 'Switch to the first tab whose URL or title contains the query string (case-insensitive). Brings Chrome to the foreground.',
  inputSchema: {
    query: z.string().describe('Substring to match against tab URL or title'),
  },
}, async ({ query }) => {
  const result = await jxa((q) => {
    const c = Application('Google Chrome');
    const lq = q.toLowerCase();
    let found = null;
    c.windows().forEach((win, wi) => {
      if (found) return;
      win.tabs().forEach((tab, ti) => {
        if (found) return;
        if (tab.url().toLowerCase().includes(lq) || tab.title().toLowerCase().includes(lq)) {
          win.activeTabIndex = ti + 1;
          c.activate();
          found = { window_index: wi, tab_index: ti, url: tab.url(), title: tab.title() };
        }
      });
    });
    return found;
  }, query);
  if (!result) throw new Error(`No tab found matching "${query}"`);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, tab: result }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('close_tab', {
  description: 'Close a Chrome tab. Closes the first tab matching the query, or the active tab if no query given.',
  inputSchema: {
    query: z.string().default('').describe('Substring to match URL or title (empty = close active tab)'),
  },
}, async ({ query }) => {
  const result = await jxa((q) => {
    const c = Application('Google Chrome');
    if (!q) {
      if (c.windows.length === 0) return null;
      const tab = c.windows[0].activeTab;
      const info = { url: tab.url(), title: tab.title() };
      tab.close();
      return info;
    }
    const lq = q.toLowerCase();
    let closed = null;
    c.windows().forEach((win) => {
      if (closed) return;
      win.tabs().forEach((tab) => {
        if (closed) return;
        if (tab.url().toLowerCase().includes(lq) || tab.title().toLowerCase().includes(lq)) {
          closed = { url: tab.url(), title: tab.title() };
          tab.close();
        }
      });
    });
    return closed;
  }, query);
  if (!result) throw new Error(query ? `No tab found matching "${query}"` : 'No Chrome windows open.');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, closed: result }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('reload', {
  description: 'Reload the active tab in the front Chrome window.',
  inputSchema: {},
}, async () => {
  await jxa(() => {
    const c = Application('Google Chrome');
    if (c.windows.length === 0) throw new Error('No Chrome windows open.');
    c.windows[0].activeTab.reload();
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('go_back', {
  description: 'Navigate back in history in the active tab of the front Chrome window.',
  inputSchema: {},
}, async () => {
  await jxa(() => {
    const c = Application('Google Chrome');
    if (c.windows.length === 0) throw new Error('No Chrome windows open.');
    c.windows[0].activeTab.goBack();
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('go_forward', {
  description: 'Navigate forward in history in the active tab of the front Chrome window.',
  inputSchema: {},
}, async () => {
  await jxa(() => {
    const c = Application('Google Chrome');
    if (c.windows.length === 0) throw new Error('No Chrome windows open.');
    c.windows[0].activeTab.goForward();
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('new_window', {
  description: 'Open a new Chrome window, optionally navigating to a URL.',
  inputSchema: {
    url: z.string().default('').describe('URL to open in the new window (empty = new tab page)'),
  },
}, async ({ url }) => {
  await jxa((u) => {
    const c = Application('Google Chrome');
    if (u) c.open(u); else c.make({ new: 'window' });
    c.activate();
  }, url);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ── Layer 2: CDP tools ────────────────────────────────────────────────────────

server.registerTool('enable_cdp', {
  description: `Launch a CDP-enabled Chrome window for JS execution and page inspection.
Opens a separate Chrome instance (profile at /tmp/chrome-cdp) alongside the user's regular Chrome.
Only needs to be called once per session; if CDP is already available it returns immediately.
After this, use navigate to load a page, then execute_javascript / get_page_source / get_page_text / take_screenshot.`,
  inputSchema: {},
}, async () => {
  // Already up?
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const info = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify({ already_enabled: true, browser: info.Browser }) }] };
    }
  } catch { /* not up yet */ }

  // Launch CDP Chrome (separate profile, runs alongside regular Chrome)
  execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CDP_USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]);

  // Poll until the port opens (up to 15s)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const info = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, browser: info.Browser, port: CDP_PORT }) }] };
      }
    } catch { /* not ready yet */ }
  }
  throw new Error('CDP Chrome launched but port did not open within 15 seconds.');
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_debug_status', {
  description: 'Check if CDP is available. Returns {available, browser, tab_count} or {available: false}. Call enable_cdp to start it.',
  inputSchema: {},
}, async () => {
  try {
    const [versionRes, tabsRes] = await Promise.all([
      fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${CDP_BASE}/json`, { signal: AbortSignal.timeout(2000) }),
    ]);
    const info = await versionRes.json();
    const tabs = await tabsRes.json();
    return { content: [{ type: 'text', text: JSON.stringify({
      available: true,
      browser: info.Browser,
      tab_count: tabs.filter(t => t.type === 'page').length,
    }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false, hint: 'Call enable_cdp to start a CDP-enabled Chrome window.' }) }] };
  }
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('navigate', {
  description: 'Navigate the CDP Chrome window to a URL. Call enable_cdp first if needed.',
  inputSchema: {
    url: z.string().describe('URL to navigate to'),
    wait_ms: z.number().default(2000).describe('Milliseconds to wait for page load after navigation'),
  },
}, async ({ url, wait_ms }) => {
  const page = await cdpActivePage();
  await cdpCall(page.webSocketDebuggerUrl, 'Page.navigate', { url });
  if (wait_ms > 0) await new Promise(r => setTimeout(r, wait_ms));
  // Re-fetch to get updated title
  const updated = (await cdpTargets()).find(t => t.type === 'page');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, url: updated?.url ?? url, title: updated?.title ?? '' }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('execute_javascript', {
  description: `Run JavaScript in the active CDP Chrome tab and return the result.
Call enable_cdp first, then navigate to the page you want to inspect.
Example: expression="document.title" → "My Page"
Example: expression="document.querySelectorAll('a').length" → 42`,
  inputSchema: {
    expression:    z.string().describe('JavaScript expression to evaluate'),
    await_promise: z.boolean().default(false).describe('Await the result if it is a Promise'),
  },
}, async ({ expression, await_promise }) => {
  const page = await cdpActivePage();
  const result = await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: await_promise,
  });
  if (result?.exceptionDetails) {
    throw new Error(`JS error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ type: result?.result?.type, value: result?.result?.value }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_page_source', {
  description: 'Get the full HTML source of the active CDP Chrome tab. Call enable_cdp first, then navigate to the target page.',
  inputSchema: {},
}, async () => {
  const page = await cdpActivePage();
  const result = await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  const html = result?.result?.value ?? '';
  return { content: [{ type: 'text', text: JSON.stringify({ url: page.url, title: page.title, length: html.length, html }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_page_text', {
  description: 'Get the readable text content of the active CDP Chrome tab (strips HTML). Call enable_cdp first, then navigate to the target page.',
  inputSchema: {},
}, async () => {
  const page = await cdpActivePage();
  const result = await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  });
  const text = result?.result?.value ?? '';
  return { content: [{ type: 'text', text: JSON.stringify({ url: page.url, title: page.title, length: text.length, text }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('take_screenshot', {
  description: 'Capture a screenshot of the active CDP Chrome tab as a base64-encoded PNG. Call enable_cdp first.',
  inputSchema: {
    full_page: z.boolean().default(false).describe('Capture the full scrollable page, not just the viewport'),
  },
}, async ({ full_page }) => {
  const page = await cdpActivePage();
  const params = { format: 'png', captureBeyondViewport: full_page };
  if (full_page) {
    const metrics = await cdpCall(page.webSocketDebuggerUrl, 'Page.getLayoutMetrics', {});
    const { contentSize } = metrics;
    params.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
  }
  const result = await cdpCall(page.webSocketDebuggerUrl, 'Page.captureScreenshot', params);
  const data = result?.data ?? '';
  return { content: [{ type: 'text', text: JSON.stringify({
    url: page.url, title: page.title,
    format: 'png', full_page,
    size_bytes: Math.round(data.length * 0.75),
    data,
  }) }] };
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
