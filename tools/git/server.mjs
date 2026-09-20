import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch, statSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';

// This pack is NOT a wrapper that hands you `git` — the bash pack already runs any
// command you like, and any agent authoring a button has git in its own shell. Two
// things bash structurally cannot do are the whole reason this exists:
//
//   1. Structured output. A face is a React component in a sandbox; it cannot
//      sensibly parse `git status --porcelain`, and an agent burns tokens doing it.
//      Everything here returns the parsed shape a key renders directly.
//   2. resource://git/status/{repo}. Repo state is the textbook case of state you
//      did NOT cause — it changes because you saved a file in your editor, or a
//      teammate pushed. A key showing "main ●2 ↑1" has to be PUSHED to; faces never
//      poll. run_command can't push, so a bound face was impossible before this.
//
// Deliberately absent: force-push, rebase, reset, amend, cherry-pick. A Stream Deck
// key is one accidental press away from a bad afternoon, and those all have an
// interactive recovery story that a 72x72 image can't tell. Use bash for them.

const execFileAsync = promisify(execFile);

// subscribe: each repo's status is pushed while a face is bound to it.
// listChanged: the advertised SET grows as repos are touched (see `list` below), and
// the host only installs its list_changed handler when we declare the capability.
const server = new McpServer(
  { name: 'git', version: '1.0.0' },
  { capabilities: { resources: { subscribe: true, listChanged: true }, tools: {} } },
);

const ok = (structured, text) => ({ structuredContent: structured, content: [{ type: 'text', text }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const VERSION = { 'io.streamdeck/tool': { version: '1.0.0' } };

// ── Repo resolution ───────────────────────────────────────────────────────────

function expandPath(p) {
  if (p === '~' || p.startsWith('~/')) return nodePath.join(homedir(), p.slice(1));
  return p;
}

/** Run git and return stdout. `combined` also folds in stderr, which is where git
 *  puts the lines that are actually its ANSWER rather than an error — "Everything
 *  up-to-date" and "Branch 'x' set up to track…" both arrive on stderr. */
async function git(root, args, { timeout = 60_000, combined = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: root,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      // Never let git try to prompt: on a button press there is nobody to answer,
      // and without this a push needing credentials hangs until the timeout.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return combined ? `${stdout}\n${stderr}`.trim() : stdout;
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
    throw new Error(`git ${args[0]} failed in ${root}: ${detail.slice(0, 800)}`);
  }
}

const rootCache = new Map();   // input path → { root, gitDir }
const gitDirs = new Map();     // repo root → absolute git dir (a submodule's is elsewhere)

/** Resolve any path inside a repo to its top level. Empty falls back to the
 *  configured default repo, which is what lets a button be authored without
 *  hard-coding a path. */
async function resolveRepo(input) {
  const raw = expandPath((input || process.env.GIT_DEFAULT_REPO || '').trim());
  if (!raw) {
    throw new Error(
      'No repository given and no default configured. Pass `repo` (an absolute path ' +
      'inside the repo), or configure this pack\'s default_repo so buttons can omit it.',
    );
  }
  const abs = nodePath.resolve(raw);
  const cached = rootCache.get(abs);
  if (cached) return cached;

  let out;
  try {
    out = await execFileAsync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], {
      cwd: abs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    throw new Error(`Not a git repository (or it does not exist): ${abs}`);
  }
  const [top, gitDir] = out.stdout.trim().split('\n');
  const rec = { root: top, gitDir };
  rootCache.set(abs, rec);
  rootCache.set(top, rec);
  gitDirs.set(top, gitDir);
  known.set(top, known.get(top) ?? null);
  return rec;
}

// ── Status ────────────────────────────────────────────────────────────────────

/** Parse `git status --porcelain=v2 --branch`.
 *
 *  Untracked counting uses git's `normal` mode, where an untracked DIRECTORY is one
 *  entry rather than every file under it. That's the cheap read (`-uall` walks the
 *  whole tree) and the right number for a key: "3 untracked" meaning three new
 *  things, not three hundred files inside one of them. */
function parseStatus(out) {
  let branch = '';
  let upstream = '';
  let head_sha = '';
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) { branch = line.slice(14).trim(); continue; }
    if (line.startsWith('# branch.upstream ')) { upstream = line.slice(18).trim(); continue; }
    if (line.startsWith('# branch.oid ')) { head_sha = line.slice(13).trim(); continue; }
    if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      continue;
    }
    if (line[0] === '?') { untracked++; continue; }
    if (line[0] === 'u') { conflicts++; continue; }
    if (line[0] === '1' || line[0] === '2') {
      // "1 XY ..." — X is the index (staged) state, Y the worktree (unstaged) one.
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') staged++;
      if (xy[1] !== '.') unstaged++;
    }
  }

  const detached = branch === '(detached)';
  return {
    branch: detached ? '' : branch,
    detached,
    head_sha: head_sha === '(initial)' ? '' : head_sha,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicts,
    clean: staged === 0 && unstaged === 0 && untracked === 0 && conflicts === 0,
  };
}

