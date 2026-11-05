# T0054 review, round 1

**Verdict: pass.** No finding blocks the task. The non-blocking findings below can go to a follow-up.

Scope reviewed: `git diff main...HEAD`, compared with `spec.md` (S1–S6, AS-1–AS-11) and `plan.md`.

Checks run:
- `bunx tsc --noEmit`: clean.
- `bun test test/`: 160 pass, 0 fail across 14 files.

## Spec conformance

| Item | Status |
|---|---|
| S1 lease armed after launch | Met. `tryLaunch` sets `launch_started_at` and the grace deadline (`taskd.ts` ~484–489). `launch()` arms `lease_sec` only when the step is still live, and otherwise closes the late tab. Never-started texts and events match the spec. `failureCount` skips never-started rows, `neverStartedStreak` provides the separate bound, and `settle` relaunches with the same session and a resume prompt that has `[user-retry]` stripped. |
| S2 runner check-in | Met. `runner.ts` sends a heartbeat after `/context` and before `mkdirSync`, and exits if the reply is `cancel`. The heartbeat route sets `runner_seen_at`. `task show` adds one line for running steps. |
| S3 herdr timeouts | Met. `run()` races against a timer, kills the child, and names the call through `callName`, which handles `--machine`. `launchInTab` closes the tab when `pane run` fails. |
| S4 non-blocking launch | Met. Launches are tracked in a `launching` map. Concurrency still counts them because the row is already `running`. `expireLeases` no longer awaits `closeTab`. |
| S5 tick-gap extension | Met. `extendRunningLeases` is shared with startup R3. The `taskd.stall` event records `gap_sec` and `extended`. |
| S6 transcript recovery | Met. This runs before classification, writes `report.json` with `recovered_from: "transcript"`, records `source` on both recovery paths, and applies the result through the unchanged `handleResult`. |
| Constraints | Met. The migration is additive. Cost fields and pipelines are untouched. The only CLI change is the new `task show` line. The README has a "Launch and leases" section covering the restart and why it is safe. |

## Findings (non-blocking)

### F1. The herdr failure text can carry `FOREMAN_TOKEN` into the step error, notifications and the ticket comment

- **Where:** `src/herdr.ts:33`, which builds the error from `args.join(" ")`. It reaches the step through `src/taskd.ts:538` and the bound message at `src/taskd.ts:440`.
- **Failure scenario:** `tab create` exits non-zero (AS-5). The error text contains every `--env K=V` argument, including `FOREMAN_TOKEN=<token>`. That text ends up in four places:
  - `steps.error`, which `task show` prints;
  - the `step.never_started` and `step.launch_failed` events;
  - after `launch_attempts_max` failures, the task result;
  - the `failTask` herdr notification and the ticket comment ("Foreman Txxxx failed: …"), which is external.
- **Context:** this predates the branch. The old `launch failed: ${e.message}` path leaked the same way. The branch keeps the leak and routes it into the new event and bound message.
- **Required change (follow-up):** build the failure message from `callName(args)` (plus stderr), as the timeout message already does, or redact `--env` values. I am filing this as a follow-up ticket rather than blocking.

### F2. Two acceptance checks are covered only by inspection, not by tests

- **Where:** `test/herdr-timeout.test.ts` and `test/launch.test.ts`.
- **Gap:** AS-6 also requires the error seen through taskd to read `runner never started: herdr tab create timed out after 1s`. The tests only check `launchInTab`'s rejection. AS-7's `task show` line ("runner seen … ago") has no test.
- **Assessment:** inspection confirms the code is right. `launch()` prefixes `e.message` unchanged, and `cli.ts:156` prints the line. The plan allows a visual check for the CLI line.
- **Suggested change:** add one taskd-level test with `herdr_timeout_sec=1` and a hanging `tab create`.

### F3. Tick-gap extension repeats while ticks keep stalling, so dead runners may never expire

- **Where:** `src/taskd.ts:205`.
- **Failure scenario:** herdr is wedged and each tick awaits `herdr.notify` or `ticketHook` (for example in `failTask` or `handleResult`). Each tick then lasts more than 60 s. Every following tick extends all running leases by the gap, so a runner that really died keeps getting extended for as long as the stall goes on.
- **Assessment:** the plan accepts this ("same trade-off as R3"), and herdr calls are now bounded at 120 s. Not blocking.
- **Possible follow-up:** cap the extension per lease, or only extend when the gap looks like wall-clock sleep (process uptime compared with wall time).

### F4. A step that fails in `pane run` after its runner already checked in is labelled "never started" but counted

- **Where:** `src/taskd.ts:538` together with `src/herdr.ts:71`.
- **Failure scenario:**
  1. `pane run` starts the runner, and the runner checks in (`runner_seen_at` is set).
  2. The `pane run` CLI call itself then times out.
  3. `launchInTab` closes the tab, killing a live runner, and the step error reads `runner never started: herdr pane run timed out…`.
  4. Because `runner_seen_at` is set, `isNeverStarted` is false, so the attempt is counted.

  The accounting is defensible, but the text is misleading.
- **Assessment:** rare edge case, not blocking. One option: in the catch, if `fresh.runner_seen_at` is set, use `launch failed: …` instead.

### F5. The transcript recovery path does not close the tab or mark the step for cancel

- **Where:** `src/taskd.ts` ~161–169.
- **Behaviour:** the recovery `continue`s before `cancelRequested.add` and `closeTab`. If the runner process is still alive after its result event (for example, waking from sleep), it gets `cancel` on its next heartbeat, because the step is no longer live, and the tab stays open until the runner exits.
- **Assessment:** this matches the existing `report.json` path. Noted only.

## Notes for the next step

- The handoff must say that taskd needs a restart and that the restart is safe while steps run. The README explains why: the migration is additive, startup extends running leases, and legacy rows have NULL `launch_started_at`, so they keep the old classification.
- Do not restart taskd as part of this task.
