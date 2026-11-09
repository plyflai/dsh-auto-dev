# dsh-auto-dev

**Your production-grade dev team for DeepSeek Harness.**

Vibe coding makes fast fashion: use it once, throw it away. dsh-auto-dev ships products you can launch and maintain.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** · [简体中文](./README.zh-CN.md)

**Targets the Web UI of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.1.**

![A finished task: the delivery report on the left, the dev progress board on the right](docs/images/hero.png)

## Why not just vibe code

### 1. Full-stack dev team: one request covers frontend, backend, database and tests
- **Vibe coding:** one model writes code; you babysit everything else.
- **dsh-auto-dev:** a whole dev team. Production-grade results, no coding skills required.

### 2. Test-driven delivery: a product you can launch, not a one-off demo
- **Vibe coding:** works in the demo, breaks on real data.
- **dsh-auto-dev:** best practices, fully tested, reproducible and stable.

### 3. Senior engineering playbook: senior experience, every time
- **Vibe coding:** quality depends on the model's mood that day.
- **dsh-auto-dev:** debugging, review, release, plus best practices for major languages and platforms — the right method for each situation.

### 4. Cross-session task state: days of work, many chats, nothing lost
- **Vibe coding:** long chats forget; every new chat starts from zero.
- **dsh-auto-dev:** switch chats, come back tomorrow, hand it to a teammate — pick up where you left off.

### 5. Dev progress UI: see where things stand, skip the essays
- **Vibe coding:** scroll through hundreds of lines to guess how far it got.
- **dsh-auto-dev:** one board — what's done, what's left, what's waiting on you.

### 6. Project knowledge base: it gets to know your project
- **Vibe coding:** every chat is a first meeting; the same pitfall, ten times.
- **dsh-auto-dev:** pitfalls, environment and business rules are recorded automatically and reused next time.

### 7. Requirement clarification: it asks before it guesses
- **Vibe coding:** starts on a one-liner, builds the wrong thing.
- **dsh-auto-dev:** it reads the code before touching anything and registers the task only once the request is clear. Small requests it restates as requirements; product-level or multi-part ones it first breaks down into one professional objective (O — with better approaches and the unknowns you may not have considered) and a few steps (KRs), shows you that plus anything you need to decide, and starts only once you say go; technical details it decides itself. Turn on **autopilot** and it never waits: it picks the best approach, does the work, and lists every decision it made without you at hand-in.

### 8. Rolling Git checkpoints: save before every boss fight
- **Vibe coding:** one slip and your code is gone.
- **dsh-auto-dev:** saves when you start, before a fix and after it passes; roll back anytime. Hard resets, force-pushes, publishing and deploys always need you to click yes first — even on autopilot.

## Install

```sh
git clone https://github.com/plyflai/dsh-auto-dev.git
dsh plugin --profile <profile> add ./dsh-auto-dev
```

Restart DSH afterwards. No runtime dependencies; works out of the box.

## Quick start

In any chat, start with `/dsh-auto-dev` and say what you want:

```
/dsh-auto-dev add a search command to the notes CLI. Done when `notes search milk` finds "buy milk".
```

That's it. Planning, coding, testing and delivery are on it; when a decision is yours, it stops and asks.

Away from the keyboard? Start it on autopilot:

```
/dsh-auto-dev start --auto add a search command to the notes CLI.
```

Continuing tomorrow in a new chat:

```
/dsh-auto-dev adopt
```

Chats that never use `/dsh-auto-dev` are left completely alone.

## Dev progress UI

![Receipts in the conversation](docs/images/conversation.png)

- **Receipts**: a card in the chat at every milestone — started, unit done, blocked, waiting for you, delivered.
- **Dock**: one line above the input — how far the task is and whether it needs you.
- **Board**: the *Auto Dev* right panel — goal, acceptance criteria, what is still unverified, the latest result, the engineering log.

## Commands

