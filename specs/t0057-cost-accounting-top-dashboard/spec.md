# Cost accounting on top of the dashboard and launch changes: rebase T0055, resolve, re-verify, merge

_Created by Foreman T0057._

## Goal

Land T0055 (per-attempt cost deltas, cost estimate on kill/lease expiry, daily totals) on top of
main at 7bfc394, which now contains T0054 (launch and leases, 14f6a40) and T0050 (collapsed dashboard
cards and the Decision block, 7bfc394). T0055 is QA-passed on `fm/t0055-cost-accounting-per-attempt`
(tip 574f3fc, merge base 6429105). The only work is integration: bring its commits onto
`fm/t0057-cost-accounting-top-dashboard`, resolve the conflicts so all three features keep working,
wire T0055's cost logic into the code paths T0054 added, and re-verify.

T0055's own spec, plan and QA reports (under `specs/t0055-cost-accounting-per-attempt/`, arriving
with the merge) stay the definition of the cost behaviour. This spec only covers how it composes
with T0050 and T0054.

## Conflict inventory (trial merge of the T0055 branch into 7bfc394)

| File | Hunks | Nature |
|---|---|---|
| `src/taskd.ts` | 1 | `expireLeases` lease-expired tail: T0054 rewrote it (transcript recovery, never-started classification, `tx`), T0055 added `...stepCost(s, {})` |
| `src/db.ts` | 2 | `StepRow` fields and `CREATE TABLE steps` columns: T0054 +3, T0055 +3 |
| `src/cli.ts` | 1 | `task show` step line: T0054 "runner seen" continuation vs T0055 `fmtCost` + `~` turns |
| `src/dashboard.html` | 1 | `card()`: T0050 replaced the card; T0055 edited `money()` call on the old card |
| `README.md` | 1 | Both sides added sections at the same spot |
| `test/step-timeouts.test.ts` | 1 | Migration test fixture: T0054 neutralises its 3 columns, T0055 destructures its 3 |

Everything else (`src/config.ts`, `src/runner.ts`, the rest of `src/taskd.ts` including
`handleResult`, `/tasks`, `/costs/today`, the T0053 triage doc which is identical on both sides,
`task ls`/`watch` cost formatting) merges cleanly.

Two places merge cleanly but still need integration work because T0050 introduced cost output that
T0055 never saw:

- `src/dashboard.html` `money()` (now at its new location, line ~103), the recent-table cost cell,
  and the header status line (`#status`) — T0055's hunks there may or may not auto-apply; verify.
- `src/decision.ts` `buildDecision` formats `Cost` facts as plain `"$" + sum.toFixed(2)`, which
  hides estimated/unknown costs inside the Decision frame.

## Scope

1. Merge T0055 into this branch (merge commit; T0055's QA'd history kept as is).
2. Resolve each conflict keeping both sides' behaviour.
3. Cost of each `expireLeases` outcome:
   - report.json recovery and T0054's transcript recovery both call `handleResult`, which (after
     the merge) calls `stepCost` → per-attempt delta of `total_cost_usd` against
     `prevSessionCost(session_id)`. No extra code expected; a test proves it for the transcript path.
   - Plain lease expiry (runner had checked in, or a pre-T0054 row with no `launch_started_at`):
     `...stepCost(s, {})` — estimate from the session log, else `cost_unknown = 1` (T0055 behaviour).
   - "Runner never started" (`error` starts with `NEVER_STARTED`): `cost_usd = 0, turns = 0,
     cost_estimated = 0, cost_unknown = 0, session_cost_usd = null`. It never ran, so it is a known
     zero, not unknown, and must not look up a session log or carry a session cost.
4. Dashboard (T0050 shape): T0055's `money(n, est, unk)` (`~$x` estimated, `$?` unknown) used for the
   collapsed row's cost (`.head .meta`), the recent table, and the header status line's
   `today $x` total from `GET /costs/today`.
5. Decision frame: `buildDecision`'s `Cost` fact uses T0055's `fmtTaskCost(sum, estimated, unknown)`
   so the frame shows `~$x`/`$?` the same way. The Activity frame shows no dollar figures today; no
   new cost display is added there (only: if any cost is rendered there, it goes through `money()`).
