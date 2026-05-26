import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'screenshot', version: '1.1.0' });

function defaultSavePath(ext = 'png') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(homedir(), 'Desktop', `Screenshot-${ts}.${ext}`);
}

function defaultRecordingPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(homedir(), 'Desktop', `Recording-${ts}.mov`);
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
      `const procs = Application('System Events').processes.whose({ frontmost: true });
       if (procs.length === 0) throw new Error('No frontmost process found');
       const p = procs[0];
       let out = null;
       for (let i = 0; i < p.windows.length; i++) {
         try {
           const w = p.windows[i];
           const sz = w.size();
           if (sz[0] > 0 && sz[1] > 0) {
             const pos = w.position();
             out = JSON.stringify({ x: pos[0], y: pos[1], width: sz[0], height: sz[1] });
             break;
           }
         } catch(e) {}
       }
       if (!out) throw new Error('Frontmost app has no visible windows');
       out`
    ]);
    const b = JSON.parse(stdout.trim());
    return ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`];
  }
  if (target === 'window_pick') {
    return ['-w'];
  }
  if (target === 'region_select') {
    return ['-s'];
  }
  // region
  if (!region) throw new Error('region param is required when target is "region"');
  return ['-x', '-R', `${region.x},${region.y},${region.width},${region.height}`];
}

// ── Screen recording state ────────────────────────────────────────────────────

let _recording = null; // { proc, path }

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool('take_screenshot', {
  description:
    'Capture the screen, frontmost window, a clicked window, or a region as a PNG image. ' +
    'Saves to Desktop by default and returns the path. ' +
    'Pass save_path="base64" to get raw base64 image data instead (useful for AI vision). ' +
    'target options: "screen" (full display), "frontmost_window" (auto-detect active window), ' +
    '"window_pick" (shows camera cursor — click the window you want), ' +
    '"region_select" (interactive crosshair — drag to select a region), ' +
    '"region" (explicit x/y/width/height coordinates).',
  inputSchema: {
    target: z.enum(['screen', 'frontmost_window', 'window_pick', 'region_select', 'region']).default('screen').describe(
      'What to capture'
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
  const result = { success: true, target, path: dest };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('start_screen_recording', {
  description:
    'Start recording the screen to a .mov file. Returns immediately — recording runs in the background. ' +
    'Call stop_screen_recording to finish and save the file. ' +
    'Only one recording can run at a time.',
  inputSchema: {
    save_path: z.string().optional().describe(
      'Where to save the recording. Defaults to ~/Desktop/Recording-<timestamp>.mov'
    ),
    display: z.number().int().min(0).optional().describe(
      '0-based display index (default: 0, i.e. main display)'
    ),
    capture_audio: z.boolean().optional().describe(
      'Capture microphone audio along with the video (default: false)'
    ),
  },
  outputSchema: {
    success: z.boolean(),
    path: z.string(),
    message: z.string(),
  },
}, async ({ save_path, display, capture_audio }) => {
  if (_recording) throw new Error('A recording is already in progress. Call stop_screen_recording first.');

  const dest = save_path ?? defaultRecordingPath();
  const args = ['-v', '-x', '-D', String((display ?? 0) + 1)];
  if (capture_audio) args.push('-g');
  args.push(dest);

  const proc = spawn('screencapture', args, { stdio: 'ignore', detached: false });
  _recording = { proc, path: dest };

  proc.on('exit', () => { _recording = null; });

  const result = { success: true, path: dest, message: 'Recording started. Call stop_screen_recording to finish.' };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

server.registerTool('stop_screen_recording', {
  description: 'Stop the current screen recording and save the file. Returns the path to the saved video.',
  inputSchema: {},
  outputSchema: {
    success: z.boolean(),
    path: z.string().nullable(),
    message: z.string(),
  },
}, async () => {
  if (!_recording) {
    const result = { success: false, path: null, message: 'No recording in progress.' };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }
  const { proc, path } = _recording;
  proc.kill('SIGINT');
  // Give screencapture a moment to finalise the file
  await new Promise(resolve => setTimeout(resolve, 1500));
  _recording = null;
  const result = { success: true, path, message: `Recording saved to ${path}` };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
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
  const result = { windows: JSON.parse(stdout.trim()) };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
