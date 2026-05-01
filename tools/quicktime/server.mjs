/**
 * QuickTime Player — control via AppleScript
 *
 * Tools: start_audio_recording, stop_audio_recording, audio_recording_status,
 *        start_screen_recording, stop_screen_recording, screen_recording_status,
 *        open_file, get_open_documents
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  description: 'Start recording from the Mac microphone using QuickTime Player. macOS will ask for microphone permission on first use. Returns {status, path}.',
  inputSchema: {
    output_path: z.string().default('').describe('Where to save the recording (default: temp .m4a file in /tmp)'),
  },
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
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'already_recording',
      path: _audioState.outPath,
      message: 'Already recording. Call stop_audio_recording first.',
    }) }] };
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
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'recording', path: outPath }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('stop_audio_recording', {
  description: 'Stop the current audio recording and export it to M4A. Returns {path, duration_seconds}.',
  inputSchema: {},
}, async () => {
  if (!_audioState) {
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'not_recording',
      message: 'No active recording. Call start_audio_recording first.',
    }) }] };
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
  return { content: [{ type: 'text', text: JSON.stringify({ path: outPath, duration_seconds: Math.round(duration * 100) / 100 }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('audio_recording_status', {
  description: 'Check whether an audio recording is currently in progress. Returns {recording, path?, elapsed_seconds?}.',
  inputSchema: {},
}, async () => {
  if (!_audioState) return { content: [{ type: 'text', text: JSON.stringify({ recording: false }) }] };
  const elapsed = (Date.now() - _audioState.startTime) / 1000;
  return { content: [{ type: 'text', text: JSON.stringify({
    recording: true,
    path: _audioState.outPath,
    elapsed_seconds: Math.round(elapsed * 100) / 100,
  }) }] };
});

// ── screen recording ──────────────────────────────────────────────────────────

server.registerTool('open_screen_recording', {
  description: 'Open the QuickTime screen recording toolbar. The user clicks Record to start and Stop to finish — QuickTime handles saving. Use this to quickly launch a screen recording from a Stream Deck button.',
  inputSchema: {},
}, async () => {
  await osascript(`
    tell application "QuickTime Player"
      activate
      new screen recording
    end tell
  `);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Screen recording toolbar opened — click Record to begin.' }) }] };
});

// ── utilities ─────────────────────────────────────────────────────────────────

server.registerTool('open_file', {
  description: 'Open a media file (video, audio, etc.) in QuickTime Player. Returns {name}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the media file to open'),
  },
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
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, name: raw }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('get_open_documents', {
  description: 'List all documents currently open in QuickTime Player. Returns [{name, duration_seconds}].',
  inputSchema: {},
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
  return { content: [{ type: 'text', text: JSON.stringify({ count: docs.length, documents: docs }) }] };
});

// ── start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