6. CLI `task show`: keep T0050's decision block, T0054's "runner seen / not seen yet" line, and
   T0055's `fmtCost` step cost and `~` turns. `task ls` footer with today's totals stays as T0055 wrote it.
7. DB: `StepRow`, `CREATE TABLE steps`, and `migrate()` list T0054's three columns
   (`launch_started_at, launched_at, runner_seen_at`) first, then T0055's three
   (`session_cost_usd, cost_estimated, cost_unknown`). `migrateCostDeltas` unchanged.
8. README: keep T0054's, T0050's and T0055's sections (Costs) all present, no duplicated headings.
9. `test/step-timeouts.test.ts`: one fixture that tolerates both column sets.

## Acceptance scenarios

- **AS-1 (merge)**: `git log` shows T0055's commits reachable from this branch via one merge commit
  whose message names T0055, T0050, T0054. No conflict markers anywhere (`git grep -n '^<<<<<<<\|^>>>>>>>'` empty).
- **AS-2 (transcript recovery is a delta)**: a running step whose lease expired, with no report.json
  and a transcript ending in a `result` event with `total_cost_usd = 5` and `session_id = S`, where an
  earlier attempt of session S recorded `session_cost_usd = 3` → step row `cost_usd = 2`,
  `session_cost_usd = 5`, `cost_estimated = 0`, `cost_unknown = 0`; event `step.result_recovered`
  with `source: "transcript"` still recorded.
- **AS-3 (never started costs nothing)**: a running step with `launch_started_at` set, `runner_seen_at`
  null, and an expired lease, whose session id has a session log on disk → `status = failed`,
  error starts with `NEVER_STARTED`, `step.never_started` event, `cost_usd = 0`, `turns = 0`,
  `cost_estimated = 0`, `cost_unknown = 0`, `session_cost_usd` null.
- **AS-4 (plain lease expiry still estimates)**: T0055's AS-7 test (`test/cost-accounting.test.ts`)
  passes unchanged: rows without `launch_started_at` get estimated / unknown cost; T0054's
  classification tests (`test/launch.test.ts`, `test/result-recovery.test.ts`, `test/stall.test.ts`) pass unchanged.
- **AS-5 (dashboard)**: the collapsed row shows `~$1.20` for a task with an estimated step, `$?` for
  a task whose only cost is unknown, `$1.20` otherwise; the header line ends with
  `· today $x` (`~$x (N est.)` when some are estimated) when `/costs/today` answers, and renders
  without it when the endpoint fails.
- **AS-6 (Decision frame)**: `buildDecision` for a gate task with one estimated step of 1.5 gives
  fact `Cost: ~$1.50`; an all-known task gives `$1.75` (T0050's existing decision tests unchanged).
- **AS-7 (CLI)**: `task show` prints the decision block, each step line with `fmtCost` cost, and the
  `runner seen … ago` / `runner not seen yet …` line for running steps; `task ls` prints the today footer.
- **AS-8 (migration on live data)**: on a copy of `~/.foreman/foreman.db` (taken read-only; the live
  DB currently has T0054's columns and no T0055 columns, `migration:cost_deltas_v1` absent),
  opening `Store` adds the three T0055 columns, writes the meta key and exactly one `costs.migrated`
  event; opening it again changes nothing (same event count, same `SUM(cost_usd)`, same per-row values).
- **AS-9 (suite)**: `bunx tsc --noEmit` clean; `bun test` fully green (T0050, T0054, T0055 tests and
  the rest); `sh test/smoke.sh` green.

## Out of scope

- Any change to T0050 or T0054 behaviour beyond what the merge needs (no layout changes, no new
  lease/launch rules, no new Activity-frame content).
- Any change to T0055's cost rules, pricing, estimator, or migration logic.
- Restarting taskd or touching the live DB (read-only copy only). The handoff must say taskd needs a
  restart to pick up the new code and run the migration.
- Pushing/merging to main (scheduler does that).