const LOG_FMT = '%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%cr';

function parseLogLine(line) {
  const [sha, short_sha, subject, author, date, relative_date] = line.split('\x1f');
  return { sha, short_sha, subject, author, date, relative_date };
}

async function statusOf(root) {
  const out = await git(root, ['status', '--porcelain=v2', '--branch']);
  const status = parseStatus(out);

  let last_commit = null;
  if (status.head_sha) {
    const log = (await git(root, ['log', '-1', `--format=${LOG_FMT}`])).trim();
    if (log) last_commit = parseLogLine(log);
  }

  return {
    repo: root,
    name: nodePath.basename(root),
    ...status,
    last_commit,
    // When ahead/behind were last compared against the remote. See FETCH_NOTE.
    fetched_at: lastFetchAt(root),
  };
}

/** mtime of FETCH_HEAD — i.e. when this repo last learned anything about its
 *  remote. ahead/behind are computed against that snapshot, not against the
 *  remote right now, so a key can honestly sit at "↓0" while the remote has moved.
 *  Surfaced rather than hidden: a face can grey out the arrows when it's stale.
 *  Reads the cached git dir, not another `rev-parse` — this runs on every poll. */
function lastFetchAt(root) {
  const gitDir = gitDirs.get(root);
  if (!gitDir) return null;
  try { return statSync(nodePath.join(gitDir, 'FETCH_HEAD')).mtimeMs; } catch { return null; }
}

const FETCH_NOTE =
  'ahead/behind are measured against the last fetch, so they can be stale — `fetched_at` says ' +
  'how stale. Call fetch (or set auto_fetch_seconds) to refresh them.';

// ── The live resource ─────────────────────────────────────────────────────────

const URI_PREFIX = 'resource://git/status/';
// The path goes in the URI percent-encoded, so it survives as a single segment.
const uriFor = (root) => `${URI_PREFIX}${encodeURIComponent(root)}`;
const rootFromUri = (uri) => {
  if (!uri.startsWith(URI_PREFIX)) return null;
  const seg = uri.slice(URI_PREFIX.length);
  try { return decodeURIComponent(seg); } catch { return seg; }
};

const known = new Map();       // repo root → last pushed snapshot (or null)
const watchers = new Map();    // repo root → { count, fsWatchers[], timer }

const AUTO_FETCH_SECONDS = Math.max(0, Number(process.env.GIT_AUTO_FETCH_SECONDS ?? 0) || 0);
const POLL_MS = Math.max(1000, (Number(process.env.GIT_POLL_SECONDS ?? 4) || 4) * 1000);

const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    name: { type: 'string' },
    branch: { type: 'string' },
    detached: { type: 'boolean' },
    head_sha: { type: 'string' },
    upstream: { type: 'string' },
    ahead: { type: 'number' },
    behind: { type: 'number' },
    staged: { type: 'number' },
    unstaged: { type: 'number' },
    untracked: { type: 'number' },
    conflicts: { type: 'number' },
    clean: { type: 'boolean' },
    fetched_at: { type: 'number' },
    last_commit: {
      type: 'object',
      properties: {
        sha: { type: 'string' }, short_sha: { type: 'string' }, subject: { type: 'string' },
        author: { type: 'string' }, date: { type: 'string' }, relative_date: { type: 'string' },
      },
    },
  },
  required: ['repo', 'name', 'branch', 'ahead', 'behind', 'staged', 'unstaged', 'untracked', 'clean'],
};

// repo root → the exact URI strings clients subscribed with.
//
// Keyed by ROOT but remembering the client's own spelling, because the two are not
// the same string and a push has to use the client's. `/tmp` is a symlink to
// `/private/tmp`, so subscribing to /tmp/x resolves to a root of /private/tmp/x; a
// face may also be bound to a SUBDIRECTORY path, or to a submodule's parent. All of
// those resolve to one root we watch once, and each gets its own notification under
// the URI it asked for — push the resolved spelling instead and the host silently
// matches it to no binding, which looks exactly like the watcher not working.
const subsByRoot = new Map();

