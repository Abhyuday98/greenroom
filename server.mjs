#!/usr/bin/env node
// greenroom: a phone-friendly chat + live preview that lets a non-technical person change a website
// through Claude Code, inside a sandboxed copy of the repo, and hand the result to a reviewer as a pull request.
// Stdlib only. Run: node server.mjs [path/to/greenroom.config.json]   (default: ./greenroom.config.json)
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(process.argv[2] || process.env.GREENROOM_CONFIG || path.join(here, 'greenroom.config.json'));
const base = path.dirname(CONFIG_FILE);
const rel = (p) => path.resolve(base, p);

const DEFAULTS = {
  name: 'Studio', owner: 'the reviewer', reviewerLogins: [],
  playground: '../playground', baseBranch: 'main', remote: 'origin', branchPrefix: 'studio/', port: 4400,
  preview: { port: 4322, command: 'npm run dev -- --host 127.0.0.1 --port {port}', url: '/' },
  sync: { everyMinutes: 10, after: [] },
  claude: {
    command: 'claude',
    allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash(npm run build:*)', 'Bash(npm run build)', 'Bash(npm test:*)', 'Bash(npm test)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)'],
    disallowedTools: ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git pull:*)', 'Bash(git fetch:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git stash:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git clean:*)', 'Bash(rm:*)', 'Bash(sudo:*)', 'Bash(curl:*)', 'WebFetch', 'WebSearch', 'Agent', 'Task'],
    bareTools: 'Read,Edit,Write,MultiEdit,Glob,Grep,LS,Bash',
  },
  prompt: 'PROMPT.md', barePrompt: 'PROMPT.bare.md',
  ideas: ['Make the headline on the home page bigger', 'Change the accent colour to something warmer', 'Put this photo on the about page', 'Rewrite the introduction to sound warmer', 'Add a new page called…'],
  tiers: { words: [], content: [], design: [] },
  policy: { autoMerge: false, autoMergeTiers: ['words'] },
  upload: { dir: 'public/img', maxWidth: 1600 },
  files: { allowed: 'allowed.txt', model: 'model.txt', models: 'models.json', state: 'state.json', decisions: 'decisions.jsonl', usage: 'usage.jsonl' },
};
const cfg = (() => {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { console.error(`No config at ${CONFIG_FILE}: ${e.message}`); process.exit(1); }
  const merged = { ...DEFAULTS, ...c };
  for (const k of ['preview', 'sync', 'claude', 'tiers', 'policy', 'upload', 'files']) merged[k] = { ...DEFAULTS[k], ...(c[k] || {}) };
  return merged;
})();
const PLAYGROUND = rel(cfg.playground);
const F = Object.fromEntries(Object.entries(cfg.files).map(([k, v]) => [k, rel(v)]));

const run = promisify(execFile);
const sh = (cmd, cwd = PLAYGROUND) => run('sh', ['-c', cmd], { cwd, maxBuffer: 64e6, env: { ...process.env, FORCE_COLOR: '0' } });
const git = (...args) => run('git', args, { cwd: PLAYGROUND, maxBuffer: 8e6 }).then((r) => r.stdout.trim());
const log = (...a) => console.log(new Date().toISOString(), ...a);
const readText = (p, fallback = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } };
const lines = (p) => readText(p).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

let state = { session: null, round: [], log: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(F.state, 'utf8')) }; } catch {}
const saveState = () => fs.writeFileSync(F.state, JSON.stringify(state, null, 2));

// ---------- who may use this: the identity Tailscale Serve (or Cloudflare Access) puts on the request ----------
const who = (req) => {
  const login = String(req.headers['tailscale-user-login'] || req.headers['cf-access-authenticated-user-email'] || '').toLowerCase();
  const name = req.headers['tailscale-user-name'] || login.split('@')[0];
  if (process.env.GREENROOM_DEV === '1' && !login) return { login: 'dev@local', name: 'Dev' };
  return lines(F.allowed).map((l) => l.toLowerCase()).includes(login) ? { login, name } : null;
};

