import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';

const server = new McpServer({ name: 'openai', version: '1.0.0' });

// ── Helpers ──────────────────────────────────────────────────────────────────

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured. Use configure_tool_pack to set it.');
  return key;
}

const MIME_MAP = {
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
};

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('call_llm', {
  description: 'Call OpenAI with a JSON schema and receive a structured JSON response.',
  inputSchema: {
    prompt: z.string().describe('The user message / instruction'),
    schema: z.record(z.any()).describe('JSON Schema for the response (type=object, additionalProperties=false)'),
    system_prompt: z.string().default('').describe('Optional system prompt'),
    model: z.string().default('gpt-4o-mini').describe('OpenAI model name'),
    temperature: z.number().default(0).describe('Sampling temperature (default: 0)'),
    max_tokens: z.number().int().default(4096).describe('Max tokens in the response'),
  },
}, async ({ prompt, schema, system_prompt, model, temperature, max_tokens }) => {
  const key = apiKey();
  const schemaCopy = { ...schema };
  const schemaName = schemaCopy.name ?? 'response';
  delete schemaCopy.name;

  const messages = [];
  if (system_prompt) messages.push({ role: 'system', content: system_prompt });
  messages.push({ role: 'user', content: prompt });

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema: schemaCopy },
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const choice = (data.choices ?? [{}])[0];
  if (choice?.message?.refusal) throw new Error(`LLM refused: ${choice.message.refusal}`);
  const content = choice?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  return { content: [{ type: 'text', text: content }] };
});

server.registerTool('analyze_image', {
  description:
    'Send an image to a GPT vision model with a prompt and get back an analysis. ' +
    'Provide either image_path (absolute path to a PNG/JPG) or image_base64 (raw base64 string). ' +
    'Optionally provide a JSON schema to get structured output — same format as call_llm.',
  inputSchema: {
    prompt: z.string().describe('Question or instruction about the image'),
    image_path: z.string().optional().describe('Absolute path to a PNG or JPG file'),
    image_base64: z.string().optional().describe('Raw base64-encoded image data (PNG or JPG)'),
    image_mime: z.string().default('image/png').describe('MIME type when using image_base64 (default: image/png)'),
    schema: z.record(z.any()).optional().describe('Optional JSON Schema for structured output (same format as call_llm)'),
    system_prompt: z.string().default('').describe('Optional system prompt'),
    model: z.string().default('gpt-4o-mini').describe('OpenAI vision model (default: gpt-4o-mini)'),
    max_tokens: z.number().int().default(1024).describe('Max tokens in the response'),
  },
}, async ({ prompt, image_path, image_base64, image_mime, schema, system_prompt, model, max_tokens }) => {
  const key = apiKey();

  let base64Data;
  let mimeType = image_mime;

  if (image_path) {
    if (!existsSync(image_path)) throw new Error(`File not found: ${image_path}`);
    const ext = nodePath.extname(image_path).toLowerCase();
    mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    base64Data = (await readFile(image_path)).toString('base64');
  } else if (image_base64) {
    base64Data = image_base64;
  } else {
    throw new Error('Provide either image_path or image_base64');
  }

  const imageContent = {
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${base64Data}`, detail: 'auto' },
  };

  const userMessage = { role: 'user', content: [{ type: 'text', text: prompt }, imageContent] };
  const messages = [];
  if (system_prompt) messages.push({ role: 'system', content: system_prompt });
  messages.push(userMessage);

  const body = { model, messages, max_tokens };
  if (schema) {
    const schemaCopy = { ...schema };
    const schemaName = schemaCopy.name ?? 'response';
    delete schemaCopy.name;
    body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: schemaCopy } };
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`OpenAI API error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const choice = (data.choices ?? [{}])[0];
  if (choice?.message?.refusal) throw new Error(`LLM refused: ${choice.message.refusal}`);
  const content = choice?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  return { content: [{ type: 'text', text: content }] };
});

server.registerTool('transcribe_file', {
  description: 'Transcribe an audio file using OpenAI Whisper. Accepts M4A, MP4, MP3, WAV, WebM, FLAC, OGG, etc. Returns {transcript, path}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the audio file'),
    language: z.string().default('').describe("ISO language code ('en', 'de', 'fr'…). Auto-detected if empty."),
  },
}, async ({ path: filePath, language }) => {
  if (!filePath || !existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const key = apiKey();
  const ext = nodePath.extname(filePath).toLowerCase() || '.m4a';
  const mimeType = MIME_MAP[ext] ?? 'audio/mp4';

  const bytes = await readFile(filePath);
  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, `audio${ext}`);
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Whisper API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return { content: [{ type: 'text', text: JSON.stringify({ transcript: data.text ?? '', path: filePath }) }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