/** Recompute and push, but ONLY if something a face could see actually changed.
 *  The poll below fires every few seconds; without this dedupe a bound face would
 *  repaint continuously for a repo nobody is touching.
 *
 *  `snap` lets a tool that already read the post-change status hand it over instead
 *  of paying for a second `git status`. This function is the ONLY writer of `known`:
 *  when the write tools also set it themselves, the comparison below ran the new
 *  state against itself and every push after a commit or a branch switch was
 *  silently swallowed. */
async function refresh(root, snap) {
  try { snap ??= await statusOf(root); } catch { return; }
  const prev = known.get(root);
  // relative_date drifts ("2 minutes ago" → "3 minutes ago") with no underlying
  // change, so it is excluded from the comparison but kept in what we send.
  const cmp = (s) => JSON.stringify({ ...s, fetched_at: null, last_commit: s.last_commit && { ...s.last_commit, relative_date: '' } });
  known.set(root, snap);
  if (prev && cmp(prev) === cmp(snap)) return;
  for (const uri of subsByRoot.get(root) ?? []) {
    server.server.sendResourceUpdated({ uri }).catch(() => {});
  }
}

/** Watching starts on subscribe and stops on unsubscribe — the profile asks for
 *  work to be gated behind an actual subscription, and this pack takes that
 *  literally: with nothing bound, this server does nothing between tool calls.
 *
 *  Two mechanisms, because the cheap one is incomplete:
 *    - fs.watch on the GIT DIR gives near-instant pushes for commits, branch
 *      switches and staging (HEAD, index, refs/ all live there). Note the git dir
 *      is resolved, not assumed to be `<root>/.git` — in a submodule or a linked
 *      worktree, `.git` is a FILE pointing elsewhere.
 *    - a debounced poll of `git status`, because working-tree edits have no cheap
 *      watcher: watching the worktree recursively is expensive on a large repo and
 *      would fire on every build artifact. So "you saved a file" shows up within
 *      POLL_MS (4s default) rather than instantly. That is the one honest latency
 *      in this pack, and it is a server-side interval — the FACE still never polls.
 */
function startWatching(root, gitDir) {
  if (watchers.has(root)) return;

  const rec = { fsWatchers: [], timer: null, fetchTimer: null };
  let debounce = null;
  const nudge = () => {
    clearTimeout(debounce);
    // Git writes index.lock, then index, then refs — a burst. Settle first.
    debounce = setTimeout(() => void refresh(root), 250);
  };

  try {
    // recursive is supported on macOS and Windows but not Linux, where it throws;
    // a flat watch on the git dir still catches HEAD and index, and the poll covers
    // the rest, so a failure here degrades rather than breaks.
    rec.fsWatchers.push(watch(gitDir, { recursive: true, persistent: false }, nudge));
  } catch {
    try { rec.fsWatchers.push(watch(gitDir, { persistent: false }, nudge)); } catch {}
  }

  rec.timer = setInterval(() => void refresh(root), POLL_MS);
  rec.timer.unref?.();

  if (AUTO_FETCH_SECONDS > 0) {
    rec.fetchTimer = setInterval(() => {
      git(root, ['fetch', '--quiet', '--all'], { timeout: 45_000 }).then(() => refresh(root)).catch(() => {});
    }, AUTO_FETCH_SECONDS * 1000);
    rec.fetchTimer.unref?.();
  }

  watchers.set(root, rec);
  void refresh(root);
}

/** Stops only once the LAST binding for this root is gone — several faces can be
 *  bound to the same repo under different spellings, sharing one watcher. */
function stopWatching(root) {
  const rec = watchers.get(root);
  if (!rec) return;
  if ((subsByRoot.get(root)?.size ?? 0) > 0) return;
  for (const w of rec.fsWatchers) { try { w.close(); } catch {} }
  clearInterval(rec.timer);
  if (rec.fetchTimer) clearInterval(rec.fetchTimer);
  watchers.delete(root);
}

