import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';

const server = new McpServer({ name: 'openai', version: '1.4.0' });

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

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function expandPath(p) {
  if (p === '~' || p.startsWith('~/')) return nodePath.join(homedir(), p.slice(1));
  return nodePath.isAbsolute(p) ? p : nodePath.join(homedir(), p);
}

/** Where a generated image lands when the caller doesn't say. Desktop matches the
 *  `screenshot` pack, which is the other tool here that produces a file you then look
 *  at, so both end up in the same predictable place. */
function defaultImagePath(format) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return nodePath.join(homedir(), 'Desktop', `Image-${ts}.${format}`);
}

/** Turn one entry of an images response into bytes. gpt-image-1 always returns
 *  b64_json; the dall-e models can return a short-lived URL instead, so follow it. */
async function imageBytes(entry) {
  if (entry?.b64_json) return Buffer.from(entry.b64_json, 'base64');
  if (entry?.url) {
    const resp = await fetch(entry.url);
    if (!resp.ok) throw new Error(`Could not download the generated image: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error('OpenAI returned no image data');
}

/** Save bytes, creating the parent directory. Returns the resolved path.
 *
 *  The image is deliberately NOT returned inline as base64: a 1024×1024 PNG is well
 *  over a megabyte of base64, which would flood an agent's context and is useless to a
 *  button anyway — a face shows a path, and every other pack here (screenshot,
 *  quicktime) already speaks in paths. */
async function saveImage(bytes, path) {
  const target = expandPath(path);
  await mkdir(nodePath.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool('call_llm', {
  title: 'Ask a Model',
  icons: [{ src: 'https://api.iconify.design/mdi/robot.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Call OpenAI with a JSON schema and receive a structured JSON response.',
  inputSchema: {
    prompt: z.string().describe('The user message / instruction'),
    schema: z.record(z.any()).describe('JSON Schema for the response (type=object, additionalProperties=false)'),
    system_prompt: z.string().default('').describe('Optional system prompt'),
    model: z.string().default('gpt-4o-mini').describe('OpenAI model name'),
    temperature: z.number().default(0).describe('Sampling temperature (default: 0)'),
    max_tokens: z.number().int().default(4096).describe('Max tokens in the response'),
  },
  // The model returns JSON matching the caller's `schema`. We parse it and return
  // those fields at the TOP LEVEL (structuredContent) so callers read e.g.
  // result.translation directly — no JSON.parse needed. `result` (the raw JSON
  // string) is kept for backward compatibility.
  outputSchema: z.object({}).passthrough(),
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

  // Parse the schema-conformant JSON and surface its fields at the top level, so
  // the structured result IS what the caller asked for (e.g. { translation }).
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  const structured = (parsed && typeof parsed === 'object')
    ? { ...parsed, result: content }   // fields + raw string (back-compat)
    : { result: content };

  return {
    content: [{ type: 'text', text: content }],
    structuredContent: structured,
  };
});

server.registerTool('analyze_image', {
  title: 'Analyse Image',
  icons: [{ src: 'https://api.iconify.design/mdi/image-search.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
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
  // With a `schema`, structured fields are surfaced at the top level (plus `result`
  // as the raw string); without one, just `result` (the plain-text answer).
  outputSchema: z.object({}).passthrough(),
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

  // If a schema was requested, content is JSON — surface its fields at top level.
  let parsed = null;
  if (schema) { try { parsed = JSON.parse(content); } catch { parsed = null; } }
  const structured = (parsed && typeof parsed === 'object')
    ? { ...parsed, result: content }
    : { result: content };

  return {
    content: [{ type: 'text', text: content }],
    structuredContent: structured,
  };
});

server.registerTool('transcribe_file', {
  title: 'Transcribe Audio',
  icons: [{ src: 'https://api.iconify.design/mdi/transcribe.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description: 'Transcribe an audio file using OpenAI Whisper. Accepts M4A, MP4, MP3, WAV, WebM, FLAC, OGG, etc. Returns {transcript, path}.',
  inputSchema: {
    path: z.string().describe('Absolute path to the audio file'),
    language: z.string().default('').describe("ISO language code ('en', 'de', 'fr'…). Auto-detected if empty."),
  },
  outputSchema: z.object({
    transcript: z.string(),
    path:       z.string(),
  }),
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
  const result = { transcript: data.text ?? '', path: filePath };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
});

const IMAGE_OUT = z.object({
  path: z.string(),
  model: z.string(),
  size: z.string(),
  bytes: z.number().int(),
  revised_prompt: z.string(),
});

server.registerTool('generate_image', {
  title: 'Generate Image',
  icons: [{ src: 'https://api.iconify.design/mdi/image-plus-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Generate an image from a text prompt with GPT Image and save it to disk. Returns the file ' +
    'path, not the image bytes — pass that path to a viewer, the clipboard, or a face. ' +
    'Defaults target gpt-image-1; if you switch model to a dall-e-* one, use a size and quality ' +
    'it accepts (dall-e-3: 1024x1024 | 1792x1024 | 1024x1792, quality standard | hd).',
  // Writes a file, so not read-only; not destructive, because the default path is a
  // fresh timestamped file and only an explicit output_path can land on an existing one.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: { 'io.streamdeck/tool': { version: '1.0.0' } },
  inputSchema: {
    prompt: z.string().describe('What to draw. Be specific — this is the whole input.'),
    output_path: z.string().default('')
      .describe('Where to write the file. Defaults to ~/Desktop/Image-<timestamp>.<format>.'),
    model: z.string().default('gpt-image-1').describe('Image model (default: gpt-image-1)'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).default('1024x1024')
      .describe('Output dimensions — 1536x1024 landscape, 1024x1536 portrait (default: 1024x1024)'),
    quality: z.enum(['low', 'medium', 'high', 'auto']).default('medium')
      .describe('Render quality. Higher costs more and takes longer (default: medium)'),
    background: z.enum(['auto', 'transparent', 'opaque']).default('auto')
      .describe('Use transparent with format png/webp for an icon with no backdrop (default: auto)'),
    format: z.enum(['png', 'jpeg', 'webp']).default('png').describe('Image file format (default: png)'),
  },
  outputSchema: IMAGE_OUT,
}, async ({ prompt, output_path, model, size, quality, background, format }) => {
  const key = apiKey();

  const body = { model, prompt, n: 1, size };
  // These four are gpt-image-1 vocabulary; dall-e-* rejects them outright.
  if (model.startsWith('gpt-image')) {
    Object.assign(body, { quality, background, output_format: format });
  }

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`OpenAI image API error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const entry = (data.data ?? [])[0];
  const bytes = await imageBytes(entry);
  const path = await saveImage(bytes, output_path || defaultImagePath(format));

  const result = {
    path,
    model,
    size: size === 'auto' ? (data.size ?? 'auto') : size,
    bytes: bytes.length,
    revised_prompt: entry?.revised_prompt ?? '',
  };
  return { content: [{ type: 'text', text: `Saved ${path} (${bytes.length} bytes)` }], structuredContent: result };
});

server.registerTool('edit_image', {
  title: 'Edit Image',
  icons: [{ src: 'https://api.iconify.design/mdi/image-edit-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Edit an existing image with a text instruction (remove the background, change the colour, ' +
    'add an object) and save the result as a new file. Supply mask_path to restrict the edit to ' +
    'the mask\'s transparent area. Accepts PNG, JPEG and WebP; returns the new file\'s path.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: { 'io.streamdeck/tool': { version: '1.0.0' } },
  inputSchema: {
    image_path: z.string().describe('Absolute path to the image to edit'),
    prompt: z.string().describe('What to change'),
    mask_path: z.string().default('')
      .describe('Optional PNG mask — the TRANSPARENT area is what gets edited. Must match the image size.'),
    output_path: z.string().default('')
      .describe('Where to write the result. Defaults to ~/Desktop/Image-<timestamp>.png. Never overwrites the input unless you ask it to.'),
    model: z.string().default('gpt-image-1').describe('Image model (default: gpt-image-1)'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).default('auto')
      .describe('Output dimensions (default: auto — keep the input\'s aspect)'),
    quality: z.enum(['low', 'medium', 'high', 'auto']).default('medium').describe('Render quality (default: medium)'),
  },
  outputSchema: IMAGE_OUT,
}, async ({ image_path, prompt, mask_path, output_path, model, size, quality }) => {
  const key = apiKey();

  const src = expandPath(image_path);
  if (!existsSync(src)) throw new Error(`File not found: ${src}`);
  const ext = nodePath.extname(src).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`Unsupported image type "${ext}" — use PNG, JPEG or WebP`);

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  if (size !== 'auto') form.append('size', size);
  if (model.startsWith('gpt-image')) form.append('quality', quality);
  form.append('image', new Blob([await readFile(src)], { type: mime }), `image${ext}`);

  if (mask_path) {
    const mask = expandPath(mask_path);
    if (!existsSync(mask)) throw new Error(`Mask not found: ${mask}`);
    form.append('mask', new Blob([await readFile(mask)], { type: 'image/png' }), 'mask.png');
  }

  const resp = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },   // no Content-Type — FormData sets the boundary
    body: form,
  });
  if (!resp.ok) throw new Error(`OpenAI image edit error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const entry = (data.data ?? [])[0];
  const bytes = await imageBytes(entry);
  const path = await saveImage(bytes, output_path || defaultImagePath('png'));

  const result = {
    path,
    model,
    size: size === 'auto' ? (data.size ?? 'auto') : size,
    bytes: bytes.length,
    revised_prompt: entry?.revised_prompt ?? '',
  };
  return { content: [{ type: 'text', text: `Saved ${path} (${bytes.length} bytes)` }], structuredContent: result };
});

// ── Start ────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
