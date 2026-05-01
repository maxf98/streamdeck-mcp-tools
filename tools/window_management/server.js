#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { run } from '@jxa/run';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import plist from 'plist';
import * as z from 'zod/v4';

const SPACES_PLIST = join(homedir(), 'Library/Preferences/com.apple.spaces.plist');

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
    description: 'Get a list of all currently running GUI applications.',
    inputSchema: {},
    outputSchema: {
      applications: z.array(z.object({ name: z.string(), bundle_id: z.string().nullable() })),
    },
  },
  async () => {
    const apps = await run(() => {
      const se = Application('System Events');
      return se.processes.whose({ backgroundOnly: false })().map(p => ({
        name: p.name(),
        bundle_id: (() => { try { return p.bundleIdentifier(); } catch { return null; } })(),
      }));
    });
    return sc({ applications: apps });
  }
);

// ---------------------------------------------------------------------------

server.registerTool('get_windows',
  {
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

const transport = new StdioServerTransport();
await server.connect(transport);