server.registerResource(
  'status',
  new ResourceTemplate(`${URI_PREFIX}{repo}`, {
    // Advertises the repos this server knows about: the configured default plus any
    // touched by a tool call this session. A face binds by percent-encoded path, so
    // it does not depend on the repo appearing here — this listing is for discovery.
    list: async () => ({
      resources: [...known.keys()].map((root) => ({
        uri: uriFor(root),
        name: `git status ${nodePath.basename(root)}`,
        title: `${nodePath.basename(root)} (git)`,
        description: `Live branch / ahead / behind / dirty counts for ${root}`,
        icons: [{ src: 'https://api.iconify.design/mdi/source-branch.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
        mimeType: 'application/json',
        _meta: { 'io.streamdeck/resourceSchema': STATUS_SCHEMA },
      })),
    }),
  }),
  {
    title: 'Repository Status',
    description:
      'Live status of one repository, by percent-encoded absolute path. Pushes when the branch, ' +
      'the staged/unstaged/untracked counts, ahead/behind or HEAD change. ' + FETCH_NOTE,
    icons: [{ src: 'https://api.iconify.design/mdi/source-branch.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    mimeType: 'application/json',
    _meta: { 'io.streamdeck/resourceSchema': STATUS_SCHEMA },
  },
  async (uri, variables) => {
    const raw = Array.isArray(variables.repo) ? variables.repo[0] : variables.repo;
    // The template may or may not have decoded the segment for us; either way this
    // lands on a real path, and decoding an already-decoded path is a no-op.
    let path = raw ?? '';
    try { path = decodeURIComponent(path); } catch {}
    const { root } = await resolveRepo(path);
    const snap = await statusOf(root);
    void refresh(root, snap);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snap) }] };
  },
);

server.server.setRequestHandler('resources/subscribe', async (req) => {
  const uri = req.params?.uri;
  const path = uri ? rootFromUri(uri) : null;
  if (!path) return {};
  const { root, gitDir } = await resolveRepo(path);
  if (!subsByRoot.has(root)) subsByRoot.set(root, new Set());
  subsByRoot.get(root).add(uri);
  startWatching(root, gitDir);
  return {};
});

server.server.setRequestHandler('resources/unsubscribe', async (req) => {
  const uri = req.params?.uri;
  const path = uri ? rootFromUri(uri) : null;
  if (!path) return {};
  try {
    const { root } = await resolveRepo(path);
    subsByRoot.get(root)?.delete(uri);
    if (subsByRoot.get(root)?.size === 0) subsByRoot.delete(root);
    stopWatching(root);
  } catch {}
  return {};
});

// ── Shared input pieces ───────────────────────────────────────────────────────

const REPO_ARG = z.string().default('')
  .describe('Absolute path to the repo (or anywhere inside it). Defaults to this pack\'s configured default_repo.');

const STATUS_OUT = z.object({
  repo: z.string(),
  name: z.string(),
  branch: z.string(),
  detached: z.boolean(),
  head_sha: z.string(),
  upstream: z.string(),
  ahead: z.number().int(),
  behind: z.number().int(),
  staged: z.number().int(),
  unstaged: z.number().int(),
  untracked: z.number().int(),
  conflicts: z.number().int(),
  clean: z.boolean(),
  fetched_at: z.number().nullable(),
  last_commit: z.object({
    sha: z.string(), short_sha: z.string(), subject: z.string(),
    author: z.string(), date: z.string(), relative_date: z.string(),
  }).nullable(),
});

/** One-line summary for the text content — also the string a key most often shows. */
const summarize = (s) => {
  const bits = [s.detached ? `detached @ ${s.head_sha.slice(0, 7)}` : (s.branch || '(no branch)')];
  if (s.ahead) bits.push(`↑${s.ahead}`);
  if (s.behind) bits.push(`↓${s.behind}`);
  if (s.staged) bits.push(`+${s.staged} staged`);
  if (s.unstaged) bits.push(`~${s.unstaged} modified`);
  if (s.untracked) bits.push(`?${s.untracked} untracked`);
  if (s.conflicts) bits.push(`!${s.conflicts} conflicts`);
  if (s.clean) bits.push('clean');
  return `${s.name}: ${bits.join(' ')}`;
};

// ── Read tools ────────────────────────────────────────────────────────────────