// ---------- which brain ----------
function provider() {
  let pick = process.env.GREENROOM_MODEL || '';
  const m = lines(F.model)[0]; if (m && m !== 'default') pick = m;
  let table = {}; try { table = JSON.parse(readText(F.models, '{}')); } catch {}
  const p = table[pick] ? { key: pick, ...table[pick] } : { key: pick || 'default', model: pick };
  if (p.tokenEnv && !p.token) p.token = process.env[p.tokenEnv] || '';
  return p;
}

// ---------- the preview dev server ----------
let preview = null;
function startPreview() {
  if (preview) return;
  const cmd = cfg.preview.command.replaceAll('{port}', String(cfg.preview.port));
  log('starting preview:', cmd);
  preview = spawn('sh', ['-c', cmd], { cwd: PLAYGROUND, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.on('exit', (code) => { log('preview exited', code); preview = null; setTimeout(startPreview, 3000); });
}
async function restartPreview() {
  const p = preview; preview = null;
  if (p) { p.removeAllListeners('exit'); p.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); }
  await sh(`fuser -k ${cfg.preview.port}/tcp >/dev/null 2>&1 || true`).catch(() => {});
  if (cfg.preview.clearCache) fs.rmSync(path.join(PLAYGROUND, cfg.preview.clearCache), { recursive: true, force: true });
  startPreview();
}
const previewUp = () => fetch(`http://127.0.0.1:${cfg.preview.port}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500).catch(() => false);

// ---------- keep the playground in step with the base branch and the live data ----------
let lastSync = 0, syncing = null;
const dirty = async () => (await git('status', '--porcelain')).trim().length > 0;
function syncPlayground(force = false) {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!force && await dirty()) return log('sync skipped: unsent changes');
      const before = await git('rev-parse', 'HEAD');
      await git('fetch', '-q', cfg.remote, cfg.baseBranch);
      await git('checkout', '-q', '-B', 'playground', `${cfg.remote}/${cfg.baseBranch}`);
      const after = await git('rev-parse', 'HEAD');
      if (before !== after && /package-lock\.json|pnpm-lock\.yaml|yarn\.lock/.test(await git('diff', '--name-only', before, after))) {
        log('dependencies changed, installing'); await sh('npm ci --silent');
      }
      for (const cmd of cfg.sync.after) await sh(cmd);
      lastSync = Date.now();
      log(`synced to ${after.slice(0, 7)}`);
      await recordDecisions();
      await restartPreview();
    } catch (e) { log('sync failed', e.message || e); }
    finally { syncing = null; }
  })();
  return syncing;
}

// ---------- one chat turn = one claude -p run ----------
let busy = false;
const fillPrompt = (t, person) => t.replaceAll('{name}', person.name).replaceAll('{owner}', cfg.owner);
const facts = () => `\n\nFacts about this session: this copy of the site was refreshed from the live site ${lastSync ? Math.max(1, Math.round((Date.now() - lastSync) / 60000)) + ' minutes ago' : 'when it was set up'}; refreshing (pull, fetch, sync) is automatic and not something you can do or ask for. There is no permission prompt anywhere: a tool that is refused is simply unavailable, so never tell {name} to approve anything; say in one sentence what you cannot do.`.replaceAll('{name}', 'the person');
function chat(text, person, res) {
  const p = provider();
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--append-system-prompt', fillPrompt(readText(rel(p.bare ? cfg.barePrompt : cfg.prompt)) || readText(rel(cfg.prompt)), person) + facts(),
    '--allowedTools', ...cfg.claude.allowedTools, '--disallowedTools', ...cfg.claude.disallowedTools];
  if (p.model) args.push('--model', p.model);
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (p.baseUrl) Object.assign(env, { ANTHROPIC_BASE_URL: p.baseUrl, ANTHROPIC_AUTH_TOKEN: p.token || 'none', ANTHROPIC_API_KEY: '', ANTHROPIC_SMALL_FAST_MODEL: p.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model });
  if (p.bare) args.push('--bare', '--tools', cfg.claude.bareTools); // small models drown in the full harness prompt
  if (state.session) args.push('--resume', state.session);
  log(`turn by ${person.login} on ${p.key} (${p.model || 'default'}${p.baseUrl ? ' @ ' + p.baseUrl : ''})`);
  state.round.push(text); saveState();
  const child = spawn(cfg.claude.command, args, { cwd: PLAYGROUND, stdio: ['ignore', 'pipe', 'pipe'], env });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let buf = '', sawText = false, err = '', ranBuild = false; // a build shares Vite's dep cache with the dev server and leaves it stale
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'system' && ev.session_id) { state.session = ev.session_id; saveState(); }
      if (ev.type === 'assistant' && ev.message?.content) for (const c of ev.message.content) {
        if (c.type === 'text' && c.text) { sawText = true; send({ type: 'text', text: c.text }); }
        if (c.type === 'tool_use') { send({ type: 'tool', text: describeTool(c) }); if (c.name === 'Bash' && /\bbuild\b/.test(c.input?.command || '')) ranBuild = true; }
      }
      if (ev.type === 'result') {
        if (!sawText && ev.result) send({ type: 'text', text: ev.result });
        send({ type: 'done', ok: !ev.is_error, turns: ev.num_turns });
        const u = ev.usage || {}; // one line per turn: who spent what. Cost is Claude Code's estimate at list price, not the bill.
        fs.appendFileSync(F.usage, JSON.stringify({ when: new Date().toISOString(), who: person.login, session: state.session, provider: p.key, model: p.model || 'default', turns: ev.num_turns, seconds: Math.round((ev.duration_ms || 0) / 1000), input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cost: ev.total_cost_usd || 0 }) + '\n');
      }
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => { if (code !== 0) send({ type: 'error', text: `Something went wrong on my side (exit ${code}). ${err.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` }); busy = false; res.end(); if (ranBuild && cfg.preview.clearCache) { log('build ran; restarting the preview with a clean cache'); restartPreview(); } });
  return child;
}
const describeTool = (c) => {
  const f = (p) => (p ? path.relative(PLAYGROUND, path.resolve(PLAYGROUND, p)) : '');
  switch (c.name) {
    case 'Edit': case 'MultiEdit': case 'Write': return `Changing ${f(c.input?.file_path)}`;
    case 'Read': return `Looking at ${f(c.input?.file_path)}`;
    case 'Glob': case 'Grep': case 'LS': return 'Looking around the site';
    case 'Bash': return /build/.test(c.input?.command || '') ? 'Checking the site still builds' : 'Running a check';
    default: return 'Thinking about it';
  }
};

// ---------- the review gate: which tier is this change, by the files it touches ----------
const TIER_ORDER = ['words', 'content', 'design', 'code'];
function tierOf(files) {
  const covered = [];
  for (const t of ['words', 'content', 'design']) {
    covered.push(...(cfg.tiers[t] || []));
    if (files.every((f) => covered.some((g) => path.matchesGlob(f, g)))) return t;
  }
  return 'code';
}
const changedFiles = async () => (await run('git', ['status', '--porcelain'], { cwd: PLAYGROUND })).stdout.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).replace(/^.* -> /, '')); // untrimmed: the first line's status letters keep their leading space

// ---------- git: send as a PR, start over, remember what the reviewer decided ----------
async function sendPR(note, person) {
  const files = await changedFiles();
  if (!files.length) return { error: 'Nothing has changed yet.' };
  const tier = tierOf(files);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  const branch = `${cfg.branchPrefix}${stamp}`;
  const title = `From ${person.name} [${tier}]: ${note || 'changes from the studio'}`.slice(0, 72);
  await git('checkout', '-B', branch);
  await git('add', '-A');
  await git('-c', `user.name=${person.name} via ${cfg.name}`, '-c', 'user.email=studio@greenroom.local', 'commit', '-q', '-m', title);
  await git('push', '-q', '-u', cfg.remote, branch);
  const body = `${note ? note + '\n\n' : ''}Made in ${cfg.name} by ${person.name} (${person.login}).\n\n**Tier: ${tier}** (by the files touched)\n\nWhat was asked:\n${state.round.map((r) => `- ${r.replace(/\n+/g, ' ').slice(0, 300)}`).join('\n')}\n\nFiles changed:\n${files.map((f) => `- ${f}`).join('\n')}`;
  await run('gh', ['label', 'create', `studio:${tier}`, '--force', '--color', { words: '0E8A16', content: 'FBCA04', design: 'D93F0B', code: 'B60205' }[tier], '--description', `greenroom change tier: ${tier}`], { cwd: PLAYGROUND }).catch(() => {});
  const { stdout } = await run('gh', ['pr', 'create', '--base', cfg.baseBranch, '--head', branch, '--title', title, '--body', body, '--label', `studio:${tier}`], { cwd: PLAYGROUND });
  const url = stdout.trim().split('\n').pop();
  log(`sent ${url} [${tier}] by ${person.login}: ${files.length} file${files.length === 1 ? '' : 's'}`);
  let autoMerge = false;
  if (cfg.policy.autoMerge && cfg.policy.autoMergeTiers.includes(tier)) {
    try { await run('gh', ['pr', 'merge', '--auto', '--squash', url], { cwd: PLAYGROUND }); autoMerge = true; } catch (e) { log('auto-merge not enabled on the repo:', e.message.split('\n')[0]); }
  }
  const entry = { at: new Date().toISOString(), who: person.login, tier, files, requests: state.round, note, pr: url, autoMerge };
  fs.appendFileSync(F.decisions, JSON.stringify(entry) + '\n');
  state.log.unshift({ when: entry.at, who: person.name, title, url, tier }); state.log = state.log.slice(0, 20);
  state.session = null; state.round = []; saveState();
  await syncPlayground(true);
  return { url, title, tier, autoMerge };
}
async function reset() {
  await git('checkout', '--', '.');
  await git('clean', '-fdq');
  state.session = null; state.round = []; saveState();
  await syncPlayground(true);
}
/** Fill in the reviewer's verdict on past PRs: merged or closed. That verdict is the label a future classifier learns from. */
async function recordDecisions() {
  let rows; try { rows = readText(F.decisions).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return; }
  let changed = false;
  for (const r of rows) {
    if (r.decision || !r.pr) continue;
    try {
      const { stdout } = await run('gh', ['pr', 'view', r.pr, '--json', 'state,mergedAt,closedAt'], { cwd: PLAYGROUND });
      const v = JSON.parse(stdout);
      if (v.state === 'MERGED') { r.decision = 'merged'; r.decidedAt = v.mergedAt; changed = true; }
      else if (v.state === 'CLOSED') { r.decision = 'closed'; r.decidedAt = v.closedAt; changed = true; }
    } catch {}
  }
  if (changed) fs.writeFileSync(F.decisions, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------- http ----------
const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = () => readText(path.join(here, 'index.html')).replaceAll('{{name}}', esc(cfg.name)).replace('{{ideas}}', cfg.ideas.map((t) => `<button type="button">${esc(t)}</button>`).join('\n        '));
const isStudioPage = (req, url) => url.pathname === '/' && req.headers['sec-fetch-dest'] === 'document' && !url.searchParams.has('preview');
const localHost = (h) => ({ ...h, host: `127.0.0.1:${cfg.preview.port}` }); // dev servers (Vite) refuse unknown Host names; they see their own
function proxyPreview(req, res) {
  const up = http.request({ host: '127.0.0.1', port: cfg.preview.port, method: req.method, path: req.url, headers: localHost(req.headers) }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta name=viewport content="width=device-width"><body style="font:18px system-ui;padding:2rem">The preview is starting. Try again in a few seconds.'); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const person = who(req);
  if (!person) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:18px/1.5 system-ui;padding:2rem"><h1>Not on the list</h1><p>Signed in as: <b>${String(req.headers['tailscale-user-login'] || req.headers['cf-access-authenticated-user-email'] || 'nobody').replace(/</g, '&lt;')}</b>.</p><p>Ask ${cfg.owner} to add that login.</p>`);
  }
  if (!url.pathname.startsWith('/api/') && !isStudioPage(req, url)) return proxyPreview(req, res);
  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page()); }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const files = await changedFiles();
      return json(res, 200, { name: person.name, owner: cfg.owner, preview: cfg.preview.url, previewUp: await previewUp(), busy, session: !!state.session, files, tier: files.length ? tierOf(files) : null, log: state.log, provider: provider().key, model: provider().model || 'default', lastSync });
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') { // totals per person and per session, from usage.jsonl
      const rows = lines(F.usage).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const sum = (key) => { const out = {}; for (const r of rows) { const k = r[key]; const o = out[k] ||= { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, seconds: 0, first: r.when, last: r.when, who: r.who }; o.turns++; for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'seconds']) o[f] += r[f] || 0; o.last = r.when; } return out; };
      return json(res, 200, { byPerson: sum('who'), bySession: sum('session'), rows: rows.slice(-200) });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const { text } = await body(req);
      if (!text?.trim()) return json(res, 400, { error: 'Say something first.' });
      if (busy) return json(res, 409, { error: 'Still working on the last one. Give it a moment.' });
      busy = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (Date.now() - lastSync > cfg.sync.everyMinutes * 60000 && !(await dirty())) { res.write(`data: ${JSON.stringify({ type: 'tool', text: 'Catching up with the live site' })}\n\n`); await syncPlayground(); }
      const child = chat(text.trim(), person, res);
      req.on('close', () => { if (busy) child.kill('SIGTERM'); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      if (busy) return json(res, 409, { error: 'Wait for the current change to finish.' });
      const { note } = await body(req);
      const r = await sendPR(String(note || '').trim(), person);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') { if (busy) return json(res, 409, { error: 'Wait for the current change to finish.' }); await reset(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/preview/restart') { await restartPreview(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const type = req.headers['content-type'] || '';
      if (!/^image\/(jpeg|png|webp|heic|heif)/.test(type)) return json(res, 400, { error: 'Photos only: JPEG, PNG or WebP.' });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 25e6) return json(res, 400, { error: 'That photo is over 25 MB.' }); chunks.push(c); }
      const raw = Buffer.concat(chunks);
      const basename = String(req.headers['x-filename'] || 'photo').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
      const dir = path.join(PLAYGROUND, cfg.upload.dir); fs.mkdirSync(dir, { recursive: true });
      let name;
      try { // web-sized WebP when the project has sharp; the original bytes otherwise
        const sharp = (await import(path.join(PLAYGROUND, 'node_modules', 'sharp', 'lib', 'index.js'))).default;
        name = `${basename}-${Date.now().toString(36)}.webp`;
        await sharp(raw).rotate().resize({ width: cfg.upload.maxWidth, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(dir, name));
      } catch { name = `${basename}-${Date.now().toString(36)}.${type.includes('png') ? 'png' : 'jpg'}`; fs.writeFileSync(path.join(dir, name), raw); }
      return json(res, 200, { path: `/${path.posix.relative('public', cfg.upload.dir) || cfg.upload.dir}/${name}`.replace(/^\/\.\.\//, '/') });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { log('error', e); if (!res.headersSent) json(res, 500, { error: String(e.message || e).slice(0, 300) }); else res.end(); }
});
server.on('upgrade', (req, socket, head) => { // websocket upgrades (the dev server's live reload) go straight through
  if (!who(req)) return socket.destroy();
  const up = net.connect(cfg.preview.port, '127.0.0.1', () => {
    up.write([`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(localHost(req.headers)).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')); if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
server.listen(cfg.port, '127.0.0.1', () => { log(`${cfg.name} on http://127.0.0.1:${cfg.port}, playground ${PLAYGROUND}, brain ${provider().key}`); startPreview(); syncPlayground(); });
process.on('SIGTERM', () => { preview?.kill('SIGTERM'); process.exit(0); });
