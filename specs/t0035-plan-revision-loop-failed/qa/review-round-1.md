# T0035 review, round 1

**Verdict: pass.** No HIGH or MEDIUM defects. Three LOW findings below; none blocks merge.

Reviewed: `git diff main...HEAD` (src/taskd.ts, db.ts, pipelines.ts, config.ts, cli.ts,
dashboard.html, prompts/plan*.md, README.md, skills/foreman/SKILL.md, test/plan-loop.test.ts)
against `spec.md` and `plan.md`. The project has no constitution or CLAUDE.md.

Checks run:
- `bunx tsc --noEmit`: clean.
- `bun test test/`: 83 pass, 0 fail. The `advance S… failed: … 'ps.type'` log lines come from
  superseded.test.ts and also appear on `main`, so this branch did not introduce them.

## Spec coverage

| Spec item | Status |
|---|---|
| `on_fail: "plan"` / `max_cycles_key` on plan_qa; legacy pipelines backfilled on read (`pipelineSteps`) | done, stored JSON untouched (test asserts) |
| `max_plan_cycles = 2` default + config comment | done |
| Loop: fail → plan#n+1 queued, plan_qa skipped, `plan_cycles`++, `task.plan_qa_fail` | done, scenario 1 test |
| Budget spent → gate with warning label, no failed rows, `revising:false` event | done, scenario 2 test |
| QA_FEEDBACK from latest failed plan_qa summary/notes + `qa/plan-review.md` pointer; implement text unchanged with no rejection | done (implement header/body are byte-identical when there is no rejection) |
| `task reject` / `POST /tasks/:id/reject`: plan and merge gates, skips intermediate rows, new target attempt, counter reset, `note` + `task.rejected` events, rejection cleared on gate reopen | done, scenario 3 (legacy T0034 shape) and 4 tests |
| Refusals (not at gate, empty feedback) are 400 and change nothing | done, scenario 5 test |
| Migration of `plan_cycles` / `rejection`, idempotent | done, scenario 6 test |
| CLI help, show (plan cycles, gate label, rejection), inbox (labels, approve/reject hints, `revising:`), watch, dashboard, README, SKILL.md | done |
| Prompt changes only in plan.md, plan_lite.md, plan_qa.md, using `{{QA_FEEDBACK}}` / `{{PLAN_CYCLE}}` as stepContext names them | done |

## Findings

### L1: gate label review count spans rejection rounds
- **File:** `src/taskd.ts:255-260` (`gateLabel`)
- **Failure scenario:** The task is at plan_approved and plan_qa#1 failed. The user runs
  `task reject`, which resets `plan_cycles` to 0. plan_qa#2 fails, plan#3 runs, then plan_qa#3
  fails and the budget is spent. The label reads "plan QA still fails after 3 review(s)", but
  only 2 of those reviews ran in this round and `max_plan_cycles` is 2. The README describes the
  budget as "reviews per round".
- **Required change (optional):** Either count only the plan_qa rows since the last
  `plan_approved` gate row, or leave the code as is and drop the count from the label. This is
  cosmetic.

### L2: `task show` prints "revising" for a failed or cancelled task with a stale rejection
- **File:** `src/cli.ts:141`
- **Failure scenario:** The user rejects at the gate, and plan#2 then fails `max_attempts` times,
  so the task is `failed`. `rejection` is cleared only when a gate opens, so it is still set, and
  `task show` prints "rejected at plan_approved, revising: …" on a failed task. The spec says
  "revising" shows only while the task is active. `statusText`, the dashboard and the inbox filter
  apply that rule (inbox and watch only list active tasks), but `show` does not.
- **Required change (optional):** Guard the line with the same active-status check as
  `statusText`, or reword it ("rejected at X: feedback") when the task is not active. Keep the
  rejection on the task, because a `task retry` should still carry the feedback.

### L3: rows inserted by the loop and by reject omit `machine`
- **File:** `src/taskd.ts:241` (`reviewed`), `src/taskd.ts:760` (reject route)
- **Failure scenario:** On a project with `machine` set, `herdr.closeTab(step.tab_id, step.machine)`
  for these rows targets the local host. Launch uses `proj.machine`, so dispatch itself is
  correct. The QA loop and `retry` already insert rows the same way, so this repeats an existing
  pattern rather than adding a new bug.
- **Required change (optional):** Pass `machine: project(task).machine ?? null` in both inserts,
  as `createStep` does. You could also file this as a follow-up that covers the QA loop and retry.

## Notes for after merge
- The live restart of taskd (`task ls --all` first, then `foreman service restart`) is out of
  scope for the worker and is still to do. After it, `task show T0034` should show the "plan QA
  still fails after 1 review(s)" label. `task reject T0034 "…"` should then queue plan#2 with the
  user's feedback and T0034's plan-review summary, which the scenario 3 test reproduces on the
  legacy pipeline shape.