server.registerTool('get_status', {
  title: 'Git Status',
  icons: [{ src: 'https://api.iconify.design/mdi/source-branch.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Current state of a repository as structured fields: branch, upstream, ahead/behind, and counts of ' +
    'staged / unstaged / untracked / conflicted entries, plus the last commit. This is the one-shot read; ' +
    'for a key that keeps itself up to date, bind resource://git/status/{repo} instead of pressing this. ' +
    FETCH_NOTE,
  annotations: READ_ONLY,
  _meta: VERSION,
  inputSchema: { repo: REPO_ARG },
  outputSchema: STATUS_OUT,
}, async ({ repo }) => {
  const { root } = await resolveRepo(repo);
  const snap = await statusOf(root);
  void refresh(root, snap);
  return ok(snap, summarize(snap));
});

server.registerTool('get_log', {
  title: 'Recent Commits',
  icons: [{ src: 'https://api.iconify.design/mdi/history.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'The most recent commits as {sha, short_sha, subject, author, date, relative_date}. Use branch to read ' +
    'a ref other than HEAD, and author/path to filter. For a popup listing "what happened here lately".',
  annotations: READ_ONLY,
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    count: z.number().int().min(1).max(100).default(10).describe('How many commits (1–100, default 10)'),
    branch: z.string().default('').describe('Ref to read (branch, tag or sha). Defaults to HEAD.'),
    author: z.string().default('').describe('Only commits whose author matches this substring'),
    path: z.string().default('').describe('Only commits touching this path, relative to the repo root'),
  },
  outputSchema: z.object({
    repo: z.string(),
    ref: z.string(),
    count: z.number().int(),
    commits: z.array(z.object({
      sha: z.string(), short_sha: z.string(), subject: z.string(),
      author: z.string(), date: z.string(), relative_date: z.string(),
    })),
  }),
}, async ({ repo, count, branch, author, path }) => {
  const { root } = await resolveRepo(repo);
  const args = ['log', `-${count}`, `--format=${LOG_FMT}`];
  if (author) args.push(`--author=${author}`);
  if (branch) args.push(branch);
  // `--` keeps a path that looks like a ref from being mistaken for one.
  if (path) args.push('--', path);
  const out = await git(root, args);
  const commits = out.split('\n').filter(Boolean).map(parseLogLine);
  const result = { repo: root, ref: branch || 'HEAD', count: commits.length, commits };
  return ok(result, commits.length
    ? commits.map((c) => `${c.short_sha}  ${c.subject}  (${c.author}, ${c.relative_date})`).join('\n')
    : 'No commits matched.');
});

server.registerTool('list_branches', {
  title: 'List Branches',
  icons: [{ src: 'https://api.iconify.design/mdi/source-branch-plus.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Local branches with which one is current, each one\'s upstream and ahead/behind, and when it last ' +
    'moved — newest first, so the top entries are what you were actually working on. Set remote to ' +
    'include remote-tracking branches.',
  annotations: READ_ONLY,
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    remote: z.boolean().default(false).describe('Also include remote-tracking branches (default: false)'),
    count: z.number().int().min(1).max(200).default(30).describe('Cap the list (default 30, newest first)'),
  },
  outputSchema: z.object({
    repo: z.string(),
    current: z.string(),
    count: z.number().int(),
    branches: z.array(z.object({
      name: z.string(), current: z.boolean(), remote: z.boolean(), upstream: z.string(),
      ahead: z.number().int(), behind: z.number().int(), date: z.string(), relative_date: z.string(),
      subject: z.string(),
    })),
  }),
}, async ({ repo, remote, count }) => {
  const { root } = await resolveRepo(repo);
  // for-each-ref rather than `branch -vv`, whose columns are a display format that
  // has to be scraped; this asks for exactly the fields we return.
  const fmt = ['%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)',
    '%(committerdate:iso-strict)', '%(committerdate:relative)', '%(contents:subject)'].join('%1f');
  const refs = remote ? ['refs/heads', 'refs/remotes'] : ['refs/heads'];
  const out = await git(root, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', ...refs]);

  const branches = out.split('\n').filter(Boolean).map((line) => {
    const [name, head, upstream, track, date, relative_date, subject] = line.split('\x1f');
    const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
    return {
      name, current: head === '*', remote: name.includes('/') && !upstream && refs.length > 1 && !name.startsWith('refs/heads'),
      upstream: upstream ?? '', ahead, behind, date, relative_date, subject: subject ?? '',
    };
  }).slice(0, count);

  const result = {
    repo: root,
    current: branches.find((b) => b.current)?.name ?? '',
    count: branches.length,
    branches,
  };
  return ok(result, branches.map((b) => `${b.current ? '*' : ' '} ${b.name}  (${b.relative_date})`).join('\n'));
});

// ── Write tools ───────────────────────────────────────────────────────────────

server.registerTool('switch_branch', {
  title: 'Switch Branch',
  icons: [{ src: 'https://api.iconify.design/mdi/swap-horizontal.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Check out a branch, optionally creating it. Refuses when local changes would be overwritten rather ' +
    'than discarding them — set stash to carry your work across instead. Returns the new status.',
  // Changes what your editor is looking at, but nothing is lost: git itself refuses
  // a checkout that would clobber uncommitted work, and `stash` preserves it.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    branch: z.string().describe('Branch to switch to'),
    create: z.boolean().default(false).describe('Create the branch from the current HEAD if it does not exist'),
    stash: z.boolean().default(false)
      .describe('Stash uncommitted changes first and reapply them on the new branch (default: false)'),
  },
  outputSchema: STATUS_OUT.extend({ switched_from: z.string(), stashed: z.boolean() }),
}, async ({ repo, branch, create, stash }) => {
  const { root } = await resolveRepo(repo);
  const before = await statusOf(root);
  if (before.branch === branch) {
    return ok({ ...before, switched_from: branch, stashed: false }, `Already on ${branch}.`);
  }

  // `switch --merge` carries local modifications across when they don't conflict;
  // that is the stash-free version of the same intent, so only reach for a real
  // stash when asked, and only when there is something to stash.
  const stashed = stash && !before.clean;
  if (stashed) {
    await git(root, ['stash', 'push', '--include-untracked', '-m', `streamdeck: switching to ${branch}`]);
  }

  const args = ['switch'];
  if (create) {
    // -c fails if it exists; the caller asked for "make sure I'm on it", so fall
    // back to a plain switch rather than surfacing an error they can't act on.
    try { await git(root, [...args, '-c', branch]); }
    catch { await git(root, [...args, branch]); }
  } else {
    await git(root, [...args, branch]);
  }

  if (stashed) await git(root, ['stash', 'pop']);

  const after = await statusOf(root);
  void refresh(root, after);
  const result = { ...after, switched_from: before.branch, stashed };
  return ok(result, `Switched ${before.branch || '(detached)'} → ${after.branch}${stashed ? ' (changes carried over)' : ''}`);
});

server.registerTool('commit', {
  title: 'Commit',
  icons: [{ src: 'https://api.iconify.design/mdi/source-commit.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Commit what is staged. Set add_all to stage every tracked modification first (it does NOT add ' +
    'untracked files — pass paths for those). Returns the new commit plus the stat line. ' +
    'There is no amend here on purpose: a key that rewrites the last commit is one misfire from losing work.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    message: z.string().describe('Commit message. First line is the subject.'),
    add_all: z.boolean().default(false).describe('Stage all modifications to tracked files first (git add -u)'),
    paths: z.array(z.string()).default([])
      .describe('Specific paths to stage first, relative to the repo root. Use this for new files.'),
  },
  outputSchema: z.object({
    repo: z.string(),
    sha: z.string(),
    short_sha: z.string(),
    subject: z.string(),
    branch: z.string(),
    files_changed: z.number().int(),
    insertions: z.number().int(),
    deletions: z.number().int(),
  }),
}, async ({ repo, message, add_all, paths }) => {
  const { root } = await resolveRepo(repo);
  if (!message.trim()) throw new Error('A commit message is required.');

  if (paths.length) await git(root, ['add', '--', ...paths]);
  if (add_all) await git(root, ['add', '-u']);

  const before = await statusOf(root);
  if (before.conflicts) {
    throw new Error(`${before.conflicts} unresolved conflict(s) in ${root} — resolve them before committing.`);
  }
  if (before.staged === 0) {
    throw new Error(
      `Nothing staged in ${root}. ${before.unstaged || before.untracked
        ? 'There are uncommitted changes — set add_all (tracked files) or pass paths (new files).'
        : 'The working tree is clean.'}`,
    );
  }

  await git(root, ['commit', '-m', message]);

  const log = (await git(root, ['log', '-1', `--format=${LOG_FMT}`])).trim();
  const head = parseLogLine(log);
  // --numstat is machine-readable; --shortstat's prose is a display format.
  const numstat = await git(root, ['show', '--numstat', '--format=', '--no-renames', 'HEAD']);
  let insertions = 0; let deletions = 0; let files_changed = 0;
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del] = line.split('\t');
    files_changed++;
    // "-" means a binary file: counted as changed, contributing no line counts.
    if (add !== '-') insertions += Number(add) || 0;
    if (del !== '-') deletions += Number(del) || 0;
  }

  const after = await statusOf(root);
  void refresh(root, after);
  const result = {
    repo: root, sha: head.sha, short_sha: head.short_sha, subject: head.subject,
    branch: after.branch, files_changed, insertions, deletions,
  };
  return ok(result, `${head.short_sha} ${head.subject} — ${files_changed} file(s), +${insertions}/-${deletions}`);
});

server.registerTool('push', {
  title: 'Push',
  icons: [{ src: 'https://api.iconify.design/mdi/cloud-upload-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Push the current branch to its remote, setting the upstream on first push. Fails cleanly if the ' +
    'remote has moved (pull first) or if credentials are needed — it never prompts, since a key press ' +
    'has nobody to answer. There is deliberately no force option; use the bash pack if you mean it.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    remote: z.string().default('origin').describe('Remote name (default: origin)'),
    branch: z.string().default('').describe('Branch to push. Defaults to the current one.'),
  },
  outputSchema: z.object({
    repo: z.string(), remote: z.string(), branch: z.string(),
    pushed: z.boolean(), up_to_date: z.boolean(), ahead: z.number().int(), output: z.string(),
  }),
}, async ({ repo, remote, branch }) => {
  const { root } = await resolveRepo(repo);
  const before = await statusOf(root);
  if (before.detached) throw new Error(`HEAD is detached in ${root} — check out a branch before pushing.`);
  const target = branch || before.branch;
  if (!target) throw new Error(`Could not determine a branch to push in ${root}.`);

  // --set-upstream unconditionally: it's a no-op when one already exists, and it
  // removes the "fatal: no upstream branch" failure from the first push of a new
  // branch, which on a button is an error with no obvious remedy.
  const out = await git(root, ['push', '--set-upstream', remote, target], { timeout: 120_000, combined: true });

  const after = await statusOf(root);
  void refresh(root, after);
  // Git's own verdict, not arithmetic on ahead/behind: a brand-new branch has NO
  // upstream yet, so its ahead count is 0 both before and after, and inferring from
  // that reported "already up to date" for a branch we had just published.
  const up_to_date = /Everything up-to-date/i.test(out);
  const result = {
    repo: root, remote, branch: target,
    pushed: !up_to_date, up_to_date,
    ahead: after.ahead, output: out.trim().slice(0, 2000),
  };
  return ok(result, up_to_date ? `${target} already up to date on ${remote}.` : `Pushed ${target} → ${remote}.`);
});

server.registerTool('pull', {
  title: 'Pull',
  icons: [{ src: 'https://api.iconify.design/mdi/cloud-download-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Fetch and integrate the upstream branch. Defaults to ff-only, which either fast-forwards cleanly ' +
    'or stops with no changes made — the right default for one press, because a merge conflict you did ' +
    'not ask for is the worst thing a button can hand you. Choose rebase or merge explicitly.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    mode: z.enum(['ff-only', 'rebase', 'merge']).default('ff-only')
      .describe('ff-only = refuse anything that is not a clean fast-forward (default)'),
    remote: z.string().default('').describe('Remote to pull from. Defaults to the branch\'s upstream.'),
  },
  outputSchema: STATUS_OUT.extend({ mode: z.string(), changed: z.boolean(), output: z.string() }),
}, async ({ repo, mode, remote }) => {
  const { root } = await resolveRepo(repo);
  const before = await statusOf(root);
  const flag = { 'ff-only': '--ff-only', rebase: '--rebase', merge: '--no-rebase' }[mode];
  const args = ['pull', flag];
  if (remote) args.push(remote);

  let out;
  try {
    out = await git(root, args, { timeout: 120_000, combined: true });
  } catch (err) {
    if (mode === 'ff-only' && /non-fast-forward|diverge|not possible to fast-forward/i.test(err.message)) {
      throw new Error(
        `${nodePath.basename(root)} has diverged from its upstream, so a fast-forward is not possible. ` +
        'Nothing was changed. Re-run with mode="rebase" or mode="merge" if that is what you want.',
      );
    }
    throw err;
  }

  const after = await statusOf(root);
  void refresh(root, after);
  const changed = after.head_sha !== before.head_sha;
  const result = { ...after, mode, changed, output: out.trim().slice(0, 2000) };
  return ok(result, changed ? `Pulled — now at ${after.head_sha.slice(0, 7)}.` : 'Already up to date.');
});

server.registerTool('fetch', {
  title: 'Fetch',
  icons: [{ src: 'https://api.iconify.design/mdi/sync.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Update remote-tracking refs without touching the working tree, then return the refreshed status. ' +
    'This is what makes ahead/behind true again — press it, or give a bound face fresh arrows by setting ' +
    'auto_fetch_seconds in this pack\'s config.',
  // Touches only .git's remote-tracking refs; the worktree and your commits are
  // untouched, so as far as a caller is concerned this is a read of the remote.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    remote: z.string().default('').describe('Remote to fetch. Defaults to all of them.'),
    prune: z.boolean().default(true).describe('Drop remote-tracking refs whose branch is gone (default: true)'),
  },
  outputSchema: STATUS_OUT,
}, async ({ repo, remote, prune }) => {
  const { root } = await resolveRepo(repo);
  const args = ['fetch', '--quiet'];
  if (prune) args.push('--prune');
  args.push(...(remote ? [remote] : ['--all']));
  await git(root, args, { timeout: 120_000 });

  const after = await statusOf(root);
  void refresh(root, after);
  return ok(after, summarize(after));
});

server.registerTool('stash_changes', {
  title: 'Stash Changes',
  icons: [{ src: 'https://api.iconify.design/mdi/archive-arrow-down-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Put uncommitted changes aside and leave a clean tree, including untracked files by default. ' +
    'Nothing is lost — pop_stash brings it back, and `git stash list` still shows it. ' +
    'No-op when the tree is already clean.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    message: z.string().default('').describe('Label for the stash entry'),
    include_untracked: z.boolean().default(true)
      .describe('Also stash untracked files (default: true — otherwise the tree is not actually clean)'),
  },
  outputSchema: z.object({
    repo: z.string(), stashed: z.boolean(), entry: z.string(), stash_count: z.number().int(), clean: z.boolean(),
  }),
}, async ({ repo, message, include_untracked }) => {
  const { root } = await resolveRepo(repo);
  const before = await statusOf(root);
  if (before.clean) {
    const count = (await git(root, ['stash', 'list'])).split('\n').filter(Boolean).length;
    return ok({ repo: root, stashed: false, entry: '', stash_count: count, clean: true },
      'Nothing to stash — the tree is already clean.');
  }

  const args = ['stash', 'push'];
  if (include_untracked) args.push('--include-untracked');
  if (message) args.push('-m', message);
  await git(root, args);

  const list = (await git(root, ['stash', 'list'])).split('\n').filter(Boolean);
  const after = await statusOf(root);
  void refresh(root, after);
  const result = {
    repo: root, stashed: true, entry: list[0] ?? '', stash_count: list.length, clean: after.clean,
  };
  return ok(result, `Stashed — ${list.length} entr${list.length === 1 ? 'y' : 'ies'} now. Tree is ${after.clean ? 'clean' : 'still dirty'}.`);
});

server.registerTool('pop_stash', {
  title: 'Pop Stash',
  icons: [{ src: 'https://api.iconify.design/mdi/archive-arrow-up-outline.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  description:
    'Reapply the most recent stash (or a specific one) and drop it. If reapplying conflicts, the stash ' +
    'is KEPT and the conflict is reported, so nothing is stranded. Use list to see what is stashed.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: VERSION,
  inputSchema: {
    repo: REPO_ARG,
    index: z.number().int().min(0).default(0).describe('Which stash entry, 0 = most recent (default 0)'),
    list: z.boolean().default(false).describe('Only list the stashes; apply nothing'),
  },
  outputSchema: z.object({
    repo: z.string(), applied: z.boolean(), stash_count: z.number().int(),
    conflicts: z.number().int(), stashes: z.array(z.string()),
  }),
}, async ({ repo, index, list }) => {
  const { root } = await resolveRepo(repo);
  const stashes = (await git(root, ['stash', 'list'])).split('\n').filter(Boolean);

  if (list) {
    return ok({ repo: root, applied: false, stash_count: stashes.length, conflicts: 0, stashes },
      stashes.length ? stashes.join('\n') : 'No stashes.');
  }
  if (!stashes.length) throw new Error(`No stashes in ${root}.`);
  if (index >= stashes.length) {
    throw new Error(`There is no stash@{${index}} in ${root} — only ${stashes.length} entr${stashes.length === 1 ? 'y' : 'ies'}.`);
  }

  // `pop` already keeps the entry when the merge conflicts, so a failure here has
  // not lost anything; say so explicitly rather than surfacing raw git output.
  try {
    await git(root, ['stash', 'pop', `stash@{${index}}`]);
  } catch (err) {
    const after = await statusOf(root);
    throw new Error(
      `Reapplying stash@{${index}} conflicted, so it was KEPT (nothing lost). ` +
      `${after.conflicts} conflicted file(s) are in the tree. Original error: ${err.message}`,
    );
  }

  const after = await statusOf(root);
  void refresh(root, after);
  const remaining = (await git(root, ['stash', 'list'])).split('\n').filter(Boolean);
  const result = {
    repo: root, applied: true, stash_count: remaining.length,
    conflicts: after.conflicts, stashes: remaining,
  };
  return ok(result, `Applied stash@{${index}} — ${remaining.length} left. ${summarize(after)}`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Seed the resource listing with the configured default, so a face has something to
// discover before any tool has run. Best-effort: a bad path must not block startup.
if (process.env.GIT_DEFAULT_REPO) {
  resolveRepo('').catch(() => {});
}

await server.connect(new StdioServerTransport());
