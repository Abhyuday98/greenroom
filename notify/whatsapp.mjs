#!/usr/bin/env node
// greenroom notify: a separate job that reads each studio's decisions.jsonl and usage.jsonl and sends WhatsApp
// messages through whatsapp-web.js: one message per pull request sent (and when it is merged or closed), and one
// summary a day. Config: ~/.config/greenroom-notify.json (see README). First run prints a QR code to link a phone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
const { Client, LocalAuth } = pkg;

const CONFIG = path.join(os.homedir(), '.config/greenroom-notify.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const home = (p) => p.replace(/^~/, os.homedir());
const STATE = path.join(os.homedir(), '.config/greenroom-notify.state.json');
let state = { seen: {}, lastSummary: '' };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const rows = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: cfg.timeZone || 'Asia/Singapore' }); // YYYY-MM-DD
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: cfg.timeZone || 'Asia/Singapore' });
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: cfg.timeZone || 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });
const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- what to say ----------
function prMessages(studio) {
  const out = [];
  for (const r of rows(path.join(home(studio.dir), 'decisions.jsonl'))) {
    if (!r.pr) continue;
    const key = `${studio.name}:${r.pr}`;
    const seen = state.seen[key] || {};
    if (!seen.sent) {
      const num = r.pr.split('/').pop();
      out.push(`📬 *${studio.name}* PR #${num} from ${r.who.split('@')[0]} [${r.tier}]\n${r.note || r.requests?.[0] || ''}\n${(r.files || []).map((f) => '• ' + f).join('\n')}\n${r.pr}`);
      seen.sent = true;
    }
    if (r.decision && !seen.decided) {
      out.push(`${r.decision === 'merged' ? '✅' : '🚫'} *${studio.name}* PR #${r.pr.split('/').pop()} ${r.decision}: ${short(r.note || '')}`);
      seen.decided = true;
    }
    state.seen[key] = seen;
  }
  return out;
}

function summary() {
  const lines = [`📋 *Studios, ${today()} ${hhmm()}*`];
  for (const s of cfg.studios) {
    let active = 'unknown';
    try { active = execFileSync('systemctl', ['--user', 'is-active', s.service], { encoding: 'utf8' }).trim(); } catch (e) { active = (e.stdout || 'inactive').trim(); }
    const use = rows(path.join(home(s.dir), 'usage.jsonl')).filter((r) => dayOf(r.when) === today());
    const dec = rows(path.join(home(s.dir), 'decisions.jsonl'));
    const sentToday = dec.filter((r) => dayOf(r.at) === today());
    const open = dec.filter((r) => r.pr && !r.decision);
    const people = [...new Set(use.map((r) => r.who.split('@')[0]))];
    const cost = use.reduce((a, r) => a + (r.cost || 0), 0);
    const outTok = use.reduce((a, r) => a + (r.output || 0), 0);
    lines.push(`\n*${s.name}* · service ${active}`);
    lines.push(`turns today: ${use.length}${people.length ? ' (' + people.join(', ') + ')' : ''} · ~$${cost.toFixed(2)} · ${outTok.toLocaleString()} output tokens`);
    lines.push(`PRs today: ${sentToday.length} · waiting for you: ${open.length}`);
    for (const r of open.slice(-3)) lines.push(`  • ${short(r.note || r.requests?.[0] || '')} [${r.tier}] ${r.pr}`);
  }
  return lines.join('\n');
}

if (process.argv.includes('--dry')) { // no WhatsApp: print what would be sent
  for (const s of cfg.studios) for (const m of prMessages(s)) console.log(m + '\n');
  console.log(summary()); process.exit(0);
}

// ---------- WhatsApp ----------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(os.homedir(), '.config/greenroom-notify') }),
  puppeteer: { executablePath: cfg.chrome || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] },
});
client.on('qr', (qr) => { console.log('\nScan this with WhatsApp > Linked devices > Link a device:\n'); qrcode.generate(qr, { small: true }); });
client.on('authenticated', () => log('authenticated'));
client.on('auth_failure', (m) => { log('auth failure', m); process.exit(1); });
client.on('disconnected', (r) => { log('disconnected', r); process.exit(1); }); // systemd restarts us
client.on('ready', async () => {
  log('ready; sending to', cfg.to);
  if (process.argv.includes('--login')) { log('linked; session saved. Start the service now.'); await client.destroy(); process.exit(0); }
  const send = async (text) => { await client.sendMessage(cfg.to, text); log('sent:', text.split('\n')[0]); };
  if (process.argv.includes('--test')) { await send(summary()); process.exit(0); }
  // first run: mark everything already in the files as seen, so we do not replay history
  if (!Object.keys(state.seen).length) { for (const s of cfg.studios) prMessages(s); save(); log('primed', Object.keys(state.seen).length, 'existing PRs'); }
  setInterval(async () => {
    try {
      for (const s of cfg.studios) for (const m of prMessages(s)) await send(m);
      save();
      if (hhmm() === (cfg.dailyAt || '21:00') && state.lastSummary !== today()) { await send(summary()); state.lastSummary = today(); save(); }
    } catch (e) { log('tick failed', e.message); }
  }, 30000);
});
client.initialize();
