#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool: `rm` may only remove plain file names inside the upload folder
// (GREENROOM_UPLOAD_DIR, e.g. public/img). No flags, no `..`, no absolute paths, no globs. Everything else that
// is not an rm passes through to the normal permission rules. Exit 2 blocks the call and shows the reason.
import fs from 'node:fs';
const DIR = (process.env.GREENROOM_UPLOAD_DIR || 'public/img').replace(/\/+$/, '');
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
const cmd = String(input.tool_input?.command || '');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
for (const seg of cmd.split(/&&|\|\||;|\|/)) {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  if (words[0] !== 'rm') continue;
  const bad = words.slice(1).find((w) => {
    if (w.startsWith('-')) return true;
    const q = w.replace(/^['"]|['"]$/g, '');
    if (!q.startsWith(DIR + '/')) return true;
    return !NAME.test(q.slice(DIR.length + 1));
  });
  if (bad !== undefined || words.length < 2) {
    process.stderr.write(`rm is only allowed for a file inside ${DIR}/, by name: not "${bad ?? seg.trim()}"\n`);
    process.exit(2);
  }
}
process.exit(0);
