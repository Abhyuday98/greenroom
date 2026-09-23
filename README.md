# greenroom

A chat window into your codebase for someone who doesn't code.

They open a page on their phone, say what they want changed on the site in plain words, watch it happen in a live preview, and press **Send**. You get a pull request. Nothing reaches the live site until you merge it.

Built for a theatre in Kolkata whose founder wanted to change his own website without learning git. One Node file, no dependencies, runs on the machine where the repo lives.

## How it works

```
phone ──HTTPS + identity──▶ greenroom (this server) ──▶ claude -p in a sandboxed worktree
                                   │                        │  edits files, runs the build
                                   ├─ passes the dev server through as the preview
                                   └─ on Send: commit, push, `gh pr create`, reset the sandbox
```

- **The sandbox is a git worktree** of your repo on its own branch, with its own dependencies and its own local data. Claude Code runs there with an explicit tool allow-list: read, edit, build, test. No commit, no push, no deploy, no network, no secrets.
- **Identity comes from the network.** Put the server behind [Tailscale Serve](https://tailscale.com/kb/1312/serve) and it receives the visitor's Tailscale login as a header; behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) it receives their verified email. `allowed.txt` is the whole authorisation layer.
- **The preview is your normal dev server**, started in the sandbox and passed through greenroom's own address, so one published port is enough and live reload keeps working.
- **Send** commits everything on a timestamped branch, pushes, opens a PR with the request transcript and the file list, labels it with a change tier, then fast-forwards the sandbox to the base branch for the next idea. **Start over** throws the sandbox's changes away.
- **The sandbox keeps itself current.** Before a message (when nothing is waiting) and after every Send, it fast-forwards to the base branch, reinstalls if the lockfile changed, and runs whatever `sync.after` commands you give it, for example loading a snapshot of the production database. The preview always starts from what is actually live.

## The review gate

Every PR is classified by the files it touches, using globs you set:

| Tier | Meaning | Default policy |
| --- | --- | --- |
| `words` | copy and images only | eligible for auto-merge, off by default |
| `content` | plus data files such as migrations | review |
| `design` | plus styles, pages, components, layouts | review |
| `code` | anything else | review |

Flip `policy.autoMerge` on and PRs in `policy.autoMergeTiers` are queued to merge automatically once your CI is green (`gh pr merge --auto`; enable auto-merge in the repo settings). Every Send is appended to `decisions.jsonl` with the request, the files and the tier, and each sync fills in what the reviewer actually did, merged or closed. That file is a training set: after a few hundred rows you can fine-tune a small classifier such as [Laya](https://huggingface.co/convaiinnovations/laya) to predict "needs a human" from the request and the diff, and let it override the file rules when it is confident. Until then, the rules alone are honest and work.

## Any brain

Each turn runs `claude -p`, and Claude Code can be pointed at any Anthropic-compatible endpoint. `models.json` lists the choices and `model.txt` picks one, read on every message:

```json
"opus":  { "model": "opus" },
"local": { "model": "qwen3.6:35b-a3b", "baseUrl": "http://127.0.0.1:11434", "token": "ollama", "bare": true },
"kimi":  { "model": "kimi-k2-0905-preview", "baseUrl": "https://api.moonshot.ai/anthropic", "tokenEnv": "MOONSHOT_API_KEY", "bare": true }
```

`bare` runs Claude Code in its minimal mode with a named tool set and swaps in `PROMPT.bare.md`, a short prompt with a map of where things live in your project. Without it, small models answer the harness's own boilerplate instead of the request.

Measured on one machine (RTX A2000 12 GB) on the same request, "change the home page headline to X, nothing else":

| Brain | Result | Time |
| --- | --- | --- |
| Claude Opus | correct | ~40 s |
| Qwen 3.6 35B-A3B via Ollama, free | made the edit and ran the build; put "nothing else" into the headline | ~140 s |
| Qwen 3.5 9B via Ollama, free | read the right file, then described the change instead of making it | ~30 s |

So a free local brain is real for words and colours, with the owner checking the preview. Design and multi-file work is where the paid model earns its cost.

## Setup

Requirements: Node 22+, git, the [GitHub CLI](https://cli.github.com/) signed in, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in (or an `ANTHROPIC_API_KEY`), and your project's dev server.

```sh
git clone https://github.com/Abhyuday98/greenroom && cd greenroom
cp example/greenroom.config.json . && cp example/models.json . && cp example/allowed.txt . && cp example/model.txt .
# edit greenroom.config.json: playground path, base branch, preview command, tiers; PROMPT.bare.md: your project map

# the sandbox: a worktree of your repo, with its own install
git -C /path/to/your-repo worktree add ../your-repo-playground -b playground origin/main
(cd ../your-repo-playground && npm ci)

node server.mjs            # http://127.0.0.1:4400, identity header required (GREENROOM_DEV=1 to skip locally)

# publish on your tailnet with a certificate and identity headers
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4400

# keep it running: see example/greenroom.service (systemd --user; enable-linger so it survives logout)
```

Add each person's Tailscale login (or Access email) to `allowed.txt`, one per line. No restart needed.

## Security model, in one breath

Private network or Access gate in front; identity from that layer only; a sandbox the agent cannot leave; an explicit tool allow-list with pushes, deploys, deletes and network denied; every change as a reviewable PR; the reviewer merges. The worst case is a bad PR you close.

## The subscription question

Claude Code signed in with a personal subscription is licensed to the account holder. If other people will use your greenroom, run it on an API key (`ANTHROPIC_API_KEY` in the service file) or on a local model. This project takes no position beyond saying so plainly.

## Files

```
server.mjs              the whole server
index.html              the page (chat + preview, phone-first)
PROMPT.md               system prompt for full-size models ({name}, {owner} are filled in)
PROMPT.bare.md          short prompt with a project map, for local/small models
example/                config, models, allow-list, model pick, systemd unit
```

Runtime files next to the config: `state.json` (session id, current round, recent sends) and `decisions.jsonl` (the review log). Keep both out of git.

MIT.
