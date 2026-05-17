import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'screenshot', version: '1.0.0' });

function sc(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

async function captureToBase64(args) {
  const path = `${tmpdir()}/mcp-screenshot-${randomUUID()}.png`;
  try {
    await execFileAsync('screencapture', [...args, path]);
    const buf = await readFile(path);
    return buf.toString('base64');
  } finally {
    await unlink(path).catch(() => {});
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool('take_screenshot', {
  description:
    'Capture the screen, frontmost window, or a region as a PNG image. ' +
    'Returns base64 image data the AI can see directly. ' +
    'Use target="screen" for the full display, "frontmost_window" for the active app window, ' +
    'or "region" with explicit x/y/width/height coordinates.',
  inputSchema: {
    target: z.enum(['screen', 'frontmost_window', 'region']).default('screen').describe(
      'What to capture: full screen, frontmost window, or a screen region'
    ),
    display: z.number().int().min(0).optional().describe(
      '0-based display index for screen capture (default: 0, i.e. main display)'
    ),
    region: z.object({
      x: z.number().describe('Left edge in screen coordinates'),
      y: z.number().describe('Top edge in screen coordinates'),
      width: z.number().describe('Width in pixels'),
      height: z.number().describe('Height in pixels'),
    }).optional().describe('Region to capture — required when target is "region"'),
  },
  outputSchema: {
    success: z.boolean(),
    target: z.string(),
  },
}, async ({ target, display = 0, region }) => {
  let base64;

  if (target === 'screen') {
    base64 = await captureToBase64(['-x', '-D', String(display + 1)]);

  } else if (target === 'frontmost_window') {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e',
      `const p = Application('System Events').processes.whose({ frontmost: true })[0];
       const w = p.windows[0];
       const pos = w.position();
       const sz = w.size();
       JSON.stringify({ x: pos[0], y: pos[1], width: sz[0], height: sz[1] })`
    ]);
    const b = JSON.parse(stdout.trim());
    base64 = await captureToBase64(['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`]);

  } else {
    if (!region) throw new Error('region param is required when target is "region"');
    base64 = await captureToBase64(['-x', '-R', `${region.x},${region.y},${region.width},${region.height}`]);
  }

  return {
    content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
    structuredContent: { success: true, target },
  };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('list_windows', {
  description:
    'List all visible windows with their app name, title, and screen bounds (x, y, width, height). ' +
    'Use this to discover window positions before calling take_screenshot with target="region".',
  inputSchema: {},
  outputSchema: {
    windows: z.array(z.object({
      app: z.string(),
      title: z.string().nullable(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })),
  },
}, async () => {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', `
    const procs = Application('System Events').processes.whose({ backgroundOnly: false })();
    const result = [];
    for (const proc of procs) {
      const appName = proc.name();
      for (let i = 0; i < proc.windows.length; i++) {
        try {
          const w = proc.windows[i];
          const pos = w.position();
          const sz = w.size();
          if (sz[0] === 0 || sz[1] === 0) continue;
          result.push({
            app: appName,
            title: (() => { try { return w.name(); } catch { return null; } })(),
            x: pos[0], y: pos[1], width: sz[0], height: sz[1],
          });
        } catch {}
      }
    }
    JSON.stringify(result);
  `]);
  return sc({ windows: JSON.parse(stdout.trim()) });
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
