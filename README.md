# Foreman

Task scheduling and agent coordination for Claude Code, with herdr as the place
where workers run and can be watched.

- **The task DB is the bus.** SQLite at `~/.foreman/foreman.db`, append-only
  `events` table plus materialised `tasks`, `steps`, `blocks`, `artifacts`.
- **`taskd` is the only thing that acts on it.** A deterministic scheduler with
  an HTTP API. No LLM runs inside it.
- **Workers are headless Claude Code runs.** One `claude -p` per pipeline step,
  in its own herdr tab, with a role prompt, a step prompt, a structured result
  schema, a deny list, and a turn and time budget. Orchestrators run Opus;
  `worker` and `explorer` subagents run Sonnet; a `consultant` subagent runs
  Fable for high-level judgement.
- **Nothing sits idle.** A worker that needs you calls `task block "<question>"`
  and exits. You answer from your assistant pane, and the scheduler resumes the
  same session with `--resume`.
- **Herdr is the viewport.** One workspace per project (`fm:<project>`), one tab
  per running step. Tabs close on success and stay open on failure or block so
  you can inspect them.

## Install

```sh
npm install -g bun            # if missing
ln -sf ~/git/foreman/bin/foreman ~/.local/bin/foreman
ln -sf ~/git/foreman/bin/task ~/.local/bin/task
foreman init                  # writes ~/.foreman/config.toml
```

Add projects to `~/.foreman/config.toml`:

```toml
[projects.dicer]
path = "~/git/dicer"
base_branch = "main"
verify = "browser"      # tests | browser | inspect
speckit = true
concurrency = 2
deny = ["Bash(supabase *)"]
notes = "Three.js app; run with bun dev on port 5173."
```

Run the scheduler in a herdr pane of its own:

```sh
foreman taskd
```

## Use

```sh
task create --project foreman --kind research --title "..." --brief "..."
task ls
task show T0001
task inbox                 # questions and gates waiting on you
task answer 3 "Use option B."
task approve T0007
task retry T0004 [--fresh]
task cancel T0004
```

Workers use the same CLI with `FOREMAN_TASK` and `FOREMAN_STEP` set:
`task note`, `task block`, `task artifact add`, `task show`.

Run artifacts live under `~/.foreman/runs/<task>/<step>-<attempt>/`:
`system.md`, `prompt.md`, `agents.json`, `command.txt`, `transcript.jsonl`,
`stderr.log`, `report.json`.

## Task kinds

| kind | pipeline | worktree |
|---|---|---|
| research | researcher writes `specs/research/<slug>.md` | no |
| design | architect writes `specs/design/<slug>.md` | no |
| triage | test analyst writes `specs/triage/<slug>.md` | no |
| implement | Spec Kit: specify, plan, plan QA, gate, implement, review and test loop, pr, gate, merge | yes (slice 3) |

Pipelines are data in `src/pipelines.ts`. Role prompts are in `roles/`, step
prompts in `prompts/`, and the worker protocol in `prompts/worker-preamble.md`.

## Guard rails

Workers run with permissions bypassed inside their checkout. The deny list is
the guard rail: push, merge, deploy, destructive git, sudo, and production
database commands are built in (`GLOBAL_DENY` in `src/config.ts`), and each
project can add more. Pushing, opening PRs, and merging are done by the
scheduler after your approval, never by a worker.

Resilience: each running step holds a lease refreshed by heartbeat. Lease
expiry, non-zero exit, timeout, or a `failed` result mark the step failed and
the scheduler retries, resuming the same session first, up to `max_attempts`,
then fails the task and notifies you. Every transition is an event row.

## Roadmap

1. ~~DB, CLI, taskd, one research task in a herdr tab~~
2. ~~Block and answer flow end to end~~ and ~~crash-recovery hardening (fencing, cancel on stale heartbeat, startup grace, result retry, transactions, resume in scheduler)~~
3. Worktrees and the Spec Kit implement pipeline with the QA loop, `open_pr` and `merge` system steps
4. Human gates polish, assistant `pa` skill, ticket provider adapters (`task ticket ...`)
5. Remote machines via `herdr --machine`
6. Retro loop over transcripts
7. TUI or web dashboard over the HTTP API

## Testing

`test/smoke.sh` runs an isolated taskd on port 7778 with `test/fake-claude.sh`
standing in for `claude` (set via `FOREMAN_CLAUDE_BIN`). It drives the happy,
blocked/answer/resume, crash/retry, and cancel paths through real herdr tabs
without calling a model.
