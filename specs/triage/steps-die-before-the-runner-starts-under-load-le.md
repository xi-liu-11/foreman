# Triage T0053: steps die before the runner starts under load; killed runs record $0 / 0 turns

Date: 2026-11-05. Read-only investigation: `sqlite3 -readonly ~/.foreman/foreman.db`, `~/.foreman/taskd.log`, `~/.foreman/runs/`, the Claude Code session logs under `~/.claude/projects/`, and `pmset -g log`. No code was changed, taskd was not restarted, and no tackle-tally worktree was touched.

All times are UTC. taskd.log is in UTC; run-dir mtimes are local time (UTC+10).

## Summary

| # | Case | Root cause | Fix |
|---|------|-----------|-----|
| 1a | T0049 triage#1, #2 | `tryLaunch` starts the 150 s lease **before** the herdr calls, then spends 4–6 min inside `herdr` CLI calls under load. The lease has already lapsed when the tab exists, and the next tick expires the step and closes the tab before the runner reaches `mkdir runDir`. | Arm the lease only after the launch returns, put timeouts on herdr calls, have the runner check in at once, and classify "never started" separately. A never-started attempt does not count against `max_attempts`. |
| 1b | T0037 plan#2 (also T0036 implement#1) | **A different cause.** The Mac went into clamshell sleep from 00:56:43 to 01:03:51. The leases passed in wall-clock time while everything was suspended, and the first tick after wake expired two live runners. plan#2 had in fact **finished successfully** (a `result` event in the transcript, $2.74, 36 turns), but the tab was closed before `report.json` was written. | Detect a jump in tick time (sleep or stall) and extend all running leases, as startup does (R3). |
| 2 | T0039 / T0043 implement#2 | When the runner kills claude, no `result` event arrives, so `handleResult` stores `total_cost_usd ?? 0`. **A second problem showed up:** `total_cost_usd` is **cumulative across `--resume`**, so resumed attempts over-report. | Compute cost from the Claude Code session log (exact token counts), store deltas rather than cumulative totals, and show "unknown" when no estimate exists. |

---

## Symptom 1a: the runner never starts (T0049)

### Evidence (DB + log + events)

| | triage#1 (step 479) | triage#2 (step 480) | triage#3 (step 481) |
|---|---|---|---|
| `step.queued` | 23:35:28.1 | 23:48:31.1 | 23:56:12.3 |
| `steps.started_at` (lease clock starts) | **23:41:59.9** | **23:48:37.4** | 23:56:18.2 |
| `steps.lease_until` (final) | 23:44:29.9 = started_at + 150 s | 23:51:07.4 = started_at + 150 s | — |
| log `started … (herdr tab)` / `step.started` | **23:46:23.3** | **23:54:39.3** | 23:56:35.0 |
| time inside herdr calls | **4 m 24 s** | **6 m 02 s** | 17 s |
| log `lease expired` / `step.lease_expired` | 23:46:33 / 23:46:34.2 | 23:54:44 / 23:54:44.7 | — |
| run dir `~/.foreman/runs/T0049/triage-N` | **absent** | **absent** | present |
| cost / turns | 0 / 0 | 0 / 0 | $1.34 / 36 |