| Command | |
| --- | --- |
| `start <request>` | Start work, or pick up this project's unfinished task (`start --auto <request>` starts on autopilot) |
| `new <request>` | Always open a new task |
| `status` | Current task, progress, what is pending |
| `tasks` | Recent tasks in this project |
| `adopt [taskId]` | Continue a task from another chat |
| `pause` · `resume` · `cancel` | Change the task's state |
| `auto on` · `auto off` | Autopilot for this task: on, it never waits for you and lists its unconfirmed decisions at hand-in; irreversible steps are still left to you |
| `organize` | Propose a cleanup of a long plan; nothing changes until you agree |
| `plan` · `help` | How to begin |

All are `/dsh-auto-dev <command>`; plain text after `/dsh-auto-dev` means `start`.

## Project knowledge base

Kept in your project's `.auto-dev/` as plain files you can read and edit:

| File | What it holds |
| --- | --- |
| `incidents.md` | Postmortems: symptom, directions tried, root cause, fix, how it was verified (required after a fix; at most 30 entries) |
| `project-domain.md` | Business rules: terms and the rulings you made |
| `memory.json` · `runtime.json` | Pitfalls and observed environment facts (with source and expiry) |

Their text goes to the model at every start. Commit them to share with your team, or add `.auto-dev/` to `.gitignore`. Task progress lives in DSH's own storage.

Experience across projects lives in `~/.dsh-auto-dev/`:

| Path | What it holds |
| --- | --- |
| `incidents/<project>.md` | A copy of each project's postmortems at hand-in; another project's start carries the newest entry of the 3 most recent projects (at most 20 projects kept) |
| `conventions.md` | Team conventions you write yourself (naming, style…), carried verbatim at every start; the project's own conventions win on conflict |

`DSH_AUTO_DEV_HOME` moves this location.

## Checkpoints and rollback

- Checkpoints are Git-based (under `refs/dsh-auto-dev/`) and never move your HEAD, branch or index. Each task keeps its latest 5; the repository keeps the saves of the latest 3 tasks, the rest is left to `git gc`.
- Rollback restores Git-tracked files only, and every rollback needs your click. Untracked files, databases and running services are not covered.
- Only four gates ever stop the model; everything else is a reminder:
  - **Honest delivery**: no passing project check after the last change — the plugin runs it itself and refuses only if it is red;
  - **Destructive commands**: `git reset --hard`, `git clean -f`, force-push, `branch -D`, `stash drop`, any `publish`, terraform / kubectl / helm, `vercel --prod`, `fly deploy`, `gh release create` run only after you click yes — on DSH's own approval card when the session asks for approvals, otherwise on a two-option question card. Typed words are never read as a yes; on autopilot these steps are skipped and listed for you;
  - **Your bans**: a place you said not to touch is refused; lifting a ban takes the same click;
  - **Postmortem on disk**: a bug was fixed but `incidents.md` did not change — the hand-in is refused once.
- Commands outside that list, such as `rm -rf` or SQL, are not stopped; checkpoints and the "deleted · still referenced" card are the safety net.

## For developers

In chats that opted in, the model gets eight tools:

| Tool | Purpose |
| --- | --- |
| `work_start` | Register the task once the request is clear, in the model's own restatement (your words and replies are kept beside it; if the model edits files first, the plugin registers your words for it) |
| `work_plan` | Optional units, dependencies and grouping |
| `work_submit` | Hand in a result tied to real executions from this session |
| `work_status` | Read the task, its executions and the board |
| `work_control` | Pause, accept, rework, hand off, checkpoints, notes |
| `work_extend` | For things that need your OK: tells the model what to ask you (it never grants anything itself) |
| `work_env` | Facts about the environment, with their source |
| `work_recall` | Postmortem knowledge base: list every incident title (this project and others), or search entries by words |

The engineering playbook lives in [skills/auto-dev](skills/auto-dev/SKILL.md).

Local development needs Node.js ≥ 20:

```sh
npm install
npm run check          # unit tests + end-to-end scenarios against the real plugin
npm run build:client   # rebuild lib/client.js after editing src/client.js
npm run hooks:install  # run the check before every commit
```

Host-side changes need a DSH restart; client changes need a page refresh.

## License

[MIT](LICENSE)
