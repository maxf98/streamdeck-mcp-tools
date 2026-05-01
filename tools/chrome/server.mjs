/**
 * Chrome — control Google Chrome via JXA (always) + CDP (opt-in)
 *
 * Layer 1 – JXA/AppleScript (no setup required):
 *   open_url, get_active_tab, list_tabs, focus_tab, close_tab,
 *   reload, go_back, go_forward, new_window
 *
 * Layer 2 – Chrome DevTools Protocol (requires --remote-debugging-port=9222):
 *   execute_javascript, get_page_source, get_page_text, take_screenshot,
 *   get_debug_status
 *
 * To enable CDP tools, launch Chrome once with:
 *   open -a "Google Chrome" --args --remote-debugging-port=9222
 *
 * To make it permanent, add --remote-debugging-port=9222 to your Chrome
 * launch shortcut / alias, or create a shell alias:
 *   alias chrome='open -a "Google Chrome" --args --remote-debugging-port=9222'
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { run } from '@jxa/run';

const CDP_PORT = 9222;
const CDP_BASE = `http://localhost:${CDP_PORT}`;

const server = new McpServer({ name: 'chrome', version: '1.0.0' });

// ── JXA helpers ───────────────────────────────────────────────────────────────

/** Run JXA and throw a clean error if Chrome isn't open */
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

const CDP_NOT_AVAILABLE = `CDP is not available. Launch Chrome with --remote-debugging-port=9222:
  open -a "Google Chrome" --args --remote-debugging-port=9222`;

async function cdpTargets() {
  try {
    const res = await fetch(`${CDP_BASE}/json`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    throw new Error(CDP_NOT_AVAILABLE);
  }
}

/** Find the frontmost page target — first 'page' type in the list */
async function cdpActiveTarget() {
  const targets = await cdpTargets();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('No Chrome page found via CDP. Make sure a tab is open.');
  return page;
}

/** Send a single CDP command over WebSocket and return the result */
function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP timeout calling ${method}`));
    }, 15000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id, method, params }));
    };
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${err.message ?? 'connection failed'}`));
    };
  });
}

// ── JXA Tools ─────────────────────────────────────────────────────────────────