- In both failed attempts `lease_until` is exactly `started_at + 150 s`, so **no heartbeat ever arrived**.
- When `started` was logged, the lease was already 1 m 54 s (#1) and 3 m 32 s (#2) overdue. The next tick expired the step 5–10 s later.
- Load at the time: T0043 test#2 logged a note at 23:53:21 that reads "load avg ~77 from 046's xcodebuild". That falls inside triage#2's 6-minute launch.
- The same event shows taskd's HTTP server was still answering requests during the launch. So the event loop was not frozen; the **tick** was the thing waiting on the herdr child processes.
- Today, with load average about 11, `herdr workspace list` takes 0.12 s. The minutes-long cost is specific to heavy load.
- The 6.5-minute queue wait before #1 (23:35 to 23:41) is ordinary concurrency: 3 steps were running. T0040 review#1 reported at 23:41:31, but its log line only appears at 23:42:06 because `handleResult` awaits herdr notify/close under the same load.

### Code path

1. `src/taskd.ts:402`: `tryLaunch` sets `status:"running", started_at: now(), lease_until: now + lease_sec` **before** any herdr work.
2. `src/taskd.ts:420-421`: `await herdr.ensureWorkspace(...)` and then `await herdr.launchInTab(...)`. That is three or four sequential `herdr` CLI processes:
   - `workspace list`, and `workspace create` if the workspace is missing (`src/herdr.ts:23-36`);
   - `tab create` (`src/herdr.ts:42-44`);
   - `pane run` (`src/herdr.ts:48`).

   `run()` (`src/herdr.ts:9-14`) has **no timeout**.
3. `src/taskd.ts:130-131`: the tick is non-reentrant (`if (ticking) return`). Because `tryLaunch` runs inside `advance`, inside `tick`, **the whole scheduler stalls during the launch**: no expiry, no other launches. The 2 s `setInterval` (`src/taskd.ts:977`) just returns early.
4. `src/taskd.ts:432`: the `started` line is logged. The tick then finishes; the next tick runs `expireLeases` (`src/taskd.ts:106-128`). There `lease_until < now`, and no `report.json` exists, so:
   - the step is failed with `"lease expired: runner stopped heartbeating"` (`:122`);
   - `herdr.closeTab` (`:126`) kills the pane that was just launched.
5. Meanwhile the runner (`src/runner.ts:20-25`) must first start Bun and then `GET /steps/:id/context`. That call runs `stepContext`, which can make a **Linear API call** (`fetchTicket`, `src/taskd.ts:560`; T0049 has ticket TAC-169). Only after that does it `mkdirSync(runDir)`. The tab was closed 5–10 s after `pane run` returned, before the runner got that far. **That is why no run dir exists.**
6. Even with no expiry, the runner's first heartbeat comes only after `heartbeat_sec` (30 s), because `setInterval` does not fire immediately (`src/runner.ts:102-107`). It is also armed only after the `/context` round trip and the claude spawn. Under load the real "first sign of life" margin is much smaller than 150 s.
7. `failureCount` (`src/taskd.ts:94-102`) counts every `failed` row. `settle` (`src/taskd.ts:361`) fails the task once `failures >= max_attempts` (3). Two never-started attempts therefore left T0049 one launch hiccup away from failing outright.

### Reproduction (inspect mode)

The following queries reproduce the evidence table from the live DB and log. They are read-only.

```sh
sqlite3 -readonly ~/.foreman/foreman.db \
  "select id,attempt,started_at,lease_until,finished_at,cost_usd,turns,error from steps where task_id='T0049'"
sqlite3 -readonly ~/.foreman/foreman.db \
  "select ts,step_id,type from events where task_id='T0049' order by id"
grep -n 'T0049' ~/.foreman/taskd.log
ls ~/.foreman/runs/T0049/          # only triage-3
```

The live mechanism was not reproduced, because taskd may not be restarted in this task. A deterministic test for the implement step:
- set `FOREMAN_CLAUDE_BIN` to a stub and put a fake `herdr` on PATH that sleeps 200 s on `tab create`;
- set `lease_sec = 150`;
- launch one step. The current code fails it with "stopped heartbeating", and the run dir is absent.

The same effect without herdr: inject a delay before `Bun.spawn` in the fallback branch.

### Observed vs expected

- **Observed:** the attempt is failed as "lease expired: runner stopped heartbeating", with $0 and 0 turns. It counts toward `max_attempts`, and the scheduler is frozen for the length of the launch.
- **Expected:** a slow launch is not a heartbeat failure. The lease clock starts when the runner can actually heartbeat. A launch that genuinely never produces a runner is reported as "runner never started" and does not use up the retry budget, though a bound still applies.

## Symptom 1b: the leases lapse during system sleep (T0037 plan#2, T0036 implement#1)

This case was reported with the same text, but the cause is different.

- T0037 plan#2 (step 354): started 00:49:04 and heartbeated normally. `lease_until` is 00:59:07, so the last heartbeat was at 00:56:37. A `task note` arrived at 00:56:49.
- T0036 implement#1 (step 350): the last heartbeat was also at 00:56:35 (`lease_until` 00:59:05). **Two independent runners stopped in the same second.**
- `pmset -g log`:
  - 10:56:43 +1000 (00:56:43Z): `Entering Sleep state due to 'Clamshell Sleep'`
  - 11:03:51 +1000 (01:03:51Z): `DarkWake to FullWake`
- The transcript (`runs/T0037/plan-2/transcript.jsonl`) jumps from `00:56:49` to `01:04:22`. Its last line is `{"type":"result","subtype":"success","num_turns":36,"total_cost_usd":2.738647}`, preceded by a `StructuredOutput` with `status: "done"`.
- The first ticks after wake expired T0036 at 01:04:03 and T0037 at 01:04:18. They were 15 s apart because `expireLeases` awaits each `closeTab` in turn. The tab was closed before the runner could write `report.json`, so a finished $2.74 plan revision was thrown away. plan#3 then redid it ($0.46).

**Root cause:** `expireLeases` compares `lease_until` with wall-clock `now()`. A host sleep counts as missed heartbeats. Startup already guards against a long taskd outage (R3, `src/taskd.ts:963-967`), but nothing guards against suspension or a stall while taskd keeps running.

## Proposed fix for symptom 1

1. **Arm the lease when the runner can heartbeat, not when taskd decides to launch** (`src/taskd.ts:402`).
   - When marking the step running, set a launch deadline instead of the heartbeat lease: `lease_until = now + launch_grace_sec`. The new config key `launch_grace_sec` defaults to 600.
   - After the herdr calls return (`:422`), set `lease_until = now + lease_sec` again.
   - This one change alone would have saved both T0049 attempts.
2. **The runner checks in immediately** (`src/runner.ts`).
   - Treat `GET /steps/:id/context` as a heartbeat: taskd sets `lease_until` and a new `steps.runner_seen_at`.
   - Send one `POST /heartbeat` straight after the claude spawn, before the `setInterval`.
   - Move `mkdirSync(runDir)` before the `/context` call (the path is known from env/step id), so even a killed launch leaves a trace (`console.log`).
3. **Bound herdr calls** (`src/herdr.ts:9`). Add a timeout to `run()`: 120 s by default, configurable. Kill the child on expiry and throw. The existing `catch` in `tryLaunch` (`:433-436`) then records `launch failed: …`.
4. **Do not stall the scheduler on launch.** Make the herdr part of `tryLaunch` fire-and-forget, keyed by step id in a `launching` set:
   - mark the step running and armed with the launch deadline inside the tick;
   - run the herdr calls outside it.

   This stops one slow launch from blocking expiry and the other projects for minutes. It is optional but recommended, and the largest piece of the change.
5. **Classify never-started attempts.** In `expireLeases` (`:121-122`), if `runner_seen_at IS NULL`, record:

   > `runner never started: no check-in within <N>s of launch (herdr launch took <M>s)`

   Otherwise keep `lease expired: runner stopped heartbeating`.

   For the `launch failed: …` path, prefix the message with `runner never started: launch failed: …`.
6. **Do not count never-started attempts against `max_attempts`.** In `failureCount` (`:94-102`), skip failed rows with `runner_seen_at IS NULL`. Bound them separately so a broken herdr or claude binary cannot loop forever:
   - after 3 consecutive never-started attempts of the same step, fail the task with `step '<name>' could not start a runner 3 times: <last error>`;
   - optionally back off 60 s between relaunches while load is high.

   When resuming, keep `resume_prompt = null` for never-started attempts: there is no session to resume, and `session_id` is carried over unchanged.
7. **Survive sleep and stalls (1b).** Record the wall time of each tick. If the gap since the previous tick is more than `max(30 s, lease_sec / 2)`, then before expiring anything:
   - extend every running lease by `lease_sec`;
   - log `tick gap <N>s (host sleep or stall): extended <k> lease(s)`, as startup does.
8. **Recover a finished result from the transcript.** In the `expireLeases` fallback (`:110-120`), if there is no `report.json` but `transcript.jsonl` ends with a `result` event, build the report from it (`killed: null`) and apply it. That would have saved T0037 plan#2 even without fix 7.

### Error text for the dashboard

- `runner never started: no check-in within 600s of launch (herdr launch took 412s)`
- `runner never started: launch failed: herdr tab create timed out after 120s`
- Unchanged for real heartbeat loss: `lease expired: runner stopped heartbeating`
- Task-level, when the separate bound trips: `step 'triage' could not start a runner 3 times: <last error>`

Suggested event type: `step.never_started` (alongside `step.lease_expired`), so the dashboard can label and filter it.

---

## Symptom 2: killed runs record $0 / 0 turns, and resumed runs over-report

### Evidence

- `runs/T0039/implement-2/report.json` and `runs/T0043/implement-2/report.json` both contain `killed: "timeout after 120 min"`, `exit_code: 143` and `result: null`.
- `handleResult` (`src/taskd.ts:530`) stores `Number(r.total_cost_usd ?? 0)` and `Number(r.num_turns ?? 0)`, which gives 0 and 0.
- Task cost in `task ls` and the dashboard is `sum(steps.cost_usd)` (`src/taskd.ts:646`, shown at `cli.ts:133`, `dashboard.html:105`).

### Is the data available?

**The stream-json transcript (`runs/…/transcript.jsonl`)** is only a partial source.
- Every top-level `assistant` event carries `message.id` and `message.usage`. Input, cache-read and cache-write counts are correct.
- `output_tokens` is the message_start value, so it is truncated: 1,615 versus the true 39,634 for T0039 implement#2.
- Subagent API calls do not appear at all.
- Unique `message.id` count = API calls (110 for T0039 implement#2, 30 for T0043 implement#2). That is a usable "turns" estimate.

**The Claude Code session log (`~/.claude/projects/<cwd-slug>/<session_id>.jsonl`, plus `<session_id>/subagents/agent-*.jsonl`)** is exact.
- Dedupe assistant rows by `message.id` (the last row wins) and sum `usage`, restricted to `[started_at, finished_at]`.
- For T0039 implement#1 this reproduces the `result.modelUsage` token counts **exactly**: opus input 300, output 102,298, cache-read 30,182,703, cache-write 289,646. Subagent files carry the sonnet usage.
- The session id is already known (`report.session_id`), and so is the cwd (task worktree).

Token totals for the killed runs, from the session log:

| step | API calls | input | output | cache read | cache write (1h) | rough cost* |
|---|---|---|---|---|---|---|
| T0039 implement#2 | 110 | 222 | 39,634 | 11,803,435 | 155,516 | ≈ $4.3 |
| T0043 implement#2 | 30 | 60 | 7,575 | 1,786,274 | 57,978 | ≈ $0.8 |

\*The rough cost uses the per-token rate implied by T0039 implement#1's own `modelUsage.costUSD` ($10.40 for the opus tokens above), with the usual output 5×, cache-read 0.1× and 1-hour cache-write 2× input ratios. It is an illustration, not a price list.

### New finding: `total_cost_usd` is cumulative across `--resume`

Every retry, block answer and user retry resumes the same session (`src/taskd.ts:354,365,835`). Claude Code then reports the session's **running total**, not the cost of this process.

- T0037 implement#1 through #6 all share session `7096e737…`. Their recorded costs are $7.84, 19.16, 21.55, 22.82, 27.14, 29.88. That is monotonic, while `turns` (5, 10, 35, 3, 70, 46) is per-process. The dashboard sums these to about $128 for a session that cost about $30.
- T0039 implement#3 resumed `ff61d3a8…` and recorded $5.78. Its `modelUsage` shows 16.28 M cache-read tokens and 50.7 k output. The session log shows 4.48 M and 11.1 k in implement#3's own window, plus 11.8 M and 39.6 k in implement#2's window. So the "$0" attempt's cost was actually folded into the next attempt.

The net effect:
- a killed attempt under-reports, unless the session is later resumed, in which case the next attempt absorbs its cost;
- every resumed attempt double-counts all earlier attempts in the session.

Task totals for long block/retry chains are inflated, often by a lot.

### Proposed fix for symptom 2

1. **Store per-attempt deltas.** In `handleResult`, set `cost_usd = max(0, total_cost_usd − prev)`, where `prev` is the cumulative cost already recorded for this `session_id`.
   - Simplest approach: add a column `steps.session_cost_usd` holding the raw cumulative value, and compute the delta from the previous attempt with the same `session_id`.
   - Keep `turns` as is; it is already per-process.
   - Add a one-off migration that recomputes historical rows the same way.
2. **Estimate on kill.** When `body.killed` is set or `result` is null, the runner (better, because it has the files on the same machine) reads the session log for `session_id` plus `subagents/*`. It sums usage over the step window, dedupes by message id, and adds an `estimate: { tokens_by_model, api_calls }` to `report.json`.
   - taskd prices the tokens with a `[pricing.<model>]` table in config.toml: `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h` per MTok.
   - It stores `cost_usd = estimate`, `turns = api_calls`, and a new `cost_estimated = 1`.
   - If the session log is missing (remote machine, or never started), fall back to the stream transcript: a lower bound from the deduped message ids. If there is nothing at all, store `cost_usd = NULL`.
3. **Display.** In `task ls`, `task show` and the dashboard:
   - an estimated cost shows as `~$4.30`;
   - `NULL` shows as `$?`;
   - the task total shows `≥ $X` when any step is unknown.

   `cost_usd` becomes nullable (`db.ts:140` currently has `NOT NULL DEFAULT 0`). Adjust `:646` and the formatters (`cli.ts:133,155,385,393`, `dashboard.html` `money()`) accordingly.
4. Keep a 0 cost only for steps that truly did no work, such as never-started runs. Those will now say "runner never started", so $0 is accurate there.

---

## Risk

- **Lease changes (1, 2, 5, 6).** Arming the lease later means a runner that truly hangs during launch is detected after `launch_grace_sec` instead of 150 s. That is acceptable.
  - Excluding never-started rows from `failureCount` without the separate bound could loop forever on a broken claude or herdr binary. The bound in fix 6 is required, not optional.
  - The R2 fencing (`isLive`) is unaffected: `/context` heartbeats must use the same `isLive` check.
- **Async launch (4).** Introduces a new in-memory state (`launching`). A taskd restart mid-launch leaves a running row with no tab. The launch deadline then expires it as "runner never started", which is the correct outcome.
  - `runningCount` must keep counting launching steps so concurrency holds.
  - This is the riskiest part; it can be split into a follow-up.
- **Tick-gap extension (7).** A real stall of taskd itself, for example a blocked event loop, would also extend leases once. That errs on the side of keeping work alive, which is what R3 already chose.
- **Transcript result recovery (8).** It must only apply a `result` event belonging to this attempt. The transcript file is per attempt (`<step>-<attempt>`), so this is safe.
- **Cost deltas and migration.** Changing historical `cost_usd` values alters reported spend. Keep the raw cumulative value in the new column so the change is reversible. Pricing tables go stale; label estimates as estimates.
  - The session-log path (`~/.claude/projects/<slug>`) is a Claude Code implementation detail and may change. Fall back to the stream transcript, then to unknown.
- Remote machines (`proj.machine`): the session log is only readable by the runner on that machine. That is why the runner, not taskd, should compute the estimate.

## Size estimate for the implement task

**Medium: about 1–1.5 days, 400–600 lines including tests.** Two separable PRs are suggested.

- **PR A, lease and launch** (fixes 1–3 and 5–8; about 250 lines plus tests):
  - schema: `runner_seen_at`;
  - `tryLaunch` arming;
  - `/context` heartbeat;
  - runner immediate heartbeat and early mkdir;
  - herdr timeouts;
  - never-started classification and bound;
  - tick-gap extension;
  - transcript result recovery.

  Tests use a stub `herdr` and stub claude with injected delays, plus a fake clock jump.

  Fix 4 (async launch) adds about 100–150 lines; it is the riskiest part and is better done as a follow-up.
- **PR B, cost accounting** (about 200 lines plus tests):
  - schema `session_cost_usd`, `cost_estimated`, nullable `cost_usd`, and a migration;
  - delta computation;
  - runner session-log estimator;
  - `[pricing]` config;
  - CLI and dashboard formatting.

  Tests use fixture session logs. The T0039 implement#1 numbers above make a good golden case.
