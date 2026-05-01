/**
 * Voice Recorder — start/stop recording from the Mac microphone.
 * Uses QuickTime Player via AppleScript. No PyObjC, no Homebrew dependencies.
 * Saves to M4A. Pairs with transcription tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'voice-recorder', version: '1.0.0' });

// ── State ────────────────────────────────────────────────────────────────────

let _state = null; // { outPath, startTime }

// ── Helpers ──────────────────────────────────────────────────────────────────

// Run an AppleScript and return stdout. Errors embedded in the script as
// "ERROR:..." strings are thrown so callers get a readable message.
async function osascript(script, timeoutMs = 30000) {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs });
  const out = stdout.trim();
  if (out.startsWith('ERROR:')) throw new Error(out.slice(6).trim());
  return out;
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('start_recording', {
  description: 'Start recording from the Mac microphone using QuickTime Player. macOS will ask for microphone permission on first use. Returns {status, path}.',
  inputSchema: {
    output_path: z.string().default('').describe('Where to save the recording (default: temp .m4a file in /tmp)'),
  },
}, async ({ output_path }) => {
  if (_state) {
    // Verify QuickTime still actually has a recording document open — state may be stale
    // from a previous run that failed to stop/clear properly.
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
      if (check === 'missing') _state = null;
    } catch {
      _state = null;
    }
  }

  if (_state) {
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'already_recording',
      path: _state.outPath,
      message: 'Already recording. Call stop_recording first.',
    }) }] };
  }

  const outPath = output_path.trim() || nodePath.join(os.tmpdir(), `recording_${Date.now()}.m4a`);

  await osascript(`
    tell application "QuickTime Player"
      new audio recording
      delay 1
      start document 1
      set miniaturized of every window to true
    end tell
  `);

  _state = { outPath, startTime: Date.now() };
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'recording', path: outPath }) }] };
});

server.registerTool('stop_recording', {
  description: 'Stop the current recording and export it to the path given at start. Returns {path, duration}.',
  inputSchema: {},
}, async () => {
  if (!_state) {
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'not_recording',
      message: 'No active recording. Call start_recording first.',
    }) }] };
  }

  const { outPath, startTime } = _state;
  const duration = (Date.now() - startTime) / 1000;

  const escapedPath = outPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Exactly matches the old Dictate button: miniaturize first (hides finishing-
  // recording UI), stop, delay 2 s, export, close without saving, quit if empty.
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
  `, 120000); // export can take a while

  _state = null;
  return { content: [{ type: 'text', text: JSON.stringify({ path: outPath, duration: Math.round(duration * 100) / 100 }) }] };
});

server.registerTool('recording_status', {
  description: 'Check whether a recording is currently in progress. Returns {recording, path?, elapsed?}.',
  inputSchema: {},
}, async () => {
  if (!_state) return { content: [{ type: 'text', text: JSON.stringify({ recording: false }) }] };
  const elapsed = (Date.now() - _state.startTime) / 1000;
  return { content: [{ type: 'text', text: JSON.stringify({
    recording: true,
    path: _state.outPath,
    elapsed: Math.round(elapsed * 100) / 100,
  }) }] };
});

server.registerTool('save_audio_data', {
  description: 'Save base64-encoded audio data (e.g. from a browser MediaRecorder) to a file. Strip any data-URL prefix first. Returns {path, size_bytes}.',
  inputSchema: {
    data_base64: z.string().describe('Base64-encoded audio bytes'),
    output_path: z.string().default('').describe('Where to save the file (default: temp file)'),
    extension: z.string().default('webm').describe("File extension hint (webm, mp4, wav). Used when generating a temp filename."),
  },
}, async ({ data_base64, output_path, extension }) => {
  let b64 = data_base64;
  if (b64.includes(',')) b64 = b64.split(',', 2)[1];
  const raw = Buffer.from(b64, 'base64');
  const filePath = output_path.trim() || nodePath.join(os.tmpdir(), `recording_${Date.now()}.${extension.replace(/^\./, '')}`);
  await writeFile(filePath, raw);
  return { content: [{ type: 'text', text: JSON.stringify({ path: filePath, size_bytes: raw.length }) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
