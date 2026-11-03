# Tasks: plan revision loop and task reject

See `plan.md` for the code sketches each task refers to. Typecheck after every
code task with `bunx tsc --noEmit`; run `bun test test/` after T009.

## Phase 1: data and config (file-disjoint)

- [x] T001 [P] `src/config.ts`: add `max_plan_cycles` to `Defaults`, `DEFAULTS` (2) and `defaultConfigToml()` with the comment "plan QA reviews per round before the plan goes to the gate anyway".
- [x] T002 [P] `src/pipelines.ts`: agent variant gets optional `on_fail?: string; max_cycles_key?: "max_plan_cycles"`; set both on the implement pipeline's `plan_qa` step; update the header comment.
- [x] T003 [P] `src/db.ts`: `plan_cycles` and `rejection` on `TaskRow`, in `SCHEMA`, and in `migrate()`; widen `insertTask`'s `Omit` to include both so existing callers compile; run `bunx tsc --noEmit` and the existing tests.

## Phase 2: scheduler (src/taskd.ts, sequential)

- [x] T004 `pipelineSteps`: backfill `on_fail: "plan"`, `max_cycles_key: "max_plan_cycles"` on a stored `plan_qa` agent step that lacks `on_fail`.
- [x] T005 `advance` agent branch: treat a `skipped` latest row as missing (new attempt); route `done` rows of steps with `on_fail` through a new `reviewed()` that implements the plan QA loop (event `task.plan_qa_fail {cycle, revising, summary}`, `plan_cycles`, queued plan row, plan_qa row → skipped; or `next()` to the gate when `plan_cycles + 1 >= max_plan_cycles`).
- [x] T006 `advance` gate branch: treat a `skipped` latest row as missing (attempt + 1); clear `rejection` in the same transaction; use `gateLabel()` in the `task.gate` event and herdr notification. Add `gateLabel(task, ps)` (base label + "plan QA still fails after N review(s); see <feature_dir>/qa/plan-review.md" when the nearest preceding `on_fail` agent step's latest result is `fail`). Comment in the system branch that `skipped` re-runs.
- [x] T007 `stepContext`: assemble `QA_FEEDBACK` from the pending rejection (when `rejection.target === step.name`), the QA group (unchanged text when no rejection) and failed `plan_qa` results with the `qa/plan-review.md` pointer; add `PLAN_CYCLE`.
- [x] T008 Routes: add `reject` to the task action regex with `rejectTarget()` and the transaction from plan.md (note + `task.rejected` events, gate and in-between rows skipped, queued target attempt, `rejection` set, cycle counter reset); add `gate_label` to `GET /tasks` (gate tasks) and `GET /tasks/:id`.

## Phase 3: tests

- [x] T009 `test/plan-loop.test.ts` (new), per the harness notes in plan.md:
  - loop: plan_qa fail → plan#2 queued, `plan_cycles` 1, event, context `QA_FEEDBACK` has summary, notes and `qa/plan-review.md` → plan#2 done → plan_qa#2 queued → pass → gate with plain label;
  - loop: fail twice (max 2) → gate, `gate_label` contains "plan QA still fails", no `failed` step rows, task not failed, second event has `revising: false`;
  - reject at plan gate on a legacy pipeline JSON (plan_qa without `on_fail`) with plan_qa#1 failed (T0034's shape): rows skipped, plan#2 queued, `note` + `task.rejected` events, `rejection` set, `QA_FEEDBACK` has the user feedback and the plan QA summary; drive plan#2 done and plan_qa#2 pass → new gate row attempt 2, `rejection` null;
  - reject at merge gate (direct, `merge_gate: true`, `speckit: true`): implement queued with feedback, review/test/handoff and gate rows skipped, `qa_cycles` 0; drive implement, review, test (pass), handoff → gate reopens;
  - refusals: not at a gate → 400; empty feedback → 400; nothing changed;
  - migration: old `tasks` table without the new columns opens twice, rows intact, `plan_cycles` 0, `rejection` null.
- [x] T010 Run `bunx tsc --noEmit` and `bun test test/`; fix until green.

## Phase 4: surfaces (file-disjoint)

- [x] T011 [P] `src/cli.ts`: `reject` command and help line; `statusText` "rejected, revising"; `show` prints plan cycles, gate label, rejection; `inbox` gate lines with label and approve/reject hints, plus a `revising:` section (and `revising` in JSON output); `watch` shows the label and revising state.
- [x] T012 [P] `src/dashboard.html`: plan/qa cycles in card meta, "rejected, revising" badge, `gate_label` in the gate box, notes for `task.plan_qa_fail` and `task.rejected`.
- [x] T013 [P] `prompts/plan.md`, `prompts/plan_lite.md`, `prompts/plan_qa.md`: revision paragraph with `{{QA_FEEDBACK}}`; finding ids and re-review instructions with `{{PLAN_CYCLE}}` (text in plan.md). Touch no other prompt.
- [x] T014 [P] `README.md`: `task reject` in the CLI block, inbox description, plan QA loop / `max_plan_cycles` / reject in the pipeline section, roadmap item 10 struck through, restart note.
- [x] T015 [P] `skills/foreman/SKILL.md`: `task reject` in the command list; Inbox guidance for relaying change requests verbatim with `task reject` and for the "plan QA still fails" label.

## Phase 5: verify

- [x] T016 `bunx tsc --noEmit`, `bun test test/`, `bun run src/cli.ts --help | grep reject` (or the project's `task` entry point).
- [x] T017 Migration check on a copy of the live DB only: `cp ~/.foreman/foreman.db /tmp/fm-t0035.db` (check the real path in `src/config.ts` `DB_PATH`), open it with `new Store("/tmp/fm-t0035.db")` in `bun -e`, confirm `getTask("T0034")` loads with `plan_cycles` 0 and its steps list. Do not restart taskd or point a dev taskd at the live DB; the live restart happens after merge, after `task ls --all`.