server.registerTool('open_url', {
  description: 'Open a URL in Google Chrome. Opens in a new tab in the front window by default, or in a new window.',
  inputSchema: {
    url:        z.string().describe('URL to open (e.g. "https://example.com")'),
    new_window: z.boolean().default(false).describe('Open in a new window instead of a new tab'),
  },
}, async ({ url, new_window }) => {
  if (new_window) {
    await jxa((u) => {
      const chrome = Application('Google Chrome');
      chrome.open(u);
      chrome.activate();
    }, url);
  } else {
    await jxa((u) => {
      const chrome = Application('Google Chrome');
      if (chrome.windows.length === 0) {
        chrome.open(u);
      } else {
        const tab = chrome.Tab({ url: u });
        chrome.windows[0].tabs.push(tab);
        chrome.windows[0].activeTabIndex = chrome.windows[0].tabs.length;
      }
      chrome.activate();
    }, url);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, url, new_window }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_active_tab', {
  description: 'Get the URL and title of the currently active tab in the front Chrome window.',
  inputSchema: {},
}, async () => {
  const result = await jxa(() => {
    const chrome = Application('Google Chrome');
    if (chrome.windows.length === 0) return null;
    const tab = chrome.windows[0].activeTab;
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
    const chrome = Application('Google Chrome');
    const results = [];
    chrome.windows().forEach((win, wi) => {
      const activeIdx = win.activeTabIndex();
      win.tabs().forEach((tab, ti) => {
        results.push({
          window_index: wi,
          tab_index: ti,
          url: tab.url(),
          title: tab.title(),
          active: (ti + 1) === activeIdx,
        });
      });
    });
    return results;
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: tabs.length, tabs }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('focus_tab', {
  description: 'Switch to the first tab whose URL or title contains the given query string (case-insensitive). Brings Chrome to the foreground.',
  inputSchema: {
    query: z.string().describe('Substring to match against tab URL or title'),
  },
}, async ({ query }) => {
  const result = await jxa((q) => {
    const chrome = Application('Google Chrome');
    const lq = q.toLowerCase();
    let found = null;
    chrome.windows().forEach((win, wi) => {
      if (found) return;
      win.tabs().forEach((tab, ti) => {
        if (found) return;
        if (tab.url().toLowerCase().includes(lq) || tab.title().toLowerCase().includes(lq)) {
          win.activeTabIndex = ti + 1;
          chrome.activate();
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
  description: 'Close a Chrome tab. If query is provided, closes the first tab matching the URL or title. Otherwise closes the active tab in the front window.',
  inputSchema: {
    query: z.string().default('').describe('Substring to match (empty = close active tab)'),
  },
}, async ({ query }) => {
  const result = await jxa((q) => {
    const chrome = Application('Google Chrome');
    if (!q) {
      if (chrome.windows.length === 0) return null;
      const tab = chrome.windows[0].activeTab;
      const info = { url: tab.url(), title: tab.title() };
      tab.close();
      return info;
    }
    const lq = q.toLowerCase();
    let closed = null;
    chrome.windows().forEach((win) => {
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
  inputSchema: {
    bypass_cache: z.boolean().default(false).describe('If true, force-reload bypassing the cache (like Cmd+Shift+R)'),
  },
}, async ({ bypass_cache }) => {
  await jxa((bypassCache) => {
    const chrome = Application('Google Chrome');
    if (chrome.windows.length === 0) throw new Error('No Chrome windows open.');
    if (bypassCache) {
      chrome.windows[0].activeTab.reload();
    } else {
      chrome.windows[0].activeTab.reload();
    }
  }, bypass_cache);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('go_back', {
  description: 'Navigate back in history in the active tab of the front Chrome window.',
  inputSchema: {},
}, async () => {
  await jxa(() => {
    const chrome = Application('Google Chrome');
    if (chrome.windows.length === 0) throw new Error('No Chrome windows open.');
    chrome.windows[0].activeTab.goBack();
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('go_forward', {
  description: 'Navigate forward in history in the active tab of the front Chrome window.',
  inputSchema: {},
}, async () => {
  await jxa(() => {
    const chrome = Application('Google Chrome');
    if (chrome.windows.length === 0) throw new Error('No Chrome windows open.');
    chrome.windows[0].activeTab.goForward();
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
    const chrome = Application('Google Chrome');
    if (u) {
      chrome.open(u);
    } else {
      chrome.make({ new: 'window' });
    }
    chrome.activate();
  }, url);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
});

// ── CDP Tools ─────────────────────────────────────────────────────────────────

server.registerTool('get_debug_status', {
  description: `Check if Chrome DevTools Protocol (CDP) is available and return version info.
CDP requires Chrome to be launched with --remote-debugging-port=9222:
  open -a "Google Chrome" --args --remote-debugging-port=9222
Returns {available, browser, protocol_version} when connected, or {available: false, hint} if not.`,
  inputSchema: {},
}, async () => {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) });
    const info = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify({
      available: true,
      browser: info.Browser,
      protocol_version: info['Protocol-Version'],
      user_agent: info['User-Agent'],
      v8_version: info['V8-Version'],
    }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({
      available: false,
      hint: CDP_NOT_AVAILABLE,
    }) }] };
  }
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('execute_javascript', {
  description: `Run JavaScript in the active Chrome tab and return the result.
Requires Chrome launched with --remote-debugging-port=9222.
The expression result is returned as a JSON value.
Example: expression="document.title" → "My Page Title"
Example: expression="document.querySelectorAll('a').length" → 42`,
  inputSchema: {
    expression: z.string().describe('JavaScript expression to evaluate in the active tab'),
    await_promise: z.boolean().default(false).describe('If true, await the result if it is a Promise'),
  },
}, async ({ expression, await_promise }) => {
  const target = await cdpActiveTarget();
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: await_promise,
  });
  const value = result?.result?.value;
  const type = result?.result?.type;
  const exceptionDetail = result?.exceptionDetails;
  if (exceptionDetail) {
    throw new Error(`JS error: ${exceptionDetail.exception?.description ?? exceptionDetail.text}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ type, value }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_page_source', {
  description: `Get the full HTML source of the active Chrome tab.
Requires Chrome launched with --remote-debugging-port=9222.
Returns the complete outerHTML of the page.`,
  inputSchema: {},
}, async () => {
  const target = await cdpActiveTarget();
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  const html = result?.result?.value ?? '';
  return { content: [{ type: 'text', text: JSON.stringify({ url: target.url, title: target.title, length: html.length, html }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_page_text', {
  description: `Get the readable text content of the active Chrome tab (strips HTML tags).
Requires Chrome launched with --remote-debugging-port=9222.
Uses document.body.innerText — returns what the user sees as text.`,
  inputSchema: {},
}, async () => {
  const target = await cdpActiveTarget();
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  });
  const text = result?.result?.value ?? '';
  return { content: [{ type: 'text', text: JSON.stringify({ url: target.url, title: target.title, length: text.length, text }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('take_screenshot', {
  description: `Capture a screenshot of the active Chrome tab as a base64-encoded PNG.
Requires Chrome launched with --remote-debugging-port=9222.
Returns {url, title, format: "png", data: "<base64>"}.`,
  inputSchema: {
    full_page: z.boolean().default(false).describe('If true, capture the full scrollable page (not just the viewport)'),
    quality:   z.number().min(0).max(100).default(80).describe('JPEG quality 0-100 (only applies if format is jpeg; PNG is lossless)'),
  },
}, async ({ full_page }) => {
  const target = await cdpActiveTarget();
  const params = { format: 'png', captureBeyondViewport: full_page };
  if (full_page) {
    // Get full page dimensions first
    const metrics = await cdpCall(target.webSocketDebuggerUrl, 'Page.getLayoutMetrics', {});
    const { contentSize } = metrics;
    params.clip = {
      x: 0, y: 0,
      width: contentSize.width,
      height: contentSize.height,
      scale: 1,
    };
  }
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Page.captureScreenshot', params);
  const data = result?.data ?? '';
  return { content: [{ type: 'text', text: JSON.stringify({
    url: target.url,
    title: target.title,
    format: 'png',
    full_page,
    size_bytes: Math.round(data.length * 0.75),
    data,
  }) }] };
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
