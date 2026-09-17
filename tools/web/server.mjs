import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// The two primitives every LLM provider ships built in (Anthropic's web_search /
// web_fetch, OpenAI's web search), and the two this catalog had no way to do at all.
//
// There are NO resources here on purpose. Nothing about "the web" is ambient state
// that changes behind your back, so there is nothing for a face to subscribe to —
// these are press-and-show-the-result tools, and a face renders their result out of
// its own local view state.

const server = new McpServer({ name: 'web', version: '1.0.0' });

const ok = (structured, text) => ({ structuredContent: structured, content: [{ type: 'text', text }] });

// Every tool here only reads. Spelled out per tool because the profile requires both
// hints explicitly — a host must be able to tell a reader from an actor without
// parsing prose, since a key press has no confirmation step.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const VERSION = { 'io.streamdeck/tool': { version: '1.0.0' } };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 StreamDeckMCP/1.0';

// ── Text utilities (used by both halves) ──────────────────────────────────────

function hostOf(u) {
    try { return new URL(u).hostname; } catch { return ''; }
}

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
    trade: '™', reg: '®', copy: '©', deg: '°', eacute: 'é', egrave: 'è', uuml: 'ü',
    ouml: 'ö', auml: 'ä', szlig: 'ß', middot: '·', bull: '•', euro: '€', pound: '£',
};

function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref) => {
        if (ref[0] === '#') {
            const cp = ref[1] === 'x' || ref[1] === 'X'
                ? parseInt(ref.slice(2), 16)
                : parseInt(ref.slice(1), 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
        }
        return ENTITIES[ref] ?? ENTITIES[ref.toLowerCase()] ?? whole;
    });
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, '')).trim();

// ── Brave Search ──────────────────────────────────────────────────────────────

function braveKey() {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) {
        throw new Error(
            'BRAVE_SEARCH_API_KEY is not configured, so search is unavailable — ' +
            'configure this pack with a key from https://api-dashboard.search.brave.com/ ' +
            '(the free tier is enough for button use). `fetch_url` needs no key and still works.',
        );
    }
    return key;
}

/** One Brave endpoint call. `path` is 'web' or 'news'. */
async function brave(path, params) {
    const url = new URL(`https://api.search.brave.com/res/v1/${path}/search`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': braveKey(),
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // 429 is the one a button will actually hit — the free tier is 1 query/second.
        if (resp.status === 429) throw new Error(`Brave Search rate limit reached (429). ${body}`);
        throw new Error(`Brave Search error ${resp.status}: ${body.slice(0, 400)}`);
    }
    return resp.json();
}

const SEARCH_OUT = z.object({
    query: z.string(),
    count: z.number().int(),
    results: z.array(z.object({
        title: z.string(),
        url: z.string(),
        description: z.string(),
        age: z.string(),
        source: z.string(),
    })),
});

