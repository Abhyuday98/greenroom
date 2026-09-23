# greenroom

A chat page for someone who doesn't code, wired into your repo.

They open it on their phone, type what they want changed on the site, watch it happen in a preview, and press Send. You get a pull request. Nothing goes live until you merge.

I built it for my brother, who wanted to edit his own website and did not want to learn git. It is one Node file with no dependencies and runs on the machine that has the repo.

## What happens when they send a message

1. The message goes to `claude -p`, Claude Code in one-shot mode, running inside a git worktree of your repo on its own branch. That worktree is the sandbox: its own dependencies, its own local data, and a tool list that allows reading, editing, running the build and the tests, and nothing else. No commit, no push, no deploy, no network, no secrets.
2. Claude's events stream back to the page as short lines ("Changing the home page") and a reply. The session id is kept, so the next message continues the conversation.
3. The preview is your normal dev server, started in the worktree. greenroom passes it through its own address, so you publish one port and live reload still works.
4. Send commits everything on a timestamped branch, pushes it, opens a PR with the request transcript and the file list, labels it with a tier (below), and resets the worktree to the base branch. Start over resets without sending.

Between messages, if nothing is waiting to be sent, the worktree fast-forwards to the base branch, reinstalls if the lockfile changed, and runs the commands in `sync.after`. I use that to load a snapshot of the production database, so the preview starts from what is actually live.

## Who gets in

Identity comes from whatever sits in front. Behind Tailscale Serve every request carries the visitor's Tailscale login as a header; behind Cloudflare Access it carries their verified email. greenroom checks that header against `allowed.txt` and that is the whole login system. There is no password, no session, no user table.

## Tiers

Each PR is classified by the files it touched, with globs you set in the config:

| Tier | Files | Default |
| --- | --- | --- |
| `words` | copy and images only | can auto-merge (off) |
| `content` | plus data files, e.g. migrations | review |
| `design` | plus styles, pages, components, layouts | review |
| `code` | anything else | review |

With `policy.autoMerge` on, PRs in `policy.autoMergeTiers` are queued with `gh pr merge --auto`, so they merge once your CI passes (enable auto-merge in the repo settings). Every Send is appended to `decisions.jsonl` with the request, the files and the tier, and on each sync greenroom records whether you merged or closed the PR. After a few hundred rows that file is enough to fine-tune a small classifier to predict "needs a look" from the request and the diff. I have not done that yet. The file rules on their own already catch what matters: in my first test, a request to change a headline also updated the test that asserted the old headline, which pushed it into `code`, and the gate asked for review.

## Which model

Claude Code can talk to any endpoint that speaks the Anthropic message format. `models.json` lists them and `model.txt` picks one; it is read on every message.

```json
"opus":  { "model": "opus" },
"local": { "model": "qwen3.6:35b-a3b", "baseUrl": "http://127.0.0.1:11434", "token": "ollama", "bare": true },
"kimi":  { "model": "kimi-k2-0905-preview", "baseUrl": "https://api.moonshot.ai/anthropic", "tokenEnv": "MOONSHOT_API_KEY", "bare": true }
```

OpenRouter also speaks the Anthropic format, at `https://openrouter.ai/api`, so every open model it hosts is one entry away: GLM 4.6, Kimi K2, DeepSeek, the 480B Qwen3-Coder. Set `OPENROUTER_API_KEY` in the service environment and pick the model id from their catalogue. These are the big versions of the models I could not run locally, billed per token, no subscription. OpenRouter also lists models with a `:free` suffix that cost nothing: rate-limited (50 requests a day until you have put $10 of credit on the account, then 1,000), served by providers who may keep your prompts, and the list changes week to week. An agent turn is several requests, so the free limit covers a handful of changes a day. Filter their model list for `:free` and `tools`; a free model without tool support cannot drive Claude Code.

`bare` runs Claude Code with `--bare` and a named tool set and swaps in `PROMPT.bare.md`, a short prompt with a map of the project. I needed this because the small models replied to Claude Code's own boilerplate (the list of agents and skills it prepends) instead of to the request.

What I measured, same request each time, "change the home page headline to X, nothing else", through the studio into the same repo. Local runs are on an RTX A2000 with 12 GB; the rest went through OpenRouter and cost $0.53 in total.

| Model | Route | What happened | Time |
| --- | --- | --- | --- |
| Claude Opus | subscription | changed the headline; also updated the test that checked the old one | 40 s |
| Kimi K2 | OpenRouter, paid | changed the headline | 27 s |
| GLM 4.6 | OpenRouter, paid | read the design guide first, then changed the headline | 37 s |
| Qwen3-Coder 480B | OpenRouter, paid | overrode the headline with a database migration instead of editing the copy file; valid in this project, and it followed the migration numbering | 141 s |
| Nemotron 3 Super 120B | OpenRouter, free | same migration route as above, correct | 48 s |
| DeepSeek V3.2 | OpenRouter, paid | wrote a migration against a table that does not exist; still running when I stopped it at 7 minutes | over 420 s |
| Nemotron 3 Ultra 550B | OpenRouter, free | the provider returned a malformed response; never got going | failed |
| Qwen 3.8 27B | OpenRouter, free | rate-limited by the provider before the first reply | failed |
| Qwen 3.6 35B-A3B | local, Ollama | changed the headline and ran the build, but put the words "nothing else" into the headline | 140 s |
| Qwen3-Coder 30B-A3B | local, Ollama | opened the right file, then summarised it instead of editing, twice | 35 s |
| Qwen 3.5 9B | local, Ollama | opened the right file, then described the change instead of making it | 30 s |

Three things I took from this. The hosted open models are usable: Kimi K2 and GLM 4.6 did the job faster than Opus and for a fraction of a cent, and a free 120B model got there too. The local models on a 12 GB card are not there yet for an instruction given by someone who does not code; the one that edited misread the instruction, and the two others lost the goal as soon as the first file came back. And only Opus noticed that the old headline was asserted in a test and fixed that as well, which is the kind of judgement you pay for on anything bigger than a one-line change.

## Setup

You need Node 22 or newer, git, the GitHub CLI signed in, Claude Code installed and signed in (or an `ANTHROPIC_API_KEY`), and a project with a dev server.

```sh
git clone https://github.com/Abhyuday98/greenroom && cd greenroom
cp example/greenroom.config.json . && cp example/models.json . && cp example/allowed.txt . && cp example/model.txt .
# edit greenroom.config.json (worktree path, base branch, preview command, tiers) and PROMPT.bare.md (your project map)

git -C /path/to/your-repo worktree add ../your-repo-playground -b playground origin/main
(cd ../your-repo-playground && npm ci)

node server.mjs                # http://127.0.0.1:4400; needs the identity header, or GREENROOM_DEV=1 to skip it locally
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4400
```

`example/greenroom.service` is a systemd user unit; enable linger so it survives logout. Add each person's login to `allowed.txt`, one per line. No restart needed.

## About the Claude subscription

If Claude Code on the machine is signed in with a personal subscription, that subscription is licensed to the account holder. When other people use your greenroom, run it on an API key (`ANTHROPIC_API_KEY` in the service file) or on a local model.

## Files

```
server.mjs        the server
index.html        the page
PROMPT.md         system prompt for Claude ({name} and {owner} are filled in)
PROMPT.bare.md    short prompt with a project map, for local and small models
example/          config, models, allow-list, model pick, systemd unit
```

`state.json` and `decisions.jsonl` are written next to the config at runtime. Keep them out of git.

MIT.
