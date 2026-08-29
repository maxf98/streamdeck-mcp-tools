/**
 * QuickTime Player — control via AppleScript
 *
 * Tools: start_audio_recording, stop_audio_recording, audio_recording_status,
 *        start_screen_recording, stop_screen_recording, screen_recording_status,
 *        open_file, get_open_documents
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import nodePath from 'node:path';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'quicktime', version: '1.0.0' });

// ── helpers ───────────────────────────────────────────────────────────────────

// Exact copy of voice-recorder's osascript helper — errors embedded as "ERROR:..."
async function osascript(script, timeoutMs = 30000) {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs });
  const out = stdout.trim();
  if (out.startsWith('ERROR:')) throw new Error(out.slice(6).trim());
  return out;
}

function esc(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function timestamp() {
  return Date.now();
}

// ── state ─────────────────────────────────────────────────────────────────────

// { outPath: string, startTime: number } | null  — exact voice-recorder shape
let _audioState = null;

// ── audio recording (ported verbatim from voice-recorder) ─────────────────────

server.registerTool('start_audio_recording', {
  icons: [{ src: 'https://api.iconify.design/mdi/record-circle.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Start recording from the Mac microphone using QuickTime Player. macOS will ask for microphone permission on first use. Returns {status, path}.',
  inputSchema: {
    output_path: z.string().default('').describe('Where to save the recording (default: temp .m4a file in /tmp)'),
  },
  outputSchema: z.object({
    status:  z.string(),
    path:    z.string().optional(),
    message: z.string().optional(),
  }),
}, async ({ output_path }) => {
  if (_audioState) {
    // Verify QuickTime still has a recording doc — state may be stale
    try {
      const check = await osascript(`
        tell application "QuickTime Player"
          if (count of documents) > 0 then
            return "exists"
          else
            return "missing"
          end if
        end tell
      `);
      if (check === 'missing') _audioState = null;
    } catch {
      _audioState = null;
    }
  }

  if (_audioState) {
    const result = {
      status: 'already_recording',
      path: _audioState.outPath,
      message: 'Already recording. Call stop_audio_recording first.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }


  const outPath = output_path.trim() || nodePath.join(os.tmpdir(), `audio_${timestamp()}.m4a`);

  await osascript(`
    tell application "QuickTime Player"
      new audio recording
      delay 1
      start document 1
      set miniaturized of every window to true
    end tell
  `);

  _audioState = { outPath, startTime: Date.now() };
  const result = { status: 'recording', path: outPath };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('stop_audio_recording', {
  icons: [{ src: 'https://api.iconify.design/mdi/stop-circle.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Stop the current audio recording and export it to M4A. Returns {path, duration_seconds}.',
  inputSchema: {},
  outputSchema: z.object({
    status:           z.string().optional(),
    message:          z.string().optional(),
    path:             z.string().optional(),
    duration_seconds: z.number().optional(),
  }),
}, async () => {
  if (!_audioState) {
    const result = {
      status: 'not_recording',
      message: 'No active recording. Call start_audio_recording first.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }

  const { outPath, startTime } = _audioState;
  const duration = (Date.now() - startTime) / 1000;
  const escapedPath = esc(outPath);

  // Exact voice-recorder stop sequence
  await osascript(`
    tell application "QuickTime Player"
      try
        set miniaturized of every window to true
        stop document 1
        delay 2
        export document 1 in POSIX file "${escapedPath}" using settings preset "Audio Only"
        close document 1 without saving
        if (count of documents) is 0 then quit
        return "ok"
      on error errMsg
        return "ERROR:" & errMsg
      end try
    end tell
  `, 120000);

  _audioState = null;
  const result = { path: outPath, duration_seconds: Math.round(duration * 100) / 100 };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('audio_recording_status', {
  icons: [{ src: 'https://api.iconify.design/mdi/record-rec.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Check whether an audio recording is currently in progress. Returns {recording, path?, elapsed_seconds?}.',
  inputSchema: {},
  outputSchema: z.object({
    recording:       z.boolean(),
    path:            z.string().optional(),
    elapsed_seconds: z.number().optional(),
  }),
}, async () => {
  if (!_audioState) {
    const result = { recording: false };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }
  const elapsed = (Date.now() - _audioState.startTime) / 1000;
  const result = {
    recording: true,
    path: _audioState.outPath,
    elapsed_seconds: Math.round(elapsed * 100) / 100,
  };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ── screen recording ──────────────────────────────────────────────────────────

server.registerTool('open_screen_recording', {
  icons: [{ src: 'https://api.iconify.design/mdi/monitor-share.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open the QuickTime screen recording toolbar. The user clicks Record to start and Stop to finish — QuickTime handles saving. Use this to quickly launch a screen recording from a Stream Deck button.',
  inputSchema: {},
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
}, async () => {
  await osascript(`
    tell application "QuickTime Player"
      activate
      new screen recording
    end tell
  `);
  const result = { success: true, message: 'Screen recording toolbar opened — click Record to begin.' };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ── utilities ─────────────────────────────────────────────────────────────────

server.registerTool('open_file', {
  icons: [{ src: 'https://api.iconify.design/mdi/folder-open.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Open a media file (video, audio, etc.) in QuickTime Player. Returns {name}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the media file to open'),
  },
  outputSchema: z.object({
    success: z.boolean(),
    name:    z.string(),
  }),
}, async ({ path }) => {
  const raw = await osascript(`
tell application "QuickTime Player"
  open POSIX file "${esc(path)}"
  activate
  delay 1
  try
    return name of document 1
  on error
    return ""
  end try
end tell`);
  const result = { success: true, name: raw };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_open_documents', {
  icons: [{ src: 'https://api.iconify.design/mdi/file-multiple.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'List all documents currently open in QuickTime Player. Returns [{name, duration_seconds}].',
  inputSchema: {},
  outputSchema: z.object({
    count:     z.number(),
    documents: z.array(z.object({
      name:             z.string(),
      duration_seconds: z.number(),
    })),
  }),
}, async () => {
  const raw = await osascript(`
tell application "QuickTime Player"
  set output to ""
  repeat with d in every document
    try
      set dur to duration of d
    on error
      set dur to 0
    end try
    set output to output & (name of d) & ":::" & dur & "|||"
  end repeat
  return output
end tell`);

  const docs = raw.split('|||').filter(Boolean).map(entry => {
    const [name, dur] = entry.split(':::');
    return { name: name ?? '', duration_seconds: Math.round(parseFloat(dur) * 100) / 100 || 0 };
  });
  const result = { count: docs.length, documents: docs };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
});

// ── start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
