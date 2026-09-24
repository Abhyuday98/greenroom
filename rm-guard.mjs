#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool. Bash is not lexed here; instead the whole command must match one
// strict shape to be an allowed rm: `rm <upload dir>/<name> [<upload dir>/<name> ...]` with plain names only.
// Any other command in which `rm` appears as a word (after a separator, a newline, a subshell, a backtick, a
// path, or at the start) is blocked. Commands without rm pass through to the normal permission rules.
import fs from 'node:fs';
const DIR = (process.env.GREENROOM_UPLOAD_DIR || 'public/img').replace(/\/+$/, '');
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
const cmd = String(input.tool_input?.command || '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const ALLOWED = new RegExp(`^rm( ${esc(DIR)}/${NAME})+$`);
if (ALLOWED.test(cmd)) process.exit(0);
if (/(^|[\s;&|(){}`$/\\])rm(\s|$)/.test(cmd)) {
  process.stderr.write(`rm is only allowed as: rm ${DIR}/<file name>. Not: ${cmd.slice(0, 80)}\n`);
  process.exit(2);
}
process.exit(0);
