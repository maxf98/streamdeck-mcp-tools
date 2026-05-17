import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'screenshot', version: '1.0.0' });

function sc(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

function defaultSavePath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(homedir(), 'Desktop', `Screenshot-${ts}.png`);
}

async function captureToPath(screencaptureArgs, destPath) {
  await execFileAsync('screencapture', [...screencaptureArgs, destPath]);
}

async function captureToBase64(screencaptureArgs) {
  const tmp = join(tmpdir(), `mcp-screenshot-${randomUUID()}.png`);
  try {
    await execFileAsync('screencapture', [...screencaptureArgs, tmp]);
    const buf = await readFile(tmp);
    return buf.toString('base64');
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function getScreencaptureArgs(target, display, region) {
  if (target === 'screen') {
    return ['-x', '-D', String((display ?? 0) + 1)];
  }
  if (target === 'frontmost_window') {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e',
      `const p = Application('System Events').processes.whose({ frontmost: true })[0];
       const w = p.windows[0];
       const pos = w.position();
       const sz = w.size();
       JSON.stringify({ x: pos[0], y: pos[1], width: sz[0], height: sz[1] })`
    ]);
    const b = JSON.parse(stdout.trim());
    return ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`];
  }
  // region
  if (!region) throw new Error('region param is required when target is "region"');
  return ['-x', '-R', `${region.x},${region.y},${region.width},${region.height}`];
}

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool('take_screenshot', {
  description:
    'Capture the screen, frontmost window, or a region as a PNG image. ' +
    'When save_path is provided (or omitted — defaults to Desktop), saves the file to disk and returns the path. ' +
    'Pass save_path="base64" to get raw base64 image data instead (useful for AI vision). ' +
    'Use target="screen" for the full display, "frontmost_window" for the active app window, ' +
    'or "region" with explicit x/y/width/height coordinates.',
  inputSchema: {
    target: z.enum(['screen', 'frontmost_window', 'region']).default('screen').describe(
      'What to capture: full screen, frontmost window, or a screen region'
    ),
    save_path: z.string().optional().describe(
      'Where to save the PNG. Defaults to ~/Desktop/Screenshot-<timestamp>.png. Pass "base64" to return image data instead of saving.'
    ),
    display: z.number().int().min(0).optional().describe(
      '0-based display index for screen capture (default: 0)'
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
    path: z.string().optional(),
  },
}, async ({ target, save_path, display, region }) => {
  const args = await getScreencaptureArgs(target, display, region);

  if (save_path === 'base64') {
    const base64 = await captureToBase64(args);
    return {
      content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
      structuredContent: { success: true, target },
    };
  }

  const dest = save_path ?? defaultSavePath();
  await captureToPath(args, dest);
  return sc({ success: true, target, path: dest });
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
