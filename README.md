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
  same session with `--resume`. A worker never ends its turn while something it
  started (a background job, a subagent, a device suite) is still running:
  under `claude -p` the end of the turn is the end of the run. taskd flags a
  failed step whose summary says work was still running with
  `step ended early (work still running?)` in `taskd.log` and the step error.
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
resource_groups = { devices = { members = ["ios-sim", "android-emu"], capacity = 1 } }   # one slot across both
device_steps = ["implement", "test"]      # steps the device lane governs (default when a group exists)
# device_steps_running = 2                # max device steps running at once (default: max capacity + 1)
step_timeouts = { implement = 120, test = 180 }   # minutes per step, overrides defaults
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
task inbox                 # questions, gates (approve or reject) and tasks being revised
task inbox --project foreman   # only that project's questions and gates
task answer 3 "Use option B."
task approve T0007
task reject T0007 "the retry path is missing"   # send a plan or merge back with feedback
task retry T0004 [--fresh]
task cancel T0004
task close T0015 --superseded-by T0019   # work shipped via another task
task create ... --branch <b> --start-at <step> --continues <id>   # continue a failed task
```

Workers use the same CLI with `FOREMAN_TASK` and `FOREMAN_STEP` set:
`task note`, `task block`, `task artifact add`, `task show`, `task ticket ...`,
`task lease [--expect <minutes>]`, `task release`, `task leases`.

### Superseded tasks

`superseded` is a terminal status for a task whose work another task finished;
`task cancel` reads as abandoned. A `failed`, `cancelled`, `gate` or `blocked`
task can be closed with `task close <id> --superseded-by <other>`. To recover
a task, use `task create --branch <b> --start-at <step> --continues <id>`, which
creates the successor and closes the old task in one step; `task close` is for
work that already shipped elsewhere. Closing stops running steps and releases
their leases but leaves the worktree and branch alone. `task ls --all` shows
`superseded→T0019`. A running taskd must be restarted to pick up the feature;
the `superseded_by` column is added by an additive migration on start.

### Tickets (Linear)

Set `[tickets.linear] api_key` (or `LINEAR_API_KEY` for taskd) and, per project,
`tickets = "linear"`, `ticket_team = "TAC"` and optionally
`ticket_states = { start = "In Progress", review = "In Review", done = "Done" }`.
Then `task create --project tackle-tally --kind implement --ticket TAC-130` takes
the title and brief from the ticket, and the scheduler comments on it when the
task starts, opens a PR, merges, or fails (transitioning to the configured
states). Workers see the ticket in their prompt and can
`task ticket show|comment|transition|create`; `task ticket ... --project <p>`
does the same from your shell. Only taskd holds the API key. Closing a task as
superseded posts no failure comment and moves no state; if the old task's
ticket differs from the successor's, it gets one comment, `Continued as <id>`,
and a shared ticket gets none.

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

### Dashboard

`foreman dashboard` opens a read-only web view. Cards start collapsed to one line: id, title, status, project · kind · cost · age, the current step or device lease, and a lead for gates, questions and failures. Click a row to expand it; open state is kept per browser (localStorage) across refreshes, and each section has Expand all / Collapse all.
An expanded card shows a Decision block, separate from the Activity block (step strip, notes). Merge gate: handoff.md Summary/Risk/Follow-ups, last review/test verdicts, QA rounds, cost. Plan gate: plan summary and plan-QA verdict, plus the remaining findings from qa/plan-review.md when plan QA still fails after max revisions. Question: full text and the `task answer` command. Failed: error, step/attempt and `task retry`.
The text is built by taskd and served as `decision` on `GET /tasks/:id` (`task show` prints it too). The dashboard never acts; `task approve/reject/answer/retry` do.

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

Plan QA works the same way: when `plan_qa` fails, the scheduler re-queues `plan`
with the findings as `QA_FEEDBACK` (summary, notes, and a pointer to
`specs/<feature>/qa/plan-review.md`) and runs `plan_qa` again. `max_plan_cycles`
(default 2, under `defaults`) is the number of plan QA reviews per round, unlike
`max_qa_cycles`, which counts revisions. If the last review still fails, the
task goes to the `plan_approved` gate anyway, labelled "plan QA still fails after
N review(s); see <feature_dir>/qa/plan-review.md". A plan QA fail never fails the
task or uses the retry budget; `task show` shows the plan cycles.

`task reject <id> "<feedback>"` works at the `plan_approved` and `merge_approved`
gates. It records the feedback as a note, re-queues `plan` (plan gate) or
`implement` (merge gate) with the feedback as `QA_FEEDBACK`, re-runs every step
up to the gate, and reopens the gate with the cycle counter reset. `task inbox`
lists such tasks under `revising:`, and `task ls` and the dashboard show
"rejected, revising". A running taskd must be restarted to pick this up:
`foreman service restart` (check `task ls --all` first).

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

### Step timeouts

Each step has a time budget. `[defaults] step_timeout_min` (default 90) is the
global one. `step_timeouts` maps a pipeline step name (`plan`, `plan_qa`,
`implement`, `review`, `test`, `handoff`, and so on; see `src/pipelines.ts`) to
minutes, under `[defaults]` (`step_timeouts = { test = 150 }`) and per project
(`[projects.<name>] step_timeouts = { implement = 120, test = 180 }`, or a
`[projects.<name>.step_timeouts]` sub-table). Resolution: project map, then
defaults map, then `step_timeout_min`. Values must be positive numbers; invalid
entries are dropped with a warning. A key that matches no pipeline step logs
`config: step_timeouts key '<k>' (<where>) matches no pipeline step` at taskd
startup.

The budget is resolved when the step launches and stored on the step row
(`timeout_min`), so a later config change does not move a running step. `task
show` prints ` budget=180min` on running steps; a step killed for time has the
error `timeout after 180 min`. Heartbeat and lease timings are unchanged. For
device and e2e suites, `implement` runs only the touched flows; the `test` step
runs the full per-flow suite and the cross-platform matrix once per QA cycle.

A running taskd must be restarted to pick up config changes:
`foreman service restart` (check `task ls --all` first so you do not restart
in the middle of a long step).

A running taskd must be restarted to pick up the early-end flag
(`foreman service restart`, check `task ls --all` first). Prompt changes apply
to the next step launched.

### Launch and leases

Launching a step and keeping its heartbeat lease are built to survive a slow
host and a Mac that sleeps. When a step is picked up, taskd marks it running and
records `launch_started_at`. At that point it gives the step a launch deadline
(`[defaults] launch_grace_sec`, default 600) instead of the heartbeat lease. The
herdr calls (workspace, `tab create`, `pane run`) then run outside the tick, so
heartbeats, lease grants and the API keep being served while a tab opens. The
launching step still counts toward concurrency. The heartbeat lease
(`lease_sec`) is armed when the launch returns or when the runner first checks
in, whichever comes first. The runner checks in with one heartbeat right after
it fetches its context, before it creates the run dir.

Each herdr CLI call has a timeout (`herdr_timeout_sec`, default 120). An attempt
whose runner never started fails with one of these errors:

- `runner never started: launch timed out after <N>s` (the launch did not return within the grace)
- `runner never started: <herdr error>`, such as `herdr tab create timed out after 120s`
- `runner never started: no check-in within <lease_sec>s of launch (launch took <M>s)`

These attempts do not count against `max_attempts`. taskd relaunches them with
the same session and resume prompt. Their own bound is `launch_attempts_max`
(default 3) in a row, counted since the last `task retry`. Once a step reaches
it, the task fails with `step '<name>' could not start a runner <N> times: …`. A
runner that checked in and then went quiet keeps the error `lease expired: runner
stopped heartbeating`, and that one counts.

If two ticks are more than `2 × heartbeat_sec` apart (host sleep, or a stalled
taskd), every running lease is extended by the gap before any lease is expired.
taskd logs `tick gap <N>s` and records a `taskd.stall` event. When a lease does
expire and the runner left no `report.json`, but `transcript.jsonl` ends with
the `result` event, taskd writes `report.json` from it
(`recovered_from: "transcript"`) and completes the step with its real summary,
cost and turns.

`task show` prints `runner seen <ago> ago` or `runner not seen yet (launch
started <ago> ago)` under each running step.

A running taskd must be restarted to pick this up (`foreman service restart`).
The restart is safe while steps run: the migration only adds columns, startup
extends every running lease, and runners started by the old taskd check in on
their next heartbeat.

### Costs

Claude's `total_cost_usd` is cumulative over a session, including across
`--resume`. Each step therefore stores the raw figure in `steps.session_cost_usd`
and its own share in `cost_usd`: the raw value minus the largest
`session_cost_usd` of an earlier attempt with the same session id (the full
value for a session's first attempt). A task's cost is the sum of its steps, so
resumed attempts no longer double count. Turns (`num_turns`) are per process and
are stored as reported.

A step that ends without a `result` (timeout or cancel, lease expired, tab
closed) is estimated from the Claude Code session log,
`~/.claude/projects/<slug of cwd>/<session id>.jsonl` (or
`$CLAUDE_CONFIG_DIR/projects/…`) plus its `subagents/` files: assistant
messages inside the attempt's window, deduplicated by message id, priced with
`[pricing]`. Estimated turns are the number of main-session API calls. The
runner computes the usage on its own machine and sends it with the report; for a
lease expiry on the local machine taskd reads the log itself. The log is only
read, and only its usage fields. Estimates show as `~$4.30` (and `~12t`) in
`task ls`, `task show`, `task watch` and the dashboard; a task total with any
estimated or unknown step shows `~$X`.

When no session log is found (no session id, a remote runner that sent no
usage) or a model has no price, the step records `cost_unknown = 1` and shows
`$?` rather than `$0.00`. Its session total stays at the previous attempt's, so
the next resumed attempt absorbs the cost and the task total stays right.

Prices are USD per million tokens, one table per model, merged over the
built-in defaults per key. A model id with a suffix (`claude-opus-5-5-2026…`,
`…[1m]`) uses the longest priced prefix:

```toml
[pricing."claude-opus-5-5"]
input = 4
output = 20
cache_read = 0.20
cache_write_5m = 5
cache_write_1h = 8
```

Defaults ship for opus-5-5, sonnet-5-5, haiku-5-5 and fable-5-1. The sonnet
`cache_read` default ($0.10) is the price measured from a real run's
`modelUsage.costUSD` (the T0039 fixture in `test/fixtures/costs/`), not the
published table; `test/costs.test.ts` checks the estimator against that run to
within 1 %.

`task ls` ends with today's totals, by `finished_at` on taskd's local day, from
`GET /costs/today`: `today: $12.34 (2 estimated) · foreman $10.00 · tackle-tally
~$2.34 (2 estimated)` (only the named project with `--project`; never with
`--json`). The dashboard header shows the same total.

The first taskd start after this change runs a one-off migration (meta key
`migration:cost_deltas_v1`, event `costs.migrated`): every step's old
`cost_usd` is copied to `session_cost_usd`, then steps sharing a session id get
their per-attempt deltas. Nothing is lost: the old figures stay in
`session_cost_usd`. History is not backfilled with estimates.

### Resource leases

A resource lease is an exclusive, named hold on a shared device (a simulator, an
emulator, a browser profile) so parallel workers take turns instead of fighting
over it. Workers use `task lease <name> [--wait N] [--expect <minutes>] [--reason ..]`,
`task release <name>` and `task leases`.

- The key is project + machine (the step's herdr machine, or local) + resource.
  First come, first served. Holders and the queue are persisted in SQLite
  (`resource_leases`); grants happen on request, on release, and every tick.
- A lease is released automatically when the step ends (done, failed, blocked,
  heartbeat lease expired, task cancelled, superseded or failed), plus a sweep each tick.
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

#### Device lane

Resource groups turn per-device leases into a lane with a capacity.

- A group (`resource_groups`) has `members` and a `capacity`. A step holding
  any member takes one slot, however many members it holds. Per-resource
  exclusivity is unchanged. A resource in no group is an implicit group of
  capacity 1, which is the old behaviour. Groups are scoped per project and
  machine.
- `device_steps` names the steps that use the lane (default `implement` and
  `test` when a group exists). `device_steps_running` caps how many of them run
  at once (default: largest capacity + 1, so one can be preparing while others
  hold devices). `concurrency` still bounds all steps. Device-free steps are
  never held by the lane.
- Grant order: tasks are ranked by their head waiter: `test` before
  `implement` before other steps, then higher `qa_cycles`, then older request.
  Within a task, FIFO. Grants are greedy: a free slot goes to the next waiter
  that fits.
- Dispatch preference: a queued device step is held (event `step.deferred
  {step, reason}`) when `device_steps_running` is reached (`device_limit`),
  when the lane is full with waiters and the free step slots are needed by
  queued device-free steps (`lane_busy`), or when a better-ranked queued device
  step would take the last device slot (`ranked_behind`). Ranking is task
  priority, then the grant ranking.
- `--expect <minutes>` is stored on the lease. Asking again updates it and
  re-arms `lease.overdue`. Overdue uses it, else `lease_max_minutes`. Waiters
  get an ETA computed from the holders' remaining expected time.
- `task leases` prints a block per lane, for example
  `tackle-tally local devices (capacity 1, device steps 2/2 running)`.
  `task ls` shows `waiting for devices (2nd)` for a step queued on the lane and
  `queued: device lane` for a step held at dispatch.
- Starvation bound: an implement waits behind tests only while tests keep
  arriving, which is bounded by the number of tasks in QA.
- `GET /lanes?project=` returns the lanes with holders, waiters and ETAs.

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
9. Runner: end the step when the `result` event arrives, instead of waiting for `claude -p` to exit. A worker that leaves background shell jobs running (emulator wait loops, Maestro) keeps the process alive until `step_timeout_min`, so a finished step is reported as a timeout. Seen three times on T0006 (attempts 7–9). Kill the process after a short grace period once the structured output is in.
9. ~~Resource leases: workers take turns on shared devices (`task lease`)~~
10. ~~Pipeline: a `plan_qa` verdict of `fail` currently falls through to the `plan_approved` gate, so the user is asked to approve a plan the reviewer rejected (T0020, 2026-10-30; worked around by cancelling and re-creating with `--branch <b> --start-at plan`). Make `plan_qa` an `on_fail → plan` loop like QA → implement, with its own cycle budget, and surface the findings at the gate if the budget runs out.~~
11. Runner liveness under host overload: on 2026-10-31 the load average hit ~590 (orphaned Jest workers, two Metros, Maestro, emulator and simulator from concurrent workers) and three implement attempts of T0021 were failed with "runner stopped heartbeating" although the workers were alive; the retry budget was burnt by the environment, not the work. Fixes to weigh: heartbeat by pid liveness as well as HTTP; scale the lease window with load; have the runner kill its process group on exit so Metro/Jest children never outlive the step; pause dispatch while load is above a threshold; count a heartbeat-expiry failure separately from a work failure so it does not consume the 3-attempt budget.
12. ~~Task lifecycle: no way to mark a failed task as superseded. T0015 failed at merge (rebase conflict), the work shipped via T0019 on the same branch, and the only option was `task cancel`, which reads as abandoned. Add `task close <id> --superseded-by <id>` (status `superseded`, shown in `ls --all` with the pointer), and have `task create --branch <b>` offer to link the task it continues.~~

## Testing

`bun test` runs `test/leases.test.ts`, the lease policy against a temp store,
`test/lane.test.ts`, the pure lane policies and `parseLane`, and
`test/lane-cli.test.ts`, the CLI rendering of lanes. `test/costs.test.ts` covers
the session-log estimator (against the stripped T0039 fixture), pricing and the
cost formats, `test/cost-migration.test.ts` the one-off cost migration on an
old-schema DB, `test/cost-accounting.test.ts` the per-attempt deltas, kill and
lease-expiry estimates and `/costs/today`, and `test/cost-cli.test.ts` the cost
cells and the `today:` footer.

`test/smoke.sh` runs an isolated taskd on port 7778 with `test/fake-claude.sh`
standing in for `claude` (set via `FOREMAN_CLAUDE_BIN`). `test/fake-gh.sh` stands in for `gh` and `test/fake-linear.ts` for Linear's API. It drives the happy,
blocked/answer/resume, crash/retry, cancel, taskd-outage, and both implement
pipelines (with a QA failure cycle, PR, and merge into a local bare remote)
through real herdr tabs without calling a model.