server.registerTool('search_web', {
    title: 'Search the Web',
    icons: [{ src: 'https://api.iconify.design/mdi/web.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Search the web via Brave and return ranked results as {title, url, description, age, source}. ' +
        'Descriptions are snippets, not full pages — pass a result url to fetch_url to read one. ' +
        'Requires a Brave Search API key in this pack\'s config.',
    annotations: READ_ONLY,
    _meta: VERSION,
    inputSchema: {
        query: z.string().describe('The search query'),
        count: z.number().int().min(1).max(20).default(5)
            .describe('How many results to return (1–20, default 5). Keep it small for a button.'),
        freshness: z.enum(['any', 'day', 'week', 'month', 'year']).default('any')
            .describe('Only return results this recent (default: any)'),
        country: z.string().default('')
            .describe("Two-letter country code to bias results ('US', 'DE', …). Brave's default if empty."),
    },
    outputSchema: SEARCH_OUT,
}, async ({ query, count, freshness, country }) => {
    const FRESH = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
    const data = await brave('web', {
        q: query, count, country: country || undefined, freshness: FRESH[freshness],
    });
    const results = (data?.web?.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        description: stripTags(r.description ?? ''),   // Brave marks matched terms with <strong>
        age: r.age ?? r.page_age ?? '',
        source: r.profile?.name ?? hostOf(r.url ?? ''),
    }));
    const out = { query, count: results.length, results };
    return ok(out, results.length
        ? results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.description}`).join('\n')
        : `No results for "${query}"`);
});

server.registerTool('search_news', {
    title: 'Search News',
    icons: [{ src: 'https://api.iconify.design/mdi/newspaper-variant-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Search recent news via Brave and return headlines as {title, url, description, age, source}. ' +
        'Same shape as search_web, ranked by recency rather than relevance — this is the one for a ' +
        'headlines button. Requires a Brave Search API key.',
    annotations: READ_ONLY,
    _meta: VERSION,
    inputSchema: {
        query: z.string().describe('Topic to get news about'),
        count: z.number().int().min(1).max(20).default(5).describe('How many headlines (1–20, default 5)'),
        freshness: z.enum(['any', 'day', 'week', 'month', 'year']).default('week')
            .describe('How recent (default: week)'),
        country: z.string().default('').describe("Two-letter country code ('US', 'DE', …)"),
    },
    outputSchema: SEARCH_OUT,
}, async ({ query, count, freshness, country }) => {
    const FRESH = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
    const data = await brave('news', {
        q: query, count, country: country || undefined, freshness: FRESH[freshness],
    });
    const results = (data?.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        description: stripTags(r.description ?? ''),
        age: r.age ?? r.page_age ?? '',
        source: r.meta_url?.hostname ?? hostOf(r.url ?? ''),
    }));
    const out = { query, count: results.length, results };
    return ok(out, results.length
        ? results.map((r, i) => `${i + 1}. ${r.title} (${r.source}, ${r.age})\n   ${r.url}`).join('\n')
        : `No news for "${query}"`);
});

// ── fetch_url ─────────────────────────────────────────────────────────────────

/** HTML → readable plain text, with no dependency.
 *
 *  Deliberately not a real parser: a pack that has to `npm install` jsdom+turndown to
 *  read a page is a slow first start and a big tree for a result a button shows as a
 *  line of text. What this does handle is the part that actually ruins extraction —
 *  dropping script/style/nav/header/footer/aside/form so their contents don't land in
 *  the middle of the prose, and preferring <main>/<article> when the page marks it.
 *
 *  Known limits, so nobody is surprised: no tables-as-tables, no link URLs (text
 *  only), and a JS-rendered SPA returns whatever its empty shell contains. For pages
 *  behind those, drive a real browser — the `chrome` pack has CDP.
 */
function htmlToText(html) {
    let s = html;
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<(script|style|noscript|template|svg|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Site chrome goes FIRST, unconditionally. It used to be an `else` branch taken only
    // when no <main> was found, which got the common case backwards: Wikipedia and most
    // docs sites put their table-of-contents <nav> INSIDE <main>, so extraction opened
    // with "Toggle the table of contents / 3 languages / Edit links" before any prose.
    s = s.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<(\w+)\b[^>]*\brole=["'](?:navigation|banner|contentinfo|search)["'][^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Then, if the page marks its main content, keep only that.
    const main = s.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    if (main && main[1].length > 500) s = main[1];

    s = s.replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n');
    s = s.replace(/<\/(?:p|div|section|li|tr|h[1-6]|blockquote|pre|td|th)\s*>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');
    s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);

    // Collapse whitespace without collapsing paragraph breaks.
    s = s.replace(/[ \t ]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

/** Read a response body with a hard byte cap, so a huge file can't blow up memory.
 *  Content-Length is a hint we can't trust, so the cap is enforced while streaming. */
async function readCapped(resp, maxBytes) {
    if (!resp.body) return { text: await resp.text(), truncated: false };
    const chunks = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of resp.body) {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) { truncated = true; break; }
    }
    return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf-8'), truncated };
}

const MAX_BYTES = 5 * 1024 * 1024;

server.registerTool('fetch_url', {
    title: 'Fetch a URL',
    icons: [{ src: 'https://api.iconify.design/mdi/download-network-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    description:
        'Fetch an http(s) URL and return its content as readable text (HTML is stripped to prose), ' +
        'plus the page title and the final URL after redirects. Needs no API key. ' +
        'Use format="raw" for JSON APIs or when you want the markup untouched. ' +
        'This is also how a FACE calls an HTTP API: a face runs on an opaque origin, so its own ' +
        'fetch() is blocked by CORS for most hosts, while this request carries no Origin at all. ' +
        'Not supported: PDFs and other binaries (use a browser pack), and JS-rendered pages return ' +
        'their empty shell.',
    annotations: READ_ONLY,
    _meta: VERSION,
    inputSchema: {
        url: z.string().describe('Absolute http:// or https:// URL'),
        format: z.enum(['text', 'raw']).default('text')
            .describe('text = HTML stripped to readable prose (default); raw = body exactly as served'),
        max_chars: z.number().int().min(100).max(500_000).default(20_000)
            .describe('Truncate the returned content to this many characters (default 20000)'),
    },
    outputSchema: z.object({
        url: z.string(),
        final_url: z.string(),
        title: z.string(),
        content: z.string(),
        content_type: z.string(),
        chars: z.number().int(),
        truncated: z.boolean(),
        status: z.number().int(),
    }),
}, async ({ url, format, max_chars }) => {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Only http and https are supported, got "${parsed.protocol}"`);
    }

    const resp = await fetch(parsed, {
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json,text/*;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(20_000),
    });

    const contentType = resp.headers.get('content-type') ?? '';
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching ${parsed.href}`);
    if (/^(image|audio|video)\//i.test(contentType) || /application\/pdf/i.test(contentType)) {
        throw new Error(`Refusing to return binary content (${contentType}) as text from ${parsed.href}`);
    }

    const { text: body, truncated: capped } = await readCapped(resp, MAX_BYTES);
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body);

    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 300) : '';

    const full = format === 'raw' || !isHtml ? body : htmlToText(body);
    const content = full.slice(0, max_chars);

    const out = {
        url: parsed.href,
        final_url: resp.url || parsed.href,
        title,
        content,
        content_type: contentType,
        chars: content.length,
        truncated: capped || content.length < full.length,
        status: resp.status,
    };
    return ok(out, content || `(empty body from ${parsed.href})`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
