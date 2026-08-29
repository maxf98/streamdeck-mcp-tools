#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { run } from '@jxa/run';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import plist from 'plist';
import * as z from 'zod/v4';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPACES_PLIST = join(homedir(), 'Library/Preferences/com.apple.spaces.plist');

// Stream Deck surfaces (io.streamdeck/surfaces extension). The app-switcher key,
// dial and popup ship as ui:// MCP-App resources whose _meta binds each to a live
// app-list resource. The key/dial declare `handles` (in-component handlers), so the
// host injects the hardware event into the live face — its Face.onKeyDown/onDialRotate
// runs and calls a tool directly. No preview/commit "controller" tools: the dial's
// preview cursor lives in the view's React state; committing calls activate_application.
const SURFACE_NS = 'io.streamdeck/surfaces';
const URI_APPS = 'resource://windows/apps';
const URI_UI_KEY = 'ui://windows/key';
const URI_UI_DIAL = 'ui://windows/dial';
const URI_UI_POPUP = 'ui://windows/popup';

// =============================================================================
// HELPERS
// =============================================================================

function readSpacesConfig() {
  const data = plist.parse(readFileSync(SPACES_PLIST, 'utf8'));
  const monitors = data.SpacesDisplayConfiguration['Management Data'].Monitors;
  const displays = [];
  for (const monitor of monitors) {
    if (!monitor['Current Space']) continue;
    const current = monitor['Current Space'];
    const spaces = (monitor.Spaces || []).map((s, i) => ({
      index: i + 1,
      id: s.ManagedSpaceID,
      uuid: s.uuid,
      type: s.type ?? 0,
      is_current: s.uuid === current.uuid,
    }));
    const currentIndex = spaces.find(s => s.is_current)?.index ?? null;
    displays.push({
      display: monitor['Display Identifier'] ?? 'Unknown',
      current_space_index: currentIndex,
      current_space_id: current.ManagedSpaceID,
      total_spaces: spaces.length,
      spaces,
    });
  }
  return { displays };
}

