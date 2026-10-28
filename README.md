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
resources = ["ios-sim", "android-emu"]   # shared devices workers lease
lease_max_minutes = 45                    # flag holds longer than this
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
task log T0001 [research] [--attempt N] [--tail N]   # what the worker did
task inbox                 # questions and gates waiting on you
task answer 3 "Use option B."
task approve T0007
task retry T0004 [--fresh]
task cancel T0004
```

Workers use the same CLI with `FOREMAN_TASK` and `FOREMAN_STEP` set:
`task note`, `task block`, `task artifact add`, `task show`, `task ticket ...`,
`task lease`, `task release`, `task leases`.

### Tickets (Linear)

Set `[tickets.linear] api_key` (or `LINEAR_API_KEY` for taskd) and, per project,
`tickets = "linear"`, `ticket_team = "TAC"` and optionally
`ticket_states = { start = "In Progress", review = "In Review", done = "Done" }`.
Then `task create --project tackle-tally --kind implement --ticket TAC-130` takes
the title and brief from the ticket, and the scheduler comments on it when the
task starts, opens a PR, merges, or fails (transitioning to the configured
states). Workers see the ticket in their prompt and can
`task ticket show|comment|transition|create`; `task ticket ... --project <p>`
does the same from your shell. Only taskd holds the API key.

### Merge modes

`merge = "pr"` (default): the pipeline pushes the branch, opens a PR from
`handoff.md`, waits for `task approve`, then squash-merges. `merge = "direct"`:
after QA passes the scheduler rebases and merges onto the base branch (one
squash commit, or `merge --no-ff` with `squash = false`), pushes, fast-forwards
your main checkout, and removes the worktree and branch. Add `merge_gate = true`
to wait for your approval first. The handoff step (plain-language summary and
verify steps, posted to the ticket) runs whenever there is a gate or a ticket.

Worktrees share the main checkout's Claude Code auto-memory
(`~/.claude/projects/<key>/memory` is symlinked), so workers read and extend
the project's accumulated knowledge.

### Running taskd as a service

`foreman service install` writes a launchd agent (`com.foreman.taskd`) that
starts taskd at login, restarts it if it dies, and logs to `~/.foreman/taskd.log`.
`foreman service status|restart|stop|uninstall` manage it. Workers still run in
herdr tabs; taskd only needs the herdr socket, git, gh, and bun.

Run artifacts live under `~/.foreman/runs/<task>/<step>-<attempt>/`:
`system.md`, `prompt.md`, `agents.json`, `command.txt`, `transcript.jsonl`,
`stderr.log`, `report.json`.

## Task kinds

| kind | pipeline | worktree |
|---|---|---|
| research | researcher writes `specs/research/<slug>.md` | no |
| design | architect writes `specs/design/<slug>.md` | no |
| triage | test analyst writes `specs/triage/<slug>.md` | no |
| implement | Spec Kit project: specify, plan, plan QA, **gate**, implement, review and test loop, pr, open PR, **gate**, merge | yes |
| implement (project without Spec Kit) | plan, **gate**, implement, review and test loop, pr, open PR, **gate**, merge | yes |

For `implement`, the scheduler creates the worktree at
`~/git/.worktrees/<project>/<branch>` from the project's `base_branch`, allocates
the Spec Kit feature number from the DB (so parallel features never collide),
seeds `specs/NNN-name/spec.md` from the template, and exports `SPECIFY_FEATURE`
to the workers. The `pr` step writes `specs/<feature>/pr.md`; the scheduler then
pushes the branch and opens the PR with `gh`. After `task approve` at the merge
gate it squash-merges, deletes the branch, and removes the worktree. QA can send
the task back to `implement` up to `max_qa_cycles` times; the failed review and
test summaries are injected into the next implement prompt.

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

### Resource leases

A resource lease is an exclusive, named hold on a shared device (a simulator, an
emulator, a browser profile) so parallel workers take turns instead of fighting
over it. Workers use `task lease <name> [--wait N] [--reason ..]`,
`task release <name>` and `task leases`.

- The key is project + machine (the step's herdr machine, or local) + resource.
  First come, first served. Holders and the queue are persisted in SQLite
  (`resource_leases`); grants happen on request, on release, and every tick.
- A lease is released automatically when the step ends (done, failed, blocked,
  heartbeat lease expired, task cancelled or failed), plus a sweep each tick.
- `--wait` exits with code 3 when the wait runs out; the worker keeps its place
  in the queue and runs the command again.
- Holds longer than `lease_max_minutes` (default 45) raise a `lease.overdue`
  event and a dashboard highlight. They are not released.
- Not the heartbeat lease (`lease_sec`) and not `concurrency`: `concurrency`
  still limits steps, leases limit devices.
- Developer and test-analyst prompts get a "Shared devices" paragraph when the
  project declares `resources` or verifies in a browser (implicit `browser`).
  Undeclared names are granted with a warning.
- Events: `lease.requested`, `lease.granted`, `lease.released`, `lease.overdue`.

A running taskd must be restarted to pick this up: `foreman service restart`.

## Roadmap

1. ~~DB, CLI, taskd, one research task in a herdr tab~~
2. ~~Block and answer flow end to end~~ and ~~crash-recovery hardening (fencing, cancel on stale heartbeat, startup grace, result retry, transactions, resume in scheduler)~~
3. ~~Worktrees and the Spec Kit implement pipeline with the QA loop, `open_pr` and `merge` system steps~~ (real run T0002 verified 2026-10-28)
4. ~~Linear ticket adapter (`task ticket ...`, scheduler hooks), direct merge mode, launchd service~~; assistant skill polish
5. Remote machines via `herdr --machine`
6. Retro loop over transcripts
7. ~~Web dashboard over the HTTP API~~ (`foreman dashboard`)
8. Merge conflicts: when the rebase in `merge_direct` conflicts, insert a developer `resolve` step (rebase, resolve, run the suite) and retry the merge, instead of failing the task (seen on T0004 after 026 landed first)
9. ~~Resource leases: workers take turns on shared devices (`task lease`)~~

## Testing

`bun test` runs `test/leases.test.ts`, the lease policy against a temp store.

`test/smoke.sh` runs an isolated taskd on port 7778 with `test/fake-claude.sh`
standing in for `claude` (set via `FOREMAN_CLAUDE_BIN`). `test/fake-gh.sh` stands in for `gh` and `test/fake-linear.ts` for Linear's API. It drives the happy,
blocked/answer/resume, crash/retry, cancel, taskd-outage, and both implement
pipelines (with a QA failure cycle, PR, and merge into a local bare remote)
through real herdr tabs without calling a model.