function sc(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

// =============================================================================
// APP-SWITCHER: ordered app list + live resource (backs the key/dial/popup surfaces)
// =============================================================================

/** Read the switchable GUI apps, ordered stably by name (so prev/next is
 *  predictable), with the frontmost flagged + its index. Shared by the
 *  get_running_applications tool and the live resource watcher. */
async function readAppList() {
  const raw = await run(() => {
    const se = Application('System Events');
    return se.processes.whose({ backgroundOnly: false })().map(p => ({
      name: p.name(),
      bundle_id: (() => { try { return p.bundleIdentifier(); } catch { return null; } })(),
      frontmost: (() => { try { return p.frontmost(); } catch { return false; } })(),
    }));
  });
  raw.sort((a, b) => a.name.localeCompare(b.name));
  let active_index = raw.findIndex(a => a.frontmost);
  if (active_index < 0) active_index = 0;
  return { applications: raw, active_index };
}

// The live app-list snapshot the surfaces bind to. Only the ordered list + frontmost
// index live here — server-owned live DATA. The dial's transient PREVIEW cursor does
// NOT live here; it's in the dial view's React state (in-component, repainted on
// dispatch). One source of truth per concern: list = resource, cursor = component.
let appsState = { applications: [], active_index: 0 };
const subscribed = new Set();

function appsSig(s) { return JSON.stringify({ a: s.applications.map(x => x.name), i: s.active_index }); }

/** Poll the app list; push resources/updated only when the ordered list or frontmost
 *  actually changed, so a bound face repaints the instant you switch apps by ANY
 *  means (not just via this pack). */
let _polling = false, _polledOk = false;
async function pollApps() {
  if (_polling) return;
  _polling = true;
  try {
    const next = await readAppList();
    if (appsSig(next) !== appsSig(appsState)) {
      appsState = next;
      if (subscribed.has(URI_APPS)) {
        server.server.sendResourceUpdated({ uri: URI_APPS }).catch(() => {});
      }
    }
    _polledOk = true;
  } catch (err) {
    if (!_polledOk) process.stderr.write(`[window_management] readAppList failed: ${err?.message ?? err}\n`);
  } finally {
    _polling = false;
  }
}

let _watcher = null;
function startWatching() {
  if (_watcher) return;
  const t = setInterval(pollApps, 700);
  t.unref?.();
  _watcher = { stop() { clearInterval(t); } };
}
function stopWatching() { if (_watcher) { _watcher.stop(); _watcher = null; } }

async function ensurePrimed() {
  startWatching();
  if (appsState.applications.length === 0) await pollApps();
}

// ── Surface views (ui:// MCP-App resources) ─────────────────────────────────
// Each view's JSX is read from a sibling .view.jsx at read time and wrapped in an
// envelope carrying io.streamdeck/surfaces _meta. key/dial use `handles` (in-component
// handlers); the popup drives itself (self-contained App, no trigger map).

function readViewFile(name) {
  try { return readFileSync(join(HERE, name), 'utf8'); }
  catch { return `function Face(){ return null; } /* missing view: ${name} */`; }
}

const UI_VIEWS = {
  [URI_UI_KEY]: {
    name: 'Window key',
    description: 'Key: shows the frontmost app; press cycles to the next.',
    file: 'key.view.jsx',
    meta: { key: { resourceUri: URI_UI_KEY, mode: 'persistent', bind: URI_APPS, handles: ['press'] } },
  },
  [URI_UI_DIAL]: {
    name: 'Window dial',
    description: 'Dial: prev|current|next strip; rotate previews (in-component), press commits.',
    file: 'dial.view.jsx',
    meta: { encoder: { resourceUri: URI_UI_DIAL, mode: 'persistent', bind: URI_APPS, handles: ['rotate', 'dialPress', 'touchTap'] } },
  },
  [URI_UI_POPUP]: {
    name: 'Window switcher',
    description: 'Popup app switcher: grid of all open apps; click one to activate it.',
    file: 'popup.view.jsx',
    meta: { popup: { resourceUri: URI_UI_POPUP, mode: 'on-demand', bind: URI_APPS } },
  },
};

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const SUCCESS_OUTPUT = { success: z.boolean(), message: z.string() };

const WINDOW_INPUT = {
  application: z.string(),
  window_index: z.number().optional().describe('1-based window index (default: 1)'),
};

// =============================================================================
// SERVER
// =============================================================================

const server = new McpServer({ name: 'window-management', version: '1.0.0' });

// ---------------------------------------------------------------------------

server.registerTool('get_running_applications',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/apps.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the currently running GUI applications, ordered stably by name, with the frontmost one flagged. `active_index` is the frontmost app\'s position in `applications` (the ordering the app-switcher dial/key navigate).',
    inputSchema: {},
    outputSchema: {
      applications: z.array(z.object({
        name: z.string(),
        bundle_id: z.string().nullable(),
        frontmost: z.boolean(),
      })),
      active_index: z.number(),
    },
  },
  async () => {
    return sc(await readAppList());
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_windows',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/window-restore.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get a list of open windows, optionally filtered by application name.',
    inputSchema: {
      application: z.string().optional().describe('Filter to this app name (e.g. "Safari"). Omit for all apps.'),
    },
    outputSchema: {
      windows: z.array(z.object({
        app_name: z.string(),
        title: z.string().nullable(),
        index: z.number(),
        x: z.number(), y: z.number(),
        width: z.number(), height: z.number(),
      })),
    },
  },
  async ({ application }) => {
    const windows = await run((appFilter) => {
      const se = Application('System Events');
      const procs = appFilter
        ? se.processes.whose({ name: appFilter, backgroundOnly: false })()
        : se.processes.whose({ backgroundOnly: false })();
      const result = [];
      for (const proc of procs) {
        const appName = proc.name();
        for (let i = 0; i < proc.windows.length; i++) {
          const w = proc.windows[i];
          try {
            const pos = w.position();
            const size = w.size();
            result.push({
              app_name: appName,
              title: (() => { try { return w.name(); } catch { return null; } })(),
              index: i + 1,
              x: pos[0], y: pos[1],
              width: size[0], height: size[1],
            });
          } catch { /* window may not have position/size */ }
        }
      }
      return result;
    }, application || null);
    return sc({ windows });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_frontmost_application',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/application.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the name and window title of the frontmost (active) application.',
    inputSchema: {},
    outputSchema: {
      app_name: z.string(),
      bundle_id: z.string().nullable(),
      window_title: z.string().nullable(),
    },
  },
  async () => {
    const result = await run(() => {
      const proc = Application('System Events').processes.whose({ frontmost: true })()[0];
      return {
        app_name: proc.name(),
        bundle_id: (() => { try { return proc.bundleIdentifier(); } catch { return null; } })(),
        window_title: (() => { try { return proc.windows[0].name(); } catch { return null; } })(),
      };
    });
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('activate_application',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/open-in-app.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Bring an application to the front (activate it).',
    inputSchema: { application: z.string() },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application }) => {
    await run((app) => { Application(app).activate(); }, application);
    return sc({ success: true, message: `Activated ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('close_window',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/window-close.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Close a specific window of an application.',
    inputSchema: WINDOW_INPUT,
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application, window_index = 1 }) => {
    const idx = window_index - 1;
    await run((app, i) => {
      const proc = Application('System Events').processes.whose({ name: app })[0];
      proc.windows[i].buttons.whose({ subrole: 'AXCloseButton' })[0].click();
    }, application, idx);
    return sc({ success: true, message: `Closed window ${window_index} of ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('move_window',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/arrow-all.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Move a window to a specific position on screen.',
    inputSchema: {
      ...WINDOW_INPUT,
      x: z.number().describe('X coordinate in pixels'),
      y: z.number().describe('Y coordinate in pixels'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application, window_index = 1, x, y }) => {
    await run((app, i, x, y) => {
      Application('System Events').processes.whose({ name: app })[0].windows[i].position = [x, y];
    }, application, window_index - 1, x, y);
    return sc({ success: true, message: `Moved window to (${x}, ${y})` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('resize_window',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/resize.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Resize a window to specific dimensions.',
    inputSchema: {
      ...WINDOW_INPUT,
      width: z.number(),
      height: z.number(),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application, window_index = 1, width, height }) => {
    await run((app, i, w, h) => {
      Application('System Events').processes.whose({ name: app })[0].windows[i].size = [w, h];
    }, application, window_index - 1, width, height);
    return sc({ success: true, message: `Resized window to ${width}x${height}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('minimize_window',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/window-minimize.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Minimize a window to the Dock.',
    inputSchema: WINDOW_INPUT,
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application, window_index = 1 }) => {
    await run((app, i) => {
      Application('System Events').processes.whose({ name: app })[0].windows[i].miniaturized = true;
    }, application, window_index - 1);
    return sc({ success: true, message: `Minimized window ${window_index} of ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('fullscreen_window',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/fullscreen.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Toggle native fullscreen for a window (enters a separate Mission Control space). Use zoom_window to maximize without leaving the current space.',
    inputSchema: WINDOW_INPUT,
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application, window_index = 1 }) => {
    await run((app, i) => {
      const win = Application('System Events').processes.whose({ name: app })[0].windows[i];
      const current = win.attributes.byName('AXFullScreen').value();
      win.attributes.byName('AXFullScreen').value = !current;
    }, application, window_index - 1);
    return sc({ success: true, message: `Toggled fullscreen for ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('zoom_window',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/magnify-plus.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Maximize (zoom) a window to fill a screen without entering fullscreen mode.',
    inputSchema: {
      ...WINDOW_INPUT,
      screen_index: z.number().optional().describe('0-based screen index from get_screens (default: main screen)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application, window_index = 1, screen_index = null }) => {
    await run((app, i, si) => {
      ObjC.import('AppKit');
      const mainH = $.NSScreen.mainScreen.frame.size.height;
      const screen = si !== null ? $.NSScreen.screens.objectAtIndex(si) : $.NSScreen.mainScreen;
      const f = screen.visibleFrame;
      // Convert NSScreen coords (origin bottom-left, y up) to Accessibility coords (origin top-left, y down)
      const axX = f.origin.x;
      const axY = mainH - (f.origin.y + f.size.height);
      const win = Application('System Events').processes.whose({ name: app })[0].windows[i];
      win.position = [axX, axY];
      win.size = [f.size.width, f.size.height];
    }, application, window_index - 1, screen_index);
    return sc({ success: true, message: `Zoomed window ${window_index} of ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_screen_size',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/monitor.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the screen dimensions of the main display.',
    inputSchema: {},
    outputSchema: { width: z.number(), height: z.number() },
  },
  async () => {
    const result = await run(() => {
      ObjC.import('AppKit');
      const frame = $.NSScreen.mainScreen.frame;
      return { width: frame.size.width, height: frame.size.height };
    });
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_screens',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/monitor-multiple.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get dimensions and positions of all connected displays.',
    inputSchema: {},
    outputSchema: {
      screens: z.array(z.object({
        index: z.number(),
        x: z.number(), y: z.number(),
        width: z.number(), height: z.number(),
        visible_x: z.number(), visible_y: z.number(),
        visible_width: z.number(), visible_height: z.number(),
        is_main: z.boolean(),
      })),
    },
  },
  async () => {
    const result = await run(() => {
      ObjC.import('AppKit');
      const main = $.NSScreen.mainScreen;
      const all = $.NSScreen.screens;
      const screens = [];
      for (let i = 0; i < all.count; i++) {
        const s = all.objectAtIndex(i);
        const f = s.frame;
        const v = s.visibleFrame;
        screens.push({
          index: i,
          x: f.origin.x, y: f.origin.y,
          width: f.size.width, height: f.size.height,
          visible_x: v.origin.x, visible_y: v.origin.y,
          visible_width: v.size.width, visible_height: v.size.height,
          is_main: s.isEqual(main),
        });
      }
      return { screens };
    });
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_window_screen',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/monitor.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get which screen a window is currently on, by comparing the window position against all screen frames.',
    inputSchema: WINDOW_INPUT,
    outputSchema: {
      screen_index: z.number().describe('0-based index into get_screens results'),
      is_main: z.boolean(),
      x: z.number(), y: z.number(),
      width: z.number(), height: z.number(),
    },
  },
  async ({ application, window_index = 1 }) => {
    const result = await run((app, i) => {
      ObjC.import('AppKit');
      const win = Application('System Events').processes.whose({ name: app })[0].windows[i];
      const pos = win.position();
      const sz = win.size();
      const cx = pos[0] + sz[0] / 2;
      const cy = pos[1] + sz[1] / 2;
      const mainH = $.NSScreen.mainScreen.frame.size.height;
      const screens = $.NSScreen.screens;
      // Convert centre to NSScreen coords for containment test
      const nscy = mainH - cy;
      for (let s = 0; s < screens.count; s++) {
        const f = screens.objectAtIndex(s).frame;
        if (cx >= f.origin.x && cx <= f.origin.x + f.size.width &&
            nscy >= f.origin.y && nscy <= f.origin.y + f.size.height) {
          return {
            screen_index: s,
            is_main: screens.objectAtIndex(s).isEqual($.NSScreen.mainScreen),
            x: f.origin.x, y: f.origin.y,
            width: f.size.width, height: f.size.height,
          };
        }
      }
      const mf = $.NSScreen.mainScreen.frame;
      return { screen_index: 0, is_main: true, x: mf.origin.x, y: mf.origin.y, width: mf.size.width, height: mf.size.height };
    }, application, window_index - 1);
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('open_url',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/open-in-new.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Open a URL in a browser. Opens in a new tab if browser is already running.',
    inputSchema: {
      url: z.string().describe('URL to open (e.g. "https://example.com")'),
      browser: z.string().optional().describe('"Safari", "Google Chrome", "Firefox", or "Arc" (default: Safari)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ url, browser = 'Safari' }) => {
    await run((url, br) => {
      if (br === 'Google Chrome' || br === 'Chrome') {
        const app = Application('Google Chrome');
        app.activate();
        if (app.windows.length === 0) app.Window().make();
        app.windows[0].tabs.push(app.Tab({ url }));
      } else if (br === 'Firefox') {
        const app = Application('Firefox');
        app.activate();
        app.openLocation(url);
      } else if (br === 'Arc') {
        const app = Application('Arc');
        app.activate();
        app.openLocation(url);
      } else {
        const app = Application('Safari');
        app.activate();
        if (app.windows.length === 0) {
          app.Document({ url }).make();
        } else {
          const tab = app.Tab({ url }).make();
          app.windows[0].currentTab = tab;
        }
      }
    }, url, browser);
    return sc({ success: true, message: `Opened ${url} in ${browser}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_browser_tabs',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/tab.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get all open tabs across all windows in the specified browser.',
    inputSchema: {
      browser: z.string().optional().describe('"Safari", "Google Chrome", or "Arc" (default: Safari)'),
    },
    outputSchema: {
      tabs: z.array(z.object({
        window_index: z.number(),
        tab_index: z.number(),
        title: z.string(),
        url: z.string(),
      })),
    },
  },
  async ({ browser = 'Safari' }) => {
    const tabs = await run((br) => {
      const result = [];
      if (br === 'Google Chrome' || br === 'Chrome') {
        const app = Application('Google Chrome');
        for (let i = 0; i < app.windows.length; i++)
          for (let j = 0; j < app.windows[i].tabs.length; j++) {
            const t = app.windows[i].tabs[j];
            result.push({ window_index: i + 1, tab_index: j + 1, title: t.title(), url: t.url() });
          }
      } else if (br === 'Arc') {
        const app = Application('Arc');
        for (let i = 0; i < app.windows.length; i++)
          for (let j = 0; j < app.windows[i].tabs.length; j++) {
            const t = app.windows[i].tabs[j];
            result.push({ window_index: i + 1, tab_index: j + 1, title: t.title(), url: t.url() });
          }
      } else {
        const app = Application('Safari');
        for (let i = 0; i < app.windows.length; i++)
          for (let j = 0; j < app.windows[i].tabs.length; j++) {
            const t = app.windows[i].tabs[j];
            result.push({ window_index: i + 1, tab_index: j + 1, title: t.name(), url: t.url() });
          }
      }
      return result;
    }, browser);
    return sc({ tabs });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('close_browser_tab',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/tab-minus.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Close a specific browser tab.',
    inputSchema: {
      browser: z.string().optional().describe('"Safari", "Google Chrome", or "Arc" (default: Safari)'),
      window_index: z.number().optional().describe('1-based window index (default: 1)'),
      tab_index: z.number().optional().describe('1-based tab index (default: 1)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ browser = 'Safari', window_index = 1, tab_index = 1 }) => {
    const wi = window_index - 1;
    const ti = tab_index - 1;
    await run((br, wi, ti) => {
      if (br === 'Google Chrome' || br === 'Chrome') {
        Application('Google Chrome').windows[wi].tabs[ti].close();
      } else if (br === 'Arc') {
        Application('Arc').windows[wi].tabs[ti].close();
      } else {
        Application('Safari').windows[wi].tabs[ti].close();
      }
    }, browser, wi, ti);
    return sc({ success: true, message: `Closed tab ${tab_index} of window ${window_index}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_active_tab_info',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/tab.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the title and URL of the active (frontmost) browser tab.',
    inputSchema: {
      browser: z.string().optional().describe('"Safari", "Google Chrome", or "Arc" (default: Safari)'),
    },
    outputSchema: { title: z.string(), url: z.string() },
  },
  async ({ browser = 'Safari' }) => {
    const result = await run((br) => {
      if (br === 'Google Chrome' || br === 'Chrome') {
        const t = Application('Google Chrome').windows[0].activeTab();
        return { title: t.title(), url: t.url() };
      } else if (br === 'Arc') {
        const t = Application('Arc').windows[0].activeTab();
        return { title: t.title(), url: t.url() };
      } else {
        const t = Application('Safari').windows[0].currentTab();
        return { title: t.name(), url: t.url() };
      }
    }, browser);
    return sc(result);
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_spaces',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/view-grid.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get information about all Mission Control desktops/spaces.',
    inputSchema: {},
    outputSchema: {
      displays: z.array(z.object({
        display: z.string(),
        current_space_index: z.number().nullable(),
        current_space_id: z.number(),
        total_spaces: z.number(),
        spaces: z.array(z.object({
          index: z.number(),
          id: z.number(),
          uuid: z.string(),
          type: z.number(),
          is_current: z.boolean(),
        })),
      })),
    },
  },
  async () => sc(readSpacesConfig())
);

// ---------------------------------------------------------------------------

server.registerTool('get_current_space',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/view-grid-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Get the current desktop/space number and details.',
    inputSchema: {},
    outputSchema: {
      current_space: z.number().nullable(),
      total_spaces: z.number(),
      space_id: z.number(),
    },
  },
  async () => {
    const config = readSpacesConfig();
    if (!config.displays.length) throw new Error('No display information found');
    const d = config.displays[0];
    return sc({ current_space: d.current_space_index, total_spaces: d.total_spaces, space_id: d.current_space_id });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('launch_application',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/rocket-launch.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Launch an application by name. If already running, brings it to the front.',
    inputSchema: { application: z.string() },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ application }) => {
    await run((app) => { Application(app).activate(); }, application);
    return sc({ success: true, message: `Launched ${application}` });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('open_file',
  {
    icons: [{ src: 'https://api.iconify.design/mdi/file-document-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description: 'Open a file, optionally with a specific application.',
    inputSchema: {
      file_path: z.string().describe('Absolute path to the file'),
      application: z.string().optional().describe('Optional app to open with (uses default if omitted)'),
    },
    outputSchema: SUCCESS_OUTPUT,
  },
  async ({ file_path, application }) => {
    await run((filePath, app) => {
      if (app) {
        Application(app).activate();
        Application(app).open(Path(filePath));
      } else {
        Application('Finder').open(Path(filePath));
      }
    }, file_path, application || null);
    return sc({ success: true, message: `Opened ${file_path}${application ? ` with ${application}` : ''}` });
  }
);

// =============================================================================
// SURFACES: register the live app-list resource + the three ui:// view resources
// =============================================================================

// Advertise resource subscription so the Studio host opens a live subscription for
// a bound face (it only calls resources/subscribe when this capability is present).
server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

// io.streamdeck/resourceSchema — see the Studio host's convention (audio's
// server.mjs has the fuller writeup). Matches appsState's shape (also the
// get_running_applications tool's outputSchema).
const APPS_SCHEMA = {
  type: 'object',
  properties: {
    applications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bundle_id: { type: 'string' },
          frontmost: { type: 'boolean' },
        },
        required: ['name', 'frontmost'],
      },
    },
    active_index: { type: 'number' },
  },
  required: ['applications', 'active_index'],
};

// The live app-list snapshot the surfaces bind to.
server.registerResource(
  'open-applications',
  URI_APPS,
  { description: 'Ordered switchable GUI apps + the frontmost index — the live data the app-switcher surfaces bind to.', mimeType: 'application/json', _meta: { 'io.streamdeck/resourceSchema': APPS_SCHEMA } },
  async () => {
    await ensurePrimed();
    return { contents: [{ uri: URI_APPS, mimeType: 'application/json', text: JSON.stringify(appsState) }] };
  }
);

// The three surface views. metadata carries the io.streamdeck/surfaces _meta on BOTH
// the list descriptor (so the host classifies the surface from resources/list) and
// the read envelope (jsx + _meta), matching what the host's resolveUiResource reads.
for (const [uri, v] of Object.entries(UI_VIEWS)) {
  server.registerResource(
    uri.replace('ui://', '').replace(/\//g, '-'),
    uri,
    { description: v.description, mimeType: 'application/vnd.mcp-ui+json', _meta: { [SURFACE_NS]: v.meta } },
    async () => ({
      contents: [{
        uri,
        mimeType: 'application/vnd.mcp-ui+json',
        text: JSON.stringify({ jsx: readViewFile(v.file), _meta: { [SURFACE_NS]: v.meta } }),
      }],
    })
  );
}

// Track subscriptions so pollApps only pushes resources/updated while a face is bound;
// start/stop the watcher with the first/last subscriber to the app list.
server.server.setRequestHandler('resources/subscribe', async (req) => {
  const uri = req.params?.uri;
  if (uri) { subscribed.add(uri); if (uri === URI_APPS) startWatching(); }
  return {};
});
server.server.setRequestHandler('resources/unsubscribe', async (req) => {
  const uri = req.params?.uri;
  if (uri) { subscribed.delete(uri); if (!subscribed.has(URI_APPS)) stopWatching(); }
  return {};
});

// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
